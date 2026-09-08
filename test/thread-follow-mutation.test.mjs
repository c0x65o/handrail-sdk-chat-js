import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_THREAD_FOLLOW_IDEMPOTENCY_KEY_UTF8_BYTES,
  ThreadFollowMutationParseError,
  parseFollowThreadInput,
  parseSetThreadFollowInput,
  parseSetThreadFollowResult,
  parseUnfollowThreadInput,
} from "../dist/index.js";
import * as clientThreadFollowContracts from "../dist/client/index.js";
import * as serverThreadFollowContracts from "../dist/server/index.js";
import {
  conflictingThreadFollowResult,
  followThreadInput,
  settledThreadFollowResult,
  threadFollowInputs,
  unfollowThreadInput,
} from "./fixtures/thread-follow-mutations.mjs";

const roundTrip = (value) => JSON.parse(JSON.stringify(value));
const assertParseError = (code) => (error) =>
  error instanceof ThreadFollowMutationParseError && error.code === code;

test("explicit follow and unfollow inputs round-trip from every public contract entry", () => {
  assert.deepEqual(parseFollowThreadInput(roundTrip(followThreadInput)), followThreadInput);
  assert.deepEqual(
    parseUnfollowThreadInput(roundTrip(unfollowThreadInput)),
    unfollowThreadInput,
  );
  for (const input of threadFollowInputs) {
    assert.deepEqual(parseSetThreadFollowInput(roundTrip(input)), input);
  }

  assert.equal(
    clientThreadFollowContracts.parseSetThreadFollowInput,
    parseSetThreadFollowInput,
  );
  assert.equal(
    serverThreadFollowContracts.parseSetThreadFollowResult,
    parseSetThreadFollowResult,
  );
});

test("rejects missing idempotency, ambiguous toggles, boolean desired state, and unknown fields", () => {
  const { idempotencyKey: _idempotencyKey, ...withoutIdempotencyKey } =
    followThreadInput;
  const invalid = [
    withoutIdempotencyKey,
    { ...followThreadInput, operation: "toggle_thread_follow" },
    { ...followThreadInput, intent: "toggle" },
    { ...followThreadInput, toggle: true },
    { ...followThreadInput, toggleFollow: true },
    { ...followThreadInput, isFollowing: false },
    { ...followThreadInput, following: true },
    { ...followThreadInput, requestedState: true },
  ];

  for (const input of invalid) {
    assert.throws(
      () => parseSetThreadFollowInput(input),
      assertParseError("malformed_input"),
    );
  }
});

test("requires a specifically discriminated thread target and rejects parent targeting", () => {
  const invalid = [
    [{ ...followThreadInput, target: { type: "channel", id: "channel-parent" } }, "malformed_target"],
    [{ ...followThreadInput, target: { id: "thread-alpha" } }, "malformed_target"],
    [{ ...followThreadInput, target: { type: "thread", id: "" } }, "malformed_identifier"],
    [{ ...followThreadInput, target: { type: "thread", id: " thread-alpha" } }, "malformed_identifier"],
    [{ ...followThreadInput, conversationId: "thread-alpha" }, "malformed_input"],
    [{ ...followThreadInput, channelId: "channel-parent" }, "parent_conversation_target"],
    [{ ...followThreadInput, parentConversationId: "channel-parent" }, "parent_conversation_target"],
    [{ ...followThreadInput, "Parent_Conversation-ID": "channel-parent" }, "parent_conversation_target"],
    [{ ...followThreadInput, target: { ...followThreadInput.target, parentChannelId: "channel-parent" } }, "parent_conversation_target"],
  ];

  for (const [input, code] of invalid) {
    assert.throws(() => parseSetThreadFollowInput(input), assertParseError(code));
  }
});

test("rejects caller-authored manual and participation auto-follow sources", () => {
  for (const [field, source] of [
    ["source", "manual"],
    ["followSource", "reply"],
    ["auto-follow_source", "mention"],
    ["participation cause", "reply"],
  ]) {
    assert.throws(
      () => parseSetThreadFollowInput({ ...followThreadInput, [field]: source }),
      assertParseError("caller_authored_auto_follow"),
      field,
    );
  }
});

test("rejects normalized tenant, user, actor, session, role, and authorization spoofing", () => {
  const spoofedFields = [
    ["tenant-id", "tenant-spoof"],
    ["organization.id", "organization-spoof"],
    ["Actor_User_ID", "user-spoof"],
    ["current user", { id: "user-spoof" }],
    ["user-id", "user-spoof"],
    ["session_id", "session-spoof"],
    ["authentication", { user: "user-spoof" }],
    ["authorization", "Bearer spoof"],
    ["roles", ["admin"]],
    ["permissions", ["thread-follow:any"]],
  ];

  for (const [field, value] of spoofedFields) {
    assert.throws(
      () => parseSetThreadFollowInput({ ...followThreadInput, [field]: value }),
      assertParseError("trusted_identity_field"),
      field,
    );
  }
});

test("enforces advanceable revisions and bounded nonblank idempotency keys", () => {
  for (const expectedFollowRevision of [
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.throws(
      () => parseSetThreadFollowInput({ ...followThreadInput, expectedFollowRevision }),
      assertParseError("malformed_revision"),
    );
  }

  for (const idempotencyKey of [
    "",
    "   ",
    " surrounded ",
    "x".repeat(MAX_THREAD_FOLLOW_IDEMPOTENCY_KEY_UTF8_BYTES + 1),
  ]) {
    assert.throws(
      () => parseSetThreadFollowInput({ ...followThreadInput, idempotencyKey }),
      assertParseError("malformed_input"),
    );
  }

  assert.equal(
    parseSetThreadFollowInput({
      ...followThreadInput,
      idempotencyKey: "x".repeat(MAX_THREAD_FOLLOW_IDEMPOTENCY_KEY_UTF8_BYTES),
    }).idempotencyKey.length,
    MAX_THREAD_FOLLOW_IDEMPOTENCY_KEY_UTF8_BYTES,
  );
});

test("follow and unfollow results round-trip for every deterministic settled status", () => {
  const cases = [
    [followThreadInput, settledThreadFollowResult(followThreadInput, "applied")],
    [followThreadInput, settledThreadFollowResult(followThreadInput, "replayed")],
    [unfollowThreadInput, settledThreadFollowResult(unfollowThreadInput, "applied")],
    [unfollowThreadInput, settledThreadFollowResult(unfollowThreadInput, "already_requested_state")],
  ];

  for (const [input, result] of cases) {
    assert.deepEqual(parseSetThreadFollowResult(roundTrip(result), input), result);
  }
});

test("revision conflicts carry a different authoritative canonical state", () => {
  const followConflict = conflictingThreadFollowResult(followThreadInput, 8);
  const unfollowConflict = conflictingThreadFollowResult(
    unfollowThreadInput,
    11,
    "mention",
  );

  assert.deepEqual(
    parseSetThreadFollowResult(roundTrip(followConflict), followThreadInput),
    followConflict,
  );
  assert.deepEqual(
    parseSetThreadFollowResult(roundTrip(unfollowConflict), unfollowThreadInput),
    unfollowConflict,
  );
  assert.equal(unfollowConflict.follow.source, "mention");
});

test("rejects incoherent result echoes and invalid revision/status combinations", () => {
  const applied = settledThreadFollowResult(followThreadInput);
  const invalid = [
    [{ ...applied, intent: "unfollow" }, "incoherent_result"],
    [{ ...applied, target: { type: "thread", id: "thread-other" } }, "incoherent_result"],
    [{ ...applied, expectedFollowRevision: 1 }, "incoherent_result"],
    [{ ...applied, idempotencyKey: "thread-follow:other" }, "incoherent_result"],
    [{ ...applied, followRevision: followThreadInput.expectedFollowRevision }, "incoherent_result"],
    [{ ...applied, reconciliationStatus: "already_requested_state" }, "incoherent_result"],
    [{ ...applied, reconciliationStatus: "follow_revision_conflict", followRevision: followThreadInput.expectedFollowRevision }, "incoherent_result"],
    [{ ...applied, follow: { ...applied.follow, target: { type: "thread", id: "thread-other" } } }, "incoherent_result"],
    [{ ...applied, follow: { ...applied.follow, isFollowing: false } }, "incoherent_result"],
    [{ ...applied, follow: { ...applied.follow, source: "reply" } }, "incoherent_result"],
    [{ ...applied, follow: { ...applied.follow, updatedAt: "not-a-time" } }, "malformed_timestamp"],
    [{ ...applied, followRevision: -1 }, "malformed_revision"],
    [{ ...applied, actorUserId: "user-spoof" }, "malformed_result"],
  ];

  for (const [result, code] of invalid) {
    assert.throws(
      () => parseSetThreadFollowResult(result, followThreadInput),
      assertParseError(code),
    );
  }

  const invalidAutoUnfollow = {
    ...settledThreadFollowResult(unfollowThreadInput),
    follow: {
      ...settledThreadFollowResult(unfollowThreadInput).follow,
      source: "mention",
    },
  };
  assert.throws(
    () => parseSetThreadFollowResult(invalidAutoUnfollow, unfollowThreadInput),
    assertParseError("incoherent_result"),
  );
});

test("revision conflicts may already match the desired state without inventing a revision", () => {
  for (const input of threadFollowInputs) {
    const result = { ...settledThreadFollowResult(input), reconciliationStatus: "follow_revision_conflict", followRevision: 12 };
    assert.deepEqual(parseSetThreadFollowResult(result, input), result);
  }
});
