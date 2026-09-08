import type {
  ConversationId,
  IsoTimestamp,
  MessageSequence,
  TenantId,
  UserId,
} from "./identifiers.js";
import type { Message } from "./message.js";

export type ConversationMemberRole = "owner" | "moderator" | "member";

export type ConversationMemberState = "active" | "left" | "removed";

/** Tenant-scoped membership in any conversation stream, including a thread. */
export interface ConversationMember {
  readonly tenantId: TenantId;
  readonly conversationId: ConversationId;
  readonly userId: UserId;
  readonly role: ConversationMemberRole;
  readonly state: ConversationMemberState;
  readonly joinedAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

/**
 * A member's durable read cursor for one conversation stream.
 *
 * `lastReadSequence` only moves forward. Marking an already-read message as
 * unread is represented by `manualUnreadFromSequence`; it never rewinds the
 * cursor. A subsequent mark-read operation clears that marker.
 */
export interface ConversationReadState {
  readonly conversationId: ConversationId;
  readonly userId: UserId;
  readonly lastReadSequence: MessageSequence;
  readonly manualUnreadFromSequence?: MessageSequence;
  readonly updatedAt: IsoTimestamp;
}

/** A thread follow is durable user state and is synchronized across devices. */
export interface FollowedThreadState {
  readonly conversationId: ConversationId;
  readonly userId: UserId;
  readonly isFollowing: boolean;
  readonly updatedAt: IsoTimestamp;
}

export type ConversationMuteState =
  | {
      readonly muted: false;
      readonly mutedUntil?: never;
    }
  | {
      readonly muted: true;
      /** Omit for an indefinite mute. */
      readonly mutedUntil?: IsoTimestamp;
    };

export type ConversationNotificationPreference =
  | "all"
  | "mentions"
  | "none";

/** Per-member starred, notification, and mute preferences for one conversation. */
export interface ConversationMemberPreference {
  /** Authoritative stored revision; zero means no row. Absent on legacy snapshots. */
  readonly preferenceRevision?: number;
  readonly conversationId: ConversationId;
  readonly userId: UserId;
  readonly isStarred: boolean;
  readonly notificationPreference: ConversationNotificationPreference;
  readonly mute: ConversationMuteState;
  readonly updatedAt: IsoTimestamp;
}

type ReadCursor = Pick<ConversationReadState, "lastReadSequence">;
type ReadStateForUnread = Pick<
  ConversationReadState,
  "lastReadSequence" | "manualUnreadFromSequence"
>;
type SequencedMessage = Pick<Message, "sequence">;

function requireSequence(
  sequence: MessageSequence,
  label: string,
): number {
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }

  return sequence;
}

/**
 * Derives unread count from conversation-local sequences, without receipt rows.
 * Cursors ahead of the latest known sequence are clamped to zero unread.
 * A manual marker makes the marker and every later sequence unread, even when
 * those messages are at or below `lastReadSequence`.
 */
export function deriveUnreadCount(
  latestSequence: MessageSequence,
  readState: ReadStateForUnread,
): number {
  const latest = requireSequence(latestSequence, "latestSequence");
  const lastRead = requireSequence(
    readState.lastReadSequence,
    "lastReadSequence",
  );
  const marker = readState.manualUnreadFromSequence;

  if (marker === undefined) {
    return Math.max(0, latest - lastRead);
  }

  const manualUnreadFrom = requireSequence(
    marker,
    "manualUnreadFromSequence",
  );
  if (manualUnreadFrom === 0) {
    throw new RangeError("manualUnreadFromSequence must be at least one");
  }

  const effectiveReadSequence = Math.min(lastRead, manualUnreadFrom - 1);
  return Math.max(0, latest - effectiveReadSequence);
}

/** DM receipts are derived solely from the recipient's conversation cursor. */
export function hasDirectMessageRecipientRead(
  recipient: ReadCursor,
  message: SequencedMessage,
): boolean {
  const recipientCursor = requireSequence(
    recipient.lastReadSequence,
    "recipient.lastReadSequence",
  );
  const messageSequence = requireSequence(message.sequence, "message.sequence");

  return recipientCursor >= messageSequence;
}

/** Returns whether a proposed mark-read cursor preserves monotonic ordering. */
export function isMonotonicMarkRead(
  currentSequence: MessageSequence,
  proposedSequence: MessageSequence,
): boolean {
  const current = requireSequence(currentSequence, "currentSequence");
  const proposed = requireSequence(proposedSequence, "proposedSequence");

  return proposed >= current;
}

/**
 * Applies a monotonic mark-read update and clears any explicit unread marker.
 * Equal cursor updates are allowed so callers can clear a manual marker without
 * allocating or pretending to read a new message sequence.
 */
export function markRead(
  readState: ConversationReadState,
  throughSequence: MessageSequence,
  updatedAt: IsoTimestamp,
): ConversationReadState {
  if (!isMonotonicMarkRead(readState.lastReadSequence, throughSequence)) {
    throw new RangeError("mark-read cursor cannot move backward");
  }

  const { manualUnreadFromSequence: _manualUnread, ...state } = readState;
  return {
    ...state,
    lastReadSequence: throughSequence,
    updatedAt,
  };
}

/**
 * Marks an already-read sequence and everything after it unread while retaining
 * the monotonic read cursor. The marker must identify an existing read range.
 */
export function markUnread(
  readState: ConversationReadState,
  fromSequence: MessageSequence,
  updatedAt: IsoTimestamp,
): ConversationReadState {
  const from = requireSequence(fromSequence, "fromSequence");
  const lastRead = requireSequence(
    readState.lastReadSequence,
    "lastReadSequence",
  );

  if (from === 0 || from > lastRead) {
    throw new RangeError(
      "mark-unread sequence must be between one and lastReadSequence",
    );
  }

  return {
    ...readState,
    lastReadSequence: readState.lastReadSequence,
    manualUnreadFromSequence: fromSequence,
    updatedAt,
  };
}
