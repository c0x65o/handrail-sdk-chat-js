import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveUnreadCount,
  hasDirectMessageRecipientRead,
  isMonotonicMarkRead,
  markRead,
  markUnread,
} from "../dist/index.js";

const readState = {
  conversationId: "conversation-1",
  userId: "user-1",
  lastReadSequence: 7,
  updatedAt: "2026-08-25T20:00:00.000Z",
};

test("derives and clamps unread counts from the latest sequence", () => {
  assert.equal(deriveUnreadCount(10, readState), 3);
  assert.equal(deriveUnreadCount(7, readState), 0);
  assert.equal(deriveUnreadCount(4, readState), 0);
  assert.equal(deriveUnreadCount(0, { ...readState, lastReadSequence: 0 }), 0);
  assert.equal(
    deriveUnreadCount(4, {
      ...readState,
      manualUnreadFromSequence: 5,
    }),
    0,
  );
  assert.equal(
    deriveUnreadCount(4, {
      ...readState,
      manualUnreadFromSequence: 1,
    }),
    4,
  );
  assert.throws(
    () => deriveUnreadCount(-1, readState),
    /non-negative safe integer/,
  );
});

test("derives direct-message receipts from the recipient cursor", () => {
  assert.equal(
    hasDirectMessageRecipientRead({ lastReadSequence: 12 }, { sequence: 12 }),
    true,
  );
  assert.equal(
    hasDirectMessageRecipientRead({ lastReadSequence: 11 }, { sequence: 12 }),
    false,
  );
});

test("accepts only monotonic mark-read cursors", () => {
  assert.equal(isMonotonicMarkRead(7, 7), true);
  assert.equal(isMonotonicMarkRead(7, 9), true);
  assert.equal(isMonotonicMarkRead(7, 6), false);
  assert.throws(
    () => markRead(readState, 6, "2026-08-25T20:01:00.000Z"),
    /cannot move backward/,
  );
});

test("manual unread retains the cursor and a later mark-read clears the marker", () => {
  const manuallyUnread = markUnread(
    readState,
    5,
    "2026-08-25T20:01:00.000Z",
  );

  assert.equal(manuallyUnread.lastReadSequence, 7);
  assert.equal(manuallyUnread.manualUnreadFromSequence, 5);
  assert.equal(deriveUnreadCount(10, manuallyUnread), 6);
  assert.throws(
    () => markUnread(readState, 8, "2026-08-25T20:01:00.000Z"),
    /between one and lastReadSequence/,
  );

  const readAgain = markRead(
    manuallyUnread,
    10,
    "2026-08-25T20:02:00.000Z",
  );
  assert.equal(readAgain.lastReadSequence, 10);
  assert.equal("manualUnreadFromSequence" in readAgain, false);
  assert.equal(deriveUnreadCount(10, readAgain), 0);
});

test("editing message revision metadata does not change unread state", () => {
  const original = { sequence: 7, revision: { revision: 1 } };
  const edited = {
    ...original,
    revision: {
      revision: 2,
      editedAt: "2026-08-25T20:03:00.000Z",
    },
  };

  assert.equal(original.sequence, edited.sequence);
  assert.equal(
    hasDirectMessageRecipientRead(readState, original),
    hasDirectMessageRecipientRead(readState, edited),
  );
  assert.equal(deriveUnreadCount(edited.sequence, readState), 0);
});
