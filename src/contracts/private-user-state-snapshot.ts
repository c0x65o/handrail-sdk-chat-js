import type {
  ConversationId,
  IsoTimestamp,
  MessageId,
  MessageSequence,
} from "./identifiers.js";
import type {
  MessageAuthorIdentity,
  MessageBlock,
  MessageContent,
  MessageMention,
  MessageReplyReference,
  MessageRevisionMetadata,
} from "./message.js";
import type { MessageAttachmentMetadata } from "./message-timeline.js";
import {
  DraftMutationParseError,
  MAX_DRAFT_ATTACHMENT_REFERENCES,
  MAX_DRAFT_IDENTIFIER_UTF8_BYTES,
  MAX_DRAFT_MENTION_REFERENCES,
  MAX_DRAFT_TEXT_UTF8_BYTES,
  parseDraftReplyReference,
  type DraftContent,
} from "./draft-mutation.js";
import {
  MAX_SAVED_MESSAGE_IDENTIFIER_UTF8_BYTES,
  MAX_SAVED_MESSAGE_PRIVATE_NOTE_UTF8_BYTES,
} from "./saved-message-mutation.js";
import {
  MAX_MESSAGE_REMINDER_IDENTIFIER_UTF8_BYTES,
  type CanonicalScheduledMessageReminder,
  type CanonicalCancelledMessageReminder,
} from "./generated/message-reminder.js";

export const PRIVATE_USER_STATE_SNAPSHOT_VERSION = 1 as const;
export const ACTOR_PRIVATE_USER_STATE_PRIVACY = "actor_private" as const;
export const MAX_SAVED_MESSAGE_SNAPSHOT_PAGE_LIMIT = 100;
export const MAX_MESSAGE_REMINDER_SNAPSHOT_PAGE_LIMIT = 100;

const SAVED_MESSAGE_CURSOR_PREFIX = "handrail-saved-messages.v";
const MESSAGE_REMINDER_CURSOR_PREFIX = "handrail-message-reminders.v";
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const TRUSTED_REQUEST_FIELDS = new Set([
  "tenant",
  "tenantid",
  "organization",
  "organizationid",
  "actor",
  "actorid",
  "actorcontext",
  "actorrole",
  "actorroles",
  "actoruserid",
  "currentactor",
  "currentactorid",
  "currentuser",
  "currentuserid",
  "user",
  "userid",
  "otheruser",
  "otheruserid",
  "arbitraryuser",
  "arbitraryuserid",
  "targetuser",
  "targetuserid",
  "principal",
  "principalid",
  "subject",
  "subjectid",
  "authenticateduser",
  "authenticateduserid",
  "identity",
  "session",
  "sessionid",
  "auth",
  "authentication",
  "authorization",
  "role",
  "roles",
  "capability",
  "capabilities",
  "permission",
  "permissions",
]);

/** Compile-time guard: tenant, actor, and authorization come from the host session. */
export interface NoTrustedPrivateUserStateSnapshotContext {
  readonly tenant?: never;
  readonly tenantId?: never;
  readonly organization?: never;
  readonly organizationId?: never;
  readonly actor?: never;
  readonly actorId?: never;
  readonly actorContext?: never;
  readonly actorRole?: never;
  readonly actorRoles?: never;
  readonly actorUserId?: never;
  readonly currentActor?: never;
  readonly currentActorId?: never;
  readonly currentUser?: never;
  readonly currentUserId?: never;
  readonly user?: never;
  readonly userId?: never;
  readonly otherUser?: never;
  readonly otherUserId?: never;
  readonly arbitraryUser?: never;
  readonly arbitraryUserId?: never;
  readonly targetUser?: never;
  readonly targetUserId?: never;
  readonly principal?: never;
  readonly principalId?: never;
  readonly subject?: never;
  readonly subjectId?: never;
  readonly authenticatedUser?: never;
  readonly authenticatedUserId?: never;
  readonly identity?: never;
  readonly session?: never;
  readonly sessionId?: never;
  readonly auth?: never;
  readonly authentication?: never;
  readonly authorization?: never;
  readonly role?: never;
  readonly roles?: never;
  readonly capability?: never;
  readonly capabilities?: never;
  readonly permission?: never;
  readonly permissions?: never;
}

/** Requests only the trusted current user's draft for one conversation. */
export type ConversationDraftSnapshotInput =
  NoTrustedPrivateUserStateSnapshotContext & {
    readonly conversationId: ConversationId;
  };

export interface ActorPrivateDraftContent {
  /** Runtime privacy marker: this value must never enter a shared stream. */
  readonly privacy: typeof ACTOR_PRIVATE_USER_STATE_PRIVACY;
  readonly value: DraftContent;
}

interface ConversationDraftSnapshotBase {
  readonly kind: "conversation_draft";
  readonly privacy: typeof ACTOR_PRIVATE_USER_STATE_PRIVACY;
  readonly conversationId: ConversationId;
}

export interface PresentConversationDraftSnapshot
  extends ConversationDraftSnapshotBase {
  readonly state: "present";
  readonly canonicalRevision: number;
  readonly canonicalUpdatedAt: IsoTimestamp;
  readonly content: ActorPrivateDraftContent;
}

export interface AbsentConversationDraftSnapshot
  extends ConversationDraftSnapshotBase {
  readonly state: "absent";
  /** Zero/null means no canonical draft row has ever existed. */
  readonly canonicalRevision: number;
  readonly canonicalUpdatedAt: IsoTimestamp | null;
  readonly content: null;
}

export type ConversationDraftSnapshot =
  | PresentConversationDraftSnapshot
  | AbsentConversationDraftSnapshot;

declare const savedMessageSnapshotCursorBrand: unique symbol;

/** Opaque, versioned continuation token for the current actor's saved list. */
export type SavedMessageSnapshotCursor = string & {
  readonly [savedMessageSnapshotCursorBrand]: "saved-message-snapshot-cursor";
};

/** Stable descending keyset position with a message-ID tie-breaker. */
export interface SavedMessageSnapshotCursorPosition {
  readonly savedAt: IsoTimestamp;
  readonly messageId: MessageId;
}

/** Lists only the trusted current user's saved messages. */
export type SavedMessageListSnapshotInput =
  NoTrustedPrivateUserStateSnapshotContext & {
    readonly cursor?: SavedMessageSnapshotCursor;
    readonly limit: number;
  };

export interface ActorPrivateSavedMessageNote {
  /** Runtime privacy marker: this note must never enter message/public streams. */
  readonly privacy: typeof ACTOR_PRIVATE_USER_STATE_PRIVACY;
  readonly text: string;
}

/** A renderer-safe projection of a message that is still visible to the actor. */
export interface SavedMessageCurrentProjection<
  Block extends MessageBlock = MessageBlock,
> {
  readonly id: MessageId;
  readonly conversationId: ConversationId;
  readonly author: MessageAuthorIdentity;
  readonly sequence: MessageSequence;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly revision: MessageRevisionMetadata;
  readonly content: MessageContent<Block>;
  /** Identity only; the source inherits this message's conversation. */
  readonly replyTo?: MessageReplyReference;
  /** Follows content attachment-reference order exactly. */
  readonly attachmentMetadata: readonly MessageAttachmentMetadata[];
}

export interface AvailableSavedMessageProjection<
  Block extends MessageBlock = MessageBlock,
> {
  readonly availability: "available";
  readonly current: SavedMessageCurrentProjection<Block>;
}

/** Exact tombstone shape; it cannot retain content or identity metadata. */
export interface UnavailableSavedMessageProjection {
  readonly availability: "unavailable";
  readonly reason: "deleted" | "inaccessible";
}

export interface SavedMessageSnapshotEntry<
  Block extends MessageBlock = MessageBlock,
> {
  readonly messageId: MessageId;
  readonly savedMessageRevision: number;
  readonly savedAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly privateNote?: ActorPrivateSavedMessageNote;
  readonly message:
    | AvailableSavedMessageProjection<Block>
    | UnavailableSavedMessageProjection;
}

export interface SavedMessageListSnapshot<
  Block extends MessageBlock = MessageBlock,
> {
  readonly kind: "saved_message_list";
  readonly privacy: typeof ACTOR_PRIVATE_USER_STATE_PRIVACY;
  /** Strictly ordered by savedAt DESC, messageId DESC. */
  readonly items: readonly SavedMessageSnapshotEntry<Block>[];
  readonly page: {
    /** Null marks a terminal page. */
    readonly nextCursor: SavedMessageSnapshotCursor | null;
  };
}

declare const messageReminderSnapshotCursorBrand: unique symbol;

/** Opaque continuation token for the current actor's reminder recovery. */
export type MessageReminderSnapshotCursor = string & {
  readonly [messageReminderSnapshotCursorBrand]: "message-reminder-snapshot-cursor";
};

export interface MessageReminderSnapshotCursorPosition {
  readonly dueAt: IsoTimestamp;
  readonly messageId: MessageId;
}

/** Lists only the trusted current user's currently recoverable reminders. */
export type MessageReminderListSnapshotInput =
  NoTrustedPrivateUserStateSnapshotContext & {
    readonly cursor?: MessageReminderSnapshotCursor;
    /** Include cancelled authority for revision hydration. */
    readonly includeCancelled?: boolean;
    readonly limit: number;
  };

export interface MessageReminderSnapshotEntry {
  readonly conversationId: ConversationId;
  readonly messageId: MessageId;
  readonly reminderRevision: number;
  readonly reminder: CanonicalScheduledMessageReminder | CanonicalCancelledMessageReminder;
  /** Retained ordering key; required only for cancelled entries. */
  readonly lastScheduledDueAt?: IsoTimestamp;
}

export interface MessageReminderListSnapshot {
  readonly kind: "message_reminder_list";
  readonly privacy: typeof ACTOR_PRIVATE_USER_STATE_PRIVACY;
  /** Strictly ordered by scheduled (or last scheduled) dueAt ASC, messageId ASC. */
  readonly items: readonly MessageReminderSnapshotEntry[];
  readonly page: {
    readonly nextCursor: MessageReminderSnapshotCursor | null;
  };
}

export type PrivateUserStateSnapshotParseErrorCode =
  | "malformed_input"
  | "trusted_identity_field"
  | "malformed_cursor"
  | "unsupported_cursor"
  | "malformed_snapshot"
  | "incoherent_snapshot"
  | "unsafe_private_data";

export class PrivateUserStateSnapshotParseError extends Error {
  readonly code: PrivateUserStateSnapshotParseErrorCode;

  constructor(code: PrivateUserStateSnapshotParseErrorCode, message: string) {
    super(message);
    this.name = "PrivateUserStateSnapshotParseError";
    this.code = code;
  }
}

export function parseConversationDraftSnapshotInput(
  value: unknown,
): ConversationDraftSnapshotInput {
  rejectTrustedRequestFields(value);
  const input = requireRecord(value, "input", "malformed_input");
  assertExactKeys(input, ["conversationId"], "input", "malformed_input");
  return {
    conversationId: readIdentifier(
      input.conversationId,
      "input.conversationId",
      MAX_DRAFT_IDENTIFIER_UTF8_BYTES,
      "malformed_input",
    ) as ConversationId,
  };
}

export function parseConversationDraftSnapshot(
  value: unknown,
  expectedInput: ConversationDraftSnapshotInput,
): ConversationDraftSnapshot {
  const request = parseConversationDraftSnapshotInput(expectedInput);
  const snapshot = requireRecord(value, "snapshot", "malformed_snapshot");
  assertExactKeys(
    snapshot,
    [
      "kind",
      "privacy",
      "conversationId",
      "state",
      "canonicalRevision",
      "canonicalUpdatedAt",
      "content",
    ],
    "snapshot",
    "malformed_snapshot",
  );
  if (snapshot.kind !== "conversation_draft") {
    throw snapshotError("snapshot.kind must be conversation_draft");
  }
  assertActorPrivate(snapshot.privacy, "snapshot.privacy");
  const conversationId = readIdentifier(
    snapshot.conversationId,
    "snapshot.conversationId",
    MAX_DRAFT_IDENTIFIER_UTF8_BYTES,
    "malformed_snapshot",
  ) as ConversationId;
  if (conversationId !== request.conversationId) {
    throw privateStateError(
      "incoherent_snapshot",
      "snapshot.conversationId must match the requested conversationId",
    );
  }

  const canonicalRevision = readNonNegativeRevision(
    snapshot.canonicalRevision,
    "snapshot.canonicalRevision",
  );
  if (snapshot.state === "present") {
    if (canonicalRevision < 1) {
      throw privateStateError(
        "incoherent_snapshot",
        "a present draft must have a positive canonical revision",
      );
    }
    const canonicalUpdatedAt = readTimestamp(
      snapshot.canonicalUpdatedAt,
      "snapshot.canonicalUpdatedAt",
    );
    const content = parseActorPrivateDraftContent(snapshot.content);
    return {
      kind: "conversation_draft",
      privacy: ACTOR_PRIVATE_USER_STATE_PRIVACY,
      conversationId,
      state: "present",
      canonicalRevision,
      canonicalUpdatedAt,
      content,
    };
  }

  if (snapshot.state !== "absent" || snapshot.content !== null) {
    throw snapshotError(
      "snapshot.state must be present or absent, and absent content must be null",
    );
  }
  const canonicalUpdatedAt =
    snapshot.canonicalUpdatedAt === null
      ? null
      : readTimestamp(
          snapshot.canonicalUpdatedAt,
          "snapshot.canonicalUpdatedAt",
        );
  if (
    (canonicalRevision === 0 && canonicalUpdatedAt !== null) ||
    (canonicalRevision > 0 && canonicalUpdatedAt === null)
  ) {
    throw privateStateError(
      "incoherent_snapshot",
      "an absent draft uses revision zero with null timestamp only when no canonical row exists",
    );
  }
  return {
    kind: "conversation_draft",
    privacy: ACTOR_PRIVATE_USER_STATE_PRIVACY,
    conversationId,
    state: "absent",
    canonicalRevision,
    canonicalUpdatedAt,
    content: null,
  };
}

/** Browser-safe deterministic encoding; no Node Buffer dependency is used. */
export function encodeSavedMessageSnapshotCursor(
  position: SavedMessageSnapshotCursorPosition,
): SavedMessageSnapshotCursor {
  const savedAt = readTimestamp(position.savedAt, "position.savedAt");
  const messageId = readIdentifier(
    position.messageId,
    "position.messageId",
    MAX_MESSAGE_REMINDER_IDENTIFIER_UTF8_BYTES,
    "malformed_cursor",
  );
  const payload = encodeURIComponent(JSON.stringify([savedAt, messageId]));
  return `${SAVED_MESSAGE_CURSOR_PREFIX}${PRIVATE_USER_STATE_SNAPSHOT_VERSION}.${payload}` as SavedMessageSnapshotCursor;
}

export function decodeSavedMessageSnapshotCursor(
  cursor: string,
): SavedMessageSnapshotCursorPosition {
  if (typeof cursor !== "string" || cursor.length === 0) {
    throw cursorError("malformed_cursor", "cursor must be a non-empty string");
  }
  const match = /^handrail-saved-messages\.v(\d+)\.(.+)$/.exec(cursor);
  if (match === null) {
    throw cursorError("malformed_cursor", "cursor has an invalid envelope");
  }
  const version = Number(match[1]);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw cursorError("malformed_cursor", "cursor version is invalid");
  }
  if (version !== PRIVATE_USER_STATE_SNAPSHOT_VERSION) {
    throw cursorError(
      "unsupported_cursor",
      `cursor version ${version} is unsupported`,
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(decodeURIComponent(match[2] as string));
  } catch {
    throw cursorError("malformed_cursor", "cursor payload is malformed");
  }
  if (!Array.isArray(payload) || payload.length !== 2) {
    throw cursorError("malformed_cursor", "cursor payload has an invalid structure");
  }
  return {
    savedAt: readTimestamp(payload[0], "cursor.savedAt", "malformed_cursor"),
    messageId: readIdentifier(
      payload[1],
      "cursor.messageId",
      MAX_MESSAGE_REMINDER_IDENTIFIER_UTF8_BYTES,
      "malformed_cursor",
    ) as MessageId,
  };
}

/** Browser-safe deterministic cursor for reminder recovery pages. */
export function encodeMessageReminderSnapshotCursor(
  position: MessageReminderSnapshotCursorPosition,
): MessageReminderSnapshotCursor {
  const dueAt = readTimestamp(position.dueAt, "position.dueAt");
  const messageId = readIdentifier(
    position.messageId,
    "position.messageId",
    MAX_SAVED_MESSAGE_IDENTIFIER_UTF8_BYTES,
    "malformed_cursor",
  );
  const payload = encodeURIComponent(JSON.stringify([dueAt, messageId]));
  return `${MESSAGE_REMINDER_CURSOR_PREFIX}${PRIVATE_USER_STATE_SNAPSHOT_VERSION}.${payload}` as MessageReminderSnapshotCursor;
}

export function decodeMessageReminderSnapshotCursor(
  cursor: string,
): MessageReminderSnapshotCursorPosition {
  if (typeof cursor !== "string" || cursor.length === 0) {
    throw cursorError("malformed_cursor", "cursor must be a non-empty string");
  }
  const match = /^handrail-message-reminders\.v(\d+)\.(.+)$/.exec(cursor);
  if (match === null) {
    throw cursorError("malformed_cursor", "cursor has an invalid envelope");
  }
  const version = Number(match[1]);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw cursorError("malformed_cursor", "cursor version is invalid");
  }
  if (version !== PRIVATE_USER_STATE_SNAPSHOT_VERSION) {
    throw cursorError(
      "unsupported_cursor",
      `cursor version ${version} is unsupported`,
    );
  }
  let payload: unknown;
  try {
    payload = JSON.parse(decodeURIComponent(match[2] as string));
  } catch {
    throw cursorError("malformed_cursor", "cursor payload is malformed");
  }
  if (!Array.isArray(payload) || payload.length !== 2) {
    throw cursorError("malformed_cursor", "cursor payload has an invalid structure");
  }
  return {
    dueAt: readTimestamp(payload[0], "cursor.dueAt", "malformed_cursor"),
    messageId: readIdentifier(
      payload[1],
      "cursor.messageId",
      MAX_SAVED_MESSAGE_IDENTIFIER_UTF8_BYTES,
      "malformed_cursor",
    ) as MessageId,
  };
}

export function parseSavedMessageListSnapshotInput(
  value: unknown,
): SavedMessageListSnapshotInput {
  rejectTrustedRequestFields(value);
  const input = requireRecord(value, "input", "malformed_input");
  assertAllowedAndRequiredKeys(
    input,
    ["cursor", "limit"],
    ["limit"],
    "input",
    "malformed_input",
  );
  if (
    !Number.isSafeInteger(input.limit) ||
    (input.limit as number) < 1 ||
    (input.limit as number) > MAX_SAVED_MESSAGE_SNAPSHOT_PAGE_LIMIT
  ) {
    throw inputError(
      `input.limit must be a safe integer between 1 and ${MAX_SAVED_MESSAGE_SNAPSHOT_PAGE_LIMIT}`,
    );
  }
  if (input.cursor === undefined) {
    return { limit: input.limit as number };
  }
  if (typeof input.cursor !== "string") {
    throw inputError("input.cursor must be a string");
  }
  decodeSavedMessageSnapshotCursor(input.cursor);
  return {
    cursor: input.cursor as SavedMessageSnapshotCursor,
    limit: input.limit as number,
  };
}

export function parseSavedMessageListSnapshot<
  Block extends MessageBlock = MessageBlock,
>(
  value: unknown,
  expectedInput: SavedMessageListSnapshotInput,
): SavedMessageListSnapshot<Block> {
  const request = parseSavedMessageListSnapshotInput(expectedInput);
  const snapshot = requireRecord(value, "snapshot", "malformed_snapshot");
  assertExactKeys(
    snapshot,
    ["kind", "privacy", "items", "page"],
    "snapshot",
    "malformed_snapshot",
  );
  if (snapshot.kind !== "saved_message_list") {
    throw snapshotError("snapshot.kind must be saved_message_list");
  }
  assertActorPrivate(snapshot.privacy, "snapshot.privacy");
  if (!Array.isArray(snapshot.items)) {
    throw snapshotError("snapshot.items must be an array");
  }
  if (snapshot.items.length > request.limit) {
    throw privateStateError(
      "incoherent_snapshot",
      "snapshot.items cannot exceed the requested limit",
    );
  }

  const items = snapshot.items.map((entry, index) =>
    parseSavedMessageEntry<Block>(entry, index),
  );
  const seenMessageIds = new Set<string>();
  let previousPosition = request.cursor
    ? decodeSavedMessageSnapshotCursor(request.cursor)
    : undefined;
  for (const item of items) {
    if (seenMessageIds.has(item.messageId)) {
      throw privateStateError(
        "incoherent_snapshot",
        "snapshot.items cannot repeat a messageId",
      );
    }
    seenMessageIds.add(item.messageId);
    const position = { savedAt: item.savedAt, messageId: item.messageId };
    if (
      previousPosition !== undefined &&
      compareSavedMessagePositions(position, previousPosition) >= 0
    ) {
      throw privateStateError(
        "incoherent_snapshot",
        "snapshot.items must be strictly ordered after the cursor by savedAt DESC, messageId DESC",
      );
    }
    previousPosition = position;
  }

  const page = requireRecord(snapshot.page, "snapshot.page", "malformed_snapshot");
  assertExactKeys(page, ["nextCursor"], "snapshot.page", "malformed_snapshot");
  let nextCursor: SavedMessageSnapshotCursor | null;
  if (page.nextCursor === null) {
    nextCursor = null;
  } else {
    if (typeof page.nextCursor !== "string") {
      throw snapshotError("snapshot.page.nextCursor must be a string or null");
    }
    const nextPosition = decodeSavedMessageSnapshotCursor(page.nextCursor);
    const last = items.at(-1);
    if (
      last === undefined ||
      nextPosition.savedAt !== last.savedAt ||
      nextPosition.messageId !== last.messageId
    ) {
      throw privateStateError(
        "incoherent_snapshot",
        "snapshot.page.nextCursor must encode the final returned item",
      );
    }
    nextCursor = page.nextCursor as SavedMessageSnapshotCursor;
  }

  return {
    kind: "saved_message_list",
    privacy: ACTOR_PRIVATE_USER_STATE_PRIVACY,
    items,
    page: { nextCursor },
  };
}

export function parseMessageReminderListSnapshotInput(
  value: unknown,
): MessageReminderListSnapshotInput {
  rejectTrustedRequestFields(value);
  const input = requireRecord(value, "input", "malformed_input");
  assertAllowedAndRequiredKeys(
    input,
    ["cursor", "limit", "includeCancelled"],
    ["limit"],
    "input",
    "malformed_input",
  );
  if (
    !Number.isSafeInteger(input.limit) ||
    (input.limit as number) < 1 ||
    (input.limit as number) > MAX_MESSAGE_REMINDER_SNAPSHOT_PAGE_LIMIT
  ) {
    throw inputError(
      `input.limit must be a safe integer between 1 and ${MAX_MESSAGE_REMINDER_SNAPSHOT_PAGE_LIMIT}`,
    );
  }
  if (input.includeCancelled !== undefined && typeof input.includeCancelled !== "boolean") {
    throw inputError("input.includeCancelled must be a boolean");
  }
  const inclusion = input.includeCancelled === undefined
    ? {}
    : { includeCancelled: input.includeCancelled };
  if (input.cursor === undefined) return { limit: input.limit as number, ...inclusion };
  if (typeof input.cursor !== "string") {
    throw inputError("input.cursor must be a string");
  }
  decodeMessageReminderSnapshotCursor(input.cursor);
  return {
    ...inclusion,
    cursor: input.cursor as MessageReminderSnapshotCursor,
    limit: input.limit as number,
  };
}

export function parseMessageReminderListSnapshot(
  value: unknown,
  expectedInput: MessageReminderListSnapshotInput,
): MessageReminderListSnapshot {
  const request = parseMessageReminderListSnapshotInput(expectedInput);
  const snapshot = requireRecord(value, "snapshot", "malformed_snapshot");
  assertExactKeys(
    snapshot,
    ["kind", "privacy", "items", "page"],
    "snapshot",
    "malformed_snapshot",
  );
  if (snapshot.kind !== "message_reminder_list") {
    throw snapshotError("snapshot.kind must be message_reminder_list");
  }
  assertActorPrivate(snapshot.privacy, "snapshot.privacy");
  if (!Array.isArray(snapshot.items)) {
    throw snapshotError("snapshot.items must be an array");
  }
  if (snapshot.items.length > request.limit) {
    throw privateStateError(
      "incoherent_snapshot",
      "snapshot.items cannot exceed the requested limit",
    );
  }

  const items: MessageReminderSnapshotEntry[] = snapshot.items.map((candidate, index) => {
    const path = `snapshot.items[${index}]`;
    const entry = requireRecord(candidate, path, "malformed_snapshot");
    const cancelled = isRecord(entry.reminder) && entry.reminder.state === "cancelled";
    assertExactKeys(
      entry,
      [
        "conversationId", "messageId", "reminderRevision", "reminder",
        ...(cancelled ? ["lastScheduledDueAt"] : []),
      ],
      path,
      "malformed_snapshot",
    );
    const reminder = requireRecord(
      entry.reminder,
      `${path}.reminder`,
      "malformed_snapshot",
    );
    assertExactKeys(
      reminder,
      cancelled ? ["privacy", "state"] : ["privacy", "state", "dueAt"],
      `${path}.reminder`,
      "malformed_snapshot",
    );
    if (
      reminder.privacy !== "affected_authenticated_actor" ||
      (reminder.state !== "scheduled" && !(cancelled && request.includeCancelled === true))
    ) {
      throw snapshotError(
        `${path}.reminder must be scheduled, or cancelled when requested`,
      );
    }
    return {
      conversationId: readIdentifier(
        entry.conversationId,
        `${path}.conversationId`,
        MAX_MESSAGE_REMINDER_IDENTIFIER_UTF8_BYTES,
        "malformed_snapshot",
      ) as ConversationId,
      messageId: readIdentifier(
        entry.messageId,
        `${path}.messageId`,
        MAX_MESSAGE_REMINDER_IDENTIFIER_UTF8_BYTES,
        "malformed_snapshot",
      ) as MessageId,
      reminderRevision: readPositiveRevision(
        entry.reminderRevision,
        `${path}.reminderRevision`,
      ),
      ...(cancelled ? {
        lastScheduledDueAt: readTimestamp(entry.lastScheduledDueAt, `${path}.lastScheduledDueAt`),
        reminder: { privacy: "affected_authenticated_actor" as const, state: "cancelled" as const },
      } : {
        reminder: {
          privacy: "affected_authenticated_actor" as const,
          state: "scheduled" as const,
          dueAt: readTimestamp(reminder.dueAt, `${path}.reminder.dueAt`),
        },
      }),
    };
  });

  const seenMessageIds = new Set<string>();
  let previousPosition = request.cursor
    ? decodeMessageReminderSnapshotCursor(request.cursor)
    : undefined;
  for (const item of items) {
    if (seenMessageIds.has(item.messageId)) {
      throw privateStateError(
        "incoherent_snapshot",
        "snapshot.items cannot repeat a messageId",
      );
    }
    seenMessageIds.add(item.messageId);
    const position = {
      dueAt: messageReminderSnapshotDueAt(item),
      messageId: item.messageId,
    };
    if (
      previousPosition !== undefined &&
      compareMessageReminderPositions(position, previousPosition) <= 0
    ) {
      throw privateStateError(
        "incoherent_snapshot",
        "snapshot.items must be strictly ordered after the cursor by dueAt ASC, messageId ASC",
      );
    }
    previousPosition = position;
  }

  const page = requireRecord(snapshot.page, "snapshot.page", "malformed_snapshot");
  assertExactKeys(page, ["nextCursor"], "snapshot.page", "malformed_snapshot");
  let nextCursor: MessageReminderSnapshotCursor | null;
  if (page.nextCursor === null) {
    nextCursor = null;
  } else {
    if (typeof page.nextCursor !== "string") {
      throw snapshotError("snapshot.page.nextCursor must be a string or null");
    }
    const nextPosition = decodeMessageReminderSnapshotCursor(page.nextCursor);
    const last = items.at(-1);
    if (
      last === undefined ||
      nextPosition.dueAt !== messageReminderSnapshotDueAt(last) ||
      nextPosition.messageId !== last.messageId
    ) {
      throw privateStateError(
        "incoherent_snapshot",
        "snapshot.page.nextCursor must encode the final returned item",
      );
    }
    nextCursor = page.nextCursor as MessageReminderSnapshotCursor;
  }
  return {
    kind: "message_reminder_list",
    privacy: ACTOR_PRIVATE_USER_STATE_PRIVACY,
    items,
    page: { nextCursor },
  };
}

function parseActorPrivateDraftContent(value: unknown): ActorPrivateDraftContent {
  const wrapper = requireRecord(
    value,
    "snapshot.content",
    "malformed_snapshot",
  );
  assertExactKeys(
    wrapper,
    ["privacy", "value"],
    "snapshot.content",
    "malformed_snapshot",
  );
  assertActorPrivate(wrapper.privacy, "snapshot.content.privacy");
  return {
    privacy: ACTOR_PRIVATE_USER_STATE_PRIVACY,
    value: parseDraftContent(wrapper.value, "snapshot.content.value"),
  };
}

function parseDraftContent(value: unknown, path: string): DraftContent {
  const content = requireRecord(value, path, "malformed_snapshot");
  assertAllowedAndRequiredKeys(
    content,
    ["format", "text", "mentions", "attachments", "replyTo"],
    ["format", "text", "attachments"],
    path,
    "malformed_snapshot",
  );
  if (content.format !== "plain" && content.format !== "markdown") {
    throw snapshotError(`${path}.format must be plain or markdown`);
  }
  const text = readSafeString(content.text, `${path}.text`, {
    allowBlank: true,
    maxBytes: MAX_DRAFT_TEXT_UTF8_BYTES,
  });
  const mentions = content.mentions === undefined
    ? undefined
    : parseDraftMentions(content.mentions, `${path}.mentions`);
  if (!Array.isArray(content.attachments)) {
    throw snapshotError(`${path}.attachments must be an array`);
  }
  if (content.attachments.length > MAX_DRAFT_ATTACHMENT_REFERENCES) {
    throw snapshotError(
      `${path}.attachments cannot exceed ${MAX_DRAFT_ATTACHMENT_REFERENCES} references`,
    );
  }
  const seen = new Set<string>();
  const attachments = content.attachments.map((candidate, index) => {
    const referencePath = `${path}.attachments[${index}]`;
    const reference = requireRecord(
      candidate,
      referencePath,
      "malformed_snapshot",
    );
    assertExactKeys(
      reference,
      ["attachmentId"],
      referencePath,
      "malformed_snapshot",
    );
    const attachmentId = readIdentifier(
      reference.attachmentId,
      `${referencePath}.attachmentId`,
      MAX_DRAFT_IDENTIFIER_UTF8_BYTES,
      "malformed_snapshot",
    );
    if (seen.has(attachmentId)) {
      throw snapshotError(`${path}.attachments cannot contain duplicates`);
    }
    seen.add(attachmentId);
    return { attachmentId: attachmentId as never };
  });
  let replyTo: DraftContent["replyTo"];
  if (Object.hasOwn(content, "replyTo")) {
    try {
      replyTo = parseDraftReplyReference(
        content.replyTo,
        `${path}.replyTo`,
        "malformed_content",
      );
    } catch (error) {
      if (error instanceof DraftMutationParseError) {
        throw snapshotError(error.message);
      }
      throw error;
    }
  }
  return {
    format: content.format,
    text,
    ...(replyTo === undefined ? {} : { replyTo }),
    ...(mentions === undefined ? {} : { mentions }),
    attachments,
  };
}

function parseDraftMentions(
  value: unknown,
  path: string,
): readonly MessageMention[] {
  if (!Array.isArray(value)) throw snapshotError(`${path} must be an array`);
  if (value.length > MAX_DRAFT_MENTION_REFERENCES) {
    throw snapshotError(
      `${path} cannot exceed ${MAX_DRAFT_MENTION_REFERENCES} references`,
    );
  }
  const seen = new Set<string>();
  return value.map((candidate, index) => {
    const mentionPath = `${path}[${index}]`;
    const mention = requireRecord(candidate, mentionPath, "malformed_snapshot");
    let parsed: MessageMention;
    if (mention.type === "user") {
      assertExactKeys(mention, ["type", "userId"], mentionPath, "malformed_snapshot");
      parsed = {
        type: "user",
        userId: readIdentifier(
          mention.userId,
          `${mentionPath}.userId`,
          MAX_DRAFT_IDENTIFIER_UTF8_BYTES,
          "malformed_snapshot",
        ) as never,
      };
    } else if (mention.type === "conversation") {
      assertExactKeys(
        mention,
        ["type", "conversationId"],
        mentionPath,
        "malformed_snapshot",
      );
      parsed = {
        type: "conversation",
        conversationId: readIdentifier(
          mention.conversationId,
          `${mentionPath}.conversationId`,
          MAX_DRAFT_IDENTIFIER_UTF8_BYTES,
          "malformed_snapshot",
        ) as ConversationId,
      };
    } else if (mention.type === "entity") {
      assertExactKeys(mention, ["type", "entity"], mentionPath, "malformed_snapshot");
      const entity = requireRecord(
        mention.entity,
        `${mentionPath}.entity`,
        "malformed_snapshot",
      );
      assertExactKeys(
        entity,
        ["type", "id"],
        `${mentionPath}.entity`,
        "malformed_snapshot",
      );
      parsed = {
        type: "entity",
        entity: {
          type: readIdentifier(
            entity.type,
            `${mentionPath}.entity.type`,
            MAX_DRAFT_IDENTIFIER_UTF8_BYTES,
            "malformed_snapshot",
          ),
          id: readIdentifier(
            entity.id,
            `${mentionPath}.entity.id`,
            MAX_DRAFT_IDENTIFIER_UTF8_BYTES,
            "malformed_snapshot",
          ),
        },
      };
    } else {
      throw snapshotError(`${mentionPath}.type is unsupported`);
    }
    const identity = draftMentionIdentity(parsed);
    if (seen.has(identity)) {
      throw snapshotError(`${path} cannot contain duplicates`);
    }
    seen.add(identity);
    return parsed;
  });
}

function draftMentionIdentity(mention: MessageMention): string {
  switch (mention.type) {
    case "user":
      return `user:${mention.userId}`;
    case "conversation":
      return `conversation:${mention.conversationId}`;
    case "entity":
      return `entity:${mention.entity.type}\u0000${mention.entity.id}`;
  }
}

function parseSavedMessageEntry<Block extends MessageBlock>(
  value: unknown,
  index: number,
): SavedMessageSnapshotEntry<Block> {
  const path = `snapshot.items[${index}]`;
  const entry = requireRecord(value, path, "malformed_snapshot");
  assertAllowedAndRequiredKeys(
    entry,
    [
      "messageId",
      "savedMessageRevision",
      "savedAt",
      "updatedAt",
      "privateNote",
      "message",
    ],
    ["messageId", "savedMessageRevision", "savedAt", "updatedAt", "message"],
    path,
    "malformed_snapshot",
  );
  const messageId = readIdentifier(
    entry.messageId,
    `${path}.messageId`,
    MAX_SAVED_MESSAGE_IDENTIFIER_UTF8_BYTES,
    "malformed_snapshot",
  ) as MessageId;
  const savedMessageRevision = readPositiveRevision(
    entry.savedMessageRevision,
    `${path}.savedMessageRevision`,
  );
  const savedAt = readTimestamp(entry.savedAt, `${path}.savedAt`);
  const updatedAt = readTimestamp(entry.updatedAt, `${path}.updatedAt`);
  if (Date.parse(updatedAt) < Date.parse(savedAt)) {
    throw privateStateError(
      "incoherent_snapshot",
      `${path}.updatedAt cannot precede savedAt`,
    );
  }
  const privateNote =
    entry.privateNote === undefined
      ? undefined
      : parseActorPrivateNote(entry.privateNote, `${path}.privateNote`);
  const message = parseSavedMessageProjection<Block>(
    entry.message,
    messageId,
    `${path}.message`,
  );
  return {
    messageId,
    savedMessageRevision,
    savedAt,
    updatedAt,
    ...(privateNote === undefined ? {} : { privateNote }),
    message,
  };
}

function parseActorPrivateNote(
  value: unknown,
  path: string,
): ActorPrivateSavedMessageNote {
  const note = requireRecord(value, path, "malformed_snapshot");
  assertExactKeys(note, ["privacy", "text"], path, "malformed_snapshot");
  assertActorPrivate(note.privacy, `${path}.privacy`);
  const text = readSafeString(note.text, `${path}.text`, {
    allowBlank: false,
    maxBytes: MAX_SAVED_MESSAGE_PRIVATE_NOTE_UTF8_BYTES,
  });
  return { privacy: ACTOR_PRIVATE_USER_STATE_PRIVACY, text };
}

function parseSavedMessageProjection<Block extends MessageBlock>(
  value: unknown,
  expectedMessageId: MessageId,
  path: string,
): AvailableSavedMessageProjection<Block> | UnavailableSavedMessageProjection {
  const projection = requireRecord(value, path, "malformed_snapshot");
  if (projection.availability === "unavailable") {
    assertExactKeys(
      projection,
      ["availability", "reason"],
      path,
      "malformed_snapshot",
    );
    if (projection.reason !== "deleted" && projection.reason !== "inaccessible") {
      throw snapshotError(`${path}.reason must be deleted or inaccessible`);
    }
    return { availability: "unavailable", reason: projection.reason };
  }
  if (projection.availability !== "available") {
    throw snapshotError(`${path}.availability must be available or unavailable`);
  }
  assertExactKeys(
    projection,
    ["availability", "current"],
    path,
    "malformed_snapshot",
  );
  return {
    availability: "available",
    current: parseCurrentMessageProjection<Block>(
      projection.current,
      expectedMessageId,
      `${path}.current`,
    ),
  };
}

function parseCurrentMessageProjection<Block extends MessageBlock>(
  value: unknown,
  expectedMessageId: MessageId,
  path: string,
): SavedMessageCurrentProjection<Block> {
  const message = requireRecord(value, path, "malformed_snapshot");
  const requiredKeys = [
    "id", "conversationId", "author", "sequence", "createdAt", "updatedAt",
    "revision", "content", "attachmentMetadata",
  ];
  assertAllowedAndRequiredKeys(
    message,
    [...requiredKeys, "replyTo"],
    requiredKeys,
    path,
    "malformed_snapshot",
  );
  const id = readIdentifier(
    message.id,
    `${path}.id`,
    MAX_SAVED_MESSAGE_IDENTIFIER_UTF8_BYTES,
    "malformed_snapshot",
  ) as MessageId;
  if (id !== expectedMessageId) {
    throw privateStateError(
      "incoherent_snapshot",
      `${path}.id must match its saved entry messageId`,
    );
  }
  const content = parseMessageContent<Block>(message.content, `${path}.content`);
  const attachmentMetadata = parseAttachmentMetadata(
    message.attachmentMetadata,
    content,
    `${path}.attachmentMetadata`,
  );
  return {
    id,
    conversationId: readIdentifier(
      message.conversationId,
      `${path}.conversationId`,
      MAX_SAVED_MESSAGE_IDENTIFIER_UTF8_BYTES,
      "malformed_snapshot",
    ) as ConversationId,
    author: parseMessageAuthor(message.author, `${path}.author`),
    sequence: readNonNegativeRevision(message.sequence, `${path}.sequence`),
    createdAt: readTimestamp(message.createdAt, `${path}.createdAt`),
    updatedAt: readTimestamp(message.updatedAt, `${path}.updatedAt`),
    revision: parseMessageRevision(message.revision, `${path}.revision`),
    content,
    ...(Object.hasOwn(message, "replyTo")
      ? { replyTo: parseSavedMessageReplyReference(message.replyTo, `${path}.replyTo`) }
      : {}),
    attachmentMetadata,
  };
}

/** Matches the canonical message model, without draft-only normalization rules. */
function parseSavedMessageReplyReference(value: unknown, path: string): MessageReplyReference {
  const reference = requireRecord(value, path, "malformed_snapshot");
  assertExactKeys(reference, ["messageId", "notifyAuthor"], path, "malformed_snapshot");
  const messageId = reference.messageId;
  if (
    typeof messageId !== "string" ||
    messageId.length === 0 ||
    messageId.trim() !== messageId ||
    /[\x00-\x1f\x7f-\x9f\u2028\u2029]/u.test(messageId) ||
    new TextEncoder().encode(messageId).length > 255
  ) {
    throw snapshotError(`${path}.messageId must be a safe identifier of at most 255 UTF-8 bytes`);
  }
  if (typeof reference.notifyAuthor !== "boolean") {
    throw snapshotError(`${path}.notifyAuthor must be a boolean`);
  }
  return { messageId: messageId as MessageId, notifyAuthor: reference.notifyAuthor };
}

function parseMessageAuthor(value: unknown, path: string): MessageAuthorIdentity {
  const author = requireRecord(value, path, "malformed_snapshot");
  assertExactKeys(author, ["type", "userId"], path, "malformed_snapshot");
  if (author.type !== "user") {
    throw snapshotError(`${path}.type must be user`);
  }
  return {
    type: "user",
    userId: readIdentifier(
      author.userId,
      `${path}.userId`,
      MAX_SAVED_MESSAGE_IDENTIFIER_UTF8_BYTES,
      "malformed_snapshot",
    ) as never,
  };
}

function parseMessageRevision(
  value: unknown,
  path: string,
): MessageRevisionMetadata {
  const revision = requireRecord(value, path, "malformed_snapshot");
  assertAllowedAndRequiredKeys(
    revision,
    ["revision", "editedAt", "editedByUserId"],
    ["revision"],
    path,
    "malformed_snapshot",
  );
  return {
    revision: readPositiveRevision(revision.revision, `${path}.revision`),
    ...(revision.editedAt === undefined
      ? {}
      : { editedAt: readTimestamp(revision.editedAt, `${path}.editedAt`) }),
    ...(revision.editedByUserId === undefined
      ? {}
      : {
          editedByUserId: readIdentifier(
            revision.editedByUserId,
            `${path}.editedByUserId`,
            MAX_SAVED_MESSAGE_IDENTIFIER_UTF8_BYTES,
            "malformed_snapshot",
          ) as never,
        }),
  };
}

function parseMessageContent<Block extends MessageBlock>(
  value: unknown,
  path: string,
): MessageContent<Block> {
  const content = requireRecord(value, path, "malformed_snapshot");
  assertAllowedAndRequiredKeys(
    content,
    ["format", "text", "mentions", "attachments", "blocks"],
    ["format", "text"],
    path,
    "malformed_snapshot",
  );
  if (content.format !== "plain" && content.format !== "markdown") {
    throw snapshotError(`${path}.format must be plain or markdown`);
  }
  const parsed = {
    format: content.format,
    text: readSafeString(content.text, `${path}.text`, { allowBlank: true }),
    ...(content.mentions === undefined
      ? {}
      : { mentions: parseMentions(content.mentions, `${path}.mentions`) }),
    ...(content.attachments === undefined
      ? {}
      : {
          attachments: parseAttachmentReferences(
            content.attachments,
            `${path}.attachments`,
          ),
        }),
    ...(content.blocks === undefined
      ? {}
      : { blocks: parseMessageBlocks<Block>(content.blocks, `${path}.blocks`) }),
  };
  return parsed as MessageContent<Block>;
}

function parseMentions(value: unknown, path: string): readonly MessageMention[] {
  if (!Array.isArray(value)) throw snapshotError(`${path} must be an array`);
  return value.map((candidate, index) => {
    const mentionPath = `${path}[${index}]`;
    const mention = requireRecord(candidate, mentionPath, "malformed_snapshot");
    if (mention.type === "user") {
      assertExactKeys(mention, ["type", "userId"], mentionPath, "malformed_snapshot");
      return {
        type: "user",
        userId: readIdentifier(
          mention.userId,
          `${mentionPath}.userId`,
          MAX_SAVED_MESSAGE_IDENTIFIER_UTF8_BYTES,
          "malformed_snapshot",
        ) as never,
      };
    }
    if (mention.type === "conversation") {
      assertExactKeys(
        mention,
        ["type", "conversationId"],
        mentionPath,
        "malformed_snapshot",
      );
      return {
        type: "conversation",
        conversationId: readIdentifier(
          mention.conversationId,
          `${mentionPath}.conversationId`,
          MAX_SAVED_MESSAGE_IDENTIFIER_UTF8_BYTES,
          "malformed_snapshot",
        ) as ConversationId,
      };
    }
    if (mention.type === "entity") {
      assertExactKeys(mention, ["type", "entity"], mentionPath, "malformed_snapshot");
      const entity = requireRecord(
        mention.entity,
        `${mentionPath}.entity`,
        "malformed_snapshot",
      );
      assertExactKeys(entity, ["type", "id"], `${mentionPath}.entity`, "malformed_snapshot");
      return {
        type: "entity",
        entity: {
          type: readSafeString(entity.type, `${mentionPath}.entity.type`, {
            allowBlank: false,
          }),
          id: readSafeString(entity.id, `${mentionPath}.entity.id`, {
            allowBlank: false,
          }),
        },
      };
    }
    throw snapshotError(`${mentionPath}.type is unsupported`);
  });
}

function parseAttachmentReferences(
  value: unknown,
  path: string,
): readonly { readonly attachmentId: never }[] {
  if (!Array.isArray(value)) throw snapshotError(`${path} must be an array`);
  const seen = new Set<string>();
  return value.map((candidate, index) => {
    const referencePath = `${path}[${index}]`;
    const reference = requireRecord(candidate, referencePath, "malformed_snapshot");
    assertExactKeys(reference, ["attachmentId"], referencePath, "malformed_snapshot");
    const attachmentId = readIdentifier(
      reference.attachmentId,
      `${referencePath}.attachmentId`,
      MAX_SAVED_MESSAGE_IDENTIFIER_UTF8_BYTES,
      "malformed_snapshot",
    );
    if (seen.has(attachmentId)) {
      throw snapshotError(`${path} cannot contain duplicate attachment IDs`);
    }
    seen.add(attachmentId);
    return { attachmentId: attachmentId as never };
  });
}

function parseMessageBlocks<Block extends MessageBlock>(
  value: unknown,
  path: string,
): readonly Block[] {
  if (!Array.isArray(value)) throw snapshotError(`${path} must be an array`);
  return value.map((candidate, index) => {
    const blockPath = `${path}[${index}]`;
    const block = requireRecord(candidate, blockPath, "malformed_snapshot");
    assertExactKeys(block, ["type", "data"], blockPath, "malformed_snapshot");
    const type = readSafeString(block.type, `${blockPath}.type`, {
      allowBlank: false,
    });
    assertJsonSafe(block.data, `${blockPath}.data`, new Set());
    return { type, data: block.data } as Block;
  });
}

function parseAttachmentMetadata<Block extends MessageBlock>(
  value: unknown,
  content: MessageContent<Block>,
  path: string,
): readonly MessageAttachmentMetadata[] {
  if (!Array.isArray(value)) throw snapshotError(`${path} must be an array`);
  const references = content.attachments ?? [];
  if (references.length !== value.length) {
    throw privateStateError(
      "incoherent_snapshot",
      `${path} must match content attachment references`,
    );
  }
  return value.map((candidate, index) => {
    const metadataPath = `${path}[${index}]`;
    const metadata = requireRecord(candidate, metadataPath, "malformed_snapshot");
    assertAllowedAndRequiredKeys(
      metadata,
      [
        "attachmentId",
        "fileName",
        "contentType",
        "sizeBytes",
        "downloadUrl",
        "previewUrl",
        "width",
        "height",
        "altText",
      ],
      ["attachmentId", "fileName", "contentType", "sizeBytes", "downloadUrl"],
      metadataPath,
      "malformed_snapshot",
    );
    const attachmentId = readIdentifier(
      metadata.attachmentId,
      `${metadataPath}.attachmentId`,
      MAX_SAVED_MESSAGE_IDENTIFIER_UTF8_BYTES,
      "malformed_snapshot",
    ) as never;
    if (attachmentId !== references[index]?.attachmentId) {
      throw privateStateError(
        "incoherent_snapshot",
        `${metadataPath}.attachmentId must follow content reference order`,
      );
    }
    return {
      attachmentId,
      fileName: readSafeString(metadata.fileName, `${metadataPath}.fileName`, {
        allowBlank: false,
      }),
      contentType: readSafeString(
        metadata.contentType,
        `${metadataPath}.contentType`,
        { allowBlank: false },
      ),
      sizeBytes: readNonNegativeRevision(
        metadata.sizeBytes,
        `${metadataPath}.sizeBytes`,
      ),
      downloadUrl: readSafeString(
        metadata.downloadUrl,
        `${metadataPath}.downloadUrl`,
        { allowBlank: false },
      ),
      ...(metadata.previewUrl === undefined
        ? {}
        : {
            previewUrl: readSafeString(
              metadata.previewUrl,
              `${metadataPath}.previewUrl`,
              { allowBlank: false },
            ),
          }),
      ...(metadata.width === undefined
        ? {}
        : {
            width: readPositiveRevision(
              metadata.width,
              `${metadataPath}.width`,
            ),
          }),
      ...(metadata.height === undefined
        ? {}
        : {
            height: readPositiveRevision(
              metadata.height,
              `${metadataPath}.height`,
            ),
          }),
      ...(metadata.altText === undefined
        ? {}
        : {
            altText: readSafeString(
              metadata.altText,
              `${metadataPath}.altText`,
              { allowBlank: true },
            ),
          }),
    };
  });
}

function compareSavedMessagePositions(
  left: SavedMessageSnapshotCursorPosition,
  right: SavedMessageSnapshotCursorPosition,
): number {
  const timeDifference = Date.parse(left.savedAt) - Date.parse(right.savedAt);
  if (timeDifference !== 0) return timeDifference;
  if (left.messageId === right.messageId) return 0;
  return left.messageId < right.messageId ? -1 : 1;
}

function compareMessageReminderPositions(
  left: MessageReminderSnapshotCursorPosition,
  right: MessageReminderSnapshotCursorPosition,
): number {
  const timeDifference = Date.parse(left.dueAt) - Date.parse(right.dueAt);
  if (timeDifference !== 0) return timeDifference;
  if (left.messageId === right.messageId) return 0;
  return left.messageId < right.messageId ? -1 : 1;
}

function rejectTrustedRequestFields(value: unknown, path = "input"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      rejectTrustedRequestFields(entry, `${path}[${index}]`),
    );
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (TRUSTED_REQUEST_FIELDS.has(normalizeFieldName(key))) {
      throw privateStateError(
        "trusted_identity_field",
        `${path}.${key} is server-derived and cannot be supplied by a client`,
      );
    }
    rejectTrustedRequestFields(nested, `${path}.${key}`);
  }
}

function assertActorPrivate(value: unknown, path: string): void {
  if (value !== ACTOR_PRIVATE_USER_STATE_PRIVACY) {
    throw privateStateError(
      "unsafe_private_data",
      `${path} must explicitly mark actor-private data`,
    );
  }
}

function readTimestamp(
  value: unknown,
  path: string,
  code: PrivateUserStateSnapshotParseErrorCode = "malformed_snapshot",
): IsoTimestamp {
  if (
    typeof value !== "string" ||
    !ISO_TIMESTAMP_PATTERN.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw privateStateError(code, `${path} must be an ISO-8601 timestamp`);
  }
  return value;
}

function readIdentifier(
  value: unknown,
  path: string,
  maxBytes: number,
  code: PrivateUserStateSnapshotParseErrorCode,
): string {
  const identifier = readSafeString(
    value,
    path,
    { allowBlank: false, maxBytes },
    code,
  );
  if (identifier.trim() !== identifier) {
    throw privateStateError(code, `${path} must not have surrounding whitespace`);
  }
  return identifier;
}

function readSafeString(
  value: unknown,
  path: string,
  options: { readonly allowBlank: boolean; readonly maxBytes?: number },
  code: PrivateUserStateSnapshotParseErrorCode = "malformed_snapshot",
): string {
  if (
    typeof value !== "string" ||
    (!options.allowBlank && value.trim().length === 0) ||
    value !== value.normalize("NFC") ||
    containsUnsafeUnicode(value) ||
    (options.maxBytes !== undefined &&
      new TextEncoder().encode(value).byteLength > options.maxBytes)
  ) {
    throw privateStateError(code, `${path} is not a safe JSON string`);
  }
  return value;
}

function readPositiveRevision(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw snapshotError(`${path} must be a positive safe integer`);
  }
  return value as number;
}

function readNonNegativeRevision(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw snapshotError(`${path} must be a nonnegative safe integer`);
  }
  return value as number;
}

function assertJsonSafe(
  value: unknown,
  path: string,
  ancestors: Set<object>,
): void {
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "string" && !containsUnsafeUnicode(value)) ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (typeof value !== "object") {
    throw snapshotError(`${path} must be JSON-safe`);
  }
  if (ancestors.has(value)) {
    throw snapshotError(`${path} must not contain cycles`);
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertJsonSafe(entry, `${path}[${index}]`, ancestors),
    );
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw snapshotError(`${path} must be a plain JSON object`);
    }
    for (const [key, nested] of Object.entries(value)) {
      readSafeString(key, `${path} key`, { allowBlank: false });
      assertJsonSafe(nested, `${path}.${key}`, ancestors);
    }
  }
  ancestors.delete(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
  code: PrivateUserStateSnapshotParseErrorCode,
): void {
  assertAllowedAndRequiredKeys(value, expected, expected, path, code);
}

function assertAllowedAndRequiredKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  path: string,
  code: PrivateUserStateSnapshotParseErrorCode,
): void {
  const allowedSet = new Set(allowed);
  if (
    Object.keys(value).some((key) => !allowedSet.has(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  ) {
    throw privateStateError(code, `${path} contains unsupported or missing keys`);
  }
}

function requireRecord(
  value: unknown,
  path: string,
  code: PrivateUserStateSnapshotParseErrorCode,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw privateStateError(code, `${path} must be an object`);
  }
  return value;
}

function containsUnsafeUnicode(value: string): boolean {
  return /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uD800-\uDFFF]/u.test(
    value,
  );
}

function normalizeFieldName(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inputError(message: string): PrivateUserStateSnapshotParseError {
  return privateStateError("malformed_input", message);
}

function snapshotError(message: string): PrivateUserStateSnapshotParseError {
  return privateStateError("malformed_snapshot", message);
}

function cursorError(
  code: "malformed_cursor" | "unsupported_cursor",
  message: string,
): PrivateUserStateSnapshotParseError {
  return privateStateError(code, message);
}

function privateStateError(
  code: PrivateUserStateSnapshotParseErrorCode,
  message: string,
): PrivateUserStateSnapshotParseError {
  return new PrivateUserStateSnapshotParseError(code, message);
}

/** Ordering key retained after cancellation, without a scheduled indicator. */
export function messageReminderSnapshotDueAt(entry: MessageReminderSnapshotEntry): IsoTimestamp {
  if (entry.reminder.state === "scheduled") return entry.reminder.dueAt;
  return readTimestamp(entry.lastScheduledDueAt, "entry.lastScheduledDueAt");
}
