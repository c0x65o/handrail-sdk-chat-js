import type {
  DeviceId,
  IsoTimestamp,
  TenantId,
  UserId,
} from "../contracts/identifiers.js";
import type { MessageBlock } from "../contracts/message.js";
import {
  deriveUnreadCount,
  type ConversationReadState,
} from "../contracts/member-read-state.js";
import {
  applyReadCursorMutation,
  parseReadCursorMutationInput,
  parseReadCursorMutationResult,
  type ReadCursorMutationInput,
} from "../contracts/read-cursor-mutation.js";
import {
  parseSendMessageInput,
  type SendMessageInput,
} from "../contracts/generated/send-message.js";
import {
  parseForwardMessageInput,
  type ForwardMessageInput,
} from "../contracts/generated/forward-message.js";
import {
  parseEditMessageInput,
  type EditMessageInput,
} from "../contracts/generated/edit-message.js";
import {
  parseSoftDeleteMessageInput,
  type SoftDeleteMessageInput,
} from "../contracts/generated/delete-message.js";
import {
  parseReactionMutationInput,
  type ReactionMutationInput,
} from "../contracts/reaction-mutations.js";
import {
  parseSynchronizeDraftInput,
  type SynchronizeDraftInput,
} from "../contracts/draft-mutation.js";
import {
  parseConversationMembershipMutationInput,
  type ConversationMembershipMutationInput,
} from "../contracts/conversation-membership.js";
import {
  parseConversationCreationInput,
  type ConversationCreationInput,
} from "../contracts/conversation-creation.js";
import {
  parseUpdateConversationPreferenceInput,
  type UpdateConversationPreferenceInput,
} from "../contracts/conversation-preference-mutation.js";
import {
  parseSetThreadFollowInput,
  type SetThreadFollowInput,
} from "../contracts/thread-follow-mutation.js";
import {
  parseSetSavedMessageInput,
  type SetSavedMessageInput,
} from "../contracts/saved-message-mutation.js";
import {
  parseMessageReminderInput,
  type MessageReminderInput,
} from "../contracts/generated/message-reminder.js";
import {
  parseConversationArchiveInput,
  type ConversationArchiveInput,
} from "../contracts/conversation-archive.js";
import {
  parseHuddleCommandInput,
  type HuddleCommandInput,
} from "../contracts/huddle-session.js";
import {
  createNormalizedChatCache,
  type NormalizedChatCacheState,
} from "./normalized-cache.js";

/** Schema version for non-snapshot storage records. */
export const APPLICATION_CHAT_STORAGE_SCHEMA_VERSION = 1 as const;

/** Snapshot envelope version, independent of persisted intent versions. */
export const APPLICATION_CHAT_NORMALIZED_SNAPSHOT_SCHEMA_VERSION = 2 as const;

/** Generated send-message contract version supported by persisted intents. */
export const APPLICATION_CHAT_SEND_MESSAGE_CONTRACT_VERSION = 1 as const;

/** Read-cursor contract version supported by persisted intents. */
export const APPLICATION_CHAT_READ_CURSOR_CONTRACT_VERSION = 1 as const;

/** Message-mutation contract version supported by persisted intents. */
export const APPLICATION_CHAT_MESSAGE_MUTATION_CONTRACT_VERSION = 1 as const;

/** Conversation-membership contract version supported by persisted intents. */
export const APPLICATION_CHAT_CONVERSATION_MEMBERSHIP_CONTRACT_VERSION = 1 as const;

/** Conversation-creation contract version supported by persisted intents. */
export const APPLICATION_CHAT_CONVERSATION_CREATION_CONTRACT_VERSION = 1 as const;

/** Conversation-preference contract version supported by persisted intents. */
export const APPLICATION_CHAT_CONVERSATION_PREFERENCE_CONTRACT_VERSION = 1 as const;

/** Thread-follow contract version supported by persisted intents. */
export const APPLICATION_CHAT_THREAD_FOLLOW_CONTRACT_VERSION = 1 as const;

/** Saved-message contract version supported by persisted intents. */
export const APPLICATION_CHAT_SAVED_MESSAGE_CONTRACT_VERSION = 1 as const;

/** Message-reminder contract version supported by persisted intents. */
export const APPLICATION_CHAT_MESSAGE_REMINDER_CONTRACT_VERSION = 1 as const;

/** Conversation-archive contract version supported by persisted intents. */
export const APPLICATION_CHAT_CONVERSATION_ARCHIVE_CONTRACT_VERSION = 1 as const;

/** Huddle-command contract version supported by persisted intents. */
export const APPLICATION_CHAT_HUDDLE_COMMAND_CONTRACT_VERSION = 1 as const;

/** Draft-mutation contract version supported by persisted intents. */
export const APPLICATION_CHAT_DRAFT_MUTATION_CONTRACT_VERSION = 1 as const;

export const MAX_APPLICATION_CHAT_STORAGE_RECORD_BYTES = 5 * 1024 * 1024;
/** Maximum compare/exchange attempts for one application storage mutation. */
export const MAX_APPLICATION_CHAT_STORAGE_MUTATION_ATTEMPTS = 8;
export const APPLICATION_CHAT_STORAGE_CONTENTION_ERROR_CODE =
  "application_chat_storage_contention" as const;
export const APPLICATION_CHAT_STORAGE_CONTENTION_ERROR_MESSAGE =
  "Application chat storage mutation is unavailable due to contention" as const;
export const MAX_APPLICATION_CHAT_QUEUED_SEND_INTENTS = 1_000;
export const MAX_APPLICATION_CHAT_QUEUED_SEND_INTENT_BYTES = 256 * 1024;
export const MAX_APPLICATION_CHAT_QUEUED_READ_CURSOR_INTENTS = 1_000;
export const MAX_APPLICATION_CHAT_QUEUED_READ_CURSOR_INTENT_BYTES = 16 * 1024;
export const MAX_APPLICATION_CHAT_QUEUED_MESSAGE_MUTATION_INTENTS = 1_000;
export const MAX_APPLICATION_CHAT_QUEUED_MESSAGE_MUTATION_INTENT_BYTES = 256 * 1024;
export const MAX_APPLICATION_CHAT_QUEUED_CONVERSATION_MEMBERSHIP_INTENTS = 1_000;
export const MAX_APPLICATION_CHAT_QUEUED_CONVERSATION_MEMBERSHIP_INTENT_BYTES = 16 * 1024;
export const MAX_APPLICATION_CHAT_QUEUED_CONVERSATION_CREATION_INTENTS = 1_000;
export const MAX_APPLICATION_CHAT_QUEUED_CONVERSATION_CREATION_INTENT_BYTES = 16 * 1024;
export const MAX_APPLICATION_CHAT_CONVERSATION_CREATION_MEMBERS = 100;
export const MAX_APPLICATION_CHAT_QUEUED_CONVERSATION_PREFERENCE_INTENTS = 1_000;
export const MAX_APPLICATION_CHAT_QUEUED_CONVERSATION_PREFERENCE_INTENT_BYTES = 16 * 1024;
export const MAX_APPLICATION_CHAT_QUEUED_THREAD_FOLLOW_INTENTS = 1_000;
export const MAX_APPLICATION_CHAT_QUEUED_THREAD_FOLLOW_INTENT_BYTES = 16 * 1024;
export const MAX_APPLICATION_CHAT_QUEUED_SAVED_MESSAGE_INTENTS = 1_000;
export const MAX_APPLICATION_CHAT_QUEUED_SAVED_MESSAGE_INTENT_BYTES = 16 * 1024;
export const MAX_APPLICATION_CHAT_QUEUED_MESSAGE_REMINDER_INTENTS = 1_000;
export const MAX_APPLICATION_CHAT_QUEUED_MESSAGE_REMINDER_INTENT_BYTES = 16 * 1024;
export const MAX_APPLICATION_CHAT_QUEUED_CONVERSATION_ARCHIVE_INTENTS = 1_000;
export const MAX_APPLICATION_CHAT_QUEUED_CONVERSATION_ARCHIVE_INTENT_BYTES = 16 * 1024;
export const MAX_APPLICATION_CHAT_QUEUED_HUDDLE_COMMAND_INTENTS = 1_000;
export const MAX_APPLICATION_CHAT_QUEUED_HUDDLE_COMMAND_INTENT_BYTES = 16 * 1024;
export const MAX_APPLICATION_CHAT_QUEUED_DRAFT_CONVERSATIONS = 500;
export const MAX_APPLICATION_CHAT_QUEUED_DRAFT_INTENT_BYTES = 128 * 1024;

const MAX_IDENTITY_COMPONENT_LENGTH = 512;
const MAX_IDENTIFIER_LENGTH = 512;
const MAX_TIMESTAMP_LENGTH = 64;
const MAX_MESSAGE_TEXT_LENGTH = 100_000;
const MAX_MESSAGE_COLLECTION_LENGTH = 1_000;
const MAX_CONVERSATION_CREATION_NAME_LENGTH = 4_096;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 100_000;
const MAX_JSON_COLLECTION_LENGTH = 10_000;
const MAX_JSON_STRING_LENGTH = 1_048_576;

export const ApplicationChatStorageRecordKind = Object.freeze({
  normalizedSnapshot: "normalized_snapshot",
  queuedSendMessageIntents: "queued_send_message_intents",
  queuedReadCursorIntents: "queued_read_cursor_intents",
  queuedMessageMutationIntents: "queued_message_mutation_intents",
  queuedConversationMembershipIntents: "queued_conversation_membership_intents",
  queuedConversationCreationIntents: "queued_conversation_creation_intents",
  queuedConversationPreferenceIntents: "queued_conversation_preference_intents",
  queuedThreadFollowIntents: "queued_thread_follow_intents",
  queuedSavedMessageIntents: "queued_saved_message_intents",
  queuedMessageReminderIntents: "queued_message_reminder_intents",
  queuedConversationArchiveIntents: "queued_conversation_archive_intents",
  queuedHuddleCommandIntents: "queued_huddle_command_intents",
  queuedDraftIntents: "queued_draft_intents",
} as const);

export type ApplicationChatStorageRecordKind =
  (typeof ApplicationChatStorageRecordKind)[keyof typeof ApplicationChatStorageRecordKind];

/** Trusted, non-secret identity boundary for all application-owned records. */
export interface ApplicationChatStorageIdentity {
  readonly tenantId: TenantId;
  readonly userId: UserId;
  readonly deviceId: DeviceId;
}

interface ApplicationChatStorageRecordBase<
  SchemaVersion extends number = typeof APPLICATION_CHAT_STORAGE_SCHEMA_VERSION,
> {
  readonly schemaVersion: SchemaVersion;
  readonly identity: ApplicationChatStorageIdentity;
}

export interface ApplicationChatNormalizedSnapshotRecord
  extends ApplicationChatStorageRecordBase<typeof APPLICATION_CHAT_NORMALIZED_SNAPSHOT_SCHEMA_VERSION> {
  readonly kind: typeof ApplicationChatStorageRecordKind.normalizedSnapshot;
  readonly snapshot: NormalizedChatCacheState;
}

/** A retry-stable generated send request plus bounded FIFO metadata. */
export interface ApplicationChatQueuedSendMessageIntent<
  Block extends MessageBlock = MessageBlock,
> {
  readonly contractVersion: typeof APPLICATION_CHAT_SEND_MESSAGE_CONTRACT_VERSION;
  readonly enqueueOrder: number;
  readonly enqueuedAt: IsoTimestamp;
  readonly request: SendMessageInput<Block>;
}

export interface ApplicationChatQueuedSendMessageIntentsRecord
  extends ApplicationChatStorageRecordBase {
  readonly kind: typeof ApplicationChatStorageRecordKind.queuedSendMessageIntents;
  readonly intents: readonly ApplicationChatQueuedSendMessageIntent[];
}

/** A retry-stable read-cursor request and its acknowledged pre-mutation state. */
export interface ApplicationChatQueuedReadCursorIntent {
  readonly contractVersion: typeof APPLICATION_CHAT_READ_CURSOR_CONTRACT_VERSION;
  readonly enqueueOrder: number;
  readonly enqueuedAt: IsoTimestamp;
  readonly request: ReadCursorMutationInput;
  readonly acknowledgedReadState: ConversationReadState;
}

export interface ApplicationChatQueuedReadCursorIntentsRecord
  extends ApplicationChatStorageRecordBase {
  readonly kind: typeof ApplicationChatStorageRecordKind.queuedReadCursorIntents;
  readonly intents: readonly ApplicationChatQueuedReadCursorIntent[];
}

/** The closed set of retry-stable message mutations supported by this record. */
export type ApplicationChatMessageMutationRequest<Block extends MessageBlock = MessageBlock> =
  | ForwardMessageInput
  | EditMessageInput<Block>
  | SoftDeleteMessageInput
  | ReactionMutationInput;

/** A validated message-mutation request plus bounded FIFO metadata. */
export interface ApplicationChatQueuedMessageMutationIntent<
  Block extends MessageBlock = MessageBlock,
> {
  readonly contractVersion: typeof APPLICATION_CHAT_MESSAGE_MUTATION_CONTRACT_VERSION;
  readonly enqueueOrder: number;
  readonly enqueuedAt: IsoTimestamp;
  readonly request: ApplicationChatMessageMutationRequest<Block>;
}

export interface ApplicationChatQueuedMessageMutationIntentsRecord
  extends ApplicationChatStorageRecordBase {
  readonly kind: typeof ApplicationChatStorageRecordKind.queuedMessageMutationIntents;
  readonly intents: readonly ApplicationChatQueuedMessageMutationIntent[];
}

/** A validated membership command plus retry-stable FIFO metadata. */
export interface ApplicationChatQueuedConversationMembershipIntent {
  readonly contractVersion: typeof APPLICATION_CHAT_CONVERSATION_MEMBERSHIP_CONTRACT_VERSION;
  readonly enqueueOrder: number;
  readonly enqueuedAt: IsoTimestamp;
  readonly request: ConversationMembershipMutationInput;
}

export interface ApplicationChatQueuedConversationMembershipIntentsRecord
  extends ApplicationChatStorageRecordBase {
  readonly kind: typeof ApplicationChatStorageRecordKind.queuedConversationMembershipIntents;
  readonly intents: readonly ApplicationChatQueuedConversationMembershipIntent[];
}

/** A validated creation request plus retry-stable correlation and FIFO metadata. */
export interface ApplicationChatQueuedConversationCreationIntent {
  readonly contractVersion: typeof APPLICATION_CHAT_CONVERSATION_CREATION_CONTRACT_VERSION;
  readonly enqueueOrder: number;
  readonly enqueuedAt: IsoTimestamp;
  readonly request: ConversationCreationInput;
}

export interface ApplicationChatQueuedConversationCreationIntentsRecord
  extends ApplicationChatStorageRecordBase {
  readonly kind: typeof ApplicationChatStorageRecordKind.queuedConversationCreationIntents;
  readonly intents: readonly ApplicationChatQueuedConversationCreationIntent[];
}

/** A validated preference update plus retry-stable correlation and FIFO metadata. */
export interface ApplicationChatQueuedConversationPreferenceIntent {
  readonly contractVersion: typeof APPLICATION_CHAT_CONVERSATION_PREFERENCE_CONTRACT_VERSION;
  readonly enqueueOrder: number;
  readonly enqueuedAt: IsoTimestamp;
  readonly request: UpdateConversationPreferenceInput;
}

export interface ApplicationChatQueuedConversationPreferenceIntentsRecord
  extends ApplicationChatStorageRecordBase {
  readonly kind: typeof ApplicationChatStorageRecordKind.queuedConversationPreferenceIntents;
  readonly intents: readonly ApplicationChatQueuedConversationPreferenceIntent[];
}

/** A validated explicit thread follow or unfollow plus retry-stable FIFO metadata. */
export interface ApplicationChatQueuedThreadFollowIntent {
  readonly contractVersion: typeof APPLICATION_CHAT_THREAD_FOLLOW_CONTRACT_VERSION;
  readonly enqueueOrder: number;
  readonly enqueuedAt: IsoTimestamp;
  readonly request: SetThreadFollowInput;
}

export interface ApplicationChatQueuedThreadFollowIntentsRecord
  extends ApplicationChatStorageRecordBase {
  readonly kind: typeof ApplicationChatStorageRecordKind.queuedThreadFollowIntents;
  readonly intents: readonly ApplicationChatQueuedThreadFollowIntent[];
}

/** A validated explicit save or unsave plus retry-stable FIFO metadata. */
export interface ApplicationChatQueuedSavedMessageIntent {
  readonly contractVersion: typeof APPLICATION_CHAT_SAVED_MESSAGE_CONTRACT_VERSION;
  readonly enqueueOrder: number;
  readonly enqueuedAt: IsoTimestamp;
  readonly request: SetSavedMessageInput;
}

export interface ApplicationChatQueuedSavedMessageIntentsRecord
  extends ApplicationChatStorageRecordBase {
  readonly kind: typeof ApplicationChatStorageRecordKind.queuedSavedMessageIntents;
  readonly intents: readonly ApplicationChatQueuedSavedMessageIntent[];
}

/** A validated explicit reminder set/reschedule or cancel plus retry-stable FIFO metadata. */
export interface ApplicationChatQueuedMessageReminderIntent {
  readonly contractVersion: typeof APPLICATION_CHAT_MESSAGE_REMINDER_CONTRACT_VERSION;
  readonly enqueueOrder: number;
  readonly enqueuedAt: IsoTimestamp;
  readonly request: MessageReminderInput;
}

export interface ApplicationChatQueuedMessageReminderIntentsRecord
  extends ApplicationChatStorageRecordBase {
  readonly kind: typeof ApplicationChatStorageRecordKind.queuedMessageReminderIntents;
  readonly intents: readonly ApplicationChatQueuedMessageReminderIntent[];
}

/** A validated explicit archive or restore plus retry-stable FIFO metadata. */
export interface ApplicationChatQueuedConversationArchiveIntent {
  readonly contractVersion: typeof APPLICATION_CHAT_CONVERSATION_ARCHIVE_CONTRACT_VERSION;
  readonly enqueueOrder: number;
  readonly enqueuedAt: IsoTimestamp;
  readonly request: ConversationArchiveInput;
}

export interface ApplicationChatQueuedConversationArchiveIntentsRecord
  extends ApplicationChatStorageRecordBase {
  readonly kind: typeof ApplicationChatStorageRecordKind.queuedConversationArchiveIntents;
  readonly intents: readonly ApplicationChatQueuedConversationArchiveIntent[];
}

/** A validated provider-neutral huddle command plus retry-stable FIFO metadata. */
export interface ApplicationChatQueuedHuddleCommandIntent {
  readonly contractVersion: typeof APPLICATION_CHAT_HUDDLE_COMMAND_CONTRACT_VERSION;
  readonly enqueueOrder: number;
  readonly enqueuedAt: IsoTimestamp;
  readonly request: HuddleCommandInput;
}

export interface ApplicationChatQueuedHuddleCommandIntentsRecord
  extends ApplicationChatStorageRecordBase {
  readonly kind: typeof ApplicationChatStorageRecordKind.queuedHuddleCommandIntents;
  readonly intents: readonly ApplicationChatQueuedHuddleCommandIntent[];
}

/** A validated draft synchronization request plus deterministic queue metadata. */
export interface ApplicationChatQueuedDraftIntent {
  readonly contractVersion: typeof APPLICATION_CHAT_DRAFT_MUTATION_CONTRACT_VERSION;
  readonly enqueueOrder: number;
  readonly enqueuedAt: IsoTimestamp;
  readonly request: SynchronizeDraftInput;
}

export interface ApplicationChatQueuedDraftIntentsRecord
  extends ApplicationChatStorageRecordBase {
  readonly kind: typeof ApplicationChatStorageRecordKind.queuedDraftIntents;
  readonly intents: readonly ApplicationChatQueuedDraftIntent[];
}

export type ApplicationChatStorageRecord =
  | ApplicationChatNormalizedSnapshotRecord
  | ApplicationChatQueuedSendMessageIntentsRecord
  | ApplicationChatQueuedReadCursorIntentsRecord
  | ApplicationChatQueuedMessageMutationIntentsRecord
  | ApplicationChatQueuedConversationMembershipIntentsRecord
  | ApplicationChatQueuedConversationCreationIntentsRecord
  | ApplicationChatQueuedConversationPreferenceIntentsRecord
  | ApplicationChatQueuedThreadFollowIntentsRecord
  | ApplicationChatQueuedSavedMessageIntentsRecord
  | ApplicationChatQueuedMessageReminderIntentsRecord
  | ApplicationChatQueuedConversationArchiveIntentsRecord
  | ApplicationChatQueuedHuddleCommandIntentsRecord
  | ApplicationChatQueuedDraftIntentsRecord;

export type ApplicationChatStorageRecordForKind<
  Kind extends ApplicationChatStorageRecordKind,
> = Extract<ApplicationChatStorageRecord, { readonly kind: Kind }>;

export type ApplicationChatStorageUpdater<
  Kind extends ApplicationChatStorageRecordKind,
> = (
  current: ApplicationChatStorageRecordForKind<Kind> | null,
) => ApplicationChatStorageRecordForKind<Kind> | null;

/**
 * Host-owned raw persistence. Every operation must atomically read, replace,
 * or remove exactly one identity-and-kind key, or clear every record kind for
 * one exact identity.
 */
export interface ApplicationChatStorageAdapter {
  read(
    identity: ApplicationChatStorageIdentity,
    kind: ApplicationChatStorageRecordKind,
  ): Promise<string | null>;
  replace(
    identity: ApplicationChatStorageIdentity,
    kind: ApplicationChatStorageRecordKind,
    encodedRecord: string,
  ): Promise<void>;
  remove(
    identity: ApplicationChatStorageIdentity,
    kind: ApplicationChatStorageRecordKind,
  ): Promise<void>;
  /**
   * Atomically replaces or removes one value only when its current encoded
   * value exactly matches `expectedEncodedRecord`. A null expected value means
   * the key must be absent; a null replacement removes the key.
   */
  compareExchange?(
    identity: ApplicationChatStorageIdentity,
    kind: ApplicationChatStorageRecordKind,
    expectedEncodedRecord: string | null,
    replacementEncodedRecord: string | null,
  ): Promise<boolean>;
  /** Atomically removes every record kind for exactly one logged-out identity. */
  clearForLogout(identity: ApplicationChatStorageIdentity): Promise<void>;
}

/** Validated application-facing storage with no global clearing operation. */
export interface ApplicationChatStorage {
  read<Kind extends ApplicationChatStorageRecordKind>(
    identity: ApplicationChatStorageIdentity,
    kind: Kind,
  ): Promise<ApplicationChatStorageRecordForKind<Kind> | null>;
  replace(record: ApplicationChatStorageRecord): Promise<void>;
  remove(
    identity: ApplicationChatStorageIdentity,
    kind: ApplicationChatStorageRecordKind,
  ): Promise<void>;
  /**
   * Applies a synchronous record update. Atomic adapters retry contention;
   * legacy adapters retain their single-writer read-then-write behavior.
   */
  mutate<Kind extends ApplicationChatStorageRecordKind>(
    identity: ApplicationChatStorageIdentity,
    kind: Kind,
    updater: ApplicationChatStorageUpdater<NoInfer<Kind>>,
  ): Promise<ApplicationChatStorageRecordForKind<Kind> | null>;
  /** Present only when the host adapter supplies a real atomic implementation. */
  compareExchange?(
    identity: ApplicationChatStorageIdentity,
    kind: ApplicationChatStorageRecordKind,
    expectedEncodedRecord: string | null,
    replacementEncodedRecord: string | null,
  ): Promise<boolean>;
  /** Atomically removes every record kind for exactly one logged-out identity. */
  clearForLogout(identity: ApplicationChatStorageIdentity): Promise<void>;
}

export class ApplicationChatStorageValidationError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "ApplicationChatStorageValidationError";
  }
}

/** A bounded atomic mutation could not commit because its key remained contended. */
export class ApplicationChatStorageUnavailableError extends Error {
  readonly code = APPLICATION_CHAT_STORAGE_CONTENTION_ERROR_CODE;

  constructor() {
    super(APPLICATION_CHAT_STORAGE_CONTENTION_ERROR_MESSAGE);
    this.name = "ApplicationChatStorageUnavailableError";
  }
}

export function parseApplicationChatStorageIdentity(
  value: unknown,
): ApplicationChatStorageIdentity {
  const identity = requireExactRecord(
    value,
    ["tenantId", "userId", "deviceId"],
    "ApplicationChatStorageIdentity",
  );
  return Object.freeze({
    tenantId: readExactIdentityComponent(
      identity.tenantId,
      "ApplicationChatStorageIdentity.tenantId",
    ) as TenantId,
    userId: readExactIdentityComponent(
      identity.userId,
      "ApplicationChatStorageIdentity.userId",
    ) as UserId,
    deviceId: readExactIdentityComponent(
      identity.deviceId,
      "ApplicationChatStorageIdentity.deviceId",
    ) as DeviceId,
  });
}

export function createApplicationChatNormalizedSnapshotRecord(
  identity: ApplicationChatStorageIdentity,
  snapshot: NormalizedChatCacheState,
): ApplicationChatNormalizedSnapshotRecord {
  const trustedIdentity = parseApplicationChatStorageIdentity(identity);
  validateJsonValue(snapshot, "snapshot", false);
  rejectUnsafeStorageFields(snapshot, "snapshot");
  const snapshotIdentity = requireCanonicalSnapshotIdentity(snapshot);
  if (
    snapshotIdentity.tenantId !== trustedIdentity.tenantId ||
    snapshotIdentity.userId !== trustedIdentity.userId
  ) {
    throw validationError("Stored normalized snapshot does not match its tenant and user identity");
  }

  const cache = createNormalizedChatCache(snapshotIdentity);
  if (!cache.hydrateCanonicalState(snapshot)) {
    throw validationError("Stored normalized snapshot is not canonical cache state");
  }
  const detachedSnapshot = cache.getState();
  const record: ApplicationChatNormalizedSnapshotRecord = Object.freeze({
    schemaVersion: APPLICATION_CHAT_NORMALIZED_SNAPSHOT_SCHEMA_VERSION,
    kind: ApplicationChatStorageRecordKind.normalizedSnapshot,
    identity: trustedIdentity,
    snapshot: detachedSnapshot,
  });
  assertEncodedSize(
    JSON.stringify(recordToWireJson(record)),
    MAX_APPLICATION_CHAT_STORAGE_RECORD_BYTES,
    "Application chat storage record",
  );
  return record;
}

export function createApplicationChatQueuedSendMessageIntent<
  Block extends MessageBlock = MessageBlock,
>(
  request: SendMessageInput<Block>,
  metadata: {
    readonly enqueueOrder: number;
    readonly enqueuedAt: IsoTimestamp;
  },
): ApplicationChatQueuedSendMessageIntent<Block> {
  if (!Number.isSafeInteger(metadata.enqueueOrder) || metadata.enqueueOrder < 1) {
    throw validationError("Queued send enqueueOrder must be a positive safe integer");
  }
  const enqueuedAt = readIsoTimestamp(metadata.enqueuedAt, "Queued send enqueuedAt");
  validateJsonValue(request, "Queued send request", true);
  rejectUnsafeStorageFields(request, "Queued send request");

  let parsed: SendMessageInput<Block>;
  try {
    parsed = parseSendMessageInput<Block>(request);
  } catch (error) {
    throw validationError(
      `Queued send request is invalid: ${error instanceof Error ? error.message : "unknown validation failure"}`,
    );
  }
  validateQueuedSendRequestBounds(parsed);
  const detachedRequest = deepFreeze(cloneJson(parsed)) as SendMessageInput<Block>;
  const intent = Object.freeze({
    contractVersion: APPLICATION_CHAT_SEND_MESSAGE_CONTRACT_VERSION,
    enqueueOrder: metadata.enqueueOrder,
    enqueuedAt,
    request: detachedRequest,
  });
  assertEncodedSize(
    JSON.stringify(intentToWireJson(intent)),
    MAX_APPLICATION_CHAT_QUEUED_SEND_INTENT_BYTES,
    "Queued send intent",
  );
  return intent;
}

export function createApplicationChatQueuedSendMessageIntentsRecord(
  identity: ApplicationChatStorageIdentity,
  intents: readonly ApplicationChatQueuedSendMessageIntent[],
): ApplicationChatQueuedSendMessageIntentsRecord {
  const trustedIdentity = parseApplicationChatStorageIdentity(identity);
  if (!Array.isArray(intents)) {
    throw validationError("Queued send intents must be an array");
  }
  if (intents.length > MAX_APPLICATION_CHAT_QUEUED_SEND_INTENTS) {
    throw validationError(
      `Queued send intents must contain at most ${MAX_APPLICATION_CHAT_QUEUED_SEND_INTENTS} entries`,
    );
  }
  const normalized = intents.map((intent, index) =>
    parsePublicIntent(intent, `Queued send intents[${index}]`),
  );
  validateIntentOrderAndUniqueness(normalized);
  const record: ApplicationChatQueuedSendMessageIntentsRecord = Object.freeze({
    schemaVersion: APPLICATION_CHAT_STORAGE_SCHEMA_VERSION,
    kind: ApplicationChatStorageRecordKind.queuedSendMessageIntents,
    identity: trustedIdentity,
    intents: Object.freeze(normalized),
  });
  assertEncodedSize(
    JSON.stringify(recordToWireJson(record)),
    MAX_APPLICATION_CHAT_STORAGE_RECORD_BYTES,
    "Application chat storage record",
  );
  return record;
}

export function createApplicationChatQueuedReadCursorIntent(
  request: ReadCursorMutationInput,
  acknowledgedReadState: ConversationReadState,
  metadata: {
    readonly enqueueOrder: number;
    readonly enqueuedAt: IsoTimestamp;
  },
): ApplicationChatQueuedReadCursorIntent {
  const enqueueOrder = requirePositiveSafeInteger(
    metadata.enqueueOrder,
    "Queued read-cursor enqueueOrder",
  );
  const enqueuedAt = readIsoTimestamp(
    metadata.enqueuedAt,
    "Queued read-cursor enqueuedAt",
  );
  validateJsonValue(request, "Queued read-cursor request", true);
  rejectUnsafeStorageFields(request, "Queued read-cursor request");

  let parsedRequest: ReadCursorMutationInput;
  try {
    parsedRequest = parseReadCursorMutationInput(request);
  } catch (error) {
    throw validationError(
      `Queued read-cursor request is invalid: ${error instanceof Error ? error.message : "unknown validation failure"}`,
    );
  }
  validateReadCursorRequestBounds(parsedRequest);
  const parsedBaseline = parseAcknowledgedReadState(acknowledgedReadState);
  if (parsedBaseline.conversationId !== parsedRequest.conversationId) {
    throw validationError(
      "Queued read-cursor canonical baseline must match the request conversation",
    );
  }
  try {
    applyReadCursorMutation(parsedRequest, {
      currentReadState: parsedBaseline,
      latestSequence: parsedRequest.operation === "mark_read"
        ? Math.max(parsedBaseline.lastReadSequence, parsedRequest.throughSequence)
        : parsedBaseline.lastReadSequence,
      updatedAt: enqueuedAt,
    });
  } catch (error) {
    throw validationError(
      `Queued read-cursor request is not applicable to its canonical baseline: ${error instanceof Error ? error.message : "unknown validation failure"}`,
    );
  }

  const intent: ApplicationChatQueuedReadCursorIntent = Object.freeze({
    contractVersion: APPLICATION_CHAT_READ_CURSOR_CONTRACT_VERSION,
    enqueueOrder,
    enqueuedAt,
    request: deepFreeze(cloneJson(parsedRequest)),
    acknowledgedReadState: parsedBaseline,
  });
  assertEncodedSize(
    JSON.stringify(readCursorIntentToWireJson(intent)),
    MAX_APPLICATION_CHAT_QUEUED_READ_CURSOR_INTENT_BYTES,
    "Queued read-cursor intent",
  );
  return intent;
}

export function createApplicationChatQueuedReadCursorIntentsRecord(
  identity: ApplicationChatStorageIdentity,
  intents: readonly ApplicationChatQueuedReadCursorIntent[],
): ApplicationChatQueuedReadCursorIntentsRecord {
  const trustedIdentity = parseApplicationChatStorageIdentity(identity);
  if (!Array.isArray(intents)) {
    throw validationError("Queued read-cursor intents must be an array");
  }
  if (intents.length > MAX_APPLICATION_CHAT_QUEUED_READ_CURSOR_INTENTS) {
    throw validationError(
      `Queued read-cursor intents must contain at most ${MAX_APPLICATION_CHAT_QUEUED_READ_CURSOR_INTENTS} entries`,
    );
  }
  const parsed = intents.map((intent, index) =>
    parsePublicReadCursorIntent(intent, `Queued read-cursor intents[${index}]`),
  );
  validateReadCursorIntentOrderAndUniqueness(parsed);
  for (const intent of parsed) {
    if (intent.acknowledgedReadState.userId !== trustedIdentity.userId) {
      throw validationError(
        "Queued read-cursor canonical baseline must match the storage user identity",
      );
    }
  }
  const normalized = coalesceReadCursorIntents(parsed);
  const record: ApplicationChatQueuedReadCursorIntentsRecord = Object.freeze({
    schemaVersion: APPLICATION_CHAT_STORAGE_SCHEMA_VERSION,
    kind: ApplicationChatStorageRecordKind.queuedReadCursorIntents,
    identity: trustedIdentity,
    intents: Object.freeze(normalized),
  });
  const encoded = JSON.stringify(recordToWireJson(record));
  assertEncodedSize(
    encoded,
    MAX_APPLICATION_CHAT_STORAGE_RECORD_BYTES,
    "Application chat storage record",
  );
  return record;
}

export function createApplicationChatQueuedMessageMutationIntent<
  Block extends MessageBlock = MessageBlock,
>(
  request: ApplicationChatMessageMutationRequest<Block>,
  metadata: {
    readonly enqueueOrder: number;
    readonly enqueuedAt: IsoTimestamp;
  },
): ApplicationChatQueuedMessageMutationIntent<Block> {
  const enqueueOrder = requirePositiveSafeInteger(
    metadata.enqueueOrder,
    "Queued message-mutation enqueueOrder",
  );
  const enqueuedAt = readIsoTimestamp(
    metadata.enqueuedAt,
    "Queued message-mutation enqueuedAt",
  );
  validateJsonValue(request, "Queued message-mutation request", true);
  rejectUnsafeStorageFields(request, "Queued message-mutation request");

  const parsed = parseMessageMutationRequest<Block>(request);
  validateMessageMutationRequestBounds(parsed);
  const intent: ApplicationChatQueuedMessageMutationIntent<Block> = Object.freeze({
    contractVersion: APPLICATION_CHAT_MESSAGE_MUTATION_CONTRACT_VERSION,
    enqueueOrder,
    enqueuedAt,
    request: deepFreeze(cloneJson(parsed)),
  });
  assertEncodedSize(
    JSON.stringify(messageMutationIntentToWireJson(intent)),
    MAX_APPLICATION_CHAT_QUEUED_MESSAGE_MUTATION_INTENT_BYTES,
    "Queued message-mutation intent",
  );
  return intent;
}

export function createApplicationChatQueuedMessageMutationIntentsRecord(
  identity: ApplicationChatStorageIdentity,
  intents: readonly ApplicationChatQueuedMessageMutationIntent[],
): ApplicationChatQueuedMessageMutationIntentsRecord {
  const trustedIdentity = parseApplicationChatStorageIdentity(identity);
  if (!Array.isArray(intents)) {
    throw validationError("Queued message-mutation intents must be an array");
  }
  if (intents.length > MAX_APPLICATION_CHAT_QUEUED_MESSAGE_MUTATION_INTENTS) {
    throw validationError(
      `Queued message-mutation intents must contain at most ${MAX_APPLICATION_CHAT_QUEUED_MESSAGE_MUTATION_INTENTS} entries`,
    );
  }
  const parsed = intents.map((intent, index) =>
    parsePublicMessageMutationIntent(
      intent,
      `Queued message-mutation intents[${index}]`,
    ),
  );
  validateMessageMutationIntentOrderAndUniqueness(parsed);
  const normalized = coalesceMessageMutationIntents(parsed);
  const record: ApplicationChatQueuedMessageMutationIntentsRecord = Object.freeze({
    schemaVersion: APPLICATION_CHAT_STORAGE_SCHEMA_VERSION,
    kind: ApplicationChatStorageRecordKind.queuedMessageMutationIntents,
    identity: trustedIdentity,
    intents: Object.freeze(normalized),
  });
  assertEncodedSize(
    JSON.stringify(recordToWireJson(record)),
    MAX_APPLICATION_CHAT_STORAGE_RECORD_BYTES,
    "Application chat storage record",
  );
  return record;
}

export function createApplicationChatQueuedConversationMembershipIntent(
  request: ConversationMembershipMutationInput,
  metadata: {
    readonly enqueueOrder: number;
    readonly enqueuedAt: IsoTimestamp;
  },
): ApplicationChatQueuedConversationMembershipIntent {
  const enqueueOrder = requirePositiveSafeInteger(
    metadata.enqueueOrder,
    "Queued conversation-membership enqueueOrder",
  );
  const enqueuedAt = readIsoTimestamp(
    metadata.enqueuedAt,
    "Queued conversation-membership enqueuedAt",
  );
  validateJsonValue(request, "Queued conversation-membership request", true);
  rejectUnsafeStorageFields(request, "Queued conversation-membership request");

  let parsed: ConversationMembershipMutationInput;
  try {
    parsed = parseConversationMembershipMutationInput(request);
  } catch (error) {
    throw validationError(
      `Queued conversation-membership request is invalid: ${error instanceof Error ? error.message : "unknown validation failure"}`,
    );
  }
  validateConversationMembershipRequestBounds(parsed);
  const intent: ApplicationChatQueuedConversationMembershipIntent = Object.freeze({
    contractVersion: APPLICATION_CHAT_CONVERSATION_MEMBERSHIP_CONTRACT_VERSION,
    enqueueOrder,
    enqueuedAt,
    request: deepFreeze(cloneJson(parsed)),
  });
  assertEncodedSize(
    JSON.stringify(conversationMembershipIntentToWireJson(intent)),
    MAX_APPLICATION_CHAT_QUEUED_CONVERSATION_MEMBERSHIP_INTENT_BYTES,
    "Queued conversation-membership intent",
  );
  return intent;
}

export function createApplicationChatQueuedConversationMembershipIntentsRecord(
  identity: ApplicationChatStorageIdentity,
  intents: readonly ApplicationChatQueuedConversationMembershipIntent[],
): ApplicationChatQueuedConversationMembershipIntentsRecord {
  const trustedIdentity = parseApplicationChatStorageIdentity(identity);
  if (!Array.isArray(intents)) {
    throw validationError("Queued conversation-membership intents must be an array");
  }
  if (intents.length > MAX_APPLICATION_CHAT_QUEUED_CONVERSATION_MEMBERSHIP_INTENTS) {
    throw validationError(
      `Queued conversation-membership intents must contain at most ${MAX_APPLICATION_CHAT_QUEUED_CONVERSATION_MEMBERSHIP_INTENTS} entries`,
    );
  }
  const parsed = intents.map((intent, index) =>
    parsePublicConversationMembershipIntent(
      intent,
      `Queued conversation-membership intents[${index}]`,
    ),
  );
  validateConversationMembershipIntentOrderAndUniqueness(parsed);
  const normalized = coalesceConversationMembershipIntents(parsed);
  const record: ApplicationChatQueuedConversationMembershipIntentsRecord = Object.freeze({
    schemaVersion: APPLICATION_CHAT_STORAGE_SCHEMA_VERSION,
    kind: ApplicationChatStorageRecordKind.queuedConversationMembershipIntents,
    identity: trustedIdentity,
    intents: Object.freeze(normalized),
  });
  assertEncodedSize(
    JSON.stringify(recordToWireJson(record)),
    MAX_APPLICATION_CHAT_STORAGE_RECORD_BYTES,
    "Application chat storage record",
  );
  return record;
}

export function createApplicationChatQueuedConversationCreationIntent(
  request: ConversationCreationInput,
  metadata: {
    readonly enqueueOrder: number;
    readonly enqueuedAt: IsoTimestamp;
  },
): ApplicationChatQueuedConversationCreationIntent {
  const enqueueOrder = requirePositiveSafeInteger(
    metadata.enqueueOrder,
    "Queued conversation-creation enqueueOrder",
  );
  const enqueuedAt = readIsoTimestamp(
    metadata.enqueuedAt,
    "Queued conversation-creation enqueuedAt",
  );
  validateJsonValue(request, "Queued conversation-creation request", true);
  rejectUnsafeStorageFields(request, "Queued conversation-creation request");

  let parsed: ConversationCreationInput;
  try {
    parsed = parseConversationCreationInput(request);
  } catch (error) {
    throw validationError(
      `Queued conversation-creation request is invalid: ${error instanceof Error ? error.message : "unknown validation failure"}`,
    );
  }
  validateConversationCreationRequestBounds(parsed);
  const intent: ApplicationChatQueuedConversationCreationIntent = Object.freeze({
    contractVersion: APPLICATION_CHAT_CONVERSATION_CREATION_CONTRACT_VERSION,
    enqueueOrder,
    enqueuedAt,
    request: canonicalizeConversationCreationRequest(parsed),
  });
  assertEncodedSize(
    JSON.stringify(conversationCreationIntentToWireJson(intent)),
    MAX_APPLICATION_CHAT_QUEUED_CONVERSATION_CREATION_INTENT_BYTES,
    "Queued conversation-creation intent",
  );
  return intent;
}

export function createApplicationChatQueuedConversationCreationIntentsRecord(
  identity: ApplicationChatStorageIdentity,
  intents: readonly ApplicationChatQueuedConversationCreationIntent[],
): ApplicationChatQueuedConversationCreationIntentsRecord {
  const trustedIdentity = parseApplicationChatStorageIdentity(identity);
  if (!Array.isArray(intents)) {
    throw validationError("Queued conversation-creation intents must be an array");
  }
  if (intents.length > MAX_APPLICATION_CHAT_QUEUED_CONVERSATION_CREATION_INTENTS) {
    throw validationError(
      `Queued conversation-creation intents must contain at most ${MAX_APPLICATION_CHAT_QUEUED_CONVERSATION_CREATION_INTENTS} entries`,
    );
  }
  const parsed = intents.map((intent, index) =>
    parsePublicConversationCreationIntent(
      intent,
      `Queued conversation-creation intents[${index}]`,
    ),
  );
  validateConversationCreationIntentOrderAndUniqueness(parsed);
  const normalized = coalesceConversationCreationIntents(parsed);
  const record: ApplicationChatQueuedConversationCreationIntentsRecord = Object.freeze({
    schemaVersion: APPLICATION_CHAT_STORAGE_SCHEMA_VERSION,
    kind: ApplicationChatStorageRecordKind.queuedConversationCreationIntents,
    identity: trustedIdentity,
    intents: Object.freeze(normalized),
  });
  assertEncodedSize(
    JSON.stringify(recordToWireJson(record)),
    MAX_APPLICATION_CHAT_STORAGE_RECORD_BYTES,
    "Application chat storage record",
  );
  return record;
}

export function createApplicationChatQueuedConversationPreferenceIntent(
  request: UpdateConversationPreferenceInput,
  metadata: {
    readonly enqueueOrder: number;
    readonly enqueuedAt: IsoTimestamp;
  },
): ApplicationChatQueuedConversationPreferenceIntent {
  const enqueueOrder = requirePositiveSafeInteger(
    metadata.enqueueOrder,
    "Queued conversation-preference enqueueOrder",
  );
  const enqueuedAt = readIsoTimestamp(
    metadata.enqueuedAt,
    "Queued conversation-preference enqueuedAt",
  );
  validateJsonValue(request, "Queued conversation-preference request", true);
  rejectUnsafeStorageFields(request, "Queued conversation-preference request");

  let parsed: UpdateConversationPreferenceInput;
  try {
    parsed = parseUpdateConversationPreferenceInput(request);
  } catch (error) {
    throw validationError(
      `Queued conversation-preference request is invalid: ${error instanceof Error ? error.message : "unknown validation failure"}`,
    );
  }
  const intent: ApplicationChatQueuedConversationPreferenceIntent = Object.freeze({
    contractVersion: APPLICATION_CHAT_CONVERSATION_PREFERENCE_CONTRACT_VERSION,
    enqueueOrder,
    enqueuedAt,
    request: deepFreeze(cloneJson(parsed)),
  });
  assertEncodedSize(
    JSON.stringify(conversationPreferenceIntentToWireJson(intent)),
    MAX_APPLICATION_CHAT_QUEUED_CONVERSATION_PREFERENCE_INTENT_BYTES,
    "Queued conversation-preference intent",
  );
  return intent;
}

export function createApplicationChatQueuedConversationPreferenceIntentsRecord(
  identity: ApplicationChatStorageIdentity,
  intents: readonly ApplicationChatQueuedConversationPreferenceIntent[],
): ApplicationChatQueuedConversationPreferenceIntentsRecord {
  const trustedIdentity = parseApplicationChatStorageIdentity(identity);
  if (!Array.isArray(intents)) {
    throw validationError("Queued conversation-preference intents must be an array");
  }
  if (intents.length > MAX_APPLICATION_CHAT_QUEUED_CONVERSATION_PREFERENCE_INTENTS) {
    throw validationError(
      `Queued conversation-preference intents must contain at most ${MAX_APPLICATION_CHAT_QUEUED_CONVERSATION_PREFERENCE_INTENTS} entries`,
    );
  }
  const parsed = intents.map((intent, index) =>
    parsePublicConversationPreferenceIntent(
      intent,
      `Queued conversation-preference intents[${index}]`,
    ),
  );
  validateConversationPreferenceIntentOrderAndUniqueness(parsed);
  const normalized = coalesceConversationPreferenceIntents(parsed);
  const record: ApplicationChatQueuedConversationPreferenceIntentsRecord = Object.freeze({
    schemaVersion: APPLICATION_CHAT_STORAGE_SCHEMA_VERSION,
    kind: ApplicationChatStorageRecordKind.queuedConversationPreferenceIntents,
    identity: trustedIdentity,
    intents: Object.freeze(normalized),
  });
  assertEncodedSize(
    JSON.stringify(recordToWireJson(record)),
    MAX_APPLICATION_CHAT_STORAGE_RECORD_BYTES,
    "Application chat storage record",
  );
  return record;
}

export function createApplicationChatQueuedThreadFollowIntent(
  request: SetThreadFollowInput,
  metadata: {
    readonly enqueueOrder: number;
    readonly enqueuedAt: IsoTimestamp;
  },
): ApplicationChatQueuedThreadFollowIntent {
  const enqueueOrder = requirePositiveSafeInteger(
    metadata.enqueueOrder,
    "Queued thread-follow enqueueOrder",
  );
  const enqueuedAt = readIsoTimestamp(
    metadata.enqueuedAt,
    "Queued thread-follow enqueuedAt",
  );
  validateJsonValue(request, "Queued thread-follow request", true);
  rejectUnsafeStorageFields(request, "Queued thread-follow request");

  let parsed: SetThreadFollowInput;
  try {
    parsed = parseSetThreadFollowInput(request);
  } catch (error) {
    throw validationError(
      `Queued thread-follow request is invalid: ${error instanceof Error ? error.message : "unknown validation failure"}`,
    );
  }
  const intent: ApplicationChatQueuedThreadFollowIntent = Object.freeze({
    contractVersion: APPLICATION_CHAT_THREAD_FOLLOW_CONTRACT_VERSION,
    enqueueOrder,
    enqueuedAt,
    request: deepFreeze(cloneJson(parsed)),
  });
  assertEncodedSize(
    JSON.stringify(threadFollowIntentToWireJson(intent)),
    MAX_APPLICATION_CHAT_QUEUED_THREAD_FOLLOW_INTENT_BYTES,
    "Queued thread-follow intent",
  );
  return intent;
}

export function createApplicationChatQueuedThreadFollowIntentsRecord(
  identity: ApplicationChatStorageIdentity,
  intents: readonly ApplicationChatQueuedThreadFollowIntent[],
): ApplicationChatQueuedThreadFollowIntentsRecord {
  const trustedIdentity = parseApplicationChatStorageIdentity(identity);
  if (!Array.isArray(intents)) {
    throw validationError("Queued thread-follow intents must be an array");
  }
  if (intents.length > MAX_APPLICATION_CHAT_QUEUED_THREAD_FOLLOW_INTENTS) {
    throw validationError(
      `Queued thread-follow intents must contain at most ${MAX_APPLICATION_CHAT_QUEUED_THREAD_FOLLOW_INTENTS} entries`,
    );
  }
  const parsed = intents.map((intent, index) =>
    parsePublicThreadFollowIntent(intent, `Queued thread-follow intents[${index}]`)
  );
  validateThreadFollowIntentOrderAndUniqueness(parsed);
  const normalized = coalesceThreadFollowIntents(parsed);
  const record: ApplicationChatQueuedThreadFollowIntentsRecord = Object.freeze({
    schemaVersion: APPLICATION_CHAT_STORAGE_SCHEMA_VERSION,
    kind: ApplicationChatStorageRecordKind.queuedThreadFollowIntents,
    identity: trustedIdentity,
    intents: Object.freeze(normalized),
  });
  assertEncodedSize(
    JSON.stringify(recordToWireJson(record)),
    MAX_APPLICATION_CHAT_STORAGE_RECORD_BYTES,
    "Application chat storage record",
  );
  return record;
}

export function createApplicationChatQueuedSavedMessageIntent(
  request: SetSavedMessageInput,
  metadata: {
    readonly enqueueOrder: number;
    readonly enqueuedAt: IsoTimestamp;
  },
): ApplicationChatQueuedSavedMessageIntent {
  const enqueueOrder = requirePositiveSafeInteger(
    metadata.enqueueOrder,
    "Queued saved-message enqueueOrder",
  );
  const enqueuedAt = readIsoTimestamp(
    metadata.enqueuedAt,
    "Queued saved-message enqueuedAt",
  );
  validateJsonValue(request, "Queued saved-message request", true);
  rejectUnsafeStorageFields(request, "Queued saved-message request");

  let parsed: SetSavedMessageInput;
  try {
    parsed = parseSetSavedMessageInput(request);
  } catch (error) {
    throw validationError(
      `Queued saved-message request is invalid: ${error instanceof Error ? error.message : "unknown validation failure"}`,
    );
  }
  const intent: ApplicationChatQueuedSavedMessageIntent = Object.freeze({
    contractVersion: APPLICATION_CHAT_SAVED_MESSAGE_CONTRACT_VERSION,
    enqueueOrder,
    enqueuedAt,
    request: deepFreeze(cloneJson(parsed)),
  });
  assertEncodedSize(
    JSON.stringify(savedMessageIntentToWireJson(intent)),
    MAX_APPLICATION_CHAT_QUEUED_SAVED_MESSAGE_INTENT_BYTES,
    "Queued saved-message intent",
  );
  return intent;
}

export function createApplicationChatQueuedSavedMessageIntentsRecord(
  identity: ApplicationChatStorageIdentity,
  intents: readonly ApplicationChatQueuedSavedMessageIntent[],
): ApplicationChatQueuedSavedMessageIntentsRecord {
  const trustedIdentity = parseApplicationChatStorageIdentity(identity);
  if (!Array.isArray(intents)) {
    throw validationError("Queued saved-message intents must be an array");
  }
  if (intents.length > MAX_APPLICATION_CHAT_QUEUED_SAVED_MESSAGE_INTENTS) {
    throw validationError(
      `Queued saved-message intents must contain at most ${MAX_APPLICATION_CHAT_QUEUED_SAVED_MESSAGE_INTENTS} entries`,
    );
  }
  const parsed = intents.map((intent, index) =>
    parsePublicSavedMessageIntent(intent, `Queued saved-message intents[${index}]`)
  );
  validateSavedMessageIntentOrderAndUniqueness(parsed);
  const normalized = coalesceSavedMessageIntents(parsed);
  const record: ApplicationChatQueuedSavedMessageIntentsRecord = Object.freeze({
    schemaVersion: APPLICATION_CHAT_STORAGE_SCHEMA_VERSION,
    kind: ApplicationChatStorageRecordKind.queuedSavedMessageIntents,
    identity: trustedIdentity,
    intents: Object.freeze(normalized),
  });
  assertEncodedSize(
    JSON.stringify(recordToWireJson(record)),
    MAX_APPLICATION_CHAT_STORAGE_RECORD_BYTES,
    "Application chat storage record",
  );
  return record;
}

export function createApplicationChatQueuedMessageReminderIntent(
  request: MessageReminderInput,
  metadata: {
    readonly enqueueOrder: number;
    readonly enqueuedAt: IsoTimestamp;
  },
): ApplicationChatQueuedMessageReminderIntent {
  const enqueueOrder = requirePositiveSafeInteger(
    metadata.enqueueOrder,
    "Queued message-reminder enqueueOrder",
  );
  const enqueuedAt = readIsoTimestamp(
    metadata.enqueuedAt,
    "Queued message-reminder enqueuedAt",
  );
  validateJsonValue(request, "Queued message-reminder request", true);
  rejectUnsafeStorageFields(request, "Queued message-reminder request");

  let parsed: MessageReminderInput;
  try {
    // The due time only needs to have been future-dated when originally queued.
    // Re-validating against wall-clock time would corrupt otherwise valid retries.
    parsed = parseMessageReminderInput(request, { referenceTime: enqueuedAt });
  } catch (error) {
    throw validationError(
      `Queued message-reminder request is invalid: ${error instanceof Error ? error.message : "unknown validation failure"}`,
    );
  }
  const intent: ApplicationChatQueuedMessageReminderIntent = Object.freeze({
    contractVersion: APPLICATION_CHAT_MESSAGE_REMINDER_CONTRACT_VERSION,
    enqueueOrder,
    enqueuedAt,
    request: deepFreeze(cloneJson(parsed)),
  });
  assertEncodedSize(
    JSON.stringify(messageReminderIntentToWireJson(intent)),
    MAX_APPLICATION_CHAT_QUEUED_MESSAGE_REMINDER_INTENT_BYTES,
    "Queued message-reminder intent",
  );
  return intent;
}

export function createApplicationChatQueuedMessageReminderIntentsRecord(
  identity: ApplicationChatStorageIdentity,
  intents: readonly ApplicationChatQueuedMessageReminderIntent[],
): ApplicationChatQueuedMessageReminderIntentsRecord {
  const trustedIdentity = parseApplicationChatStorageIdentity(identity);
  if (!Array.isArray(intents)) {
    throw validationError("Queued message-reminder intents must be an array");
  }
  if (intents.length > MAX_APPLICATION_CHAT_QUEUED_MESSAGE_REMINDER_INTENTS) {
    throw validationError(
      `Queued message-reminder intents must contain at most ${MAX_APPLICATION_CHAT_QUEUED_MESSAGE_REMINDER_INTENTS} entries`,
    );
  }
  const parsed = intents.map((intent, index) =>
    parsePublicMessageReminderIntent(
      intent,
      `Queued message-reminder intents[${index}]`,
    ),
  );
  validateMessageReminderIntentOrderAndUniqueness(parsed);
  const normalized = coalesceMessageReminderIntents(parsed);
  const record: ApplicationChatQueuedMessageReminderIntentsRecord = Object.freeze({
    schemaVersion: APPLICATION_CHAT_STORAGE_SCHEMA_VERSION,
    kind: ApplicationChatStorageRecordKind.queuedMessageReminderIntents,
    identity: trustedIdentity,
    intents: Object.freeze(normalized),
  });
  assertEncodedSize(
    JSON.stringify(recordToWireJson(record)),
    MAX_APPLICATION_CHAT_STORAGE_RECORD_BYTES,
    "Application chat storage record",
  );
  return record;
}

export function createApplicationChatQueuedConversationArchiveIntent(
  request: ConversationArchiveInput,
  metadata: {
    readonly enqueueOrder: number;
    readonly enqueuedAt: IsoTimestamp;
  },
): ApplicationChatQueuedConversationArchiveIntent {
  const enqueueOrder = requirePositiveSafeInteger(
    metadata.enqueueOrder,
    "Queued conversation-archive enqueueOrder",
  );
  const enqueuedAt = readIsoTimestamp(
    metadata.enqueuedAt,
    "Queued conversation-archive enqueuedAt",
  );
  validateJsonValue(request, "Queued conversation-archive request", true);
  rejectUnsafeStorageFields(request, "Queued conversation-archive request");

  let parsed: ConversationArchiveInput;
  try {
    parsed = parseConversationArchiveInput(request);
  } catch (error) {
    throw validationError(
      `Queued conversation-archive request is invalid: ${error instanceof Error ? error.message : "unknown validation failure"}`,
    );
  }
  validateConversationArchiveRequestBounds(parsed);
  const intent: ApplicationChatQueuedConversationArchiveIntent = Object.freeze({
    contractVersion: APPLICATION_CHAT_CONVERSATION_ARCHIVE_CONTRACT_VERSION,
    enqueueOrder,
    enqueuedAt,
    request: deepFreeze(cloneJson(parsed)),
  });
  assertEncodedSize(
    JSON.stringify(conversationArchiveIntentToWireJson(intent)),
    MAX_APPLICATION_CHAT_QUEUED_CONVERSATION_ARCHIVE_INTENT_BYTES,
    "Queued conversation-archive intent",
  );
  return intent;
}

export function createApplicationChatQueuedConversationArchiveIntentsRecord(
  identity: ApplicationChatStorageIdentity,
  intents: readonly ApplicationChatQueuedConversationArchiveIntent[],
): ApplicationChatQueuedConversationArchiveIntentsRecord {
  const trustedIdentity = parseApplicationChatStorageIdentity(identity);
  if (!Array.isArray(intents)) {
    throw validationError("Queued conversation-archive intents must be an array");
  }
  if (intents.length > MAX_APPLICATION_CHAT_QUEUED_CONVERSATION_ARCHIVE_INTENTS) {
    throw validationError(
      `Queued conversation-archive intents must contain at most ${MAX_APPLICATION_CHAT_QUEUED_CONVERSATION_ARCHIVE_INTENTS} entries`,
    );
  }
  const parsed = intents.map((intent, index) =>
    parsePublicConversationArchiveIntent(
      intent,
      `Queued conversation-archive intents[${index}]`,
    ),
  );
  validateConversationArchiveIntentOrderAndUniqueness(parsed);
  const normalized = coalesceConversationArchiveIntents(parsed);
  const record: ApplicationChatQueuedConversationArchiveIntentsRecord = Object.freeze({
    schemaVersion: APPLICATION_CHAT_STORAGE_SCHEMA_VERSION,
    kind: ApplicationChatStorageRecordKind.queuedConversationArchiveIntents,
    identity: trustedIdentity,
    intents: Object.freeze(normalized),
  });
  assertEncodedSize(
    JSON.stringify(recordToWireJson(record)),
    MAX_APPLICATION_CHAT_STORAGE_RECORD_BYTES,
    "Application chat storage record",
  );
  return record;
}

export function createApplicationChatQueuedHuddleCommandIntent(
  request: HuddleCommandInput,
  metadata: {
    readonly enqueueOrder: number;
    readonly enqueuedAt: IsoTimestamp;
  },
): ApplicationChatQueuedHuddleCommandIntent {
  const enqueueOrder = requirePositiveSafeInteger(
    metadata.enqueueOrder,
    "Queued huddle-command enqueueOrder",
  );
  const enqueuedAt = readIsoTimestamp(
    metadata.enqueuedAt,
    "Queued huddle-command enqueuedAt",
  );
  validateJsonValue(request, "Queued huddle-command request", true);
  rejectUnsafeStorageFields(request, "Queued huddle-command request");

  let parsed: HuddleCommandInput;
  try {
    parsed = parseHuddleCommandInput(request);
  } catch (error) {
    throw validationError(
      `Queued huddle-command request is invalid: ${error instanceof Error ? error.message : "unknown validation failure"}`,
    );
  }
  const intent: ApplicationChatQueuedHuddleCommandIntent = Object.freeze({
    contractVersion: APPLICATION_CHAT_HUDDLE_COMMAND_CONTRACT_VERSION,
    enqueueOrder,
    enqueuedAt,
    request: deepFreeze(cloneJson(parsed)),
  });
  assertEncodedSize(
    JSON.stringify(huddleCommandIntentToWireJson(intent)),
    MAX_APPLICATION_CHAT_QUEUED_HUDDLE_COMMAND_INTENT_BYTES,
    "Queued huddle-command intent",
  );
  return intent;
}

export function createApplicationChatQueuedHuddleCommandIntentsRecord(
  identity: ApplicationChatStorageIdentity,
  intents: readonly ApplicationChatQueuedHuddleCommandIntent[],
): ApplicationChatQueuedHuddleCommandIntentsRecord {
  const trustedIdentity = parseApplicationChatStorageIdentity(identity);
  if (!Array.isArray(intents)) {
    throw validationError("Queued huddle-command intents must be an array");
  }
  if (intents.length > MAX_APPLICATION_CHAT_QUEUED_HUDDLE_COMMAND_INTENTS) {
    throw validationError(
      `Queued huddle-command intents must contain at most ${MAX_APPLICATION_CHAT_QUEUED_HUDDLE_COMMAND_INTENTS} entries`,
    );
  }
  const parsed = intents.map((intent, index) =>
    parsePublicHuddleCommandIntent(
      intent,
      `Queued huddle-command intents[${index}]`,
    ),
  );
  validateHuddleCommandIntentOrderAndCompatibility(parsed);
  const normalized = coalesceHuddleCommandIntents(parsed);
  const record: ApplicationChatQueuedHuddleCommandIntentsRecord = Object.freeze({
    schemaVersion: APPLICATION_CHAT_STORAGE_SCHEMA_VERSION,
    kind: ApplicationChatStorageRecordKind.queuedHuddleCommandIntents,
    identity: trustedIdentity,
    intents: Object.freeze(normalized),
  });
  assertEncodedSize(
    JSON.stringify(recordToWireJson(record)),
    MAX_APPLICATION_CHAT_STORAGE_RECORD_BYTES,
    "Application chat storage record",
  );
  return record;
}

export function createApplicationChatQueuedDraftIntent(
  request: SynchronizeDraftInput,
  metadata: {
    readonly enqueueOrder: number;
    readonly enqueuedAt: IsoTimestamp;
  },
): ApplicationChatQueuedDraftIntent {
  const enqueueOrder = requirePositiveSafeInteger(
    metadata.enqueueOrder,
    "Queued draft enqueueOrder",
  );
  const enqueuedAt = readIsoTimestamp(metadata.enqueuedAt, "Queued draft enqueuedAt");
  validateJsonValue(request, "Queued draft request", true);
  rejectUnsafeStorageFields(request, "Queued draft request");

  let parsed: SynchronizeDraftInput;
  try {
    parsed = parseSynchronizeDraftInput(request);
  } catch (error) {
    throw validationError(
      `Queued draft request is invalid: ${error instanceof Error ? error.message : "unknown validation failure"}`,
    );
  }
  const intent: ApplicationChatQueuedDraftIntent = Object.freeze({
    contractVersion: APPLICATION_CHAT_DRAFT_MUTATION_CONTRACT_VERSION,
    enqueueOrder,
    enqueuedAt,
    request: deepFreeze(cloneJson(parsed)),
  });
  assertEncodedSize(
    JSON.stringify(draftIntentToWireJson(intent)),
    MAX_APPLICATION_CHAT_QUEUED_DRAFT_INTENT_BYTES,
    "Queued draft intent",
  );
  return intent;
}

export function createApplicationChatQueuedDraftIntentsRecord(
  identity: ApplicationChatStorageIdentity,
  intents: readonly ApplicationChatQueuedDraftIntent[],
): ApplicationChatQueuedDraftIntentsRecord {
  const trustedIdentity = parseApplicationChatStorageIdentity(identity);
  if (!Array.isArray(intents)) {
    throw validationError("Queued draft intents must be an array");
  }
  const parsed = intents.map((intent, index) =>
    parsePublicDraftIntent(intent, `Queued draft intents[${index}]`),
  );
  validateDraftIntentOrderAndUniqueness(parsed);
  const normalized = coalesceDraftIntents(parsed);
  if (normalized.length > MAX_APPLICATION_CHAT_QUEUED_DRAFT_CONVERSATIONS) {
    throw validationError(
      `Queued draft intents must contain at most ${MAX_APPLICATION_CHAT_QUEUED_DRAFT_CONVERSATIONS} conversations`,
    );
  }
  const record: ApplicationChatQueuedDraftIntentsRecord = Object.freeze({
    schemaVersion: APPLICATION_CHAT_STORAGE_SCHEMA_VERSION,
    kind: ApplicationChatStorageRecordKind.queuedDraftIntents,
    identity: trustedIdentity,
    intents: Object.freeze(normalized),
  });
  assertEncodedSize(
    JSON.stringify(recordToWireJson(record)),
    MAX_APPLICATION_CHAT_STORAGE_RECORD_BYTES,
    "Application chat storage record",
  );
  return record;
}

export function encodeApplicationChatStorageRecord(
  record: ApplicationChatStorageRecord,
): string {
  const normalized = normalizePublicRecord(record);
  const encoded = JSON.stringify(recordToWireJson(normalized));
  assertEncodedSize(
    encoded,
    MAX_APPLICATION_CHAT_STORAGE_RECORD_BYTES,
    "Application chat storage record",
  );
  return encoded;
}

export function decodeApplicationChatStorageRecord<
  Kind extends ApplicationChatStorageRecordKind,
>(
  encoded: string,
  expectedIdentity: ApplicationChatStorageIdentity,
  expectedKind: Kind,
): ApplicationChatStorageRecordForKind<Kind> {
  if (typeof encoded !== "string") {
    throw validationError("Application chat storage record must be encoded JSON text");
  }
  assertEncodedSize(
    encoded,
    MAX_APPLICATION_CHAT_STORAGE_RECORD_BYTES,
    "Application chat storage record",
  );
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    throw validationError("Application chat storage record is invalid JSON");
  }
  validateJsonValue(value, "Application chat storage record", false);

  const envelope = requireExactRecord(
    value,
    ["schemaVersion", "kind", "identity", "payload"],
    "ApplicationChatStorageRecord",
  );
  const kind = parseRecordKind(envelope.kind);
  if (kind === ApplicationChatStorageRecordKind.normalizedSnapshot) {
    requireSnapshotSchemaVersion(envelope.schemaVersion);
  } else {
    requireSchemaVersion(envelope.schemaVersion);
  }
  const identity = parseApplicationChatStorageIdentity(envelope.identity);
  const trustedExpectedIdentity = parseApplicationChatStorageIdentity(expectedIdentity);
  if (!storageIdentitiesEqual(identity, trustedExpectedIdentity)) {
    throw validationError("Application chat storage record identity does not match its requested key");
  }
  if (kind !== parseRecordKind(expectedKind)) {
    throw validationError("Application chat storage record kind does not match its requested key");
  }

  let record: ApplicationChatStorageRecord;
  if (kind === ApplicationChatStorageRecordKind.normalizedSnapshot) {
    const payload = requireExactRecord(
      envelope.payload,
      ["snapshot"],
      "NormalizedSnapshotPayload",
    );
    record = createApplicationChatNormalizedSnapshotRecord(identity, payload.snapshot as NormalizedChatCacheState);
  } else if (kind === ApplicationChatStorageRecordKind.queuedSendMessageIntents) {
    const payload = requireExactRecord(
      envelope.payload,
      ["intents"],
      "QueuedSendMessageIntentsPayload",
    );
    if (!Array.isArray(payload.intents)) {
      throw validationError("QueuedSendMessageIntentsPayload.intents must be an array");
    }
    const intents = payload.intents.map((intent, index) =>
      parseWireIntent(intent, `QueuedSendMessageIntentsPayload.intents[${index}]`),
    );
    record = createApplicationChatQueuedSendMessageIntentsRecord(identity, intents);
  } else if (kind === ApplicationChatStorageRecordKind.queuedReadCursorIntents) {
    const payload = requireExactRecord(
      envelope.payload,
      ["intents"],
      "QueuedReadCursorIntentsPayload",
    );
    if (!Array.isArray(payload.intents)) {
      throw validationError("QueuedReadCursorIntentsPayload.intents must be an array");
    }
    const intents = payload.intents.map((intent, index) =>
      parseWireReadCursorIntent(
        intent,
        `QueuedReadCursorIntentsPayload.intents[${index}]`,
      ),
    );
    record = createApplicationChatQueuedReadCursorIntentsRecord(identity, intents);
  } else if (kind === ApplicationChatStorageRecordKind.queuedMessageMutationIntents) {
    const payload = requireExactRecord(
      envelope.payload,
      ["intents"],
      "QueuedMessageMutationIntentsPayload",
    );
    if (!Array.isArray(payload.intents)) {
      throw validationError("QueuedMessageMutationIntentsPayload.intents must be an array");
    }
    const intents = payload.intents.map((intent, index) =>
      parseWireMessageMutationIntent(
        intent,
        `QueuedMessageMutationIntentsPayload.intents[${index}]`,
      ),
    );
    record = createApplicationChatQueuedMessageMutationIntentsRecord(identity, intents);
  } else if (kind === ApplicationChatStorageRecordKind.queuedConversationMembershipIntents) {
    const payload = requireExactRecord(
      envelope.payload,
      ["intents"],
      "QueuedConversationMembershipIntentsPayload",
    );
    if (!Array.isArray(payload.intents)) {
      throw validationError(
        "QueuedConversationMembershipIntentsPayload.intents must be an array",
      );
    }
    const intents = payload.intents.map((intent, index) =>
      parseWireConversationMembershipIntent(
        intent,
        `QueuedConversationMembershipIntentsPayload.intents[${index}]`,
      ),
    );
    record = createApplicationChatQueuedConversationMembershipIntentsRecord(
      identity,
      intents,
    );
  } else if (kind === ApplicationChatStorageRecordKind.queuedConversationCreationIntents) {
    const payload = requireExactRecord(
      envelope.payload,
      ["intents"],
      "QueuedConversationCreationIntentsPayload",
    );
    if (!Array.isArray(payload.intents)) {
      throw validationError(
        "QueuedConversationCreationIntentsPayload.intents must be an array",
      );
    }
    const intents = payload.intents.map((intent, index) =>
      parseWireConversationCreationIntent(
        intent,
        `QueuedConversationCreationIntentsPayload.intents[${index}]`,
      ),
    );
    record = createApplicationChatQueuedConversationCreationIntentsRecord(
      identity,
      intents,
    );
  } else if (kind === ApplicationChatStorageRecordKind.queuedConversationPreferenceIntents) {
    const payload = requireExactRecord(
      envelope.payload,
      ["intents"],
      "QueuedConversationPreferenceIntentsPayload",
    );
    if (!Array.isArray(payload.intents)) {
      throw validationError(
        "QueuedConversationPreferenceIntentsPayload.intents must be an array",
      );
    }
    const intents = payload.intents.map((intent, index) =>
      parseWireConversationPreferenceIntent(
        intent,
        `QueuedConversationPreferenceIntentsPayload.intents[${index}]`,
      ),
    );
    record = createApplicationChatQueuedConversationPreferenceIntentsRecord(
      identity,
      intents,
    );
  } else if (kind === ApplicationChatStorageRecordKind.queuedThreadFollowIntents) {
    const payload = requireExactRecord(
      envelope.payload,
      ["intents"],
      "QueuedThreadFollowIntentsPayload",
    );
    if (!Array.isArray(payload.intents)) {
      throw validationError("QueuedThreadFollowIntentsPayload.intents must be an array");
    }
    const intents = payload.intents.map((intent, index) =>
      parseWireThreadFollowIntent(
        intent,
        `QueuedThreadFollowIntentsPayload.intents[${index}]`,
      )
    );
    record = createApplicationChatQueuedThreadFollowIntentsRecord(identity, intents);
  } else if (kind === ApplicationChatStorageRecordKind.queuedSavedMessageIntents) {
    const payload = requireExactRecord(
      envelope.payload,
      ["intents"],
      "QueuedSavedMessageIntentsPayload",
    );
    if (!Array.isArray(payload.intents)) {
      throw validationError("QueuedSavedMessageIntentsPayload.intents must be an array");
    }
    const intents = payload.intents.map((intent, index) =>
      parseWireSavedMessageIntent(
        intent,
        `QueuedSavedMessageIntentsPayload.intents[${index}]`,
      )
    );
    record = createApplicationChatQueuedSavedMessageIntentsRecord(identity, intents);
  } else if (kind === ApplicationChatStorageRecordKind.queuedMessageReminderIntents) {
    const payload = requireExactRecord(
      envelope.payload,
      ["intents"],
      "QueuedMessageReminderIntentsPayload",
    );
    if (!Array.isArray(payload.intents)) {
      throw validationError("QueuedMessageReminderIntentsPayload.intents must be an array");
    }
    const intents = payload.intents.map((intent, index) =>
      parseWireMessageReminderIntent(
        intent,
        `QueuedMessageReminderIntentsPayload.intents[${index}]`,
      ),
    );
    record = createApplicationChatQueuedMessageReminderIntentsRecord(identity, intents);
  } else if (kind === ApplicationChatStorageRecordKind.queuedConversationArchiveIntents) {
    const payload = requireExactRecord(
      envelope.payload,
      ["intents"],
      "QueuedConversationArchiveIntentsPayload",
    );
    if (!Array.isArray(payload.intents)) {
      throw validationError(
        "QueuedConversationArchiveIntentsPayload.intents must be an array",
      );
    }
    const intents = payload.intents.map((intent, index) =>
      parseWireConversationArchiveIntent(
        intent,
        `QueuedConversationArchiveIntentsPayload.intents[${index}]`,
      ),
    );
    record = createApplicationChatQueuedConversationArchiveIntentsRecord(
      identity,
      intents,
    );
  } else if (kind === ApplicationChatStorageRecordKind.queuedHuddleCommandIntents) {
    const payload = requireExactRecord(
      envelope.payload,
      ["intents"],
      "QueuedHuddleCommandIntentsPayload",
    );
    if (!Array.isArray(payload.intents)) {
      throw validationError("QueuedHuddleCommandIntentsPayload.intents must be an array");
    }
    const intents = payload.intents.map((intent, index) =>
      parseWireHuddleCommandIntent(
        intent,
        `QueuedHuddleCommandIntentsPayload.intents[${index}]`,
      ),
    );
    record = createApplicationChatQueuedHuddleCommandIntentsRecord(identity, intents);
  } else {
    const payload = requireExactRecord(
      envelope.payload,
      ["intents"],
      "QueuedDraftIntentsPayload",
    );
    if (!Array.isArray(payload.intents)) {
      throw validationError("QueuedDraftIntentsPayload.intents must be an array");
    }
    const intents = payload.intents.map((intent, index) =>
      parseWireDraftIntent(intent, `QueuedDraftIntentsPayload.intents[${index}]`),
    );
    record = createApplicationChatQueuedDraftIntentsRecord(identity, intents);
  }
  return record as ApplicationChatStorageRecordForKind<Kind>;
}

export function createApplicationChatStorage(
  adapter: ApplicationChatStorageAdapter,
): ApplicationChatStorage {
  if (adapter === null || typeof adapter !== "object") {
    throw validationError("Application chat storage adapter must be an object");
  }
  for (const method of ["read", "replace", "remove", "clearForLogout"] as const) {
    if (typeof adapter[method] !== "function") {
      throw validationError(`Application chat storage adapter.${method} must be a function`);
    }
  }
  const compareExchange = adapter.compareExchange;
  if (compareExchange !== undefined && typeof compareExchange !== "function") {
    throw validationError(
      "Application chat storage adapter.compareExchange must be a function when provided",
    );
  }

  const readDecoded = async <Kind extends ApplicationChatStorageRecordKind>(
    identity: ApplicationChatStorageIdentity,
    kind: Kind,
  ): Promise<{
    readonly encoded: string | null;
    readonly record: ApplicationChatStorageRecordForKind<Kind> | null;
  }> => {
    const encoded = await adapter.read(identity, kind);
    if (encoded === null) return { encoded, record: null };
    try {
      return {
        encoded,
        record: decodeApplicationChatStorageRecord(encoded, identity, kind),
      };
    } catch {
      try {
        if (compareExchange === undefined) {
          await adapter.remove(identity, kind);
        } else {
          await compareExchange.call(adapter, identity, kind, encoded, null);
        }
      } catch {
        // The validation result must not expose adapter or record details.
      }
      throw validationError("Application chat storage record failed validation");
    }
  };

  return Object.freeze({
    async read<Kind extends ApplicationChatStorageRecordKind>(
      identity: ApplicationChatStorageIdentity,
      kind: Kind,
    ): Promise<ApplicationChatStorageRecordForKind<Kind> | null> {
      const trustedIdentity = parseApplicationChatStorageIdentity(identity);
      const trustedKind = parseRecordKind(kind) as Kind;
      return (await readDecoded(trustedIdentity, trustedKind)).record;
    },
    async replace(record: ApplicationChatStorageRecord): Promise<void> {
      const normalized = normalizePublicRecord(record);
      await adapter.replace(
        normalized.identity,
        normalized.kind,
        encodeApplicationChatStorageRecord(normalized),
      );
    },
    async remove(
      identity: ApplicationChatStorageIdentity,
      kind: ApplicationChatStorageRecordKind,
    ): Promise<void> {
      await adapter.remove(
        parseApplicationChatStorageIdentity(identity),
        parseRecordKind(kind),
      );
    },
    async mutate<Kind extends ApplicationChatStorageRecordKind>(
      identity: ApplicationChatStorageIdentity,
      kind: Kind,
      updater: ApplicationChatStorageUpdater<NoInfer<Kind>>,
    ): Promise<ApplicationChatStorageRecordForKind<Kind> | null> {
      const trustedIdentity = parseApplicationChatStorageIdentity(identity);
      const trustedKind = parseRecordKind(kind) as Kind;
      if (typeof updater !== "function") {
        throw validationError("Application chat storage mutation updater must be a function");
      }

      if (compareExchange === undefined) {
        const current = (await readDecoded(trustedIdentity, trustedKind)).record;
        const proposal = normalizeMutationProposal(
          updater(current),
          trustedIdentity,
          trustedKind,
        );
        if (proposal === null) {
          await adapter.remove(trustedIdentity, trustedKind);
        } else {
          await adapter.replace(
            trustedIdentity,
            trustedKind,
            encodeApplicationChatStorageRecord(proposal),
          );
        }
        return proposal;
      }

      for (
        let attempt = 0;
        attempt < MAX_APPLICATION_CHAT_STORAGE_MUTATION_ATTEMPTS;
        attempt += 1
      ) {
        const current = await readDecoded(trustedIdentity, trustedKind);
        const proposal = normalizeMutationProposal(
          updater(current.record),
          trustedIdentity,
          trustedKind,
        );
        const replacement = proposal === null
          ? null
          : encodeApplicationChatStorageRecord(proposal);
        if (await compareExchange.call(
          adapter,
          trustedIdentity,
          trustedKind,
          current.encoded,
          replacement,
        )) {
          return proposal;
        }
      }
      throw new ApplicationChatStorageUnavailableError();
    },
    ...(compareExchange === undefined
      ? {}
      : {
          async compareExchange(
            identity: ApplicationChatStorageIdentity,
            kind: ApplicationChatStorageRecordKind,
            expectedEncodedRecord: string | null,
            replacementEncodedRecord: string | null,
          ): Promise<boolean> {
            const trustedIdentity = parseApplicationChatStorageIdentity(identity);
            const trustedKind = parseRecordKind(kind);
            const trustedExpected = validateCompareExchangeEncodedRecord(
              expectedEncodedRecord,
              trustedIdentity,
              trustedKind,
              "expected value",
            );
            const trustedReplacement = validateCompareExchangeEncodedRecord(
              replacementEncodedRecord,
              trustedIdentity,
              trustedKind,
              "replacement",
            );
            return compareExchange.call(
              adapter,
              trustedIdentity,
              trustedKind,
              trustedExpected,
              trustedReplacement,
            );
          },
        }),
    async clearForLogout(identity: ApplicationChatStorageIdentity): Promise<void> {
      await adapter.clearForLogout(parseApplicationChatStorageIdentity(identity));
    },
  });
}

function normalizeMutationProposal<Kind extends ApplicationChatStorageRecordKind>(
  value: unknown,
  identity: ApplicationChatStorageIdentity,
  kind: Kind,
): ApplicationChatStorageRecordForKind<Kind> | null {
  if (isThenable(value)) {
    throw validationError(
      "Application chat storage mutation updater must return synchronously",
    );
  }
  if (value === null) return null;
  const normalized = normalizePublicRecord(value);
  if (!storageIdentitiesEqual(normalized.identity, identity)) {
    throw validationError(
      "Application chat storage mutation result identity must match its requested key",
    );
  }
  if (normalized.kind !== kind) {
    throw validationError(
      "Application chat storage mutation result kind must match its requested key",
    );
  }
  return normalized as ApplicationChatStorageRecordForKind<Kind>;
}

function isThenable(value: unknown): boolean {
  if (
    value === null
    || (typeof value !== "object" && typeof value !== "function")
  ) {
    return false;
  }
  try {
    return typeof (value as { readonly then?: unknown }).then === "function";
  } catch {
    return true;
  }
}

function validateCompareExchangeEncodedRecord(
  value: unknown,
  identity: ApplicationChatStorageIdentity,
  kind: ApplicationChatStorageRecordKind,
  role: "expected value" | "replacement",
): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw validationError(
      `Application chat storage compareExchange ${role} must be encoded JSON text or null`,
    );
  }
  try {
    decodeApplicationChatStorageRecord(value, identity, kind);
  } catch {
    throw validationError(
      `Application chat storage compareExchange ${role} must be a valid encoded record for its key`,
    );
  }
  return value;
}

function normalizePublicRecord(value: unknown): ApplicationChatStorageRecord {
  if (!isPlainRecord(value)) {
    throw validationError("Application chat storage record must be an object");
  }
  if (value.kind === ApplicationChatStorageRecordKind.normalizedSnapshot) {
    const record = requireExactRecord(
      value,
      ["schemaVersion", "kind", "identity", "snapshot"],
      "ApplicationChatNormalizedSnapshotRecord",
    );
    requireSnapshotSchemaVersion(record.schemaVersion);
    return createApplicationChatNormalizedSnapshotRecord(
      record.identity as ApplicationChatStorageIdentity,
      record.snapshot as NormalizedChatCacheState,
    );
  }
  if (value.kind === ApplicationChatStorageRecordKind.queuedSendMessageIntents) {
    const record = requireExactRecord(
      value,
      ["schemaVersion", "kind", "identity", "intents"],
      "ApplicationChatQueuedSendMessageIntentsRecord",
    );
    requireSchemaVersion(record.schemaVersion);
    if (!Array.isArray(record.intents)) {
      throw validationError("ApplicationChatQueuedSendMessageIntentsRecord.intents must be an array");
    }
    return createApplicationChatQueuedSendMessageIntentsRecord(
      record.identity as ApplicationChatStorageIdentity,
      record.intents as readonly ApplicationChatQueuedSendMessageIntent[],
    );
  }
  if (value.kind === ApplicationChatStorageRecordKind.queuedReadCursorIntents) {
    const record = requireExactRecord(
      value,
      ["schemaVersion", "kind", "identity", "intents"],
      "ApplicationChatQueuedReadCursorIntentsRecord",
    );
    requireSchemaVersion(record.schemaVersion);
    if (!Array.isArray(record.intents)) {
      throw validationError("ApplicationChatQueuedReadCursorIntentsRecord.intents must be an array");
    }
    return createApplicationChatQueuedReadCursorIntentsRecord(
      record.identity as ApplicationChatStorageIdentity,
      record.intents as readonly ApplicationChatQueuedReadCursorIntent[],
    );
  }
  if (value.kind === ApplicationChatStorageRecordKind.queuedMessageMutationIntents) {
    const record = requireExactRecord(
      value,
      ["schemaVersion", "kind", "identity", "intents"],
      "ApplicationChatQueuedMessageMutationIntentsRecord",
    );
    requireSchemaVersion(record.schemaVersion);
    if (!Array.isArray(record.intents)) {
      throw validationError("ApplicationChatQueuedMessageMutationIntentsRecord.intents must be an array");
    }
    return createApplicationChatQueuedMessageMutationIntentsRecord(
      record.identity as ApplicationChatStorageIdentity,
      record.intents as readonly ApplicationChatQueuedMessageMutationIntent[],
    );
  }
  if (value.kind === ApplicationChatStorageRecordKind.queuedConversationMembershipIntents) {
    const record = requireExactRecord(
      value,
      ["schemaVersion", "kind", "identity", "intents"],
      "ApplicationChatQueuedConversationMembershipIntentsRecord",
    );
    requireSchemaVersion(record.schemaVersion);
    if (!Array.isArray(record.intents)) {
      throw validationError(
        "ApplicationChatQueuedConversationMembershipIntentsRecord.intents must be an array",
      );
    }
    return createApplicationChatQueuedConversationMembershipIntentsRecord(
      record.identity as ApplicationChatStorageIdentity,
      record.intents as readonly ApplicationChatQueuedConversationMembershipIntent[],
    );
  }
  if (value.kind === ApplicationChatStorageRecordKind.queuedConversationCreationIntents) {
    const record = requireExactRecord(
      value,
      ["schemaVersion", "kind", "identity", "intents"],
      "ApplicationChatQueuedConversationCreationIntentsRecord",
    );
    requireSchemaVersion(record.schemaVersion);
    if (!Array.isArray(record.intents)) {
      throw validationError(
        "ApplicationChatQueuedConversationCreationIntentsRecord.intents must be an array",
      );
    }
    return createApplicationChatQueuedConversationCreationIntentsRecord(
      record.identity as ApplicationChatStorageIdentity,
      record.intents as readonly ApplicationChatQueuedConversationCreationIntent[],
    );
  }
  if (value.kind === ApplicationChatStorageRecordKind.queuedConversationPreferenceIntents) {
    const record = requireExactRecord(
      value,
      ["schemaVersion", "kind", "identity", "intents"],
      "ApplicationChatQueuedConversationPreferenceIntentsRecord",
    );
    requireSchemaVersion(record.schemaVersion);
    if (!Array.isArray(record.intents)) {
      throw validationError(
        "ApplicationChatQueuedConversationPreferenceIntentsRecord.intents must be an array",
      );
    }
    return createApplicationChatQueuedConversationPreferenceIntentsRecord(
      record.identity as ApplicationChatStorageIdentity,
      record.intents as readonly ApplicationChatQueuedConversationPreferenceIntent[],
    );
  }
  if (value.kind === ApplicationChatStorageRecordKind.queuedThreadFollowIntents) {
    const record = requireExactRecord(
      value,
      ["schemaVersion", "kind", "identity", "intents"],
      "ApplicationChatQueuedThreadFollowIntentsRecord",
    );
    requireSchemaVersion(record.schemaVersion);
    if (!Array.isArray(record.intents)) {
      throw validationError(
        "ApplicationChatQueuedThreadFollowIntentsRecord.intents must be an array",
      );
    }
    return createApplicationChatQueuedThreadFollowIntentsRecord(
      record.identity as ApplicationChatStorageIdentity,
      record.intents as readonly ApplicationChatQueuedThreadFollowIntent[],
    );
  }
  if (value.kind === ApplicationChatStorageRecordKind.queuedSavedMessageIntents) {
    const record = requireExactRecord(
      value,
      ["schemaVersion", "kind", "identity", "intents"],
      "ApplicationChatQueuedSavedMessageIntentsRecord",
    );
    requireSchemaVersion(record.schemaVersion);
    if (!Array.isArray(record.intents)) {
      throw validationError(
        "ApplicationChatQueuedSavedMessageIntentsRecord.intents must be an array",
      );
    }
    return createApplicationChatQueuedSavedMessageIntentsRecord(
      record.identity as ApplicationChatStorageIdentity,
      record.intents as readonly ApplicationChatQueuedSavedMessageIntent[],
    );
  }
  if (value.kind === ApplicationChatStorageRecordKind.queuedMessageReminderIntents) {
    const record = requireExactRecord(
      value,
      ["schemaVersion", "kind", "identity", "intents"],
      "ApplicationChatQueuedMessageReminderIntentsRecord",
    );
    requireSchemaVersion(record.schemaVersion);
    if (!Array.isArray(record.intents)) {
      throw validationError(
        "ApplicationChatQueuedMessageReminderIntentsRecord.intents must be an array",
      );
    }
    return createApplicationChatQueuedMessageReminderIntentsRecord(
      record.identity as ApplicationChatStorageIdentity,
      record.intents as readonly ApplicationChatQueuedMessageReminderIntent[],
    );
  }
  if (value.kind === ApplicationChatStorageRecordKind.queuedConversationArchiveIntents) {
    const record = requireExactRecord(
      value,
      ["schemaVersion", "kind", "identity", "intents"],
      "ApplicationChatQueuedConversationArchiveIntentsRecord",
    );
    requireSchemaVersion(record.schemaVersion);
    if (!Array.isArray(record.intents)) {
      throw validationError(
        "ApplicationChatQueuedConversationArchiveIntentsRecord.intents must be an array",
      );
    }
    return createApplicationChatQueuedConversationArchiveIntentsRecord(
      record.identity as ApplicationChatStorageIdentity,
      record.intents as readonly ApplicationChatQueuedConversationArchiveIntent[],
    );
  }
  if (value.kind === ApplicationChatStorageRecordKind.queuedHuddleCommandIntents) {
    const record = requireExactRecord(
      value,
      ["schemaVersion", "kind", "identity", "intents"],
      "ApplicationChatQueuedHuddleCommandIntentsRecord",
    );
    requireSchemaVersion(record.schemaVersion);
    if (!Array.isArray(record.intents)) {
      throw validationError(
        "ApplicationChatQueuedHuddleCommandIntentsRecord.intents must be an array",
      );
    }
    return createApplicationChatQueuedHuddleCommandIntentsRecord(
      record.identity as ApplicationChatStorageIdentity,
      record.intents as readonly ApplicationChatQueuedHuddleCommandIntent[],
    );
  }
  if (value.kind === ApplicationChatStorageRecordKind.queuedDraftIntents) {
    const record = requireExactRecord(
      value,
      ["schemaVersion", "kind", "identity", "intents"],
      "ApplicationChatQueuedDraftIntentsRecord",
    );
    requireSchemaVersion(record.schemaVersion);
    if (!Array.isArray(record.intents)) {
      throw validationError("ApplicationChatQueuedDraftIntentsRecord.intents must be an array");
    }
    return createApplicationChatQueuedDraftIntentsRecord(
      record.identity as ApplicationChatStorageIdentity,
      record.intents as readonly ApplicationChatQueuedDraftIntent[],
    );
  }
  throw validationError(`Unsupported application chat storage record kind: ${String(value.kind)}`);
}

function parsePublicIntent(value: unknown, path: string): ApplicationChatQueuedSendMessageIntent {
  const intent = requireExactRecord(
    value,
    ["contractVersion", "enqueueOrder", "enqueuedAt", "request"],
    path,
  );
  requireSendContractVersion(intent.contractVersion);
  return createApplicationChatQueuedSendMessageIntent(
    intent.request as SendMessageInput,
    {
      enqueueOrder: requirePositiveSafeInteger(intent.enqueueOrder, `${path}.enqueueOrder`),
      enqueuedAt: readIsoTimestamp(intent.enqueuedAt, `${path}.enqueuedAt`),
    },
  );
}

function parseWireIntent(value: unknown, path: string): ApplicationChatQueuedSendMessageIntent {
  const intent = requireExactRecord(
    value,
    [
      "contractVersion",
      "enqueueOrder",
      "enqueuedAt",
      "conversationId",
      "content",
      "clientMessageId",
      "idempotencyKey",
      ...(isPlainRecord(value) && Object.hasOwn(value, "replyTo") ? ["replyTo"] : []),
    ],
    path,
  );
  requireSendContractVersion(intent.contractVersion);
  return createApplicationChatQueuedSendMessageIntent(
    {
      operation: "send",
      conversationId: intent.conversationId as SendMessageInput["conversationId"],
      content: intent.content as SendMessageInput["content"],
      clientMessageId: intent.clientMessageId as string,
      idempotencyKey: intent.idempotencyKey as string,
      ...(Object.hasOwn(intent, "replyTo")
        ? { replyTo: intent.replyTo as NonNullable<SendMessageInput["replyTo"]> }
        : {}),
    },
    {
      enqueueOrder: requirePositiveSafeInteger(intent.enqueueOrder, `${path}.enqueueOrder`),
      enqueuedAt: readIsoTimestamp(intent.enqueuedAt, `${path}.enqueuedAt`),
    },
  );
}

function parsePublicReadCursorIntent(
  value: unknown,
  path: string,
): ApplicationChatQueuedReadCursorIntent {
  const intent = requireExactRecord(
    value,
    ["contractVersion", "enqueueOrder", "enqueuedAt", "request", "acknowledgedReadState"],
    path,
  );
  requireReadCursorContractVersion(intent.contractVersion);
  return createApplicationChatQueuedReadCursorIntent(
    intent.request as ReadCursorMutationInput,
    intent.acknowledgedReadState as ConversationReadState,
    {
      enqueueOrder: requirePositiveSafeInteger(intent.enqueueOrder, `${path}.enqueueOrder`),
      enqueuedAt: readIsoTimestamp(intent.enqueuedAt, `${path}.enqueuedAt`),
    },
  );
}

function parseWireReadCursorIntent(
  value: unknown,
  path: string,
): ApplicationChatQueuedReadCursorIntent {
  assertEncodedSize(
    JSON.stringify(value),
    MAX_APPLICATION_CHAT_QUEUED_READ_CURSOR_INTENT_BYTES,
    "Queued read-cursor intent",
  );
  if (!isPlainRecord(value)) {
    throw validationError(`${path} must be a JSON object`);
  }
  const sequenceField = value.operation === "mark_read"
    ? "throughSequence"
    : value.operation === "mark_unread"
      ? "fromSequence"
      : null;
  if (sequenceField === null) {
    throw validationError(`${path}.operation must be mark_read or mark_unread`);
  }
  const intent = requireExactRecord(
    value,
    [
      "contractVersion",
      "enqueueOrder",
      "enqueuedAt",
      "operation",
      "conversationId",
      sequenceField,
      "idempotencyKey",
      "acknowledgedReadState",
    ],
    path,
  );
  requireReadCursorContractVersion(intent.contractVersion);
  const request = {
    operation: intent.operation,
    conversationId: intent.conversationId,
    [sequenceField]: intent[sequenceField],
    idempotencyKey: intent.idempotencyKey,
  } as unknown as ReadCursorMutationInput;
  return createApplicationChatQueuedReadCursorIntent(
    request,
    intent.acknowledgedReadState as ConversationReadState,
    {
      enqueueOrder: requirePositiveSafeInteger(intent.enqueueOrder, `${path}.enqueueOrder`),
      enqueuedAt: readIsoTimestamp(intent.enqueuedAt, `${path}.enqueuedAt`),
    },
  );
}

function parsePublicMessageMutationIntent(
  value: unknown,
  path: string,
): ApplicationChatQueuedMessageMutationIntent {
  const intent = requireExactRecord(
    value,
    ["contractVersion", "enqueueOrder", "enqueuedAt", "request"],
    path,
  );
  requireMessageMutationContractVersion(intent.contractVersion);
  return createApplicationChatQueuedMessageMutationIntent(
    intent.request as ApplicationChatMessageMutationRequest,
    {
      enqueueOrder: requirePositiveSafeInteger(intent.enqueueOrder, `${path}.enqueueOrder`),
      enqueuedAt: readIsoTimestamp(intent.enqueuedAt, `${path}.enqueuedAt`),
    },
  );
}

function parseWireMessageMutationIntent(
  value: unknown,
  path: string,
): ApplicationChatQueuedMessageMutationIntent {
  assertEncodedSize(
    JSON.stringify(value),
    MAX_APPLICATION_CHAT_QUEUED_MESSAGE_MUTATION_INTENT_BYTES,
    "Queued message-mutation intent",
  );
  if (!isPlainRecord(value)) {
    throw validationError(`${path} must be a JSON object`);
  }
  const commandFields = messageMutationCommandFields(value.operation, path);
  const intent = requireExactRecord(
    value,
    ["contractVersion", "enqueueOrder", "enqueuedAt", ...commandFields],
    path,
  );
  requireMessageMutationContractVersion(intent.contractVersion);
  const request = Object.fromEntries(
    commandFields.map((field) => [field, intent[field]]),
  ) as unknown as ApplicationChatMessageMutationRequest;
  return createApplicationChatQueuedMessageMutationIntent(request, {
    enqueueOrder: requirePositiveSafeInteger(intent.enqueueOrder, `${path}.enqueueOrder`),
    enqueuedAt: readIsoTimestamp(intent.enqueuedAt, `${path}.enqueuedAt`),
  });
}

function parsePublicConversationMembershipIntent(
  value: unknown,
  path: string,
): ApplicationChatQueuedConversationMembershipIntent {
  const intent = requireExactRecord(
    value,
    ["contractVersion", "enqueueOrder", "enqueuedAt", "request"],
    path,
  );
  requireConversationMembershipContractVersion(intent.contractVersion);
  return createApplicationChatQueuedConversationMembershipIntent(
    intent.request as ConversationMembershipMutationInput,
    {
      enqueueOrder: requirePositiveSafeInteger(intent.enqueueOrder, `${path}.enqueueOrder`),
      enqueuedAt: readIsoTimestamp(intent.enqueuedAt, `${path}.enqueuedAt`),
    },
  );
}

function parseWireConversationMembershipIntent(
  value: unknown,
  path: string,
): ApplicationChatQueuedConversationMembershipIntent {
  assertEncodedSize(
    JSON.stringify(value),
    MAX_APPLICATION_CHAT_QUEUED_CONVERSATION_MEMBERSHIP_INTENT_BYTES,
    "Queued conversation-membership intent",
  );
  if (!isPlainRecord(value)) {
    throw validationError(`${path} must be a JSON object`);
  }
  const requestFields = conversationMembershipCommandFields(value.intent, path);
  const intent = requireExactRecord(
    value,
    ["contractVersion", "enqueueOrder", "enqueuedAt", ...requestFields],
    path,
  );
  requireConversationMembershipContractVersion(intent.contractVersion);
  const request = Object.fromEntries(
    requestFields.map((field) => [field, intent[field]]),
  ) as unknown as ConversationMembershipMutationInput;
  return createApplicationChatQueuedConversationMembershipIntent(request, {
    enqueueOrder: requirePositiveSafeInteger(intent.enqueueOrder, `${path}.enqueueOrder`),
    enqueuedAt: readIsoTimestamp(intent.enqueuedAt, `${path}.enqueuedAt`),
  });
}

function parsePublicConversationCreationIntent(
  value: unknown,
  path: string,
): ApplicationChatQueuedConversationCreationIntent {
  const intent = requireExactRecord(
    value,
    ["contractVersion", "enqueueOrder", "enqueuedAt", "request"],
    path,
  );
  requireConversationCreationContractVersion(intent.contractVersion);
  return createApplicationChatQueuedConversationCreationIntent(
    intent.request as ConversationCreationInput,
    {
      enqueueOrder: requirePositiveSafeInteger(intent.enqueueOrder, `${path}.enqueueOrder`),
      enqueuedAt: readIsoTimestamp(intent.enqueuedAt, `${path}.enqueuedAt`),
    },
  );
}

function parseWireConversationCreationIntent(
  value: unknown,
  path: string,
): ApplicationChatQueuedConversationCreationIntent {
  assertEncodedSize(
    JSON.stringify(value),
    MAX_APPLICATION_CHAT_QUEUED_CONVERSATION_CREATION_INTENT_BYTES,
    "Queued conversation-creation intent",
  );
  if (!isPlainRecord(value)) {
    throw validationError(`${path} must be a JSON object`);
  }
  const requestFields = conversationCreationCommandFields(value, path);
  const intent = requireExactRecord(
    value,
    ["contractVersion", "enqueueOrder", "enqueuedAt", ...requestFields],
    path,
  );
  requireConversationCreationContractVersion(intent.contractVersion);
  const request = Object.fromEntries(
    requestFields.map((field) => [field, intent[field]]),
  ) as unknown as ConversationCreationInput;
  const parsed = createApplicationChatQueuedConversationCreationIntent(request, {
    enqueueOrder: requirePositiveSafeInteger(intent.enqueueOrder, `${path}.enqueueOrder`),
    enqueuedAt: readIsoTimestamp(intent.enqueuedAt, `${path}.enqueuedAt`),
  });
  if (
    parsed.request.type !== "channel" &&
    !sameStringOrder(
      intent.intendedMemberUserIds,
      parsed.request.intendedMemberUserIds,
    )
  ) {
    throw validationError(
      `${path}.intendedMemberUserIds must use canonical string order`,
    );
  }
  return parsed;
}

function parsePublicConversationPreferenceIntent(
  value: unknown,
  path: string,
): ApplicationChatQueuedConversationPreferenceIntent {
  const intent = requireExactRecord(
    value,
    ["contractVersion", "enqueueOrder", "enqueuedAt", "request"],
    path,
  );
  requireConversationPreferenceContractVersion(intent.contractVersion);
  return createApplicationChatQueuedConversationPreferenceIntent(
    intent.request as UpdateConversationPreferenceInput,
    {
      enqueueOrder: requirePositiveSafeInteger(intent.enqueueOrder, `${path}.enqueueOrder`),
      enqueuedAt: readIsoTimestamp(intent.enqueuedAt, `${path}.enqueuedAt`),
    },
  );
}

function parseWireConversationPreferenceIntent(
  value: unknown,
  path: string,
): ApplicationChatQueuedConversationPreferenceIntent {
  assertEncodedSize(
    JSON.stringify(value),
    MAX_APPLICATION_CHAT_QUEUED_CONVERSATION_PREFERENCE_INTENT_BYTES,
    "Queued conversation-preference intent",
  );
  const intent = requireExactRecord(
    value,
    [
      "contractVersion",
      "enqueueOrder",
      "enqueuedAt",
      "operation",
      "conversationId",
      "expectedPreferenceRevision",
      "idempotencyKey",
      "notificationPreference",
      "isStarred",
      "mute",
    ],
    path,
  );
  requireConversationPreferenceContractVersion(intent.contractVersion);
  return createApplicationChatQueuedConversationPreferenceIntent(
    {
      operation: intent.operation,
      conversationId: intent.conversationId,
      expectedPreferenceRevision: intent.expectedPreferenceRevision,
      idempotencyKey: intent.idempotencyKey,
      notificationPreference: intent.notificationPreference,
      isStarred: intent.isStarred,
      mute: intent.mute,
    } as UpdateConversationPreferenceInput,
    {
      enqueueOrder: requirePositiveSafeInteger(intent.enqueueOrder, `${path}.enqueueOrder`),
      enqueuedAt: readIsoTimestamp(intent.enqueuedAt, `${path}.enqueuedAt`),
    },
  );
}

function parsePublicThreadFollowIntent(
  value: unknown,
  path: string,
): ApplicationChatQueuedThreadFollowIntent {
  const intent = requireExactRecord(
    value,
    ["contractVersion", "enqueueOrder", "enqueuedAt", "request"],
    path,
  );
  requireThreadFollowContractVersion(intent.contractVersion);
  return createApplicationChatQueuedThreadFollowIntent(
    intent.request as SetThreadFollowInput,
    {
      enqueueOrder: requirePositiveSafeInteger(intent.enqueueOrder, `${path}.enqueueOrder`),
      enqueuedAt: readIsoTimestamp(intent.enqueuedAt, `${path}.enqueuedAt`),
    },
  );
}

function parseWireThreadFollowIntent(
  value: unknown,
  path: string,
): ApplicationChatQueuedThreadFollowIntent {
  assertEncodedSize(
    JSON.stringify(value),
    MAX_APPLICATION_CHAT_QUEUED_THREAD_FOLLOW_INTENT_BYTES,
    "Queued thread-follow intent",
  );
  const intent = requireExactRecord(
    value,
    [
      "contractVersion",
      "enqueueOrder",
      "enqueuedAt",
      "operation",
      "intent",
      "target",
      "expectedFollowRevision",
      "idempotencyKey",
    ],
    path,
  );
  requireThreadFollowContractVersion(intent.contractVersion);
  return createApplicationChatQueuedThreadFollowIntent(
    {
      operation: intent.operation,
      intent: intent.intent,
      target: intent.target,
      expectedFollowRevision: intent.expectedFollowRevision,
      idempotencyKey: intent.idempotencyKey,
    } as SetThreadFollowInput,
    {
      enqueueOrder: requirePositiveSafeInteger(intent.enqueueOrder, `${path}.enqueueOrder`),
      enqueuedAt: readIsoTimestamp(intent.enqueuedAt, `${path}.enqueuedAt`),
    },
  );
}

function parsePublicSavedMessageIntent(
  value: unknown,
  path: string,
): ApplicationChatQueuedSavedMessageIntent {
  const intent = requireExactRecord(
    value,
    ["contractVersion", "enqueueOrder", "enqueuedAt", "request"],
    path,
  );
  requireSavedMessageContractVersion(intent.contractVersion);
  return createApplicationChatQueuedSavedMessageIntent(
    intent.request as SetSavedMessageInput,
    {
      enqueueOrder: requirePositiveSafeInteger(intent.enqueueOrder, `${path}.enqueueOrder`),
      enqueuedAt: readIsoTimestamp(intent.enqueuedAt, `${path}.enqueuedAt`),
    },
  );
}

function parseWireSavedMessageIntent(
  value: unknown,
  path: string,
): ApplicationChatQueuedSavedMessageIntent {
  assertEncodedSize(
    JSON.stringify(value),
    MAX_APPLICATION_CHAT_QUEUED_SAVED_MESSAGE_INTENT_BYTES,
    "Queued saved-message intent",
  );
  if (!isPlainRecord(value)) {
    throw validationError(`${path} must be a JSON object`);
  }
  const requestFields = value.intent === "save"
    ? Object.hasOwn(value, "privateNote")
      ? [
        "operation",
        "intent",
        "messageId",
        "expectedSavedMessageRevision",
        "idempotencyKey",
        "privateNote",
      ] as const
      : [
        "operation",
        "intent",
        "messageId",
        "expectedSavedMessageRevision",
        "idempotencyKey",
      ] as const
    : value.intent === "unsave"
      ? [
        "operation",
        "intent",
        "messageId",
        "expectedSavedMessageRevision",
        "idempotencyKey",
      ] as const
      : null;
  if (requestFields === null) {
    throw validationError(`${path}.intent must be save or unsave`);
  }
  const intent = requireExactRecord(
    value,
    ["contractVersion", "enqueueOrder", "enqueuedAt", ...requestFields],
    path,
  );
  requireSavedMessageContractVersion(intent.contractVersion);
  const request = Object.fromEntries(
    requestFields.map((field) => [field, intent[field]]),
  ) as unknown as SetSavedMessageInput;
  return createApplicationChatQueuedSavedMessageIntent(request, {
    enqueueOrder: requirePositiveSafeInteger(intent.enqueueOrder, `${path}.enqueueOrder`),
    enqueuedAt: readIsoTimestamp(intent.enqueuedAt, `${path}.enqueuedAt`),
  });
}

function parsePublicMessageReminderIntent(
  value: unknown,
  path: string,
): ApplicationChatQueuedMessageReminderIntent {
  const intent = requireExactRecord(
    value,
    ["contractVersion", "enqueueOrder", "enqueuedAt", "request"],
    path,
  );
  requireMessageReminderContractVersion(intent.contractVersion);
  return createApplicationChatQueuedMessageReminderIntent(
    intent.request as MessageReminderInput,
    {
      enqueueOrder: requirePositiveSafeInteger(intent.enqueueOrder, `${path}.enqueueOrder`),
      enqueuedAt: readIsoTimestamp(intent.enqueuedAt, `${path}.enqueuedAt`),
    },
  );
}

function parseWireMessageReminderIntent(
  value: unknown,
  path: string,
): ApplicationChatQueuedMessageReminderIntent {
  assertEncodedSize(
    JSON.stringify(value),
    MAX_APPLICATION_CHAT_QUEUED_MESSAGE_REMINDER_INTENT_BYTES,
    "Queued message-reminder intent",
  );
  if (!isPlainRecord(value)) {
    throw validationError(`${path} must be a JSON object`);
  }
  const requestFields = value.intent === "set"
    ? [
      "operation",
      "intent",
      "conversationId",
      "messageId",
      "expectedReminderRevision",
      "idempotencyKey",
      "dueAt",
    ] as const
    : value.intent === "cancel"
      ? [
        "operation",
        "intent",
        "conversationId",
        "messageId",
        "expectedReminderRevision",
        "idempotencyKey",
      ] as const
      : null;
  if (requestFields === null) {
    throw validationError(`${path}.intent must be set or cancel`);
  }
  const intent = requireExactRecord(
    value,
    ["contractVersion", "enqueueOrder", "enqueuedAt", ...requestFields],
    path,
  );
  requireMessageReminderContractVersion(intent.contractVersion);
  const request = Object.fromEntries(
    requestFields.map((field) => [field, intent[field]]),
  ) as unknown as MessageReminderInput;
  return createApplicationChatQueuedMessageReminderIntent(request, {
    enqueueOrder: requirePositiveSafeInteger(intent.enqueueOrder, `${path}.enqueueOrder`),
    enqueuedAt: readIsoTimestamp(intent.enqueuedAt, `${path}.enqueuedAt`),
  });
}

function parsePublicConversationArchiveIntent(
  value: unknown,
  path: string,
): ApplicationChatQueuedConversationArchiveIntent {
  const intent = requireExactRecord(
    value,
    ["contractVersion", "enqueueOrder", "enqueuedAt", "request"],
    path,
  );
  requireConversationArchiveContractVersion(intent.contractVersion);
  return createApplicationChatQueuedConversationArchiveIntent(
    intent.request as ConversationArchiveInput,
    {
      enqueueOrder: requirePositiveSafeInteger(intent.enqueueOrder, `${path}.enqueueOrder`),
      enqueuedAt: readIsoTimestamp(intent.enqueuedAt, `${path}.enqueuedAt`),
    },
  );
}

function parseWireConversationArchiveIntent(
  value: unknown,
  path: string,
): ApplicationChatQueuedConversationArchiveIntent {
  assertEncodedSize(
    JSON.stringify(value),
    MAX_APPLICATION_CHAT_QUEUED_CONVERSATION_ARCHIVE_INTENT_BYTES,
    "Queued conversation-archive intent",
  );
  const intent = requireExactRecord(
    value,
    [
      "contractVersion",
      "enqueueOrder",
      "enqueuedAt",
      "operation",
      "intent",
      "conversationId",
      "expectedLifecycleRevision",
      "idempotencyKey",
    ],
    path,
  );
  requireConversationArchiveContractVersion(intent.contractVersion);
  return createApplicationChatQueuedConversationArchiveIntent(
    {
      operation: intent.operation,
      intent: intent.intent,
      conversationId: intent.conversationId,
      expectedLifecycleRevision: intent.expectedLifecycleRevision,
      idempotencyKey: intent.idempotencyKey,
    } as ConversationArchiveInput,
    {
      enqueueOrder: requirePositiveSafeInteger(intent.enqueueOrder, `${path}.enqueueOrder`),
      enqueuedAt: readIsoTimestamp(intent.enqueuedAt, `${path}.enqueuedAt`),
    },
  );
}

function parsePublicHuddleCommandIntent(
  value: unknown,
  path: string,
): ApplicationChatQueuedHuddleCommandIntent {
  const intent = requireExactRecord(
    value,
    ["contractVersion", "enqueueOrder", "enqueuedAt", "request"],
    path,
  );
  requireHuddleCommandContractVersion(intent.contractVersion);
  return createApplicationChatQueuedHuddleCommandIntent(
    intent.request as HuddleCommandInput,
    {
      enqueueOrder: requirePositiveSafeInteger(intent.enqueueOrder, `${path}.enqueueOrder`),
      enqueuedAt: readIsoTimestamp(intent.enqueuedAt, `${path}.enqueuedAt`),
    },
  );
}

function parseWireHuddleCommandIntent(
  value: unknown,
  path: string,
): ApplicationChatQueuedHuddleCommandIntent {
  assertEncodedSize(
    JSON.stringify(value),
    MAX_APPLICATION_CHAT_QUEUED_HUDDLE_COMMAND_INTENT_BYTES,
    "Queued huddle-command intent",
  );
  if (!isPlainRecord(value)) {
    throw validationError(`${path} must be a JSON object`);
  }
  const requestFields = huddleCommandRequestFields(value, path);
  const intent = requireExactRecord(
    value,
    ["contractVersion", "enqueueOrder", "enqueuedAt", ...requestFields],
    path,
  );
  requireHuddleCommandContractVersion(intent.contractVersion);
  const request = Object.fromEntries(
    requestFields.map((field) => [field, intent[field]]),
  ) as unknown as HuddleCommandInput;
  return createApplicationChatQueuedHuddleCommandIntent(request, {
    enqueueOrder: requirePositiveSafeInteger(intent.enqueueOrder, `${path}.enqueueOrder`),
    enqueuedAt: readIsoTimestamp(intent.enqueuedAt, `${path}.enqueuedAt`),
  });
}

function huddleCommandRequestFields(
  value: Record<string, unknown>,
  path: string,
): readonly string[] {
  switch (value.operation) {
    case "start_huddle":
      return ["operation", "conversationId", "idempotencyKey"];
    case "join_huddle":
    case "leave_huddle":
    case "end_huddle":
      return ["operation", "huddleSessionId", "idempotencyKey"];
    case "set_huddle_screen_share":
      return ["operation", "huddleSessionId", "intent", "idempotencyKey"];
    default:
      throw validationError(`${path}.operation is not a supported huddle command`);
  }
}

function parsePublicDraftIntent(
  value: unknown,
  path: string,
): ApplicationChatQueuedDraftIntent {
  const intent = requireExactRecord(
    value,
    ["contractVersion", "enqueueOrder", "enqueuedAt", "request"],
    path,
  );
  requireDraftMutationContractVersion(intent.contractVersion);
  return createApplicationChatQueuedDraftIntent(
    intent.request as SynchronizeDraftInput,
    {
      enqueueOrder: requirePositiveSafeInteger(intent.enqueueOrder, `${path}.enqueueOrder`),
      enqueuedAt: readIsoTimestamp(intent.enqueuedAt, `${path}.enqueuedAt`),
    },
  );
}

function parseWireDraftIntent(
  value: unknown,
  path: string,
): ApplicationChatQueuedDraftIntent {
  assertEncodedSize(
    JSON.stringify(value),
    MAX_APPLICATION_CHAT_QUEUED_DRAFT_INTENT_BYTES,
    "Queued draft intent",
  );
  if (!isPlainRecord(value)) {
    throw validationError(`${path} must be a JSON object`);
  }
  const requestFields = value.intent === "replace"
    ? [
      "operation",
      "intent",
      "conversationId",
      "baseRevision",
      "deviceMutationId",
      "idempotencyKey",
      "content",
    ] as const
    : value.intent === "clear"
      ? [
        "operation",
        "intent",
        "conversationId",
        "baseRevision",
        "deviceMutationId",
        "idempotencyKey",
      ] as const
      : null;
  if (requestFields === null) {
    throw validationError(`${path}.intent must be replace or clear`);
  }
  const intent = requireExactRecord(
    value,
    ["contractVersion", "enqueueOrder", "enqueuedAt", ...requestFields],
    path,
  );
  requireDraftMutationContractVersion(intent.contractVersion);
  const request = Object.fromEntries(
    requestFields.map((field) => [field, intent[field]]),
  ) as unknown as SynchronizeDraftInput;
  return createApplicationChatQueuedDraftIntent(request, {
    enqueueOrder: requirePositiveSafeInteger(intent.enqueueOrder, `${path}.enqueueOrder`),
    enqueuedAt: readIsoTimestamp(intent.enqueuedAt, `${path}.enqueuedAt`),
  });
}

function parseMessageMutationRequest<Block extends MessageBlock = MessageBlock>(
  value: unknown,
): ApplicationChatMessageMutationRequest<Block> {
  if (!isPlainRecord(value)) {
    throw validationError("Queued message-mutation request must be a JSON object");
  }
  try {
    switch (value.operation) {
      case "forward_message.v1":
        return parseForwardMessageInput(value);
      case "edit":
        return parseEditMessageInput<Block>(value);
      case "soft_delete":
        return parseSoftDeleteMessageInput(value);
      case "add_reaction":
      case "remove_reaction":
        return parseReactionMutationInput(value);
      default:
        throw validationError(
          `Queued message-mutation request operation is unsupported: ${String(value.operation)}`,
        );
    }
  } catch (error) {
    if (error instanceof ApplicationChatStorageValidationError) throw error;
    throw validationError(
      `Queued message-mutation request is invalid: ${error instanceof Error ? error.message : "unknown validation failure"}`,
    );
  }
}

function messageMutationCommandFields(
  operation: unknown,
  path: string,
): readonly string[] {
  switch (operation) {
    case "forward_message.v1":
      return [
        "operation",
        "sourceMessageId",
        "destinationConversationId",
        "clientCorrelationId",
        "idempotencyKey",
      ];
    case "edit":
      return ["operation", "messageId", "expectedRevision", "content", "idempotencyKey"];
    case "soft_delete":
      return ["operation", "messageId", "expectedRevision", "idempotencyKey"];
    case "add_reaction":
    case "remove_reaction":
      return ["operation", "messageId", "reactionKey", "idempotencyKey"];
    default:
      throw validationError(`${path}.operation is not a supported message mutation`);
  }
}

function conversationMembershipCommandFields(
  intent: unknown,
  path: string,
): readonly string[] {
  const base = [
    "operation",
    "intent",
    "conversationId",
    "expectedMemberListRevision",
    "idempotencyKey",
  ] as const;
  switch (intent) {
    case "join":
    case "leave":
      return base;
    case "remove_member":
      return [...base, "targetUserId"];
    case "add_member":
    case "change_member_role":
      return [...base, "targetUserId", "requestedRole"];
    default:
      throw validationError(`${path}.intent is not a supported membership mutation`);
  }
}

function conversationCreationCommandFields(
  value: Record<string, unknown>,
  path: string,
): readonly string[] {
  const base = [
    "operation",
    "type",
    "idempotencyKey",
    "clientRequestId",
  ] as const;
  switch (value.type) {
    case "channel":
      return Object.hasOwn(value, "entity")
        ? [...base, "name", "visibility", "entity"]
        : [...base, "name", "visibility"];
    case "direct":
    case "group_direct":
      return [...base, "visibility", "intendedMemberUserIds"];
    default:
      throw validationError(`${path}.type is not a supported conversation creation`);
  }
}

function validateIntentOrderAndUniqueness(
  intents: readonly ApplicationChatQueuedSendMessageIntent[],
): void {
  const clientMessageIds = new Set<string>();
  const idempotencyKeys = new Set<string>();
  let previousOrder = 0;
  for (const intent of intents) {
    if (intent.enqueueOrder <= previousOrder) {
      throw validationError("Queued send intents must have strictly increasing FIFO order");
    }
    if (clientMessageIds.has(intent.request.clientMessageId)) {
      throw validationError("Queued send intent clientMessageId values must be unique");
    }
    clientMessageIds.add(intent.request.clientMessageId);
    if (idempotencyKeys.has(intent.request.idempotencyKey)) {
      throw validationError("Queued send intent idempotencyKey values must be unique");
    }
    idempotencyKeys.add(intent.request.idempotencyKey);
    previousOrder = intent.enqueueOrder;
  }
}

function validateReadCursorIntentOrderAndUniqueness(
  intents: readonly ApplicationChatQueuedReadCursorIntent[],
): void {
  const idempotencyKeys = new Set<string>();
  let previousOrder = 0;
  for (const intent of intents) {
    if (intent.enqueueOrder <= previousOrder) {
      throw validationError("Queued read-cursor intents must have strictly increasing FIFO order");
    }
    if (idempotencyKeys.has(intent.request.idempotencyKey)) {
      throw validationError("Queued read-cursor intent idempotencyKey values must be unique");
    }
    idempotencyKeys.add(intent.request.idempotencyKey);
    previousOrder = intent.enqueueOrder;
  }
}

function validateMessageMutationIntentOrderAndUniqueness(
  intents: readonly ApplicationChatQueuedMessageMutationIntent[],
): void {
  const clientCorrelationIds = new Set<string>();
  const idempotencyKeys = new Set<string>();
  let previousOrder = 0;
  for (const intent of intents) {
    if (intent.enqueueOrder <= previousOrder) {
      throw validationError(
        "Queued message-mutation intents must have strictly increasing FIFO order",
      );
    }
    if (intent.request.operation === "forward_message.v1") {
      if (clientCorrelationIds.has(intent.request.clientCorrelationId)) {
        throw validationError(
          "Queued forward-message intent clientCorrelationId values must be unique",
        );
      }
      clientCorrelationIds.add(intent.request.clientCorrelationId);
    }
    if (idempotencyKeys.has(intent.request.idempotencyKey)) {
      throw validationError(
        "Queued message-mutation intent idempotencyKey values must be unique",
      );
    }
    idempotencyKeys.add(intent.request.idempotencyKey);
    previousOrder = intent.enqueueOrder;
  }
}

function validateConversationMembershipIntentOrderAndUniqueness(
  intents: readonly ApplicationChatQueuedConversationMembershipIntent[],
): void {
  const idempotencyKeys = new Set<string>();
  let previousOrder = 0;
  for (const intent of intents) {
    if (intent.enqueueOrder <= previousOrder) {
      throw validationError(
        "Queued conversation-membership intents must have strictly increasing FIFO order",
      );
    }
    if (idempotencyKeys.has(intent.request.idempotencyKey)) {
      throw validationError(
        "Queued conversation-membership intent idempotencyKey values must be unique",
      );
    }
    idempotencyKeys.add(intent.request.idempotencyKey);
    previousOrder = intent.enqueueOrder;
  }
}

function validateConversationCreationIntentOrderAndUniqueness(
  intents: readonly ApplicationChatQueuedConversationCreationIntent[],
): void {
  const clientRequestIds = new Set<string>();
  const idempotencyKeys = new Set<string>();
  let previousOrder = 0;
  for (const intent of intents) {
    if (intent.enqueueOrder <= previousOrder) {
      throw validationError(
        "Queued conversation-creation intents must have strictly increasing FIFO order",
      );
    }
    if (clientRequestIds.has(intent.request.clientRequestId)) {
      throw validationError(
        "Queued conversation-creation intent clientRequestId values must be unique",
      );
    }
    clientRequestIds.add(intent.request.clientRequestId);
    if (idempotencyKeys.has(intent.request.idempotencyKey)) {
      throw validationError(
        "Queued conversation-creation intent idempotencyKey values must be unique",
      );
    }
    idempotencyKeys.add(intent.request.idempotencyKey);
    previousOrder = intent.enqueueOrder;
  }
}

function validateConversationPreferenceIntentOrderAndUniqueness(
  intents: readonly ApplicationChatQueuedConversationPreferenceIntent[],
): void {
  const idempotencyKeys = new Set<string>();
  let previousOrder = 0;
  for (const intent of intents) {
    if (intent.enqueueOrder <= previousOrder) {
      throw validationError(
        "Queued conversation-preference intents must have strictly increasing FIFO order",
      );
    }
    if (idempotencyKeys.has(intent.request.idempotencyKey)) {
      throw validationError(
        "Queued conversation-preference intent idempotencyKey values must be unique",
      );
    }
    idempotencyKeys.add(intent.request.idempotencyKey);
    previousOrder = intent.enqueueOrder;
  }
}

function validateThreadFollowIntentOrderAndUniqueness(
  intents: readonly ApplicationChatQueuedThreadFollowIntent[],
): void {
  const idempotencyKeys = new Set<string>();
  let previousOrder = 0;
  for (const intent of intents) {
    if (intent.enqueueOrder <= previousOrder) {
      throw validationError(
        "Queued thread-follow intents must have strictly increasing FIFO order",
      );
    }
    if (idempotencyKeys.has(intent.request.idempotencyKey)) {
      throw validationError(
        "Queued thread-follow intent idempotencyKey values must be unique",
      );
    }
    idempotencyKeys.add(intent.request.idempotencyKey);
    previousOrder = intent.enqueueOrder;
  }
}

function validateSavedMessageIntentOrderAndUniqueness(
  intents: readonly ApplicationChatQueuedSavedMessageIntent[],
): void {
  const idempotencyKeys = new Set<string>();
  let previousOrder = 0;
  for (const intent of intents) {
    if (intent.enqueueOrder <= previousOrder) {
      throw validationError(
        "Queued saved-message intents must have strictly increasing FIFO order",
      );
    }
    if (idempotencyKeys.has(intent.request.idempotencyKey)) {
      throw validationError(
        "Queued saved-message intent idempotencyKey values must be unique",
      );
    }
    idempotencyKeys.add(intent.request.idempotencyKey);
    previousOrder = intent.enqueueOrder;
  }
}

function validateMessageReminderIntentOrderAndUniqueness(
  intents: readonly ApplicationChatQueuedMessageReminderIntent[],
): void {
  const idempotencyKeys = new Set<string>();
  let previousOrder = 0;
  for (const intent of intents) {
    if (intent.enqueueOrder <= previousOrder) {
      throw validationError(
        "Queued message-reminder intents must have strictly increasing FIFO order",
      );
    }
    if (idempotencyKeys.has(intent.request.idempotencyKey)) {
      throw validationError(
        "Queued message-reminder intent idempotencyKey values must be unique",
      );
    }
    idempotencyKeys.add(intent.request.idempotencyKey);
    previousOrder = intent.enqueueOrder;
  }
}

function validateConversationArchiveIntentOrderAndUniqueness(
  intents: readonly ApplicationChatQueuedConversationArchiveIntent[],
): void {
  const idempotencyKeys = new Set<string>();
  let previousOrder = 0;
  for (const intent of intents) {
    if (intent.enqueueOrder <= previousOrder) {
      throw validationError(
        "Queued conversation-archive intents must have strictly increasing FIFO order",
      );
    }
    if (idempotencyKeys.has(intent.request.idempotencyKey)) {
      throw validationError(
        "Queued conversation-archive intent idempotencyKey values must be unique",
      );
    }
    idempotencyKeys.add(intent.request.idempotencyKey);
    previousOrder = intent.enqueueOrder;
  }
}

function validateHuddleCommandIntentOrderAndCompatibility(
  intents: readonly ApplicationChatQueuedHuddleCommandIntent[],
): void {
  const requestsByIdempotencyKey = new Map<string, string>();
  let previousOrder = 0;
  for (const intent of intents) {
    if (intent.enqueueOrder <= previousOrder) {
      throw validationError(
        "Queued huddle-command intents must have strictly increasing FIFO order",
      );
    }
    const canonicalRequest = JSON.stringify(intent.request);
    const previousRequest = requestsByIdempotencyKey.get(intent.request.idempotencyKey);
    if (previousRequest !== undefined && previousRequest !== canonicalRequest) {
      throw validationError(
        "Queued huddle-command intent idempotencyKey values cannot identify different commands",
      );
    }
    requestsByIdempotencyKey.set(intent.request.idempotencyKey, canonicalRequest);
    previousOrder = intent.enqueueOrder;
  }
}

function validateDraftIntentOrderAndUniqueness(
  intents: readonly ApplicationChatQueuedDraftIntent[],
): void {
  const deviceMutationIds = new Set<string>();
  const idempotencyKeys = new Set<string>();
  let previousOrder = 0;
  for (const intent of intents) {
    if (intent.enqueueOrder <= previousOrder) {
      throw validationError(
        "Queued draft intents must have strictly increasing FIFO order",
      );
    }
    if (deviceMutationIds.has(intent.request.deviceMutationId)) {
      throw validationError(
        "Queued draft intent deviceMutationId values must be unique",
      );
    }
    deviceMutationIds.add(intent.request.deviceMutationId);
    if (idempotencyKeys.has(intent.request.idempotencyKey)) {
      throw validationError(
        "Queued draft intent idempotencyKey values must be unique",
      );
    }
    idempotencyKeys.add(intent.request.idempotencyKey);
    previousOrder = intent.enqueueOrder;
  }
}

function coalesceConversationPreferenceIntents(
  intents: readonly ApplicationChatQueuedConversationPreferenceIntent[],
): ApplicationChatQueuedConversationPreferenceIntent[] {
  const normalized: ApplicationChatQueuedConversationPreferenceIntent[] = [];
  const laneIndexes = new Map<string, number>();
  for (const intent of intents) {
    const existingIndex = laneIndexes.get(intent.request.conversationId);
    if (existingIndex === undefined) {
      laneIndexes.set(intent.request.conversationId, normalized.length);
      normalized.push(intent);
      continue;
    }
    const existing = normalized[existingIndex]!;
    normalized[existingIndex] = createApplicationChatQueuedConversationPreferenceIntent(
      intent.request,
      {
        enqueueOrder: existing.enqueueOrder,
        enqueuedAt: existing.enqueuedAt,
      },
    );
  }
  return normalized;
}

function coalesceThreadFollowIntents(
  intents: readonly ApplicationChatQueuedThreadFollowIntent[],
): ApplicationChatQueuedThreadFollowIntent[] {
  const normalized: ApplicationChatQueuedThreadFollowIntent[] = [];
  const threadIndexes = new Map<string, number>();
  for (const intent of intents) {
    const existingIndex = threadIndexes.get(intent.request.target.id);
    if (existingIndex === undefined) {
      threadIndexes.set(intent.request.target.id, normalized.length);
      normalized.push(intent);
      continue;
    }
    const existing = normalized[existingIndex]!;
    normalized[existingIndex] = createApplicationChatQueuedThreadFollowIntent(
      intent.request,
      {
        enqueueOrder: existing.enqueueOrder,
        enqueuedAt: existing.enqueuedAt,
      },
    );
  }
  return normalized;
}

function coalesceSavedMessageIntents(
  intents: readonly ApplicationChatQueuedSavedMessageIntent[],
): ApplicationChatQueuedSavedMessageIntent[] {
  const normalized: ApplicationChatQueuedSavedMessageIntent[] = [];
  const messageIndexes = new Map<string, number>();
  for (const intent of intents) {
    const existingIndex = messageIndexes.get(intent.request.messageId);
    if (existingIndex === undefined) {
      messageIndexes.set(intent.request.messageId, normalized.length);
      normalized.push(intent);
      continue;
    }
    const existing = normalized[existingIndex]!;
    normalized[existingIndex] = createApplicationChatQueuedSavedMessageIntent(
      intent.request,
      {
        enqueueOrder: existing.enqueueOrder,
        enqueuedAt: existing.enqueuedAt,
      },
    );
  }
  return normalized;
}

function coalesceMessageReminderIntents(
  intents: readonly ApplicationChatQueuedMessageReminderIntent[],
): ApplicationChatQueuedMessageReminderIntent[] {
  const normalized: ApplicationChatQueuedMessageReminderIntent[] = [];
  const messageIndexes = new Map<string, number>();
  for (const intent of intents) {
    const existingIndex = messageIndexes.get(intent.request.messageId);
    if (existingIndex === undefined) {
      messageIndexes.set(intent.request.messageId, normalized.length);
      normalized.push(intent);
      continue;
    }
    const existing = normalized[existingIndex]!;
    normalized[existingIndex] = createApplicationChatQueuedMessageReminderIntent(
      intent.request,
      {
        enqueueOrder: existing.enqueueOrder,
        enqueuedAt: existing.enqueuedAt,
      },
    );
  }
  return normalized;
}

function coalesceConversationArchiveIntents(
  intents: readonly ApplicationChatQueuedConversationArchiveIntent[],
): ApplicationChatQueuedConversationArchiveIntent[] {
  const normalized: ApplicationChatQueuedConversationArchiveIntent[] = [];
  const conversationIndexes = new Map<string, number>();
  for (const intent of intents) {
    const existingIndex = conversationIndexes.get(intent.request.conversationId);
    if (existingIndex === undefined) {
      conversationIndexes.set(intent.request.conversationId, normalized.length);
      normalized.push(intent);
      continue;
    }
    const existing = normalized[existingIndex]!;
    normalized[existingIndex] = createApplicationChatQueuedConversationArchiveIntent(
      intent.request,
      {
        enqueueOrder: existing.enqueueOrder,
        enqueuedAt: existing.enqueuedAt,
      },
    );
  }
  return normalized;
}

function coalesceHuddleCommandIntents(
  intents: readonly ApplicationChatQueuedHuddleCommandIntent[],
): ApplicationChatQueuedHuddleCommandIntent[] {
  const latestByIdempotencyKey = new Map<
    string,
    ApplicationChatQueuedHuddleCommandIntent
  >();
  for (const intent of intents) {
    latestByIdempotencyKey.set(intent.request.idempotencyKey, intent);
  }
  return intents.filter(
    (intent) => latestByIdempotencyKey.get(intent.request.idempotencyKey) === intent,
  );
}

function coalesceDraftIntents(
  intents: readonly ApplicationChatQueuedDraftIntent[],
): ApplicationChatQueuedDraftIntent[] {
  const latestByConversation = new Map<string, ApplicationChatQueuedDraftIntent>();
  for (const intent of intents) {
    latestByConversation.set(intent.request.conversationId, intent);
  }
  return intents.filter(
    (intent) => latestByConversation.get(intent.request.conversationId) === intent,
  );
}

function coalesceConversationMembershipIntents(
  intents: readonly ApplicationChatQueuedConversationMembershipIntent[],
): ApplicationChatQueuedConversationMembershipIntent[] {
  const normalized: ApplicationChatQueuedConversationMembershipIntent[] = [];
  for (const intent of intents) {
    const previous = normalized.at(-1);
    if (
      previous !== undefined &&
      conversationMembershipLogicalLane(previous.request) ===
        conversationMembershipLogicalLane(intent.request)
    ) {
      continue;
    }
    normalized.push(intent);
  }
  return normalized;
}

function conversationMembershipLogicalLane(
  request: ConversationMembershipMutationInput,
): string {
  return JSON.stringify([
    request.intent,
    request.conversationId,
    request.expectedMemberListRevision,
    "targetUserId" in request ? request.targetUserId ?? null : null,
    "requestedRole" in request ? request.requestedRole ?? null : null,
  ]);
}

function coalesceConversationCreationIntents(
  intents: readonly ApplicationChatQueuedConversationCreationIntent[],
): ApplicationChatQueuedConversationCreationIntent[] {
  const logicalKeys = new Set<string>();
  return intents.filter((intent) => {
    const key = conversationCreationLogicalKey(intent.request);
    if (logicalKeys.has(key)) return false;
    logicalKeys.add(key);
    return true;
  });
}

function conversationCreationLogicalKey(request: ConversationCreationInput): string {
  if (request.type === "channel") {
    return JSON.stringify([
      request.operation,
      request.type,
      request.name,
      request.visibility,
      request.entity === undefined
        ? null
        : [request.entity.type, request.entity.id],
    ]);
  }
  return JSON.stringify([
    request.operation,
    request.type,
    request.visibility,
    request.intendedMemberUserIds,
  ]);
}

function coalesceMessageMutationIntents(
  intents: readonly ApplicationChatQueuedMessageMutationIntent[],
): ApplicationChatQueuedMessageMutationIntent[] {
  const normalized: ApplicationChatQueuedMessageMutationIntent[] = [];
  const laneIndexes = new Map<string, number>();
  let previousInputLane: string | undefined;
  for (const intent of intents) {
    const lane = messageMutationConflictLane(intent.request);
    if (
      intent.request.operation === "add_reaction" ||
      intent.request.operation === "remove_reaction"
    ) {
      const previousIndex = normalized.length - 1;
      const previous = normalized[previousIndex];
      if (
        previousInputLane === lane &&
        previous !== undefined &&
        (previous.request.operation === "add_reaction" ||
          previous.request.operation === "remove_reaction") &&
        messageMutationConflictLane(previous.request) === lane
      ) {
        normalized[previousIndex] = createApplicationChatQueuedMessageMutationIntent(
          intent.request,
          {
            enqueueOrder: previous.enqueueOrder,
            enqueuedAt: previous.enqueuedAt,
          },
        );
      } else {
        normalized.push(intent);
      }
      previousInputLane = lane;
      continue;
    }
    const existingIndex = laneIndexes.get(lane);
    if (existingIndex === undefined) {
      laneIndexes.set(lane, normalized.length);
      normalized.push(intent);
      previousInputLane = lane;
      continue;
    }
    const existing = normalized[existingIndex]!;
    normalized[existingIndex] = createApplicationChatQueuedMessageMutationIntent(
      intent.request,
      {
        enqueueOrder: existing.enqueueOrder,
        enqueuedAt: existing.enqueuedAt,
      },
    );
    previousInputLane = lane;
  }
  return normalized;
}

function messageMutationConflictLane(
  request: ApplicationChatMessageMutationRequest,
): string {
  switch (request.operation) {
    case "forward_message.v1":
      return JSON.stringify([
        "forward",
        request.sourceMessageId,
        request.destinationConversationId,
      ]);
    case "edit":
    case "soft_delete":
      return JSON.stringify(["message", request.messageId]);
    case "add_reaction":
    case "remove_reaction":
      return JSON.stringify(["reaction", request.messageId, request.reactionKey]);
  }
}

function coalesceReadCursorIntents(
  intents: readonly ApplicationChatQueuedReadCursorIntent[],
): ApplicationChatQueuedReadCursorIntent[] {
  const normalized: ApplicationChatQueuedReadCursorIntent[] = [];
  for (const intent of intents) {
    const previous = normalized.at(-1);
    if (
      previous?.request.operation === "mark_read" &&
      intent.request.operation === "mark_read" &&
      previous.request.conversationId === intent.request.conversationId
    ) {
      normalized[normalized.length - 1] = createApplicationChatQueuedReadCursorIntent(
        {
          ...previous.request,
          throughSequence: Math.max(
            previous.request.throughSequence,
            intent.request.throughSequence,
          ),
        },
        previous.acknowledgedReadState,
        {
          enqueueOrder: previous.enqueueOrder,
          enqueuedAt: previous.enqueuedAt,
        },
      );
    } else {
      normalized.push(intent);
    }
  }
  return normalized;
}

function validateReadCursorRequestBounds(request: ReadCursorMutationInput): void {
  readBoundedNonBlankString(
    request.conversationId,
    "Queued read-cursor request.conversationId",
    MAX_IDENTIFIER_LENGTH,
  );
  readBoundedNonBlankString(
    request.idempotencyKey,
    "Queued read-cursor request.idempotencyKey",
    MAX_IDENTIFIER_LENGTH,
  );
}

function parseAcknowledgedReadState(value: unknown): ConversationReadState {
  validateJsonValue(value, "Queued read-cursor canonical baseline", true);
  rejectUnsafeStorageFields(value, "Queued read-cursor canonical baseline");
  const candidate = isPlainRecord(value) ? value : {};
  const latestSequence = Number.isSafeInteger(candidate.lastReadSequence) &&
      (candidate.lastReadSequence as number) >= 0
    ? candidate.lastReadSequence as number
    : 0;
  const operation = Object.hasOwn(candidate, "manualUnreadFromSequence")
    ? "mark_unread"
    : "mark_read";
  let parsed: ConversationReadState;
  try {
    parsed = parseReadCursorMutationResult({
      operation,
      conversationId: candidate.conversationId,
      readState: value,
      latestSequence,
      unreadCount: deriveUnreadCount(latestSequence, candidate as unknown as ConversationReadState),
    }).readState;
  } catch (error) {
    throw validationError(
      `Queued read-cursor canonical baseline is invalid: ${error instanceof Error ? error.message : "unknown validation failure"}`,
    );
  }
  readBoundedNonBlankString(
    parsed.conversationId,
    "Queued read-cursor canonical baseline.conversationId",
    MAX_IDENTIFIER_LENGTH,
  );
  readBoundedNonBlankString(
    parsed.userId,
    "Queued read-cursor canonical baseline.userId",
    MAX_IDENTIFIER_LENGTH,
  );
  readIsoTimestamp(
    parsed.updatedAt,
    "Queued read-cursor canonical baseline.updatedAt",
  );
  return deepFreeze(cloneJson(parsed));
}

function validateQueuedSendRequestBounds(request: SendMessageInput): void {
  readBoundedNonBlankString(
    request.conversationId,
    "Queued send request.conversationId",
    MAX_IDENTIFIER_LENGTH,
  );
  readBoundedNonBlankString(
    request.clientMessageId,
    "Queued send request.clientMessageId",
    MAX_IDENTIFIER_LENGTH,
  );
  readBoundedNonBlankString(
    request.idempotencyKey,
    "Queued send request.idempotencyKey",
    MAX_IDENTIFIER_LENGTH,
  );
  if (request.content.text.length > MAX_MESSAGE_TEXT_LENGTH) {
    throw validationError(`Queued send request.content.text exceeds ${MAX_MESSAGE_TEXT_LENGTH} characters`);
  }
  for (const key of ["mentions", "attachments", "blocks"] as const) {
    const collection = request.content[key];
    if (collection !== undefined && collection.length > MAX_MESSAGE_COLLECTION_LENGTH) {
      throw validationError(
        `Queued send request.content.${key} exceeds ${MAX_MESSAGE_COLLECTION_LENGTH} entries`,
      );
    }
  }
}

function validateMessageMutationRequestBounds(
  request: ApplicationChatMessageMutationRequest,
): void {
  readBoundedNonBlankString(
    request.idempotencyKey,
    "Queued message-mutation request.idempotencyKey",
    MAX_IDENTIFIER_LENGTH,
  );
  switch (request.operation) {
    case "forward_message.v1":
      readBoundedNonBlankString(
        request.sourceMessageId,
        "Queued message-mutation request.sourceMessageId",
        MAX_IDENTIFIER_LENGTH,
      );
      readBoundedNonBlankString(
        request.destinationConversationId,
        "Queued message-mutation request.destinationConversationId",
        MAX_IDENTIFIER_LENGTH,
      );
      readBoundedNonBlankString(
        request.clientCorrelationId,
        "Queued message-mutation request.clientCorrelationId",
        MAX_IDENTIFIER_LENGTH,
      );
      break;
    case "edit":
      validateMessageMutationMessageId(request.messageId);
      validateMessageContentBounds(request.content, "Queued message-mutation request.content");
      break;
    case "soft_delete":
      validateMessageMutationMessageId(request.messageId);
      break;
    case "add_reaction":
    case "remove_reaction":
      validateMessageMutationMessageId(request.messageId);
      break;
  }
}

function validateConversationMembershipRequestBounds(
  request: ConversationMembershipMutationInput,
): void {
  readBoundedNonBlankString(
    request.conversationId,
    "Queued conversation-membership request.conversationId",
    MAX_IDENTIFIER_LENGTH,
  );
  readBoundedNonBlankString(
    request.idempotencyKey,
    "Queued conversation-membership request.idempotencyKey",
    MAX_IDENTIFIER_LENGTH,
  );
  if ("targetUserId" in request && request.targetUserId !== undefined) {
    readBoundedNonBlankString(
      request.targetUserId,
      "Queued conversation-membership request.targetUserId",
      MAX_IDENTIFIER_LENGTH,
    );
  }
}

function validateConversationArchiveRequestBounds(
  request: ConversationArchiveInput,
): void {
  readBoundedNonBlankString(
    request.conversationId,
    "Queued conversation-archive request.conversationId",
    MAX_IDENTIFIER_LENGTH,
  );
  readBoundedNonBlankString(
    request.idempotencyKey,
    "Queued conversation-archive request.idempotencyKey",
    MAX_IDENTIFIER_LENGTH,
  );
}

function validateConversationCreationRequestBounds(
  request: ConversationCreationInput,
): void {
  readBoundedNonBlankString(
    request.idempotencyKey,
    "Queued conversation-creation request.idempotencyKey",
    MAX_IDENTIFIER_LENGTH,
  );
  readBoundedNonBlankString(
    request.clientRequestId,
    "Queued conversation-creation request.clientRequestId",
    MAX_IDENTIFIER_LENGTH,
  );
  if (request.type === "channel") {
    readBoundedNonBlankString(
      request.name,
      "Queued conversation-creation request.name",
      MAX_CONVERSATION_CREATION_NAME_LENGTH,
    );
    if (request.entity !== undefined) {
      readBoundedNonBlankString(
        request.entity.type,
        "Queued conversation-creation request.entity.type",
        MAX_IDENTIFIER_LENGTH,
      );
      readBoundedNonBlankString(
        request.entity.id,
        "Queued conversation-creation request.entity.id",
        MAX_IDENTIFIER_LENGTH,
      );
    }
    return;
  }
  if (
    request.intendedMemberUserIds.length >
      MAX_APPLICATION_CHAT_CONVERSATION_CREATION_MEMBERS
  ) {
    throw validationError(
      `Queued conversation-creation request.intendedMemberUserIds must contain at most ${MAX_APPLICATION_CHAT_CONVERSATION_CREATION_MEMBERS} entries`,
    );
  }
  request.intendedMemberUserIds.forEach((memberUserId, index) => {
    readBoundedNonBlankString(
      memberUserId,
      `Queued conversation-creation request.intendedMemberUserIds[${index}]`,
      MAX_IDENTIFIER_LENGTH,
    );
  });
}

function canonicalizeConversationCreationRequest(
  request: ConversationCreationInput,
): ConversationCreationInput {
  const detached = cloneJson(request);
  if (detached.type === "channel") return deepFreeze(detached);
  return deepFreeze({
    ...detached,
    intendedMemberUserIds: [...detached.intendedMemberUserIds].sort(compareStrings),
  } as unknown as ConversationCreationInput);
}

function sameStringOrder(left: unknown, right: readonly string[]): boolean {
  return Array.isArray(left) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateMessageMutationMessageId(messageId: string): void {
  readBoundedNonBlankString(
    messageId,
    "Queued message-mutation request.messageId",
    MAX_IDENTIFIER_LENGTH,
  );
}

function validateMessageContentBounds(
  content: EditMessageInput["content"],
  path: string,
): void {
  if (content.text.length > MAX_MESSAGE_TEXT_LENGTH) {
    throw validationError(`${path}.text exceeds ${MAX_MESSAGE_TEXT_LENGTH} characters`);
  }
  for (const key of ["mentions", "attachments", "blocks"] as const) {
    const collection = content[key];
    if (collection !== undefined && collection.length > MAX_MESSAGE_COLLECTION_LENGTH) {
      throw validationError(
        `${path}.${key} exceeds ${MAX_MESSAGE_COLLECTION_LENGTH} entries`,
      );
    }
  }
}

function requireCanonicalSnapshotIdentity(
  snapshot: NormalizedChatCacheState,
): NonNullable<NormalizedChatCacheState["identity"]> {
  if (!isPlainRecord(snapshot) || snapshot.identity === null) {
    throw validationError("Stored normalized snapshot must have a trusted cache identity");
  }
  const identity = requireExactRecord(
    snapshot.identity,
    ["tenantId", "userId", "sessionId"],
    "NormalizedChatCacheState.identity",
  );
  return Object.freeze({
    tenantId: readBoundedNonBlankString(
      identity.tenantId,
      "NormalizedChatCacheState.identity.tenantId",
      MAX_IDENTITY_COMPONENT_LENGTH,
    ) as NonNullable<NormalizedChatCacheState["identity"]>["tenantId"],
    userId: readBoundedNonBlankString(
      identity.userId,
      "NormalizedChatCacheState.identity.userId",
      MAX_IDENTITY_COMPONENT_LENGTH,
    ) as NonNullable<NormalizedChatCacheState["identity"]>["userId"],
    sessionId: readBoundedNonBlankString(
      identity.sessionId,
      "NormalizedChatCacheState.identity.sessionId",
      MAX_IDENTITY_COMPONENT_LENGTH,
    ) as NonNullable<NormalizedChatCacheState["identity"]>["sessionId"],
  });
}

function recordToWireJson(record: ApplicationChatStorageRecord): unknown {
  if (record.kind === ApplicationChatStorageRecordKind.normalizedSnapshot) {
    return {
      schemaVersion: record.schemaVersion,
      kind: record.kind,
      identity: record.identity,
      payload: { snapshot: record.snapshot },
    };
  }
  return {
    schemaVersion: record.schemaVersion,
    kind: record.kind,
    identity: record.identity,
    payload: {
      intents: record.kind === ApplicationChatStorageRecordKind.queuedSendMessageIntents
        ? record.intents.map(intentToWireJson)
        : record.kind === ApplicationChatStorageRecordKind.queuedReadCursorIntents
          ? record.intents.map(readCursorIntentToWireJson)
          : record.kind === ApplicationChatStorageRecordKind.queuedMessageMutationIntents
            ? record.intents.map(messageMutationIntentToWireJson)
            : record.kind === ApplicationChatStorageRecordKind.queuedConversationMembershipIntents
              ? record.intents.map(conversationMembershipIntentToWireJson)
              : record.kind === ApplicationChatStorageRecordKind.queuedConversationCreationIntents
                ? record.intents.map(conversationCreationIntentToWireJson)
                : record.kind === ApplicationChatStorageRecordKind.queuedConversationPreferenceIntents
                  ? record.intents.map(conversationPreferenceIntentToWireJson)
                  : record.kind === ApplicationChatStorageRecordKind.queuedThreadFollowIntents
                    ? record.intents.map(threadFollowIntentToWireJson)
                    : record.kind === ApplicationChatStorageRecordKind.queuedSavedMessageIntents
                      ? record.intents.map(savedMessageIntentToWireJson)
                      : record.kind === ApplicationChatStorageRecordKind.queuedMessageReminderIntents
                        ? record.intents.map(messageReminderIntentToWireJson)
                        : record.kind === ApplicationChatStorageRecordKind.queuedConversationArchiveIntents
                          ? record.intents.map(conversationArchiveIntentToWireJson)
                          : record.kind === ApplicationChatStorageRecordKind.queuedHuddleCommandIntents
                            ? record.intents.map(huddleCommandIntentToWireJson)
                            : record.intents.map(draftIntentToWireJson),
    },
  };
}

function intentToWireJson(intent: ApplicationChatQueuedSendMessageIntent): unknown {
  return {
    contractVersion: intent.contractVersion,
    enqueueOrder: intent.enqueueOrder,
    enqueuedAt: intent.enqueuedAt,
    conversationId: intent.request.conversationId,
    content: intent.request.content,
    clientMessageId: intent.request.clientMessageId,
    idempotencyKey: intent.request.idempotencyKey,
    ...(intent.request.replyTo === undefined ? {} : { replyTo: intent.request.replyTo }),
  };
}

function readCursorIntentToWireJson(
  intent: ApplicationChatQueuedReadCursorIntent,
): unknown {
  const sequence = intent.request.operation === "mark_read"
    ? { throughSequence: intent.request.throughSequence }
    : { fromSequence: intent.request.fromSequence };
  return {
    contractVersion: intent.contractVersion,
    enqueueOrder: intent.enqueueOrder,
    enqueuedAt: intent.enqueuedAt,
    operation: intent.request.operation,
    conversationId: intent.request.conversationId,
    ...sequence,
    idempotencyKey: intent.request.idempotencyKey,
    acknowledgedReadState: intent.acknowledgedReadState,
  };
}

function messageMutationIntentToWireJson(
  intent: ApplicationChatQueuedMessageMutationIntent,
): unknown {
  return {
    contractVersion: intent.contractVersion,
    enqueueOrder: intent.enqueueOrder,
    enqueuedAt: intent.enqueuedAt,
    ...intent.request,
  };
}

function conversationMembershipIntentToWireJson(
  intent: ApplicationChatQueuedConversationMembershipIntent,
): unknown {
  return {
    contractVersion: intent.contractVersion,
    enqueueOrder: intent.enqueueOrder,
    enqueuedAt: intent.enqueuedAt,
    ...intent.request,
  };
}

function conversationCreationIntentToWireJson(
  intent: ApplicationChatQueuedConversationCreationIntent,
): unknown {
  return {
    contractVersion: intent.contractVersion,
    enqueueOrder: intent.enqueueOrder,
    enqueuedAt: intent.enqueuedAt,
    ...intent.request,
  };
}

function conversationPreferenceIntentToWireJson(
  intent: ApplicationChatQueuedConversationPreferenceIntent,
): unknown {
  return {
    contractVersion: intent.contractVersion,
    enqueueOrder: intent.enqueueOrder,
    enqueuedAt: intent.enqueuedAt,
    ...intent.request,
  };
}

function threadFollowIntentToWireJson(
  intent: ApplicationChatQueuedThreadFollowIntent,
): unknown {
  return {
    contractVersion: intent.contractVersion,
    enqueueOrder: intent.enqueueOrder,
    enqueuedAt: intent.enqueuedAt,
    ...intent.request,
  };
}

function savedMessageIntentToWireJson(
  intent: ApplicationChatQueuedSavedMessageIntent,
): unknown {
  return {
    contractVersion: intent.contractVersion,
    enqueueOrder: intent.enqueueOrder,
    enqueuedAt: intent.enqueuedAt,
    ...intent.request,
  };
}

function messageReminderIntentToWireJson(
  intent: ApplicationChatQueuedMessageReminderIntent,
): unknown {
  return {
    contractVersion: intent.contractVersion,
    enqueueOrder: intent.enqueueOrder,
    enqueuedAt: intent.enqueuedAt,
    ...intent.request,
  };
}

function conversationArchiveIntentToWireJson(
  intent: ApplicationChatQueuedConversationArchiveIntent,
): unknown {
  return {
    contractVersion: intent.contractVersion,
    enqueueOrder: intent.enqueueOrder,
    enqueuedAt: intent.enqueuedAt,
    ...intent.request,
  };
}

function huddleCommandIntentToWireJson(
  intent: ApplicationChatQueuedHuddleCommandIntent,
): unknown {
  return {
    contractVersion: intent.contractVersion,
    enqueueOrder: intent.enqueueOrder,
    enqueuedAt: intent.enqueuedAt,
    ...intent.request,
  };
}

function draftIntentToWireJson(intent: ApplicationChatQueuedDraftIntent): unknown {
  return {
    contractVersion: intent.contractVersion,
    enqueueOrder: intent.enqueueOrder,
    enqueuedAt: intent.enqueuedAt,
    ...intent.request,
  };
}

function requireSnapshotSchemaVersion(value: unknown): void {
  // Legacy snapshots retain the same strict payload validation and are rebuilt
  // as current-version records by createApplicationChatNormalizedSnapshotRecord.
  if (value !== 1 && value !== APPLICATION_CHAT_NORMALIZED_SNAPSHOT_SCHEMA_VERSION) {
    throw validationError(`Unsupported application chat storage schema version: ${String(value)}`);
  }
}

function requireSchemaVersion(value: unknown): void {
  if (value !== APPLICATION_CHAT_STORAGE_SCHEMA_VERSION) {
    throw validationError(`Unsupported application chat storage schema version: ${String(value)}`);
  }
}

function requireSendContractVersion(value: unknown): void {
  if (value !== APPLICATION_CHAT_SEND_MESSAGE_CONTRACT_VERSION) {
    throw validationError(`Unsupported send-message contract version: ${String(value)}`);
  }
}

function requireReadCursorContractVersion(value: unknown): void {
  if (value !== APPLICATION_CHAT_READ_CURSOR_CONTRACT_VERSION) {
    throw validationError(`Unsupported read-cursor contract version: ${String(value)}`);
  }
}

function requireMessageMutationContractVersion(value: unknown): void {
  if (value !== APPLICATION_CHAT_MESSAGE_MUTATION_CONTRACT_VERSION) {
    throw validationError(`Unsupported message-mutation contract version: ${String(value)}`);
  }
}

function requireConversationMembershipContractVersion(value: unknown): void {
  if (value !== APPLICATION_CHAT_CONVERSATION_MEMBERSHIP_CONTRACT_VERSION) {
    throw validationError(
      `Unsupported conversation-membership contract version: ${String(value)}`,
    );
  }
}

function requireConversationCreationContractVersion(value: unknown): void {
  if (value !== APPLICATION_CHAT_CONVERSATION_CREATION_CONTRACT_VERSION) {
    throw validationError(
      `Unsupported conversation-creation contract version: ${String(value)}`,
    );
  }
}

function requireConversationPreferenceContractVersion(value: unknown): void {
  if (value !== APPLICATION_CHAT_CONVERSATION_PREFERENCE_CONTRACT_VERSION) {
    throw validationError(
      `Unsupported conversation-preference contract version: ${String(value)}`,
    );
  }
}

function requireThreadFollowContractVersion(value: unknown): void {
  if (value !== APPLICATION_CHAT_THREAD_FOLLOW_CONTRACT_VERSION) {
    throw validationError(`Unsupported thread-follow contract version: ${String(value)}`);
  }
}

function requireSavedMessageContractVersion(value: unknown): void {
  if (value !== APPLICATION_CHAT_SAVED_MESSAGE_CONTRACT_VERSION) {
    throw validationError(`Unsupported saved-message contract version: ${String(value)}`);
  }
}

function requireMessageReminderContractVersion(value: unknown): void {
  if (value !== APPLICATION_CHAT_MESSAGE_REMINDER_CONTRACT_VERSION) {
    throw validationError(`Unsupported message-reminder contract version: ${String(value)}`);
  }
}

function requireConversationArchiveContractVersion(value: unknown): void {
  if (value !== APPLICATION_CHAT_CONVERSATION_ARCHIVE_CONTRACT_VERSION) {
    throw validationError(
      `Unsupported conversation-archive contract version: ${String(value)}`,
    );
  }
}

function requireHuddleCommandContractVersion(value: unknown): void {
  if (value !== APPLICATION_CHAT_HUDDLE_COMMAND_CONTRACT_VERSION) {
    throw validationError(`Unsupported huddle-command contract version: ${String(value)}`);
  }
}

function requireDraftMutationContractVersion(value: unknown): void {
  if (value !== APPLICATION_CHAT_DRAFT_MUTATION_CONTRACT_VERSION) {
    throw validationError(`Unsupported draft-mutation contract version: ${String(value)}`);
  }
}

function parseRecordKind(value: unknown): ApplicationChatStorageRecordKind {
  if (
    value !== ApplicationChatStorageRecordKind.normalizedSnapshot &&
    value !== ApplicationChatStorageRecordKind.queuedSendMessageIntents &&
    value !== ApplicationChatStorageRecordKind.queuedReadCursorIntents &&
    value !== ApplicationChatStorageRecordKind.queuedMessageMutationIntents &&
    value !== ApplicationChatStorageRecordKind.queuedConversationMembershipIntents &&
    value !== ApplicationChatStorageRecordKind.queuedConversationCreationIntents &&
    value !== ApplicationChatStorageRecordKind.queuedConversationPreferenceIntents &&
    value !== ApplicationChatStorageRecordKind.queuedThreadFollowIntents &&
    value !== ApplicationChatStorageRecordKind.queuedSavedMessageIntents &&
    value !== ApplicationChatStorageRecordKind.queuedMessageReminderIntents &&
    value !== ApplicationChatStorageRecordKind.queuedConversationArchiveIntents &&
    value !== ApplicationChatStorageRecordKind.queuedHuddleCommandIntents &&
    value !== ApplicationChatStorageRecordKind.queuedDraftIntents
  ) {
    throw validationError(`Unsupported application chat storage record kind: ${String(value)}`);
  }
  return value;
}

function storageIdentitiesEqual(
  left: ApplicationChatStorageIdentity,
  right: ApplicationChatStorageIdentity,
): boolean {
  return left.tenantId === right.tenantId &&
    left.userId === right.userId &&
    left.deviceId === right.deviceId;
}

function requireExactRecord(
  value: unknown,
  fields: readonly string[],
  path: string,
): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    throw validationError(`${path} must be a JSON object`);
  }
  const keys = ownJsonEntries(value, path).map(([key]) => key);
  if (keys.length !== fields.length || !fields.every((field) => Object.hasOwn(value, field))) {
    throw validationError(`${path} must contain exactly: ${fields.join(", ")}`);
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownJsonEntries(
  value: Record<string, unknown>,
  path: string,
): readonly (readonly [string, unknown])[] {
  const entries: [string, unknown][] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw validationError(`${path} contains a non-string JSON key`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw validationError(`${path}.${key} is not a plain JSON field`);
    }
    entries.push([key, descriptor.value]);
  }
  return entries;
}

function readBoundedNonBlankString(
  value: unknown,
  path: string,
  maxLength: number,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw validationError(`${path} must be a non-blank string`);
  }
  if (value.length > maxLength) {
    throw validationError(`${path} must be at most ${maxLength} characters`);
  }
  return value;
}

function readExactIdentityComponent(value: unknown, path: string): string {
  const component = readBoundedNonBlankString(
    value,
    path,
    MAX_IDENTITY_COMPONENT_LENGTH,
  );
  if (component.includes("*")) {
    throw validationError(`${path} must identify one exact value and cannot contain a wildcard`);
  }
  return component;
}

function readIsoTimestamp(value: unknown, path: string): IsoTimestamp {
  const timestamp = readBoundedNonBlankString(value, path, MAX_TIMESTAMP_LENGTH);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(timestamp);
  if (match === null || !Number.isFinite(Date.parse(timestamp))) {
    throw validationError(`${path} must be an ISO-8601 timestamp`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > (daysInMonth[month - 1] ?? 0) ||
    Number(match[4]) > 23 ||
    Number(match[5]) > 59 ||
    Number(match[6]) > 59
  ) {
    throw validationError(`${path} must be an ISO-8601 timestamp`);
  }
  return timestamp;
}

function requirePositiveSafeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw validationError(`${path} must be a positive safe integer`);
  }
  return value as number;
}

const FORBIDDEN_STORAGE_FIELD_NAMES = new Set([
  "accesstoken",
  "apikey",
  "apisecret",
  "auth",
  "authentication",
  "authorization",
  "authorizationdata",
  "authorizationheader",
  "authtoken",
  "bearertoken",
  "bytes",
  "clientsecret",
  "commandbody",
  "commandrequestbody",
  "credential",
  "credentials",
  "diagnostic",
  "diagnostics",
  "error",
  "exception",
  "huddlemediatoken",
  "huddletoken",
  "password",
  "provider",
  "providerconfig",
  "providerconfiguration",
  "providerdescriptor",
  "providertoken",
  "rawbytes",
  "rawdiagnostic",
  "rawerror",
  "requestbody",
  "secret",
  "stack",
  "stacktrace",
  "throwable",
  "thrown",
  "thrownvalue",
  "token",
  "uploadprovider",
  "uploadproviderconfig",
  "uploadproviderconfiguration",
]);

function rejectUnsafeStorageFields(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      rejectUnsafeStorageFields(value[index], `${path}[${index}]`);
    }
    return;
  }
  if (!isPlainRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.replaceAll(/[^a-zA-Z0-9]/g, "").toLowerCase();
    if (
      FORBIDDEN_STORAGE_FIELD_NAMES.has(normalized) ||
      normalized.includes("authorization") ||
      normalized.includes("accesstoken") ||
      normalized.includes("authtoken") ||
      normalized.endsWith("token") ||
      normalized.includes("authentication") ||
      normalized.includes("credential") ||
      normalized.includes("secret") ||
      normalized.includes("providerc") ||
      normalized.includes("providerdata") ||
      normalized.includes("providerdescriptor") ||
      normalized.includes("attachmentbytes") ||
      normalized.includes("attachmentsource") ||
      normalized.includes("bytesource") ||
      normalized.includes("mediatoken") ||
      normalized.includes("huddletoken") ||
      normalized.includes("diagnostic") ||
      normalized.endsWith("error") ||
      normalized.includes("exception") ||
      normalized.includes("stacktrace") ||
      normalized.endsWith("stack") ||
      normalized.startsWith("stack")
    ) {
      throw validationError(`${path}.${key} is not permitted in application chat storage`);
    }
    rejectUnsafeStorageFields(child, `${path}.${key}`);
  }
}

function validateJsonValue(value: unknown, path: string, rejectByteLikeData: boolean): void {
  let nodeCount = 0;
  const ancestors = new Set<object>();
  const visit = (candidate: unknown, candidatePath: string, depth: number): void => {
    nodeCount += 1;
    if (nodeCount > MAX_JSON_NODES) {
      throw validationError(`${path} exceeds ${MAX_JSON_NODES} JSON values`);
    }
    if (depth > MAX_JSON_DEPTH) {
      throw validationError(`${path} exceeds maximum JSON depth ${MAX_JSON_DEPTH}`);
    }
    if (candidate === null || typeof candidate === "boolean") return;
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) throw validationError(`${candidatePath} must be a finite JSON number`);
      return;
    }
    if (typeof candidate === "string") {
      if (candidate.length > MAX_JSON_STRING_LENGTH) {
        throw validationError(`${candidatePath} exceeds ${MAX_JSON_STRING_LENGTH} characters`);
      }
      return;
    }
    if (typeof candidate !== "object") {
      throw validationError(`${candidatePath} contains a non-JSON value`);
    }
    if (ancestors.has(candidate)) {
      throw validationError(`${candidatePath} contains a circular value`);
    }
    ancestors.add(candidate);
    if (Array.isArray(candidate)) {
      if (candidate.length > MAX_JSON_COLLECTION_LENGTH) {
        throw validationError(`${candidatePath} exceeds ${MAX_JSON_COLLECTION_LENGTH} array entries`);
      }
      if (
        rejectByteLikeData &&
        candidate.length > 0 &&
        candidate.every((item) => Number.isInteger(item) && (item as number) >= 0 && (item as number) <= 255)
      ) {
        throw validationError(`${candidatePath} contains byte-like data`);
      }
      for (const key of Reflect.ownKeys(candidate)) {
        if (key === "length") continue;
        if (
          typeof key !== "string" ||
          !/^\d+$/.test(key) ||
          String(Number(key)) !== key ||
          Number(key) >= candidate.length
        ) {
          throw validationError(`${candidatePath} contains a non-JSON array field`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
          throw validationError(`${candidatePath}[${key}] is not a plain JSON value`);
        }
      }
      for (let index = 0; index < candidate.length; index += 1) {
        visit(candidate[index], `${candidatePath}[${index}]`, depth + 1);
      }
    } else {
      if (!isPlainRecord(candidate)) {
        throw validationError(`${candidatePath} contains a non-JSON object`);
      }
      const entries = ownJsonEntries(candidate, candidatePath);
      if (entries.length > MAX_JSON_COLLECTION_LENGTH) {
        throw validationError(`${candidatePath} exceeds ${MAX_JSON_COLLECTION_LENGTH} object fields`);
      }
      for (const [key, child] of entries) {
        visit(child, `${candidatePath}.${key}`, depth + 1);
      }
    }
    ancestors.delete(candidate);
  };
  visit(value, path, 0);
}

function cloneJson<Value>(value: Value): Value {
  return JSON.parse(JSON.stringify(value)) as Value;
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function assertEncodedSize(encoded: string, maxBytes: number, path: string): void {
  if (encoded.length > maxBytes || new TextEncoder().encode(encoded).byteLength > maxBytes) {
    throw validationError(`${path} exceeds ${maxBytes} encoded bytes`);
  }
}

function validationError(message: string): ApplicationChatStorageValidationError {
  return new ApplicationChatStorageValidationError(message);
}
