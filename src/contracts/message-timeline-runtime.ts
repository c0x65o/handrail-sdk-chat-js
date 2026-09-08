import type {
  AttachmentId,
  ConversationId,
  MessageSequence,
} from "./identifiers.js";
import type {
  Message,
  MessageBlock,
  ThreadSummary,
} from "./message.js";
import type { EventCursor } from "./realtime.js";

/** The cursor, when present, is excluded from the requested page. */
export type MessageTimelineDirection = "backward" | "forward";

/** A stable, conversation-local pagination position. */
export type MessageTimelineCursor = MessageSequence;

export interface MessageTimelineRequest {
  readonly conversationId: ConversationId;
  readonly direction: MessageTimelineDirection;
  /** An exclusive, conversation-local stable message position. */
  readonly cursor?: MessageTimelineCursor;
  readonly limit: number;
}

export interface MessageReactionAggregate {
  /** An emoji or host-defined reaction identifier. */
  readonly reactionKey: string;
  readonly count: number;
  readonly reactedByCurrentUser: boolean;
}

/** Metadata sufficient for a client renderer to display or open an attachment. */
export interface MessageAttachmentMetadata {
  readonly attachmentId: AttachmentId;
  readonly fileName: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly downloadUrl: string;
  readonly previewUrl?: string;
  readonly width?: number;
  readonly height?: number;
  readonly altText?: string;
}

type MessageWithoutThreadSummary<Block extends MessageBlock> =
  Message<Block> extends infer Candidate
    ? Candidate extends unknown
      ? Omit<Candidate, "threadSummary">
      : never
    : never;

interface MessageTimelineEnrichment {
  readonly reactions: readonly MessageReactionAggregate[];
  /** One entry for every attachment reference in content, in reference order. */
  readonly attachmentMetadata: readonly MessageAttachmentMetadata[];
}

/**
 * A transport-ready message. The explicit root discriminator prevents thread
 * summaries from appearing on messages without an explicit thread root.
 * An inline reply reference is independent of this discriminator.
 */
export type MessageTimelineMessage<Block extends MessageBlock = MessageBlock> =
  MessageWithoutThreadSummary<Block> &
    MessageTimelineEnrichment &
    (
      | {
          readonly isThreadRoot: false;
          readonly threadSummary?: never;
        }
      | {
          readonly isThreadRoot: true;
          readonly threadSummary: ThreadSummary;
        }
    );

export type MessageTimelineBoundary =
  | {
      readonly available: false;
      readonly cursor?: never;
    }
  | {
      readonly available: true;
      /** Exclusive cursor to request the adjacent page. */
      readonly cursor: MessageTimelineCursor;
    };

export interface MessageTimelinePagination {
  readonly older: MessageTimelineBoundary;
  readonly newer: MessageTimelineBoundary;
}

export interface MessageTimelineReplayMetadata {
  /** Resume realtime replay strictly after the snapshot represented here. */
  readonly resumeFrom: EventCursor;
}

/** Messages are always in ascending sequence order, independent of direction. */
export interface MessageTimelinePage<
  Block extends MessageBlock = MessageBlock,
> {
  readonly conversationId: ConversationId;
  readonly messages: readonly MessageTimelineMessage<Block>[];
  readonly pagination: MessageTimelinePagination;
  readonly replay: MessageTimelineReplayMetadata;
}

/** The timeline query response is exactly one normalized conversation page. */
export type MessageTimelineResponse<
  Block extends MessageBlock = MessageBlock,
> = MessageTimelinePage<Block>;

export interface MessageTimelinePageInput<
  Block extends MessageBlock = MessageBlock,
> {
  readonly messages: readonly MessageTimelineMessage<Block>[];
  readonly pagination: MessageTimelinePagination;
  readonly replay: MessageTimelineReplayMetadata;
}

export type MessageTimelineContractErrorCode =
  | "invalid_request"
  | "conversation_mismatch"
  | "cursor_boundary"
  | "duplicate_sequence"
  | "invalid_message"
  | "invalid_pagination";

export class MessageTimelineContractError extends Error {
  readonly code: MessageTimelineContractErrorCode;

  constructor(code: MessageTimelineContractErrorCode, message: string) {
    super(message);
    this.name = "MessageTimelineContractError";
    this.code = code;
  }
}

/**
 * Validates page invariants and normalizes storage/query order to ascending
 * conversation sequence. It rejects cross-conversation rows instead of ever
 * serializing a thread reply into its parent conversation timeline.
 */
export function createMessageTimelinePage<
  Block extends MessageBlock = MessageBlock,
>(
  request: MessageTimelineRequest,
  input: MessageTimelinePageInput<Block>,
): MessageTimelinePage<Block> {
  validateRequest(request);

  if (input.messages.length > request.limit) {
    throw timelineError(
      "invalid_request",
      "message count cannot exceed the requested limit",
    );
  }

  const messages = [...input.messages].sort(
    (left, right) => left.sequence - right.sequence,
  );
  const sequences = new Set<MessageSequence>();

  for (const message of messages) {
    validateMessage(request, message);

    if (sequences.has(message.sequence)) {
      throw timelineError(
        "duplicate_sequence",
        `duplicate message sequence ${message.sequence}`,
      );
    }
    sequences.add(message.sequence);
  }

  validatePagination(input.pagination, messages);
  validateReplay(input.replay);

  return {
    conversationId: request.conversationId,
    messages,
    pagination: input.pagination,
    replay: input.replay,
  };
}

function validateRequest(request: MessageTimelineRequest): void {
  if (request.direction !== "backward" && request.direction !== "forward") {
    throw timelineError("invalid_request", "direction must be backward or forward");
  }
  assertPositiveSafeInteger(request.limit, "limit", "invalid_request");
  if (request.cursor !== undefined) {
    assertNonNegativeSafeInteger(request.cursor, "cursor", "invalid_request");
  }
  assertNonEmptyString(
    request.conversationId,
    "conversationId",
    "invalid_request",
  );
}

function validateMessage<Block extends MessageBlock>(
  request: MessageTimelineRequest,
  message: MessageTimelineMessage<Block>,
): void {
  if (message.conversationId !== request.conversationId) {
    throw timelineError(
      "conversation_mismatch",
      "timeline message does not belong to the requested conversation",
    );
  }

  assertNonNegativeSafeInteger(
    message.sequence,
    "message sequence",
    "invalid_message",
  );

  if (
    request.cursor !== undefined &&
    ((request.direction === "forward" && message.sequence <= request.cursor) ||
      (request.direction === "backward" && message.sequence >= request.cursor))
  ) {
    throw timelineError(
      "cursor_boundary",
      `message sequence ${message.sequence} is not strictly ${
        request.direction === "forward" ? "after" : "before"
      } cursor ${request.cursor}`,
    );
  }

  if (Object.hasOwn(message, "replyTo")) {
    validateReplyReference(message.replyTo);
  }
  validateThreadSummary(message);
  validateReactions(message.reactions);
  validateAttachmentMetadata(message);
}

/** Match the canonical MessageReplyReference parser, including deleted shells. */
function validateReplyReference(value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw timelineError("invalid_message", "replyTo must be an object");
  }
  const reference = value as Record<string, unknown>;
  for (const field of Object.keys(reference)) {
    if (field !== "messageId" && field !== "notifyAuthor") {
      throw timelineError("invalid_message", `replyTo.${field} is not allowed`);
    }
  }
  const messageId = reference.messageId;
  if (
    typeof messageId !== "string" ||
    messageId.length === 0 ||
    messageId.trim() !== messageId ||
    /[\x00-\x1f\x7f-\x9f\u2028\u2029]/u.test(messageId) ||
    new TextEncoder().encode(messageId).length > 255
  ) {
    throw timelineError(
      "invalid_message",
      "replyTo.messageId must be a safe identifier of at most 255 UTF-8 bytes",
    );
  }
  if (typeof reference.notifyAuthor !== "boolean") {
    throw timelineError("invalid_message", "replyTo.notifyAuthor must be a boolean");
  }
}

function validateThreadSummary<Block extends MessageBlock>(
  message: MessageTimelineMessage<Block>,
): void {
  if (!message.isThreadRoot) {
    if (Object.hasOwn(message, "threadSummary")) {
      throw timelineError(
        "invalid_message",
        "only a thread root may include threadSummary",
      );
    }
    return;
  }

  const summary = message.threadSummary;
  if (summary === undefined || summary.threadId === message.conversationId) {
    throw timelineError(
      "invalid_message",
      "a thread root must reference a distinct thread conversation",
    );
  }
  assertNonNegativeSafeInteger(
    summary.replyCount,
    "replyCount",
    "invalid_message",
  );
  assertNonNegativeSafeInteger(
    summary.unreadCount,
    "unreadCount",
    "invalid_message",
  );
}

function validateReactions(reactions: readonly MessageReactionAggregate[]): void {
  const keys = new Set<string>();
  for (const reaction of reactions) {
    assertNonEmptyString(reaction.reactionKey, "reactionKey", "invalid_message");
    assertPositiveSafeInteger(reaction.count, "reaction count", "invalid_message");
    if (keys.has(reaction.reactionKey)) {
      throw timelineError(
        "invalid_message",
        "reaction aggregates must have unique keys",
      );
    }
    keys.add(reaction.reactionKey);
  }
}

function validateAttachmentMetadata<Block extends MessageBlock>(
  message: MessageTimelineMessage<Block>,
): void {
  const references = message.content?.attachments ?? [];
  if (references.length !== message.attachmentMetadata.length) {
    throw timelineError(
      "invalid_message",
      "attachment metadata must match message attachment references",
    );
  }

  const ids = new Set<AttachmentId>();
  for (let index = 0; index < references.length; index += 1) {
    const reference = references[index];
    const metadata = message.attachmentMetadata[index];
    if (reference === undefined || metadata === undefined) {
      throw timelineError("invalid_message", "attachment metadata is incomplete");
    }
    if (
      reference.attachmentId !== metadata.attachmentId ||
      ids.has(metadata.attachmentId)
    ) {
      throw timelineError(
        "invalid_message",
        "attachment metadata must uniquely follow attachment reference order",
      );
    }
    ids.add(metadata.attachmentId);
    assertNonEmptyString(metadata.fileName, "fileName", "invalid_message");
    assertNonEmptyString(metadata.contentType, "contentType", "invalid_message");
    assertNonEmptyString(metadata.downloadUrl, "downloadUrl", "invalid_message");
    assertNonNegativeSafeInteger(
      metadata.sizeBytes,
      "sizeBytes",
      "invalid_message",
    );
    if (metadata.width !== undefined) {
      assertPositiveSafeInteger(metadata.width, "width", "invalid_message");
    }
    if (metadata.height !== undefined) {
      assertPositiveSafeInteger(metadata.height, "height", "invalid_message");
    }
  }
}

function validatePagination<Block extends MessageBlock>(
  pagination: MessageTimelinePagination,
  messages: readonly MessageTimelineMessage<Block>[],
): void {
  validateBoundary(pagination.older, "older");
  validateBoundary(pagination.newer, "newer");

  if (messages.length === 0) {
    if (pagination.older.available || pagination.newer.available) {
      throw timelineError(
        "invalid_pagination",
        "an empty page cannot advertise an adjacent cursor",
      );
    }
    return;
  }

  const first = messages[0];
  const last = messages[messages.length - 1];
  if (first === undefined || last === undefined) {
    throw timelineError("invalid_pagination", "page boundaries are unavailable");
  }
  if (pagination.older.available && pagination.older.cursor !== first.sequence) {
    throw timelineError(
      "invalid_pagination",
      "older cursor must equal the first returned sequence",
    );
  }
  if (pagination.newer.available && pagination.newer.cursor !== last.sequence) {
    throw timelineError(
      "invalid_pagination",
      "newer cursor must equal the last returned sequence",
    );
  }
}

function validateBoundary(
  boundary: MessageTimelineBoundary,
  name: "older" | "newer",
): void {
  if (boundary.available) {
    assertNonNegativeSafeInteger(
      boundary.cursor,
      `${name} cursor`,
      "invalid_pagination",
    );
  } else if (Object.hasOwn(boundary, "cursor")) {
    throw timelineError(
      "invalid_pagination",
      `${name} cursor must be absent when no page is available`,
    );
  }
}

function validateReplay(replay: MessageTimelineReplayMetadata): void {
  assertNonEmptyString(
    replay.resumeFrom.eventId,
    "replay eventId",
    "invalid_pagination",
  );
}

function assertNonEmptyString(
  value: string,
  name: string,
  code: MessageTimelineContractErrorCode,
): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw timelineError(code, `${name} must be a non-empty string`);
  }
}

function assertPositiveSafeInteger(
  value: number,
  name: string,
  code: MessageTimelineContractErrorCode,
): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw timelineError(code, `${name} must be a positive safe integer`);
  }
}

function assertNonNegativeSafeInteger(
  value: number,
  name: string,
  code: MessageTimelineContractErrorCode,
): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw timelineError(code, `${name} must be a non-negative safe integer`);
  }
}

function timelineError(
  code: MessageTimelineContractErrorCode,
  message: string,
): MessageTimelineContractError {
  return new MessageTimelineContractError(code, message);
}
