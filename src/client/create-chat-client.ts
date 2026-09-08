import { createReplyStyleRuntime, type ChatReplyStyle, type ChatReplyStyleConfiguration } from "./reply-style-runtime.js";
import { createThreadListRuntime, type ChatThreadList, type ChatThreadListScheduling } from "./thread-list.js";
import { createMessageContextRuntime, type ChatMessageContext } from "./message-context.js";
import { createThreadLifecycleRuntime, type ChatThreadLifecycle } from "./thread-lifecycle.js";
import {
  CHAT_PROTOCOL_VERSION,
  CHAT_REFRESH_REQUIRED_MESSAGE,
  decideRealtimeHandshake,
  type ChatEvent,
  type EnabledFeatures,
  type ServerHandshakeMetadata,
} from "../contracts/realtime.js";
import type {
  ConversationDetailSnapshot,
  ConversationDetailSnapshotInput,
  ConversationListSnapshot,
  ConversationListSnapshotInput,
} from "../contracts/conversation-snapshot.js";
import {
  CONVERSATION_SNAPSHOT_FEATURE,
  CONVERSATION_SNAPSHOT_VERSION,
} from "../contracts/conversation-snapshot.js";
import {
  deriveCanonicalParticipantIdentity,
  parseCreateChannelConversationInput,
  parseCreateDirectConversationInput,
  parseCreateGroupDirectConversationInput,
  parseConversationCreationInput,
  parseConversationCreationResult,
  type ChannelConversationCreationResult,
  type ConversationCreationInput,
  type ConversationCreationResult,
  type CreateChannelConversationInput,
  type CreateDirectConversationInput,
  type CreateGroupDirectConversationInput,
  type DirectConversationCreationResult,
  type GroupDirectConversationCreationResult,
} from "../contracts/conversation-creation.js";
import {
  parseConversationArchiveInput,
  parseConversationArchiveResult,
  type ArchiveConversationInput,
  type ArchiveConversationResult,
  type ConversationArchiveInput,
  type ConversationArchiveResult,
  type RestoreConversationInput,
  type RestoreConversationResult,
} from "../contracts/conversation-archive.js";
import {
  parseAddConversationMemberInput,
  parseChangeConversationMemberRoleInput,
  parseConversationMembershipMutationResult,
  parseConversationMembershipMutationInput,
  parseJoinConversationInput,
  parseLeaveConversationInput,
  parseRemoveConversationMemberInput,
  type AddConversationMemberInput,
  type AddConversationMemberResult,
  type ChangeConversationMemberRoleInput,
  type ChangeConversationMemberRoleResult,
  type ConversationMembershipMutationInput,
  type ConversationMembershipMutationResult,
  type JoinConversationInput,
  type JoinConversationResult,
  type LeaveConversationInput,
  type LeaveConversationResult,
  type RemoveConversationMemberInput,
  type RemoveConversationMemberResult,
} from "../contracts/conversation-membership.js";
import {
  parseUpdateConversationPreferenceInput,
  parseUpdateConversationPreferenceResult,
  type UpdateConversationPreferenceInput,
  type UpdateConversationPreferenceResult,
} from "../contracts/conversation-preference-mutation.js";
import {
  parseThreadCreationInput,
  parseThreadCreationResult,
  type ThreadCreationInput,
  type ThreadCreationReconciliationStatus,
  type ThreadCreationResult,
} from "../contracts/thread-creation.js";
import {
  parseSetThreadFollowInput,
  parseSetThreadFollowResult,
  type SetThreadFollowInput,
  type SetThreadFollowResult,
  type ThreadFollowMutationIntent,
} from "../contracts/thread-follow-mutation.js";
import {
  parseSetSavedMessageInput,
  parseSetSavedMessageResult,
  type SetSavedMessageInput,
  type SetSavedMessageResult,
} from "../contracts/saved-message-mutation.js";
import {
  parseCancelMessageReminderInput,
  parseMessageReminderResult,
  parseSetMessageReminderInput,
  type CancelMessageReminderInput,
  type CanonicalMessageReminder,
  type MessageReminderInput,
  type MessageReminderResult,
  type SetMessageReminderInput,
} from "../contracts/generated/message-reminder.js";
import type {
  MessageAttachmentMetadata,
  MessageTimelinePage,
  MessageTimelineRequest,
} from "../contracts/message-timeline.js";
import {
  MAX_MESSAGE_REMINDER_SNAPSHOT_PAGE_LIMIT,
  MAX_SAVED_MESSAGE_SNAPSHOT_PAGE_LIMIT,
  type ConversationDraftSnapshot,
  type ConversationDraftSnapshotInput,
  type MessageReminderListSnapshot,
  type MessageReminderListSnapshotInput,
  type SavedMessageListSnapshot,
  type SavedMessageListSnapshotInput,
} from "../contracts/private-user-state-snapshot.js";
import {
  parseEditMessageInput,
  parseEditMessageResult,
  parseSendMessageInput,
  parseSendMessageResult,
  parseSoftDeleteMessageInput,
  parseSoftDeleteMessageResult,
  type EditMessageInput,
  type EditMessageResult,
  type SendMessageInput,
  type SendMessageResult,
  type SoftDeleteMessageInput,
  type SoftDeleteMessageResult,
} from "../contracts/message-mutations.js";
import {
  parseReactionMutationInput,
  parseReactionMutationResult,
  type ReactionMutationInput,
  type ReactionMutationResult,
} from "../contracts/reaction-mutations.js";
import {
  parseForwardMessageInput,
  parseForwardMessageResult,
  type ForwardMessageInput,
  type ForwardMessageResult,
} from "../contracts/generated/forward-message.js";
import type { MessageBlock, MessageContent, MessageReplyReference } from "../contracts/message.js";
import { createUnreadMentionRefresh } from "./unread-mention-refresh.js";
import type { ConversationMemberPreference } from "../contracts/member-read-state.js";
import type {
  ConversationId,
  IsoTimestamp,
  MessageId,
  MessageSequence,
  UserId,
} from "../contracts/identifiers.js";
import type {
  HostDirectorySearchInput,
  HostDirectoryUserSummary,
} from "../contracts/host-directory-snapshot.js";
import type { MessageSearchRequest } from "../contracts/message-search.js";
import {
  createChatCommandDispatcher,
  type ChatClientFetch,
  type ChatClientFetchResponse,
  type ChatCommandDescriptor,
  type ChatCommandDispatchOptions,
  type ChatCommandResult,
  type ChatCommandRuntimeOptions,
} from "./command-dispatcher.js";
import {
  createChatAttachmentUploadManager,
  type ChatAttachmentUploadHandle,
  type ChatAttachmentUploadInput,
  type ChatAttachmentUploadManager,
  type ChatAttachmentUploadOptions,
} from "./attachment-uploader.js";
import {
  createChatRealtimeSession,
  type ChatRealtimeSession,
  type CreateChatRealtimeSessionOptions,
} from "./realtime-session.js";
import {
  createNormalizedChatCache,
  type ChatCacheIdentity,
  type NormalizedChatCacheState,
  type OptimisticMessageFailure,
  type OptimisticMessageProjection,
  type NormalizedChatCache,
} from "./normalized-cache.js";
import {
  ApplicationChatStorageRecordKind,
  ApplicationChatStorageValidationError,
  createApplicationChatQueuedConversationCreationIntent,
  createApplicationChatQueuedConversationCreationIntentsRecord,
  createApplicationChatQueuedConversationMembershipIntent,
  createApplicationChatQueuedConversationMembershipIntentsRecord,
  createApplicationChatQueuedConversationPreferenceIntent,
  createApplicationChatQueuedConversationPreferenceIntentsRecord,
  createApplicationChatQueuedConversationArchiveIntent,
  createApplicationChatQueuedConversationArchiveIntentsRecord,
  createApplicationChatQueuedThreadFollowIntent,
  createApplicationChatQueuedThreadFollowIntentsRecord,
  createApplicationChatQueuedSavedMessageIntent,
  createApplicationChatQueuedSavedMessageIntentsRecord,
  createApplicationChatQueuedMessageReminderIntent,
  createApplicationChatQueuedMessageReminderIntentsRecord,
  createApplicationChatQueuedMessageMutationIntent,
  createApplicationChatQueuedMessageMutationIntentsRecord,
  createApplicationChatNormalizedSnapshotRecord,
  encodeApplicationChatStorageRecord,
  parseApplicationChatStorageIdentity,
  type ApplicationChatQueuedConversationCreationIntent,
  type ApplicationChatQueuedConversationCreationIntentsRecord,
  type ApplicationChatQueuedConversationMembershipIntent,
  type ApplicationChatQueuedConversationMembershipIntentsRecord,
  type ApplicationChatQueuedConversationPreferenceIntent,
  type ApplicationChatQueuedConversationPreferenceIntentsRecord,
  type ApplicationChatQueuedConversationArchiveIntent,
  type ApplicationChatQueuedConversationArchiveIntentsRecord,
  type ApplicationChatQueuedThreadFollowIntent,
  type ApplicationChatQueuedThreadFollowIntentsRecord,
  type ApplicationChatQueuedSavedMessageIntent,
  type ApplicationChatQueuedSavedMessageIntentsRecord,
  type ApplicationChatQueuedMessageReminderIntent,
  type ApplicationChatQueuedMessageReminderIntentsRecord,
  type ApplicationChatQueuedMessageMutationIntent,
  type ApplicationChatQueuedMessageMutationIntentsRecord,
  type ApplicationChatStorage,
  type ApplicationChatStorageIdentity,
} from "./application-chat-storage.js";
import {
  createOfflineSendMessageQueue,
  type OfflineSendMessageIntent,
  type OfflineSendMessageQueue,
  type OfflineSendMessageQueueListener,
  type OfflineSendMessageQueueState,
} from "./offline-send-message-queue.js";
import {
  createChatSnapshotReader,
  type ChatSnapshotQueryOptions,
  type ChatSnapshotQueryResult,
  type ChatSnapshotQueryRuntimeOptions,
} from "./snapshot-reader.js";
import {
  createChatCrossTabCoordinator,
  type ChatCrossTabCoordinator,
  type ChatCrossTabStatus,
  type CreateChatCrossTabCoordinatorOptions,
} from "./cross-tab-coordinator.js";
import {
  createChatReadStateRuntime,
  type ChatMarkReadInput,
  type ChatMarkReadResult,
  type ChatMarkUnreadInput,
  type ChatMarkUnreadResult,
  type ChatReadStateRuntime,
  type ChatRetainedReadStateRecoveryOptions,
} from "./read-state.js";
import {
  createChatHuddleRuntime,
  type ChatHuddleActionResult,
  type ChatHuddleListener,
  type ChatHuddleRuntime,
  type ChatHuddleRuntimeOptions,
  type ChatHuddleViewState,
} from "./huddle-runtime.js";
import {
  createChatHostDirectoryRuntime,
  type ChatHostDirectoryHydration,
  type ChatHostDirectoryQueryOptions,
  type ChatHostDirectoryResult,
  type ChatHostDirectoryRuntime,
  type ChatHostDirectoryRuntimeOptions,
  type ChatHostDirectorySearchListener,
  type ChatHostDirectorySearchPage,
  type ChatHostDirectorySearchState,
} from "./host-directory.js";
import {
  createChatMessageSearchRuntime,
  type ChatMessageSearchListener,
  type ChatMessageSearchQueryOptions,
  type ChatMessageSearchResult,
  type ChatMessageSearchRuntime,
  type ChatMessageSearchRuntimeOptions,
  type ChatMessageSearchState,
} from "./message-search.js";
import {
  createChatDraftRuntime,
  type ChatDraftCanonicalCheckpoint,
  type ChatCloseDraftOptions,
  type ChatConversationDraftState,
  type ChatDraftFlushResult,
  type ChatDraftRuntime,
  type ChatDraftRuntimeOptions,
  type ChatDraftStateListener,
  type ChatReplaceDraftInput,
} from "./draft-runtime.js";
import { CHAT_CLIENT_PACKAGE_VERSION } from "./generated/package-version.js";

export type {
  ChatClientFetch,
  ChatClientFetchInit,
  ChatClientFetchResponse,
  ChatCommandAborted,
  ChatCommandAuthenticationFailure,
  ChatCommandClosed,
  ChatCommandConflict,
  ChatCommandDescriptor,
  ChatCommandDiagnostic,
  ChatCommandDiagnosticEvent,
  ChatCommandDispatchOptions,
  ChatCommandFeatureDisabled,
  ChatCommandMalformedResponse,
  ChatCommandMethod,
  ChatCommandRejected,
  ChatCommandResult,
  ChatCommandRetryOptions,
  ChatCommandRetrySafety,
  ChatCommandRuntimeOptions,
  ChatCommandSuccess,
  ChatCommandTransportFailure,
  ChatCommandUnsupported,
  ChatCommandValidationFailure,
} from "./command-dispatcher.js";

export { CHAT_CLIENT_PACKAGE_VERSION } from "./generated/package-version.js";

export type ChatClientErrorCode =
  | "access_token_failed"
  | "metadata_request_failed"
  | "malformed_metadata";

export interface ChatClientDiagnostic {
  readonly code: ChatClientErrorCode;
  /** Safe to display or log; never includes a token, response body, or thrown value. */
  readonly message: string;
  readonly httpStatus?: number;
}

export interface ChatClientIdleState {
  readonly state: "idle";
}

export interface ChatClientStartingState {
  readonly state: "starting";
}

export interface ChatClientReadyState<Feature extends string = string> {
  readonly state: "ready";
  readonly clientPackageVersion: typeof CHAT_CLIENT_PACKAGE_VERSION;
  readonly protocolVersion: typeof CHAT_PROTOCOL_VERSION;
  readonly metadata: ServerHandshakeMetadata<Feature>;
  /** The intersection of requested and server-enabled features, including false entries. */
  readonly enabledFeatures: EnabledFeatures<Feature>;
}

export interface ChatClientRefreshRequiredState<
  Feature extends string = string,
> {
  readonly state: "refresh_required";
  readonly reason: "unsupported_protocol";
  readonly message: typeof CHAT_REFRESH_REQUIRED_MESSAGE;
  readonly requestedProtocolVersion: typeof CHAT_PROTOCOL_VERSION;
  readonly clientPackageVersion: typeof CHAT_CLIENT_PACKAGE_VERSION;
  readonly metadata: ServerHandshakeMetadata<Feature>;
}

export interface ChatClientErrorState {
  readonly state: "error";
  readonly diagnostic: ChatClientDiagnostic;
}

export type ChatClientLifecycleState<Feature extends string = string> =
  | ChatClientIdleState
  | ChatClientStartingState
  | ChatClientReadyState<Feature>
  | ChatClientRefreshRequiredState<Feature>
  | ChatClientErrorState;

export type ChatClientLifecycleListener<Feature extends string = string> = (
  state: ChatClientLifecycleState<Feature>,
) => void;

export interface ChatClientCrossTabOptions extends Omit<
  CreateChatCrossTabCoordinatorOptions,
  | "endpoint"
  | "sessionFingerprint"
  | "onHydrationRequest"
  | "onCanonicalState"
  | "onCanonicalEvent"
> {
  /** Stable, trusted, non-secret scope. Access tokens are never consulted. */
  readonly sessionFingerprint?: string;
  /** Re-resolved after close/start so a changed login receives a fresh scope. */
  readonly getSessionFingerprint?: () =>
    | string
    | null
    | undefined
    | Promise<string | null | undefined>;
}

export type ChatNormalizedCachePersistenceDiagnosticCode =
  | "identity_resolution_failed"
  | "snapshot_read_failed"
  | "snapshot_rejected"
  | "snapshot_quarantine_failed"
  | "snapshot_checkpoint_failed"
  | "message_mutation_intents_read_failed"
  | "message_mutation_intents_rejected"
  | "message_mutation_intents_quarantine_failed"
  | "message_mutation_intents_write_failed"
  | "membership_intents_read_failed"
  | "membership_intents_rejected"
  | "membership_intents_quarantine_failed"
  | "membership_intents_write_failed"
  | "conversation_creation_intents_read_failed"
  | "conversation_creation_intents_rejected"
  | "conversation_creation_intents_quarantine_failed"
  | "conversation_creation_intents_write_failed"
  | "conversation_preference_intents_read_failed"
  | "conversation_preference_intents_rejected"
  | "conversation_preference_intents_quarantine_failed"
  | "conversation_preference_intents_write_failed"
  | "conversation_archive_intents_read_failed"
  | "conversation_archive_intents_rejected"
  | "conversation_archive_intents_quarantine_failed"
  | "conversation_archive_intents_write_failed"
  | "thread_follow_intents_read_failed"
  | "thread_follow_intents_rejected"
  | "thread_follow_intents_quarantine_failed"
  | "thread_follow_intents_write_failed"
  | "saved_message_intents_read_failed"
  | "saved_message_intents_rejected"
  | "saved_message_intents_quarantine_failed"
  | "saved_message_intents_write_failed"
  | "message_reminder_intents_read_failed"
  | "message_reminder_intents_rejected"
  | "message_reminder_intents_quarantine_failed"
  | "message_reminder_intents_write_failed"
  | "huddle_intents_read_failed"
  | "huddle_intents_rejected"
  | "huddle_intents_quarantine_failed"
  | "huddle_intents_write_failed"
  | "draft_intents_read_failed"
  | "draft_intents_rejected"
  | "draft_intents_quarantine_failed"
  | "draft_intents_write_failed"
  | "read_intents_read_failed"
  | "read_intents_rejected"
  | "read_intents_quarantine_failed";

export interface ChatNormalizedCachePersistenceDiagnostic {
  readonly code: ChatNormalizedCachePersistenceDiagnosticCode;
  /** Static, redacted text. Identity values, records, and thrown values are omitted. */
  readonly message: string;
}

export interface ChatNormalizedCachePersistenceOptions {
  readonly storage: ApplicationChatStorage;
  /** Trusted host identity. Access-token payloads are never inspected for identity. */
  readonly resolveIdentity: () =>
    | ApplicationChatStorageIdentity
    | Promise<ApplicationChatStorageIdentity>;
  readonly onDiagnostic?: (
    diagnostic: ChatNormalizedCachePersistenceDiagnostic,
  ) => void;
  /** Deterministic, bounded scheduling for retained FIFO send recovery. */
  readonly retainedSendRecovery?: ChatRetainedSendRecoveryOptions;
  /** Deterministic, bounded scheduling for retained membership recovery. */
  readonly retainedMembershipRecovery?: ChatRetainedMembershipRecoveryOptions;
  /** Deterministic, bounded scheduling for retained conversation-creation recovery. */
  readonly retainedConversationCreationRecovery?: ChatRetainedConversationCreationRecoveryOptions;
  /** Deterministic, bounded scheduling for retained conversation-preference recovery. */
  readonly retainedConversationPreferenceRecovery?: ChatRetainedConversationPreferenceRecoveryOptions;
}

export interface ChatRetainedSendRecoveryOptions {
  /** Defaults to 250ms. */
  readonly initialDelayMs?: number;
  /** Defaults to 30 seconds and always bounds calculated delays. */
  readonly maximumDelayMs?: number;
  /** Defaults to 2. */
  readonly multiplier?: number;
  /** Injectable abort-aware wait boundary for controlled clocks. */
  readonly wait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

export type ChatRetainedMembershipRecoveryOptions = ChatRetainedSendRecoveryOptions;
export type ChatRetainedConversationCreationRecoveryOptions = ChatRetainedSendRecoveryOptions;
export type ChatRetainedConversationPreferenceRecoveryOptions = ChatRetainedSendRecoveryOptions;
export type ChatRetainedConversationArchiveRecoveryOptions = ChatRetainedSendRecoveryOptions;
export type ChatRetainedThreadFollowRecoveryOptions = ChatRetainedSendRecoveryOptions;
export type ChatRetainedSavedMessageRecoveryOptions = ChatRetainedSendRecoveryOptions;
export type ChatRetainedMessageReminderRecoveryOptions = ChatRetainedSendRecoveryOptions;

export interface CreateChatClientConfig<Feature extends string = string> {
  readonly endpoint: string;
  /** Commands treat provider exceptions as transport failures; invalid returned tokens as authentication failures. */
  readonly getAccessToken: () => string | Promise<string>;
  /** Client-supported features. Omitted means accept the server's advertised set. */
  readonly features?: EnabledFeatures<Feature>;
  /** Optional browser fetch-compatible implementation. Defaults to globalThis.fetch. */
  readonly fetch?: ChatClientFetch;
  /** Shared command transport policy and deterministic test boundaries. */
  readonly commands?: ChatCommandRuntimeOptions;
  /** Attachment byte-transfer and deterministic lifecycle boundaries. */
  readonly attachments?: ChatAttachmentUploadOptions;
  /** Deterministic identity/clock boundaries for optimistic message projections. */
  readonly optimisticMessages?: {
    readonly generateClientMessageId?: () => string;
    readonly generateIdempotencyKey?: () => string;
    readonly now?: () => number;
  };
  /** Deterministic identity boundary for optimistic message edits. */
  readonly optimisticEdits?: {
    readonly generateIdempotencyKey?: () => string;
  };
  /** Deterministic identity boundary for optimistic message deletions. */
  readonly optimisticDeletes?: {
    readonly generateIdempotencyKey?: () => string;
  };
  /** Deterministic identity boundary for explicit optimistic reaction intents. */
  readonly optimisticReactions?: {
    readonly generateIdempotencyKey?: () => string;
  };
  /** Deterministic identity/scheduling/clock boundaries for optimistic read intents. */
  readonly readState?: {
    readonly generateIdempotencyKey?: () => string;
    readonly schedule?: (task: () => void) => void;
    readonly now?: () => number;
    /** Deterministic, bounded retry scheduling for retained read intents. */
    readonly retainedRecovery?: ChatRetainedReadStateRecoveryOptions;
  };
  /** Deterministic correlation boundaries for conversation lifecycle commands. */
  readonly conversationLifecycle?: {
    readonly generateIdempotencyKey?: () => string;
    readonly generateClientRequestId?: (logicalKey: string) => string;
    /** Deterministic, bounded retry scheduling for retained archive intents. */
    readonly retainedRecovery?: ChatRetainedConversationArchiveRecoveryOptions;
  };
  /** Deterministic identity/clock boundaries for private preference projections. */
  readonly conversationPreferences?: {
    readonly generateIdempotencyKey?: () => string;
    readonly now?: () => number;
  };
  /** Clock and cancellable expiry scheduling for observed channel discovery. */
  readonly threadList?: ChatThreadListScheduling;
  readonly replyStyle?: ChatReplyStyleConfiguration;
  /** Deterministic identity/clock boundaries for explicit thread-follow intents. */
  readonly threadFollows?: {
    readonly generateIdempotencyKey?: () => string;
    readonly now?: () => number;
    /** Deterministic, bounded retry scheduling for retained follow intents. */
    readonly retainedRecovery?: ChatRetainedThreadFollowRecoveryOptions;
  };
  /** Deterministic correlation/clock boundaries for actor-private saved-message intents. */
  readonly savedMessages?: {
    readonly generateIdempotencyKey?: () => string;
    readonly now?: () => number;
    /** Deterministic, bounded retry scheduling for retained saved-message intents. */
    readonly retainedRecovery?: ChatRetainedSavedMessageRecoveryOptions;
  };
  /** Deterministic correlation/clock boundaries for actor-private reminder intents. */
  readonly messageReminders?: {
    readonly generateIdempotencyKey?: () => string;
    readonly now?: () => number;
    /** Deterministic, bounded retry scheduling for retained reminder intents. */
    readonly retainedRecovery?: ChatRetainedMessageReminderRecoveryOptions;
  };
  /** Deterministic identity boundaries for retryable message-forward intents. */
  readonly forwardMessages?: {
    readonly generateClientCorrelationId?: () => string;
    readonly generateIdempotencyKey?: () => string;
  };
  /** Actor-private draft debounce, timer, identifier, and diagnostic boundaries. */
  readonly drafts?: ChatDraftRuntimeOptions;
  /** Deterministic identity/clock boundaries for ephemeral huddle join state. */
  readonly huddles?: ChatHuddleRuntimeOptions;
  /** In-memory identity-scoped host-directory cache and search boundaries. */
  readonly directory?: ChatHostDirectoryRuntimeOptions;
  /** Transient identity-scoped authorized message-search boundaries. */
  readonly messageSearch?: ChatMessageSearchRuntimeOptions;
  /** Optional externally owned normalized cache hydrated by successful snapshot reads. */
  readonly cache?: NormalizedChatCache;
  /** Optional identity-scoped durable canonical cache and send-intent lifecycle. */
  readonly normalizedCachePersistence?: ChatNormalizedCachePersistenceOptions;
  /** Safe diagnostics for snapshot GET operations. */
  readonly queries?: ChatSnapshotQueryRuntimeOptions;
  /** Optional browser WebSocket reliability runtime, owned by this lifecycle. */
  readonly realtime?: Omit<
    CreateChatRealtimeSessionOptions<Feature>,
    "endpoint" | "clientPackageVersion" | "getAccessToken" | "protocolVersion"
  >;
  /** Optional fail-open browser tab coordination. Omit the fingerprint for local mode. */
  readonly crossTab?: ChatClientCrossTabOptions;
}

export interface ChatSendMessageInput<Block extends MessageBlock = MessageBlock> {
  readonly conversationId: ConversationId;
  readonly content: MessageContent<Block>;
  readonly replyTo?: MessageReplyReference;
}

export type ChatSendMessageResult<Block extends MessageBlock = MessageBlock> =
  ChatCommandResult<SendMessageResult<Block>>;

export type ChatForwardMessageInput = Pick<
  ForwardMessageInput,
  "sourceMessageId" | "destinationConversationId"
>;

export type ChatForwardMessageResult<Block extends MessageBlock = MessageBlock> =
  ChatCommandResult<ForwardMessageResult<Block>>;

export interface ChatEditMessageInput<Block extends MessageBlock = MessageBlock> {
  readonly messageId: MessageId;
  readonly expectedRevision: number;
  readonly content: MessageContent<Block>;
}

export type ChatEditMessageResult<Block extends MessageBlock = MessageBlock> =
  ChatCommandResult<EditMessageResult<Block>>;

export interface ChatDeleteMessageInput {
  readonly messageId: MessageId;
  readonly expectedRevision: number;
}

export type ChatDeleteMessageResult<Block extends MessageBlock = MessageBlock> =
  ChatCommandResult<SoftDeleteMessageResult<Block>>;

export interface ChatSetReactionInput {
  readonly messageId: MessageId;
  readonly reactionKey: string;
  /** Explicit desired state; this is intentionally not toggle semantics. */
  readonly reacted: boolean;
}

export type ChatSetReactionResult = ChatCommandResult<ReactionMutationResult>;

export type ChatCreateChannelInput = Omit<
  CreateChannelConversationInput,
  "operation" | "type" | "idempotencyKey" | "clientRequestId"
>;
export type ChatCreateDirectInput = Omit<
  CreateDirectConversationInput,
  "operation" | "type" | "visibility" | "idempotencyKey" | "clientRequestId"
>;
export type ChatCreateGroupDirectInput = Omit<
  CreateGroupDirectConversationInput,
  "operation" | "type" | "visibility" | "idempotencyKey" | "clientRequestId"
>;
export type ChatSetConversationArchiveInput = Omit<
  ArchiveConversationInput,
  "operation" | "intent" | "idempotencyKey"
>;
export type ChatMutateConversationMembershipInput<Input> = Omit<
  Input,
  "operation" | "intent" | "idempotencyKey"
>;

export type ChatCreateChannelResult = ChatCommandResult<ChannelConversationCreationResult>;
export type ChatCreateDirectResult = ChatCommandResult<DirectConversationCreationResult>;
export type ChatCreateGroupDirectResult = ChatCommandResult<GroupDirectConversationCreationResult>;
export type ChatArchiveConversationResult = ChatCommandResult<ArchiveConversationResult>;
export type ChatRestoreConversationResult = ChatCommandResult<RestoreConversationResult>;
export type ChatJoinConversationResult = ChatCommandResult<JoinConversationResult>;
export type ChatLeaveConversationResult = ChatCommandResult<LeaveConversationResult>;
export type ChatAddConversationMemberResult = ChatCommandResult<AddConversationMemberResult>;
export type ChatRemoveConversationMemberResult = ChatCommandResult<RemoveConversationMemberResult>;
export type ChatChangeConversationMemberRoleResult = ChatCommandResult<ChangeConversationMemberRoleResult>;

export type ChatUpdateConversationPreferenceInput = Omit<
  UpdateConversationPreferenceInput,
  "operation" | "expectedPreferenceRevision" | "idempotencyKey"
>;
export type ChatUpdateConversationPreferenceResult =
  ChatCommandResult<UpdateConversationPreferenceResult>;

export interface ChatSetThreadFollowInput {
  readonly threadId: ConversationId;
  /** Explicit desired state; toggle semantics are intentionally unsupported. */
  readonly intent: ThreadFollowMutationIntent;
}

export type ChatSetThreadFollowResult = ChatCommandResult<SetThreadFollowResult>;

export interface ChatSaveMessageInput {
  readonly messageId: MessageId;
  readonly privateNote?: string;
}

export interface ChatUnsaveMessageInput {
  readonly messageId: MessageId;
}

export type ChatSetSavedMessageResult = ChatCommandResult<SetSavedMessageResult>;

export type ChatSetMessageReminderInput = Pick<
  SetMessageReminderInput,
  "conversationId" | "messageId" | "dueAt"
>;
export type ChatCancelMessageReminderInput = Pick<
  CancelMessageReminderInput,
  "conversationId" | "messageId"
>;
export type ChatMessageReminderResult = ChatCommandResult<MessageReminderResult>;

/** A name is optional so host integrations can retain legacy creation policy. */
export type ChatCreateThreadInput = Pick<ThreadCreationInput, "rootMessageId" | "name">;

/** Read-only opening has no creation reconciliation outcome. */
export type ChatExistingThreadOpeningState =
  | Readonly<{ state: "idle" | "loading"; threadConversationId: ConversationId }>
  | Readonly<{
      state: "error";
      threadConversationId: ConversationId;
      code: ChatThreadOpeningErrorCode;
      message: string;
      httpStatus?: number;
    }>
  | Readonly<{
      state: "ready";
      threadConversationId: ConversationId;
      parentConversationId: ConversationId;
      rootMessageId: MessageId;
      rootContext: "available" | "deleted" | "unavailable";
      name?: string;
    }>;

export type ChatExistingThreadOpeningListener = (
  state: ChatExistingThreadOpeningState,
  previous: ChatExistingThreadOpeningState,
) => void;

export type ChatThreadOpeningErrorCode =
  | "root_message_unavailable"
  | "command_failed"
  | "snapshot_failed"
  | "subscription_failed"
  | "cache_reconciliation_failed"
  | "closed";

export interface ChatThreadOpeningIdleState {
  readonly state: "idle";
  readonly rootMessageId: MessageId;
}

export interface ChatThreadOpeningLoadingState {
  readonly state: "loading";
  readonly rootMessageId: MessageId;
  readonly parentConversationId: ConversationId;
}

export interface ChatThreadOpeningErrorState {
  readonly state: "error";
  readonly rootMessageId: MessageId;
  readonly parentConversationId?: ConversationId;
  readonly code: ChatThreadOpeningErrorCode;
  /** Safe renderer-facing detail; transport bodies and thrown values are excluded. */
  readonly message: string;
  readonly httpStatus?: number;
}

export interface ChatThreadOpeningReadyState {
  readonly state: "ready";
  readonly rootMessageId: MessageId;
  readonly parentConversationId: ConversationId;
  readonly threadConversationId: ConversationId;
  readonly reconciliationStatus: ThreadCreationReconciliationStatus;
}

export type ChatThreadOpeningState =
  | ChatThreadOpeningIdleState
  | ChatThreadOpeningLoadingState
  | ChatThreadOpeningErrorState
  | ChatThreadOpeningReadyState;

export type ChatThreadOpeningListener = (
  state: ChatThreadOpeningState,
  previous: ChatThreadOpeningState,
) => void;

export interface ChatClient<Feature extends string = string> {
  /** Normalized base endpoint; trailing separators are removed. */
  readonly endpoint: string;
  readonly state: ChatClientLifecycleState<Feature>;
  readonly realtime: ChatRealtimeSession<Feature> | undefined;
  readonly coordination: ChatCrossTabStatus | undefined;
  readonly cache: NormalizedChatCache;
  readonly threadList: ChatThreadList;
  readonly replyStyle: ChatReplyStyle;
  readonly threadLifecycle: ChatThreadLifecycle;
  readonly messageContext: ChatMessageContext;
  /** Returns the immutable durable-send state for the active trusted identity. */
  getSendMessageQueueState(): OfflineSendMessageQueueState;
  /** Immediately observes the current durable-send state and future persisted changes. */
  subscribeSendMessageQueue(listener: OfflineSendMessageQueueListener): () => void;
  /** Durably removes one queued send without dispatching it. */
  cancelQueuedMessage(clientMessageId: string): Promise<boolean>;
  /** Observes future canonical lifecycle transitions. */
  subscribeLifecycle(listener: ChatClientLifecycleListener<Feature>): () => void;
  /**
   * Starts metadata negotiation. Concurrent calls share one promise; ready and
   * refresh-required states are stable. Error states retry with a fresh token.
   */
  start(): Promise<ChatClientLifecycleState<Feature>>;
  /** Dispatches one validated command without directly mutating client state or cache. */
  dispatch<Input, RequestBody, Result>(
    descriptor: ChatCommandDescriptor<Input, RequestBody, Result>,
    input: Input,
    options?: ChatCommandDispatchOptions,
  ): Promise<ChatCommandResult<Result>>;
  listConversations(
    input: ConversationListSnapshotInput,
    options?: ChatSnapshotQueryOptions,
  ): Promise<ChatSnapshotQueryResult<ConversationListSnapshot<Feature>>>;
  getConversation(
    input: ConversationDetailSnapshotInput,
    options?: ChatSnapshotQueryOptions,
  ): Promise<ChatSnapshotQueryResult<ConversationDetailSnapshot<Feature>>>;
  getMessageTimeline(
    input: MessageTimelineRequest,
    options?: ChatSnapshotQueryOptions,
  ): Promise<ChatSnapshotQueryResult<MessageTimelinePage>>;
  /** Hydrates the trusted current actor's draft for one conversation. */
  getConversationDraft(
    input: ConversationDraftSnapshotInput,
    options?: ChatSnapshotQueryOptions,
  ): Promise<ChatSnapshotQueryResult<ConversationDraftSnapshot>>;
  /** Opens and safely hydrates one actor-private composer lifecycle. */
  openConversationDraft(
    conversationId: ConversationId,
  ): Promise<ChatConversationDraftState>;
  /** Selects an immutable, renderer-safe local/canonical draft projection. */
  selectConversationDraft(conversationId: ConversationId): ChatConversationDraftState;
  subscribeConversationDraft(
    conversationId: ConversationId,
    listener: ChatDraftStateListener,
  ): () => void;
  /** Projects local content synchronously and debounces revisioned persistence. */
  replaceConversationDraft(input: ChatReplaceDraftInput): ChatConversationDraftState;
  /** Projects a clear tombstone synchronously and debounces persistence. */
  clearConversationDraft(conversationId: ConversationId): ChatConversationDraftState;
  flushConversationDraft(conversationId: ConversationId): Promise<ChatDraftFlushResult>;
  retryConversationDraft(conversationId: ConversationId): Promise<ChatDraftFlushResult>;
  /** Defaults to flush; abort restores the last authoritative state. */
  closeConversationDraft(
    conversationId: ConversationId,
    options?: ChatCloseDraftOptions,
  ): Promise<ChatDraftFlushResult>;
  /** Hydrates one opaque-cursor page from the trusted current actor's saved list. */
  listSavedMessages(
    input: SavedMessageListSnapshotInput,
    options?: ChatSnapshotQueryOptions,
  ): Promise<ChatSnapshotQueryResult<SavedMessageListSnapshot>>;
  listMessageReminders(
    input: MessageReminderListSnapshotInput,
    options?: ChatSnapshotQueryOptions,
  ): Promise<ChatSnapshotQueryResult<MessageReminderListSnapshot>>;
  /** Fetches only missing or expired visible user projections. */
  hydrateDirectoryUsers(
    userIds: readonly UserId[],
    options?: ChatHostDirectoryQueryOptions,
  ): Promise<ChatHostDirectoryResult<ChatHostDirectoryHydration>>;
  /** Selects a validated immutable projection from the current identity's memory. */
  selectDirectoryUser(userId: UserId): HostDirectoryUserSummary | undefined;
  /** Debounces first-page membership search and uses opaque cursors for later pages. */
  searchDirectoryUsers(
    input: HostDirectorySearchInput,
    options?: ChatHostDirectoryQueryOptions,
  ): Promise<ChatHostDirectoryResult<ChatHostDirectorySearchPage>>;
  getDirectorySearchState(): ChatHostDirectorySearchState;
  subscribeDirectorySearch(listener: ChatHostDirectorySearchListener): () => void;
  cancelDirectorySearch(): void;
  /** Debounces first-page authorized search and accumulates opaque-cursor pages. */
  searchMessages(
    input: MessageSearchRequest,
    options?: ChatMessageSearchQueryOptions,
  ): Promise<ChatMessageSearchResult>;
  getMessageSearchState(): ChatMessageSearchState;
  subscribeMessageSearch(listener: ChatMessageSearchListener): () => void;
  cancelMessageSearch(): void;
  /** Hydrates canonical server huddle state without exposing media join material. */
  hydrateHuddle(conversationId: ConversationId): Promise<ChatHuddleActionResult>;
  getHuddleState(conversationId: ConversationId): ChatHuddleViewState;
  subscribeHuddle(
    conversationId: ConversationId,
    listener: ChatHuddleListener,
  ): () => void;
  startHuddle(conversationId: ConversationId): Promise<ChatHuddleActionResult>;
  joinHuddle(conversationId: ConversationId): Promise<ChatHuddleActionResult>;
  leaveHuddle(conversationId: ConversationId): Promise<ChatHuddleActionResult>;
  setHuddleScreenShare(
    conversationId: ConversationId,
  ): Promise<ChatHuddleActionResult>;
  clearHuddleScreenShare(
    conversationId: ConversationId,
  ): Promise<ChatHuddleActionResult>;
  endHuddle(conversationId: ConversationId): Promise<ChatHuddleActionResult>;
  retryHuddle(conversationId: ConversationId): Promise<ChatHuddleActionResult>;
  rejoinHuddle(conversationId: ConversationId): Promise<ChatHuddleActionResult>;
  /** Returns short-lived opaque media material from private in-memory state only. */
  getHuddleMediaJoinDescriptor(
    conversationId: ConversationId,
  ): import("../contracts/huddle-session.js").HuddleMediaJoinDescriptor | undefined;
  /** Resolves, subscribes, and hydrates a root's canonical thread without sending a reply. */
  openThread(rootMessageId: MessageId): Promise<ChatThreadOpeningState>;
  /** Creates or resolves a root's canonical thread; retries retain the first name and key. */
  createThread(input: ChatCreateThreadInput): Promise<ChatThreadOpeningState>;
  /** Reads an authorized thread without creating, joining, following, or marking it read. */
  openExistingThread(threadId: ConversationId): Promise<ChatExistingThreadOpeningState>;
  getExistingThreadOpeningState(threadId: ConversationId): ChatExistingThreadOpeningState;
  subscribeExistingThreadOpening(
    threadId: ConversationId,
    listener: ChatExistingThreadOpeningListener,
  ): () => void;
  getThreadOpeningState(rootMessageId: MessageId): ChatThreadOpeningState;
  subscribeThreadOpening(
    rootMessageId: MessageId,
    listener: ChatThreadOpeningListener,
  ): () => void;
  /** Starts prepare-transfer-finalize orchestration and returns a caller-cancellable handle. */
  uploadAttachment(input: ChatAttachmentUploadInput): ChatAttachmentUploadHandle;
  /** Persists first when storage is configured, then projects and dispatches the command. */
  sendMessage<Block extends MessageBlock = MessageBlock>(
    input: ChatSendMessageInput<Block>,
  ): Promise<ChatSendMessageResult<Block>>;
  /** Retries a failed projection with its original clientMessageId and idempotency key. */
  retryMessage<Block extends MessageBlock = MessageBlock>(
    clientMessageId: string,
  ): Promise<ChatSendMessageResult<Block>>;
  /** Forwards an immutable source snapshot into the requested destination. */
  forwardMessage<Block extends MessageBlock = MessageBlock>(
    input: ChatForwardMessageInput,
  ): Promise<ChatForwardMessageResult<Block>>;
  /** Applies content synchronously and settles it from HTTP or the durable event. */
  editMessage<Block extends MessageBlock = MessageBlock>(
    input: ChatEditMessageInput<Block>,
  ): Promise<ChatEditMessageResult<Block>>;
  /** Redacts content synchronously and settles the tombstone from HTTP or realtime. */
  deleteMessage<Block extends MessageBlock = MessageBlock>(
    input: ChatDeleteMessageInput,
  ): Promise<ChatDeleteMessageResult<Block>>;
  /** Applies an explicit desired reaction state and serializes commands per message. */
  setReaction(input: ChatSetReactionInput): Promise<ChatSetReactionResult>;
  createChannel(input: ChatCreateChannelInput): Promise<ChatCreateChannelResult>;
  createDirect(input: ChatCreateDirectInput): Promise<ChatCreateDirectResult>;
  createGroupDirect(
    input: ChatCreateGroupDirectInput,
  ): Promise<ChatCreateGroupDirectResult>;
  archiveConversation(
    input: ChatSetConversationArchiveInput,
  ): Promise<ChatArchiveConversationResult>;
  restoreConversation(
    input: ChatSetConversationArchiveInput,
  ): Promise<ChatRestoreConversationResult>;
  joinConversation(
    input: ChatMutateConversationMembershipInput<JoinConversationInput>,
  ): Promise<ChatJoinConversationResult>;
  leaveConversation(
    input: ChatMutateConversationMembershipInput<LeaveConversationInput>,
  ): Promise<ChatLeaveConversationResult>;
  addConversationMember(
    input: ChatMutateConversationMembershipInput<AddConversationMemberInput>,
  ): Promise<ChatAddConversationMemberResult>;
  removeConversationMember(
    input: ChatMutateConversationMembershipInput<RemoveConversationMemberInput>,
  ): Promise<ChatRemoveConversationMemberResult>;
  changeConversationMemberRole(
    input: ChatMutateConversationMembershipInput<ChangeConversationMemberRoleInput>,
  ): Promise<ChatChangeConversationMemberRoleResult>;
  /** Immediately projects explicit private settings and serializes replacements per conversation. */
  updateConversationPreference(
    input: ChatUpdateConversationPreferenceInput,
  ): Promise<ChatUpdateConversationPreferenceResult>;
  /** Persists first when configured, then projects and reconciles the explicit desired state. */
  setThreadFollow(input: ChatSetThreadFollowInput): Promise<ChatSetThreadFollowResult>;
  followThread(threadId: ConversationId): Promise<ChatSetThreadFollowResult>;
  unfollowThread(threadId: ConversationId): Promise<ChatSetThreadFollowResult>;
  /** Immediately projects an actor-private saved state for an accessible message. */
  saveMessage(input: ChatSaveMessageInput): Promise<ChatSetSavedMessageResult>;
  /** Immediately projects explicit unsaved state; toggle semantics are unsupported. */
  unsaveMessage(input: ChatUnsaveMessageInput): Promise<ChatSetSavedMessageResult>;
  /** Retries a failed ambiguous delivery with its exact original request correlation. */
  retrySavedMessage(messageId: MessageId): Promise<ChatSetSavedMessageResult>;
  /** Immediately projects a scheduled reminder and serializes replacements per message. */
  setMessageReminder(input: ChatSetMessageReminderInput): Promise<ChatMessageReminderResult>;
  /** Immediately projects explicit cancellation; toggle semantics are unsupported. */
  cancelMessageReminder(input: ChatCancelMessageReminderInput): Promise<ChatMessageReminderResult>;
  /** Retries an ambiguous reminder delivery with its original correlation. */
  retryMessageReminder(messageId: MessageId): Promise<ChatMessageReminderResult>;
  /** Optimistically reads through an explicit in-bounds sequence. */
  markRead(input: ChatMarkReadInput): Promise<ChatMarkReadResult>;
  /** Optimistically marks an explicit already-read sequence unread. */
  markUnread(input: ChatMarkUnreadInput): Promise<ChatMarkUnreadResult>;
  startTyping(
    conversationId: string,
    visibility?: "public" | "private",
  ): boolean;
  stopTyping(conversationId: string): void;
  setPresence(state: "online" | "away" | "offline"): void;
  notifyActivity(): void;
  /**
   * Aborts startup and returns to idle. It is idempotent. Calling start after
   * close begins a new attempt and obtains a fresh token.
   */
  close(): void;
}

export class ChatClientConfigurationError extends TypeError {
  constructor(message: string) {
    super(`Invalid chat client configuration: ${message}`);
    this.name = "ChatClientConfigurationError";
  }
}

const CROSS_TAB_ATOMIC_STORAGE_REQUIRED_MESSAGE =
  "normalizedCachePersistence.storage.compareExchange must be a function when crossTab is configured";

class StartupFailure {
  constructor(readonly diagnostic: ChatClientDiagnostic) {}
}

const ABORTED = Symbol("chat-client-startup-aborted");
// Detach even host block data before retaining the logical request for retries.
const freezeLogicalSend = <T>(input: T): T => {
  const copy = structuredClone(input);
  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  };
  freeze(copy);
  return copy;
};

const IDLE_STATE = Object.freeze({ state: "idle" } as const);
const STARTING_STATE = Object.freeze({ state: "starting" } as const);
const SEND_VALIDATION_FAILURE = Object.freeze({
  status: "validation",
  message: "The command input is invalid.",
} as const);
const SEND_MALFORMED_RESPONSE = Object.freeze({
  status: "malformed_response",
  message: "The chat server returned an invalid command response.",
} as const);
const EMPTY_SEND_MESSAGE_QUEUE_STATE: OfflineSendMessageQueueState = Object.freeze({
  identity: null,
  isHydrated: false,
  intents: Object.freeze([]),
});
const PREFERENCE_CLOSED_RESULT = Object.freeze({
  status: "closed",
  message: "The chat client was closed.",
} as const);
const THREAD_FOLLOW_CLOSED_RESULT = PREFERENCE_CLOSED_RESULT;
const RETAINED_SEND_INITIAL_DELAY_MS = 250;
const RETAINED_SEND_MAXIMUM_DELAY_MS = 30_000;
const RETAINED_SEND_RETRY_MULTIPLIER = 2;
const MAX_RETAINED_MESSAGE_REMINDER_AUTHORITY_PAGES = 100;
type DurableEditIntent = Omit<
  ApplicationChatQueuedMessageMutationIntent,
  "request"
> & Readonly<{ request: EditMessageInput }>;
type DurableDeleteIntent = Omit<
  ApplicationChatQueuedMessageMutationIntent,
  "request"
> & Readonly<{ request: SoftDeleteMessageInput }>;
type DurableReactionIntent = Omit<
  ApplicationChatQueuedMessageMutationIntent,
  "request"
> & Readonly<{ request: ReactionMutationInput }>;
type DurableForwardIntent = Omit<
  ApplicationChatQueuedMessageMutationIntent,
  "request"
> & Readonly<{ request: ForwardMessageInput }>;
type DurableMembershipIntent = ApplicationChatQueuedConversationMembershipIntent;
type DurableConversationCreationIntent = ApplicationChatQueuedConversationCreationIntent;
type DurableConversationPreferenceIntent = ApplicationChatQueuedConversationPreferenceIntent;
type DurableConversationArchiveIntent = ApplicationChatQueuedConversationArchiveIntent;
type DurableThreadFollowIntent = ApplicationChatQueuedThreadFollowIntent;
type DurableSavedMessageIntent = ApplicationChatQueuedSavedMessageIntent;
type DurableMessageReminderIntent = ApplicationChatQueuedMessageReminderIntent;
const METADATA_FIELDS = [
  "packageVersion",
  "protocolVersion",
  "schemaVersion",
  "enabledFeatures",
  "supportedProtocolRange",
] as const;

const waitForRetainedSendDelay = (
  delayMs: number,
  signal: AbortSignal,
): Promise<void> => {
  if (signal.aborted) return Promise.reject(ABORTED);
  return new Promise<void>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    const abort = () => {
      globalThis.clearTimeout(timer);
      reject(ABORTED);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
};

const createSendMessageDescriptor = <Block extends MessageBlock>(): ChatCommandDescriptor<
  SendMessageInput<Block>,
  SendMessageInput<Block>,
  SendMessageResult<Block>
> => Object.freeze({
  name: "message.send",
  method: "POST",
  path: (input: SendMessageInput<Block>) =>
    `/conversations/${encodeURIComponent(input.conversationId)}/messages`,
  retry: "safe",
  validateInput: (input: SendMessageInput<Block>) => parseSendMessageInput<Block>(input),
  parseResult: (value: unknown) => parseSendMessageResult<Block>(value),
});

const createForwardMessageDescriptor = <Block extends MessageBlock>(
  expectedInput: ForwardMessageInput,
): ChatCommandDescriptor<
  ForwardMessageInput,
  ForwardMessageInput,
  ForwardMessageResult<Block>
> => Object.freeze({
  name: "message.forward",
  method: "POST",
  path: "/messages/forward",
  retry: "safe",
  validateInput: (input: ForwardMessageInput) => parseForwardMessageInput(input),
  parseResult: (value: unknown) =>
    parseForwardMessageResult<Block>(value, expectedInput),
});

const createEditMessageDescriptor = <Block extends MessageBlock>(): ChatCommandDescriptor<
  EditMessageInput<Block>,
  EditMessageInput<Block>,
  EditMessageResult<Block>
> => Object.freeze({
  name: "message.edit",
  method: "PATCH",
  path: (input: EditMessageInput<Block>) =>
    `/messages/${encodeURIComponent(input.messageId)}`,
  retry: "safe",
  validateInput: (input: EditMessageInput<Block>) => parseEditMessageInput<Block>(input),
  parseResult: (value: unknown) => parseEditMessageResult<Block>(value),
  parseErrorResult: (value: unknown, httpStatus: number) => {
    if (httpStatus !== 409) return undefined;
    try {
      const result = parseEditMessageResult<Block>(value);
      return result.reconciliationStatus === "revision_conflict"
        ? result
        : undefined;
    } catch {
      return undefined;
    }
  },
});

const createDeleteMessageDescriptor = <Block extends MessageBlock>(): ChatCommandDescriptor<
  SoftDeleteMessageInput,
  SoftDeleteMessageInput,
  SoftDeleteMessageResult<Block>
> => Object.freeze({
  name: "message.delete",
  method: "DELETE",
  path: (input: SoftDeleteMessageInput) =>
    `/messages/${encodeURIComponent(input.messageId)}`,
  retry: "safe",
  validateInput: (input: SoftDeleteMessageInput) => parseSoftDeleteMessageInput(input),
  parseResult: (value: unknown) => parseSoftDeleteMessageResult<Block>(value),
  parseErrorResult: (value: unknown, httpStatus: number) => {
    if (httpStatus !== 409) return undefined;
    try {
      const result = parseSoftDeleteMessageResult<Block>(value);
      return result.reconciliationStatus === "revision_conflict"
        ? result
        : undefined;
    } catch {
      return undefined;
    }
  },
});

const REACTION_DESCRIPTOR: ChatCommandDescriptor<
  ReactionMutationInput,
  ReactionMutationInput,
  ReactionMutationResult
> = Object.freeze({
  name: "reaction.set",
  method: "PATCH",
  path: (input: ReactionMutationInput) =>
    `/messages/${encodeURIComponent(input.messageId)}/reactions/${encodeURIComponent(input.reactionKey)}`,
  retry: "safe",
  validateInput: (input: ReactionMutationInput) => parseReactionMutationInput(input),
  parseResult: (value: unknown) => parseReactionMutationResult(value),
});

const createConversationDescriptor = (
  expectedInput: ConversationCreationInput,
): ChatCommandDescriptor<
  ConversationCreationInput,
  ConversationCreationInput,
  ConversationCreationResult
> => Object.freeze({
  name: "conversation.create",
  method: "POST",
  path: "/conversations",
  retry: "safe",
  validateInput: (input: ConversationCreationInput) =>
    parseConversationCreationInput(input),
  parseResult: (value: unknown) =>
    parseConversationCreationResult(value, expectedInput),
});

const createThreadDescriptor = (
  expectedInput: ThreadCreationInput,
): ChatCommandDescriptor<
  ThreadCreationInput,
  ThreadCreationInput,
  ThreadCreationResult
> => Object.freeze({
  name: "thread.create",
  method: "POST",
  path: `/messages/${encodeURIComponent(expectedInput.rootMessageId)}/thread`,
  retry: "safe",
  validateInput: (input: ThreadCreationInput) => parseThreadCreationInput(input),
  parseResult: (value: unknown) =>
    parseThreadCreationResult(value, expectedInput),
});

const createConversationArchiveDescriptor = (
  expectedInput: ConversationArchiveInput,
): ChatCommandDescriptor<
  ConversationArchiveInput,
  ConversationArchiveInput,
  ConversationArchiveResult
> => Object.freeze({
  name: `conversation.${expectedInput.intent}`,
  method: "PATCH",
  path: `/conversations/${encodeURIComponent(expectedInput.conversationId)}/lifecycle`,
  retry: "safe",
  validateInput: (input: ConversationArchiveInput) =>
    parseConversationArchiveInput(input),
  parseResult: (value: unknown) =>
    parseConversationArchiveResult(value, expectedInput),
  parseErrorResult: (value: unknown, httpStatus: number) => {
    if (httpStatus !== 409) return undefined;
    try {
      const result = parseConversationArchiveResult(value, expectedInput);
      return result.reconciliationStatus === "lifecycle_conflict"
        ? result
        : undefined;
    } catch {
      return undefined;
    }
  },
});

const createConversationMembershipDescriptor = (
  expectedInput: ConversationMembershipMutationInput,
): ChatCommandDescriptor<
  ConversationMembershipMutationInput,
  ConversationMembershipMutationInput,
  ConversationMembershipMutationResult
> => Object.freeze({
  name: `conversation.membership.${expectedInput.intent}`,
  method: "PATCH",
  path: `/conversations/${encodeURIComponent(expectedInput.conversationId)}/membership`,
  retry: "safe",
  validateInput: (input: ConversationMembershipMutationInput) =>
    parseConversationMembershipMutationInput(input),
  parseResult: (value: unknown) =>
    parseConversationMembershipMutationResult(value, expectedInput),
  parseErrorResult: (value: unknown, httpStatus: number) => {
    if (httpStatus !== 409) return undefined;
    try {
      const result = parseConversationMembershipMutationResult(value, expectedInput);
      return result.reconciliationStatus === "member_list_conflict" ||
        result.reconciliationStatus === "safety_rejected"
        ? result
        : undefined;
    } catch {
      return undefined;
    }
  },
});

const conversationMembershipLogicalKey = (
  input: ConversationMembershipMutationInput,
): string => JSON.stringify([
  "membership",
  input.intent,
  input.conversationId,
  input.expectedMemberListRevision,
  "targetUserId" in input ? input.targetUserId ?? null : null,
  "requestedRole" in input ? input.requestedRole ?? null : null,
]);

const createConversationPreferenceDescriptor = (
  expectedInput: UpdateConversationPreferenceInput,
): ChatCommandDescriptor<
  UpdateConversationPreferenceInput,
  UpdateConversationPreferenceInput,
  UpdateConversationPreferenceResult
> => Object.freeze({
  name: "conversation.preference.update",
  method: "PATCH",
  path: `/conversations/${encodeURIComponent(expectedInput.conversationId)}/preference`,
  retry: "safe",
  validateInput: (input: UpdateConversationPreferenceInput) =>
    parseUpdateConversationPreferenceInput(input),
  parseResult: (value: unknown) =>
    parseUpdateConversationPreferenceResult(value, expectedInput),
  parseErrorResult: (value: unknown, httpStatus: number) => {
    if (httpStatus !== 409) return undefined;
    try {
      const result = parseUpdateConversationPreferenceResult(value, expectedInput);
      return result.reconciliationStatus === "preference_revision_conflict"
        ? result
        : undefined;
    } catch {
      return undefined;
    }
  },
});

const createThreadFollowDescriptor = (
  expectedInput: SetThreadFollowInput,
): ChatCommandDescriptor<
  SetThreadFollowInput,
  SetThreadFollowInput,
  SetThreadFollowResult
> => Object.freeze({
  name: "thread.follow.set",
  method: "PATCH",
  path: `/conversations/${encodeURIComponent(expectedInput.target.id)}/follow`,
  retry: "safe",
  validateInput: (input: SetThreadFollowInput) =>
    parseSetThreadFollowInput(input),
  parseResult: (value: unknown) =>
    parseSetThreadFollowResult(value, expectedInput),
  parseErrorResult: (value: unknown, httpStatus: number) => {
    if (httpStatus !== 409) return undefined;
    try {
      const result = parseSetThreadFollowResult(value, expectedInput);
      return result.reconciliationStatus === "follow_revision_conflict"
        ? result
        : undefined;
    } catch {
      return undefined;
    }
  },
});

const CONVERSATION_ARCHIVE_AUTHORITY_REFRESH_RESULT = Object.freeze({
  status: "success" as const,
  value: Object.freeze({ authorityRefresh: true as const }),
});

const isConversationArchiveAuthorityRefreshResult = (
  value: unknown,
): boolean => isRecord(value) &&
  exactKeys(value, ["status", "value"]) &&
  value.status === "success" &&
  isRecord(value.value) &&
  exactKeys(value.value, ["authorityRefresh"]) &&
  value.value.authorityRefresh === true;

const createSavedMessageDescriptor = (
  expectedInput: SetSavedMessageInput,
): ChatCommandDescriptor<
  SetSavedMessageInput,
  SetSavedMessageInput,
  SetSavedMessageResult
> => Object.freeze({
  name: "saved-message.set",
  method: "PATCH",
  path: `/messages/${encodeURIComponent(expectedInput.messageId)}/saved`,
  retry: "safe",
  validateInput: (input: SetSavedMessageInput) =>
    parseSetSavedMessageInput(input),
  parseResult: (value: unknown) =>
    parseSetSavedMessageResult(value, expectedInput),
  parseErrorResult: (value: unknown, httpStatus: number) => {
    if (httpStatus !== 409) return undefined;
    try {
      const result = parseSetSavedMessageResult(value, expectedInput);
      return result.reconciliationStatus === "saved_message_revision_conflict"
        ? result
        : undefined;
    } catch {
      return undefined;
    }
  },
});

const SAVED_MESSAGE_AUTHORITY_REFRESH_RESULT = Object.freeze({
  status: "success" as const,
  value: Object.freeze({ authorityRefresh: true as const }),
});

const isSavedMessageAuthorityRefreshResult = (
  value: unknown,
): boolean => isRecord(value) &&
  exactKeys(value, ["status", "value"]) &&
  value.status === "success" &&
  isRecord(value.value) &&
  exactKeys(value.value, ["authorityRefresh"]) &&
  value.value.authorityRefresh === true;

const MESSAGE_REMINDER_AUTHORITY_REFRESH_RESULT = Object.freeze({
  status: "success" as const,
  value: Object.freeze({ authorityRefresh: true as const }),
});

const HUDDLE_AUTHORITY_REFRESH_RESULT = Object.freeze({
  status: "success" as const,
  value: Object.freeze({ authorityRefresh: true as const }),
});

const isMessageReminderAuthorityRefreshResult = (
  value: unknown,
): boolean => isRecord(value) &&
  exactKeys(value, ["status", "value"]) &&
  value.status === "success" &&
  isRecord(value.value) &&
  exactKeys(value.value, ["authorityRefresh"]) &&
  value.value.authorityRefresh === true;

const createMessageReminderDescriptor = (
  expectedInput: MessageReminderInput,
): ChatCommandDescriptor<MessageReminderInput, MessageReminderInput, MessageReminderResult> =>
  Object.freeze({
    name: "message-reminder.set",
    method: "PUT",
    path: `/conversations/${encodeURIComponent(expectedInput.conversationId)}/messages/${encodeURIComponent(expectedInput.messageId)}/reminder`,
    retry: "safe",
    validateInput: (input: MessageReminderInput) => input.intent === "set"
      ? parseSetMessageReminderInput(input, { referenceTime: new Date(0) })
      : parseCancelMessageReminderInput(input),
    parseResult: (value: unknown) => parseMessageReminderResult(value, expectedInput),
    parseErrorResult: (value: unknown, httpStatus: number) => {
      if (httpStatus !== 409) return undefined;
      try {
        const result = parseMessageReminderResult(value, expectedInput);
        return result.reconciliationStatus === "revision-conflict" ? result : undefined;
      } catch {
        return undefined;
      }
    },
  });

const isRetryableSendFailure = (
  status: ChatCommandResult<unknown>["status"],
): status is OptimisticMessageFailure =>
  status === "transport" ||
  status === "authentication" ||
  status === "conflict" ||
  status === "malformed_response" ||
  status === "aborted" ||
  status === "closed";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const storageIdentitiesEqual = (
  left: ApplicationChatStorageIdentity | undefined,
  right: ApplicationChatStorageIdentity | undefined,
): boolean => left !== undefined && right !== undefined &&
  left.tenantId === right.tenantId &&
  left.userId === right.userId &&
  left.deviceId === right.deviceId;

/**
 * Removes process-local projections before the storage contract validates and
 * detaches a checkpoint. Canonical server rows remain available after reload;
 * pending transport correlation, transient uploads, and ephemeral signals do not.
 */
const createDurableCacheSnapshot = (
  state: NormalizedChatCacheState,
  canonicalDrafts?: ChatDraftCanonicalCheckpoint,
): NormalizedChatCacheState => {
  const messages: Record<string, unknown> = {};
  for (const [messageId, message] of Object.entries(state.entities.messages)) {
    if ("delivery" in message) continue;
    if ("deleteState" in message) {
      messages[messageId] = message.deleteState.previous;
      continue;
    }
    if ("editState" in message) {
      if (message.editState.state === "pending") {
        messages[messageId] = message.editState.previous;
      } else {
        const { editState: _editState, ...canonical } = message;
        messages[messageId] = canonical;
      }
      continue;
    }
    messages[messageId] = message;
  }

  const timelines: Record<string, unknown> = {};
  for (const [conversationId, timeline] of Object.entries(state.timelines)) {
    const messageIds = timeline.messageIds.filter((messageId) =>
      Object.hasOwn(messages, messageId));
    const eventId = timeline.realtimeCursor.eventId;
    if (eventId.startsWith("optimistic:") && state.metadata.realtimeCursor === undefined) {
      continue;
    }
    timelines[conversationId] = {
      ...timeline,
      messageIds,
      realtimeCursor: eventId.startsWith("optimistic:")
        ? state.metadata.realtimeCursor
        : timeline.realtimeCursor,
    };
  }

  const preferences: Record<string, unknown> = { ...state.currentUser.preferences };
  for (const [conversationId, pending] of Object.entries(
    state.currentUser.pendingPreferenceUpdates,
  )) {
    if (pending.authoritativePreference === undefined) delete preferences[conversationId];
    else preferences[conversationId] = pending.authoritativePreference;
  }
  const threadFollows: Record<string, unknown> = {
    ...state.currentUser.threadFollows,
  };
  for (const [threadId, pending] of Object.entries(
    state.currentUser.pendingThreadFollowUpdates,
  )) {
    if (pending.authoritativeFollow === undefined) delete threadFollows[threadId];
    else threadFollows[threadId] = pending.authoritativeFollow;
  }
  const savedMessages: Record<string, unknown> = {
    ...state.currentUser.savedMessages,
  };
  for (const [messageId, pending] of Object.entries(
    state.currentUser.pendingSavedMessageUpdates,
  )) {
    if (pending.authoritativeSavedMessage === undefined) delete savedMessages[messageId];
    else savedMessages[messageId] = pending.authoritativeSavedMessage;
  }
  const messageReminders: Record<string, unknown> = {
    ...state.currentUser.messageReminders,
  };
  const messageReminderConversationIds: Record<string, unknown> = {
    ...state.currentUser.messageReminderConversationIds,
  };
  const messageReminderRevisions = state.currentUser
    .messageReminderRevisions as Readonly<Record<string, number>>;
  for (const [messageId, pending] of Object.entries(
    state.currentUser.pendingMessageReminderUpdates,
  )) {
    if (pending.authoritativeReminder === undefined) {
      delete messageReminders[messageId];
      if (messageReminderRevisions[messageId] === undefined) {
        delete messageReminderConversationIds[messageId];
      }
    } else {
      messageReminders[messageId] = pending.authoritativeReminder;
    }
  }

  const { realtimeCursor, ...metadataWithoutCursor } = state.metadata;
  const durableMetadata = {
    ...metadataWithoutCursor,
    pendingConversationOperations: {},
    ...(realtimeCursor === undefined || realtimeCursor.eventId.startsWith("optimistic:")
      ? {}
      : { realtimeCursor }),
  };
  return {
    ...state,
    entities: { ...state.entities, messages } as NormalizedChatCacheState["entities"],
    attachmentUploads: {},
    timelines: timelines as NormalizedChatCacheState["timelines"],
    currentUser: {
      ...state.currentUser,
      preferences,
      pendingPreferenceUpdates: {},
      threadFollows,
      pendingThreadFollowUpdates: {},
      savedMessages,
      pendingSavedMessageUpdates: {},
      messageReminders,
      messageReminderConversationIds,
      pendingMessageReminderUpdates: {},
      ...(canonicalDrafts === undefined
        ? {}
        : {
            drafts: canonicalDrafts.drafts,
            draftRevisions: canonicalDrafts.draftRevisions,
          }),
    } as unknown as NormalizedChatCacheState["currentUser"],
    ephemeral: { typing: {}, presence: {} },
    // Huddle rows are canonical provider-neutral authority. Pending recovery
    // state and opaque media descriptors live only in the huddle runtime.
    huddles: state.huddles,
    metadata: durableMetadata,
  } as NormalizedChatCacheState;
};

const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
};

const stableLogicalHash = (value: string): string => {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(36)}${(second >>> 0).toString(36)}`;
};

const lifecycleCoordinationKey = (logicalKey: string): string =>
  `conversation:${stableLogicalHash(logicalKey)}`;

const defaultLifecycleClientRequestId = (logicalKey: string): string =>
  `conversation-request:${stableLogicalHash(logicalKey)}`;

const parseCoordinatedCommandResult = <Input, RequestBody, Result>(
  descriptor: ChatCommandDescriptor<Input, RequestBody, Result>,
  value: unknown,
): ChatCommandResult<Result> | undefined => {
  if (!isRecord(value) || typeof value.status !== "string") return undefined;
  if (value.status === "success") {
    if (!exactKeys(value, ["status", "value"])) return undefined;
    try {
      return Object.freeze({ status: "success", value: descriptor.parseResult(value.value) });
    } catch {
      return undefined;
    }
  }
  const definitions = {
    validation: ["The command input is invalid.", false],
    conflict: ["The command conflicts with current server state.", true],
    authentication: ["Chat authentication failed.", "optional"],
    feature_disabled: ["The requested chat feature is disabled.", true],
    unsupported: ["The requested chat command is unsupported.", true],
    rejected: ["The chat server rejected the command.", true],
    malformed_response: ["The chat server returned an invalid command response.", "optional"],
    transport: ["The chat command could not be completed.", "optional"],
    aborted: ["The chat command was aborted.", false],
    closed: ["The chat client was closed.", false],
  } as const;
  const definition = definitions[value.status as keyof typeof definitions];
  if (definition === undefined || value.message !== definition[0]) return undefined;
  const http = definition[1];
  const expectedKeys =
    http === true || (http === "optional" && value.httpStatus !== undefined)
      ? ["status", "message", "httpStatus"]
      : ["status", "message"];
  if (
    !exactKeys(value, expectedKeys) ||
    (expectedKeys.length === 3 &&
      (!Number.isInteger(value.httpStatus) ||
        (value.httpStatus as number) < 100 ||
        (value.httpStatus as number) > 599))
  ) return undefined;
  return Object.freeze({ ...value }) as unknown as ChatCommandResult<Result>;
};

const hasExactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean => {
  const actual = Object.keys(value);
  return (
    actual.length === expected.length &&
    actual.every((key) => expected.includes(key))
  );
};

const isPositiveSafeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 1;

const isNonNegativeSafeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

const malformedMetadata = (): StartupFailure =>
  new StartupFailure(
    Object.freeze({
      code: "malformed_metadata",
      message: "The chat server returned invalid metadata.",
    }),
  );

const parseMetadata = <Feature extends string>(
  value: unknown,
): ServerHandshakeMetadata<Feature> => {
  if (!isRecord(value) || !hasExactKeys(value, METADATA_FIELDS)) {
    throw malformedMetadata();
  }

  const {
    packageVersion,
    protocolVersion,
    schemaVersion,
    enabledFeatures,
    supportedProtocolRange,
  } = value;
  if (
    typeof packageVersion !== "string" ||
    packageVersion.trim().length === 0 ||
    !isPositiveSafeInteger(protocolVersion) ||
    !isNonNegativeSafeInteger(schemaVersion) ||
    !isRecord(enabledFeatures) ||
    !isRecord(supportedProtocolRange) ||
    !hasExactKeys(supportedProtocolRange, ["minimumVersion", "maximumVersion"])
  ) {
    throw malformedMetadata();
  }

  const minimumVersion = supportedProtocolRange.minimumVersion;
  const maximumVersion = supportedProtocolRange.maximumVersion;
  if (
    !isPositiveSafeInteger(minimumVersion) ||
    !isPositiveSafeInteger(maximumVersion) ||
    minimumVersion > maximumVersion ||
    protocolVersion < minimumVersion ||
    protocolVersion > maximumVersion
  ) {
    throw malformedMetadata();
  }

  const featureEntries = Object.entries(enabledFeatures);
  if (
    featureEntries.some(
      ([name, enabled]) => name.trim().length === 0 || typeof enabled !== "boolean",
    )
  ) {
    throw malformedMetadata();
  }

  const parsedFeatures = Object.freeze(
    Object.fromEntries(featureEntries),
  ) as EnabledFeatures<Feature>;

  return Object.freeze({
    packageVersion,
    protocolVersion,
    schemaVersion,
    enabledFeatures: parsedFeatures,
    supportedProtocolRange: Object.freeze({
      minimumVersion,
      maximumVersion,
    }),
  });
};

const normalizeEndpoint = (value: unknown): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ChatClientConfigurationError("endpoint must be a non-empty string");
  }

  const endpoint = value.trim();
  if (/\s|[?#]/.test(endpoint)) {
    throw new ChatClientConfigurationError(
      "endpoint cannot contain whitespace, a query, or a fragment",
    );
  }

  return endpoint.replace(/\/+$/, "");
};

const normalizeRequestedFeatures = <Feature extends string>(
  value: unknown,
): EnabledFeatures<Feature> | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new ChatClientConfigurationError("features must be an object");
  }

  const entries = Object.entries(value);
  if (
    entries.some(
      ([name, enabled]) => name.trim().length === 0 || typeof enabled !== "boolean",
    )
  ) {
    throw new ChatClientConfigurationError(
      "feature names must be non-empty and values must be boolean",
    );
  }
  return Object.freeze(Object.fromEntries(entries)) as EnabledFeatures<Feature>;
};

const negotiateFeatures = <Feature extends string>(
  server: EnabledFeatures<Feature>,
  requested: EnabledFeatures<Feature> | undefined,
): EnabledFeatures<Feature> => {
  if (requested === undefined) {
    return server;
  }

  const names = new Set([...Object.keys(server), ...Object.keys(requested)]);
  const serverByName = server as Readonly<Record<string, boolean>>;
  const requestedByName = requested as Readonly<Record<string, boolean>>;
  return Object.freeze(
    Object.fromEntries(
      [...names].map((name) => [
        name,
        serverByName[name] === true && requestedByName[name] === true,
      ]),
    ),
  ) as EnabledFeatures<Feature>;
};

const raceWithAbort = <Value>(
  promise: Promise<Value>,
  signal: AbortSignal,
): Promise<Value> => {
  if (signal.aborted) {
    return Promise.reject(ABORTED);
  }

  return new Promise<Value>((resolve, reject) => {
    const abort = () => reject(ABORTED);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
};

const fetchServerMetadata = async <Feature extends string>(
  metadataUrl: string,
  getAccessToken: () => string | Promise<string>,
  fetchImplementation: ChatClientFetch,
  signal: AbortSignal,
): Promise<ServerHandshakeMetadata<Feature>> => {
  let accessToken: string;
  try {
    accessToken = await raceWithAbort(
      Promise.resolve().then(getAccessToken),
      signal,
    );
  } catch (error) {
    if (error === ABORTED) {
      throw error;
    }
    throw new StartupFailure(
      Object.freeze({
        code: "access_token_failed",
        message: "Chat credentials could not be obtained.",
      }),
    );
  }

  if (typeof accessToken !== "string" || accessToken.trim().length === 0) {
    throw new StartupFailure(
      Object.freeze({
        code: "access_token_failed",
        message: "Chat credentials could not be obtained.",
      }),
    );
  }

  let response: ChatClientFetchResponse;
  try {
    response = await fetchImplementation(metadataUrl, {
      method: "GET",
      headers: Object.freeze({
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
      }),
      signal,
    });
  } catch (error) {
    if (signal.aborted || error === ABORTED) {
      throw ABORTED;
    }
    throw new StartupFailure(
      Object.freeze({
        code: "metadata_request_failed",
        message: "Chat server metadata could not be requested.",
      }),
    );
  }

  if (!response.ok) {
    throw new StartupFailure(
      Object.freeze({
        code: "metadata_request_failed",
        message: "Chat server metadata could not be requested.",
        httpStatus: response.status,
      }),
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw malformedMetadata();
  }
  return parseMetadata<Feature>(body);
};

/** Creates the browser-only lifecycle runtime. No network work occurs until start. */
export function createChatClient<Feature extends string = string>(
  config: CreateChatClientConfig<Feature>,
): ChatClient<Feature> {
  if (!isRecord(config)) {
    throw new ChatClientConfigurationError("configuration must be an object");
  }

  const endpoint = normalizeEndpoint(config.endpoint);
  if (typeof config.getAccessToken !== "function") {
    throw new ChatClientConfigurationError("getAccessToken must be a function");
  }
  const requestedFeatures = normalizeRequestedFeatures<Feature>(config.features);
  const fetchImplementation = (config.fetch ?? (
    typeof globalThis.fetch === "function"
      ? globalThis.fetch.bind(globalThis)
      : undefined
  )) as ChatClientFetch | undefined;
  if (typeof fetchImplementation !== "function") {
    throw new ChatClientConfigurationError("fetch is not available");
  }
  const normalizedCachePersistence = config.normalizedCachePersistence;
  const retainedSendRecovery = normalizedCachePersistence?.retainedSendRecovery;
  const retainedMembershipRecovery =
    normalizedCachePersistence?.retainedMembershipRecovery;
  const retainedConversationCreationRecovery =
    normalizedCachePersistence?.retainedConversationCreationRecovery;
  const retainedConversationPreferenceRecovery =
    normalizedCachePersistence?.retainedConversationPreferenceRecovery;
  const retainedConversationArchiveRecovery =
    config.conversationLifecycle?.retainedRecovery;
  const retainedThreadFollowRecovery = config.threadFollows?.retainedRecovery;
  const retainedSavedMessageRecovery = config.savedMessages?.retainedRecovery;
  const retainedMessageReminderRecovery = config.messageReminders?.retainedRecovery;
  if (
    normalizedCachePersistence !== undefined &&
    (!isRecord(normalizedCachePersistence) ||
      !isRecord(normalizedCachePersistence.storage) ||
      typeof normalizedCachePersistence.storage.read !== "function" ||
      typeof normalizedCachePersistence.storage.replace !== "function" ||
      typeof normalizedCachePersistence.storage.remove !== "function" ||
      typeof normalizedCachePersistence.resolveIdentity !== "function" ||
      (normalizedCachePersistence.onDiagnostic !== undefined &&
        typeof normalizedCachePersistence.onDiagnostic !== "function") ||
      (retainedSendRecovery !== undefined &&
        (!isRecord(retainedSendRecovery) ||
          (retainedSendRecovery.initialDelayMs !== undefined &&
            (typeof retainedSendRecovery.initialDelayMs !== "number" ||
              !Number.isFinite(retainedSendRecovery.initialDelayMs) ||
              retainedSendRecovery.initialDelayMs < 0 ||
              retainedSendRecovery.initialDelayMs > 60_000)) ||
          (retainedSendRecovery.maximumDelayMs !== undefined &&
            (typeof retainedSendRecovery.maximumDelayMs !== "number" ||
              !Number.isFinite(retainedSendRecovery.maximumDelayMs) ||
              retainedSendRecovery.maximumDelayMs < 0 ||
              retainedSendRecovery.maximumDelayMs > 60_000)) ||
          (retainedSendRecovery.multiplier !== undefined &&
            (typeof retainedSendRecovery.multiplier !== "number" ||
              !Number.isFinite(retainedSendRecovery.multiplier) ||
              retainedSendRecovery.multiplier <= 0)) ||
          (retainedSendRecovery.wait !== undefined &&
            typeof retainedSendRecovery.wait !== "function"))) ||
      (retainedMembershipRecovery !== undefined &&
        (!isRecord(retainedMembershipRecovery) ||
          (retainedMembershipRecovery.initialDelayMs !== undefined &&
            (typeof retainedMembershipRecovery.initialDelayMs !== "number" ||
              !Number.isFinite(retainedMembershipRecovery.initialDelayMs) ||
              retainedMembershipRecovery.initialDelayMs < 0 ||
              retainedMembershipRecovery.initialDelayMs > 60_000)) ||
          (retainedMembershipRecovery.maximumDelayMs !== undefined &&
            (typeof retainedMembershipRecovery.maximumDelayMs !== "number" ||
              !Number.isFinite(retainedMembershipRecovery.maximumDelayMs) ||
              retainedMembershipRecovery.maximumDelayMs < 0 ||
              retainedMembershipRecovery.maximumDelayMs > 60_000)) ||
          (retainedMembershipRecovery.multiplier !== undefined &&
            (typeof retainedMembershipRecovery.multiplier !== "number" ||
              !Number.isFinite(retainedMembershipRecovery.multiplier) ||
              retainedMembershipRecovery.multiplier <= 0)) ||
          (retainedMembershipRecovery.wait !== undefined &&
            typeof retainedMembershipRecovery.wait !== "function"))) ||
      (retainedConversationCreationRecovery !== undefined &&
        (!isRecord(retainedConversationCreationRecovery) ||
          (retainedConversationCreationRecovery.initialDelayMs !== undefined &&
            (typeof retainedConversationCreationRecovery.initialDelayMs !== "number" ||
              !Number.isFinite(retainedConversationCreationRecovery.initialDelayMs) ||
              retainedConversationCreationRecovery.initialDelayMs < 0 ||
              retainedConversationCreationRecovery.initialDelayMs > 60_000)) ||
          (retainedConversationCreationRecovery.maximumDelayMs !== undefined &&
            (typeof retainedConversationCreationRecovery.maximumDelayMs !== "number" ||
              !Number.isFinite(retainedConversationCreationRecovery.maximumDelayMs) ||
              retainedConversationCreationRecovery.maximumDelayMs < 0 ||
              retainedConversationCreationRecovery.maximumDelayMs > 60_000)) ||
          (retainedConversationCreationRecovery.multiplier !== undefined &&
            (typeof retainedConversationCreationRecovery.multiplier !== "number" ||
              !Number.isFinite(retainedConversationCreationRecovery.multiplier) ||
              retainedConversationCreationRecovery.multiplier <= 0)) ||
          (retainedConversationCreationRecovery.wait !== undefined &&
            typeof retainedConversationCreationRecovery.wait !== "function"))) ||
      (retainedConversationPreferenceRecovery !== undefined &&
        (!isRecord(retainedConversationPreferenceRecovery) ||
          (retainedConversationPreferenceRecovery.initialDelayMs !== undefined &&
            (typeof retainedConversationPreferenceRecovery.initialDelayMs !== "number" ||
              !Number.isFinite(retainedConversationPreferenceRecovery.initialDelayMs) ||
              retainedConversationPreferenceRecovery.initialDelayMs < 0 ||
              retainedConversationPreferenceRecovery.initialDelayMs > 60_000)) ||
          (retainedConversationPreferenceRecovery.maximumDelayMs !== undefined &&
            (typeof retainedConversationPreferenceRecovery.maximumDelayMs !== "number" ||
              !Number.isFinite(retainedConversationPreferenceRecovery.maximumDelayMs) ||
              retainedConversationPreferenceRecovery.maximumDelayMs < 0 ||
              retainedConversationPreferenceRecovery.maximumDelayMs > 60_000)) ||
          (retainedConversationPreferenceRecovery.multiplier !== undefined &&
            (typeof retainedConversationPreferenceRecovery.multiplier !== "number" ||
              !Number.isFinite(retainedConversationPreferenceRecovery.multiplier) ||
              retainedConversationPreferenceRecovery.multiplier <= 0)) ||
          (retainedConversationPreferenceRecovery.wait !== undefined &&
            typeof retainedConversationPreferenceRecovery.wait !== "function"))))
  ) {
    throw new ChatClientConfigurationError(
      "normalizedCachePersistence options are invalid",
    );
  }
  if (config.crossTab !== undefined && normalizedCachePersistence !== undefined) {
    let hasAtomicStorage = false;
    try {
      hasAtomicStorage =
        typeof normalizedCachePersistence.storage.compareExchange === "function";
    } catch {
      // Capability inspection must not expose host adapter failures.
    }
    if (!hasAtomicStorage) {
      throw new ChatClientConfigurationError(
        CROSS_TAB_ATOMIC_STORAGE_REQUIRED_MESSAGE,
      );
    }
  }
  const retainedSendInitialDelayMs =
    retainedSendRecovery?.initialDelayMs ?? RETAINED_SEND_INITIAL_DELAY_MS;
  const retainedSendMaximumDelayMs =
    retainedSendRecovery?.maximumDelayMs ?? RETAINED_SEND_MAXIMUM_DELAY_MS;
  if (retainedSendMaximumDelayMs < retainedSendInitialDelayMs) {
    throw new ChatClientConfigurationError(
      "normalizedCachePersistence retainedSendRecovery options are invalid",
    );
  }
  const retainedSendRetryMultiplier =
    retainedSendRecovery?.multiplier ?? RETAINED_SEND_RETRY_MULTIPLIER;
  const retainedSendWait = retainedSendRecovery?.wait ?? waitForRetainedSendDelay;
  const retainedMembershipInitialDelayMs =
    retainedMembershipRecovery?.initialDelayMs ?? RETAINED_SEND_INITIAL_DELAY_MS;
  const retainedMembershipMaximumDelayMs =
    retainedMembershipRecovery?.maximumDelayMs ?? RETAINED_SEND_MAXIMUM_DELAY_MS;
  if (retainedMembershipMaximumDelayMs < retainedMembershipInitialDelayMs) {
    throw new ChatClientConfigurationError(
      "normalizedCachePersistence retainedMembershipRecovery options are invalid",
    );
  }
  const retainedMembershipRetryMultiplier =
    retainedMembershipRecovery?.multiplier ?? RETAINED_SEND_RETRY_MULTIPLIER;
  const retainedMembershipWait =
    retainedMembershipRecovery?.wait ?? waitForRetainedSendDelay;
  const retainedConversationCreationInitialDelayMs =
    retainedConversationCreationRecovery?.initialDelayMs ?? RETAINED_SEND_INITIAL_DELAY_MS;
  const retainedConversationCreationMaximumDelayMs =
    retainedConversationCreationRecovery?.maximumDelayMs ?? RETAINED_SEND_MAXIMUM_DELAY_MS;
  if (
    retainedConversationCreationMaximumDelayMs <
      retainedConversationCreationInitialDelayMs
  ) {
    throw new ChatClientConfigurationError(
      "normalizedCachePersistence retainedConversationCreationRecovery options are invalid",
    );
  }
  const retainedConversationCreationRetryMultiplier =
    retainedConversationCreationRecovery?.multiplier ?? RETAINED_SEND_RETRY_MULTIPLIER;
  const retainedConversationCreationWait =
    retainedConversationCreationRecovery?.wait ?? waitForRetainedSendDelay;
  const retainedConversationPreferenceInitialDelayMs =
    retainedConversationPreferenceRecovery?.initialDelayMs ?? RETAINED_SEND_INITIAL_DELAY_MS;
  const retainedConversationPreferenceMaximumDelayMs =
    retainedConversationPreferenceRecovery?.maximumDelayMs ?? RETAINED_SEND_MAXIMUM_DELAY_MS;
  if (
    retainedConversationPreferenceMaximumDelayMs <
      retainedConversationPreferenceInitialDelayMs
  ) {
    throw new ChatClientConfigurationError(
      "normalizedCachePersistence retainedConversationPreferenceRecovery options are invalid",
    );
  }
  const retainedConversationPreferenceRetryMultiplier =
    retainedConversationPreferenceRecovery?.multiplier ?? RETAINED_SEND_RETRY_MULTIPLIER;
  const retainedConversationPreferenceWait =
    retainedConversationPreferenceRecovery?.wait ?? waitForRetainedSendDelay;
  const retainedReadRecovery = config.readState?.retainedRecovery;
  if (
    config.readState !== undefined &&
    (!isRecord(config.readState) ||
      (config.readState.generateIdempotencyKey !== undefined &&
        typeof config.readState.generateIdempotencyKey !== "function") ||
      (config.readState.schedule !== undefined &&
        typeof config.readState.schedule !== "function") ||
      (config.readState.now !== undefined &&
        typeof config.readState.now !== "function") ||
      (retainedReadRecovery !== undefined &&
        (!isRecord(retainedReadRecovery) ||
          (retainedReadRecovery.initialDelayMs !== undefined &&
            (typeof retainedReadRecovery.initialDelayMs !== "number" ||
              !Number.isFinite(retainedReadRecovery.initialDelayMs) ||
              retainedReadRecovery.initialDelayMs < 0 ||
              retainedReadRecovery.initialDelayMs > 60_000)) ||
          (retainedReadRecovery.maximumDelayMs !== undefined &&
            (typeof retainedReadRecovery.maximumDelayMs !== "number" ||
              !Number.isFinite(retainedReadRecovery.maximumDelayMs) ||
              retainedReadRecovery.maximumDelayMs < 0 ||
              retainedReadRecovery.maximumDelayMs > 60_000)) ||
          (retainedReadRecovery.multiplier !== undefined &&
            (typeof retainedReadRecovery.multiplier !== "number" ||
              !Number.isFinite(retainedReadRecovery.multiplier) ||
              retainedReadRecovery.multiplier <= 0)) ||
          (retainedReadRecovery.wait !== undefined &&
            typeof retainedReadRecovery.wait !== "function"))))
  ) {
    throw new ChatClientConfigurationError("readState options are invalid");
  }
  if (
    (retainedReadRecovery?.maximumDelayMs ?? 30_000) <
      (retainedReadRecovery?.initialDelayMs ?? 250)
  ) {
    throw new ChatClientConfigurationError("readState retainedRecovery options are invalid");
  }
  if (
    config.conversationLifecycle !== undefined &&
    (!isRecord(config.conversationLifecycle) ||
      (config.conversationLifecycle.generateIdempotencyKey !== undefined &&
        typeof config.conversationLifecycle.generateIdempotencyKey !== "function") ||
      (config.conversationLifecycle.generateClientRequestId !== undefined &&
        typeof config.conversationLifecycle.generateClientRequestId !== "function") ||
      (retainedConversationArchiveRecovery !== undefined &&
        (!isRecord(retainedConversationArchiveRecovery) ||
          (retainedConversationArchiveRecovery.initialDelayMs !== undefined &&
            (typeof retainedConversationArchiveRecovery.initialDelayMs !== "number" ||
              !Number.isFinite(retainedConversationArchiveRecovery.initialDelayMs) ||
              retainedConversationArchiveRecovery.initialDelayMs < 0 ||
              retainedConversationArchiveRecovery.initialDelayMs > 60_000)) ||
          (retainedConversationArchiveRecovery.maximumDelayMs !== undefined &&
            (typeof retainedConversationArchiveRecovery.maximumDelayMs !== "number" ||
              !Number.isFinite(retainedConversationArchiveRecovery.maximumDelayMs) ||
              retainedConversationArchiveRecovery.maximumDelayMs < 0 ||
              retainedConversationArchiveRecovery.maximumDelayMs > 60_000)) ||
          (retainedConversationArchiveRecovery.multiplier !== undefined &&
            (typeof retainedConversationArchiveRecovery.multiplier !== "number" ||
              !Number.isFinite(retainedConversationArchiveRecovery.multiplier) ||
              retainedConversationArchiveRecovery.multiplier <= 0)) ||
          (retainedConversationArchiveRecovery.wait !== undefined &&
            typeof retainedConversationArchiveRecovery.wait !== "function"))))
  ) {
    throw new ChatClientConfigurationError(
      "conversationLifecycle options are invalid",
    );
  }
  const retainedConversationArchiveInitialDelayMs =
    retainedConversationArchiveRecovery?.initialDelayMs ?? RETAINED_SEND_INITIAL_DELAY_MS;
  const retainedConversationArchiveMaximumDelayMs =
    retainedConversationArchiveRecovery?.maximumDelayMs ?? RETAINED_SEND_MAXIMUM_DELAY_MS;
  if (
    retainedConversationArchiveMaximumDelayMs <
      retainedConversationArchiveInitialDelayMs
  ) {
    throw new ChatClientConfigurationError(
      "conversationLifecycle retainedRecovery options are invalid",
    );
  }
  const retainedConversationArchiveRetryMultiplier =
    retainedConversationArchiveRecovery?.multiplier ?? RETAINED_SEND_RETRY_MULTIPLIER;
  const retainedConversationArchiveWait =
    retainedConversationArchiveRecovery?.wait ?? waitForRetainedSendDelay;
  if (
    config.conversationPreferences !== undefined &&
    (!isRecord(config.conversationPreferences) ||
      (config.conversationPreferences.generateIdempotencyKey !== undefined &&
        typeof config.conversationPreferences.generateIdempotencyKey !== "function") ||
      (config.conversationPreferences.now !== undefined &&
        typeof config.conversationPreferences.now !== "function"))
  ) {
    throw new ChatClientConfigurationError(
      "conversationPreferences options are invalid",
    );
  }
  if (
    config.threadFollows !== undefined &&
    (!isRecord(config.threadFollows) ||
      (config.threadFollows.generateIdempotencyKey !== undefined &&
        typeof config.threadFollows.generateIdempotencyKey !== "function") ||
      (config.threadFollows.now !== undefined &&
        typeof config.threadFollows.now !== "function") ||
      (retainedThreadFollowRecovery !== undefined &&
        (!isRecord(retainedThreadFollowRecovery) ||
          (retainedThreadFollowRecovery.initialDelayMs !== undefined &&
            (typeof retainedThreadFollowRecovery.initialDelayMs !== "number" ||
              !Number.isFinite(retainedThreadFollowRecovery.initialDelayMs) ||
              retainedThreadFollowRecovery.initialDelayMs < 0 ||
              retainedThreadFollowRecovery.initialDelayMs > 60_000)) ||
          (retainedThreadFollowRecovery.maximumDelayMs !== undefined &&
            (typeof retainedThreadFollowRecovery.maximumDelayMs !== "number" ||
              !Number.isFinite(retainedThreadFollowRecovery.maximumDelayMs) ||
              retainedThreadFollowRecovery.maximumDelayMs < 0 ||
              retainedThreadFollowRecovery.maximumDelayMs > 60_000)) ||
          (retainedThreadFollowRecovery.multiplier !== undefined &&
            (typeof retainedThreadFollowRecovery.multiplier !== "number" ||
              !Number.isFinite(retainedThreadFollowRecovery.multiplier) ||
              retainedThreadFollowRecovery.multiplier <= 0)) ||
          (retainedThreadFollowRecovery.wait !== undefined &&
            typeof retainedThreadFollowRecovery.wait !== "function"))))
  ) {
    throw new ChatClientConfigurationError("threadFollows options are invalid");
  }
  const retainedThreadFollowInitialDelayMs =
    retainedThreadFollowRecovery?.initialDelayMs ?? RETAINED_SEND_INITIAL_DELAY_MS;
  const retainedThreadFollowMaximumDelayMs =
    retainedThreadFollowRecovery?.maximumDelayMs ?? RETAINED_SEND_MAXIMUM_DELAY_MS;
  if (retainedThreadFollowMaximumDelayMs < retainedThreadFollowInitialDelayMs) {
    throw new ChatClientConfigurationError(
      "threadFollows retainedRecovery options are invalid",
    );
  }
  const retainedThreadFollowRetryMultiplier =
    retainedThreadFollowRecovery?.multiplier ?? RETAINED_SEND_RETRY_MULTIPLIER;
  const retainedThreadFollowWait =
    retainedThreadFollowRecovery?.wait ?? waitForRetainedSendDelay;
  if (
    config.savedMessages !== undefined &&
    (!isRecord(config.savedMessages) ||
      (config.savedMessages.generateIdempotencyKey !== undefined &&
        typeof config.savedMessages.generateIdempotencyKey !== "function") ||
      (config.savedMessages.now !== undefined &&
        typeof config.savedMessages.now !== "function") ||
      (retainedSavedMessageRecovery !== undefined &&
        (!isRecord(retainedSavedMessageRecovery) ||
          (retainedSavedMessageRecovery.initialDelayMs !== undefined &&
            (typeof retainedSavedMessageRecovery.initialDelayMs !== "number" ||
              !Number.isFinite(retainedSavedMessageRecovery.initialDelayMs) ||
              retainedSavedMessageRecovery.initialDelayMs < 0 ||
              retainedSavedMessageRecovery.initialDelayMs > 60_000)) ||
          (retainedSavedMessageRecovery.maximumDelayMs !== undefined &&
            (typeof retainedSavedMessageRecovery.maximumDelayMs !== "number" ||
              !Number.isFinite(retainedSavedMessageRecovery.maximumDelayMs) ||
              retainedSavedMessageRecovery.maximumDelayMs < 0 ||
              retainedSavedMessageRecovery.maximumDelayMs > 60_000)) ||
          (retainedSavedMessageRecovery.multiplier !== undefined &&
            (typeof retainedSavedMessageRecovery.multiplier !== "number" ||
              !Number.isFinite(retainedSavedMessageRecovery.multiplier) ||
              retainedSavedMessageRecovery.multiplier <= 0)) ||
          (retainedSavedMessageRecovery.wait !== undefined &&
            typeof retainedSavedMessageRecovery.wait !== "function"))))
  ) {
    throw new ChatClientConfigurationError("savedMessages options are invalid");
  }
  const retainedSavedMessageInitialDelayMs =
    retainedSavedMessageRecovery?.initialDelayMs ?? RETAINED_SEND_INITIAL_DELAY_MS;
  const retainedSavedMessageMaximumDelayMs =
    retainedSavedMessageRecovery?.maximumDelayMs ?? RETAINED_SEND_MAXIMUM_DELAY_MS;
  if (retainedSavedMessageMaximumDelayMs < retainedSavedMessageInitialDelayMs) {
    throw new ChatClientConfigurationError(
      "savedMessages retainedRecovery options are invalid",
    );
  }
  const retainedSavedMessageRetryMultiplier =
    retainedSavedMessageRecovery?.multiplier ?? RETAINED_SEND_RETRY_MULTIPLIER;
  const retainedSavedMessageWait =
    retainedSavedMessageRecovery?.wait ?? waitForRetainedSendDelay;
  if (
    config.messageReminders !== undefined &&
    (!isRecord(config.messageReminders) ||
      (config.messageReminders.generateIdempotencyKey !== undefined &&
        typeof config.messageReminders.generateIdempotencyKey !== "function") ||
      (config.messageReminders.now !== undefined &&
        typeof config.messageReminders.now !== "function") ||
      (retainedMessageReminderRecovery !== undefined &&
        (!isRecord(retainedMessageReminderRecovery) ||
          (retainedMessageReminderRecovery.initialDelayMs !== undefined &&
            (typeof retainedMessageReminderRecovery.initialDelayMs !== "number" ||
              !Number.isFinite(retainedMessageReminderRecovery.initialDelayMs) ||
              retainedMessageReminderRecovery.initialDelayMs < 0 ||
              retainedMessageReminderRecovery.initialDelayMs > 60_000)) ||
          (retainedMessageReminderRecovery.maximumDelayMs !== undefined &&
            (typeof retainedMessageReminderRecovery.maximumDelayMs !== "number" ||
              !Number.isFinite(retainedMessageReminderRecovery.maximumDelayMs) ||
              retainedMessageReminderRecovery.maximumDelayMs < 0 ||
              retainedMessageReminderRecovery.maximumDelayMs > 60_000)) ||
          (retainedMessageReminderRecovery.multiplier !== undefined &&
            (typeof retainedMessageReminderRecovery.multiplier !== "number" ||
              !Number.isFinite(retainedMessageReminderRecovery.multiplier) ||
              retainedMessageReminderRecovery.multiplier <= 0)) ||
          (retainedMessageReminderRecovery.wait !== undefined &&
            typeof retainedMessageReminderRecovery.wait !== "function"))))
  ) {
    throw new ChatClientConfigurationError("messageReminders options are invalid");
  }
  const retainedMessageReminderInitialDelayMs =
    retainedMessageReminderRecovery?.initialDelayMs ?? RETAINED_SEND_INITIAL_DELAY_MS;
  const retainedMessageReminderMaximumDelayMs =
    retainedMessageReminderRecovery?.maximumDelayMs ?? RETAINED_SEND_MAXIMUM_DELAY_MS;
  if (retainedMessageReminderMaximumDelayMs < retainedMessageReminderInitialDelayMs) {
    throw new ChatClientConfigurationError(
      "messageReminders retainedRecovery options are invalid",
    );
  }
  const retainedMessageReminderRetryMultiplier =
    retainedMessageReminderRecovery?.multiplier ?? RETAINED_SEND_RETRY_MULTIPLIER;
  const retainedMessageReminderWait =
    retainedMessageReminderRecovery?.wait ?? waitForRetainedSendDelay;
  if (
    config.forwardMessages !== undefined &&
    (!isRecord(config.forwardMessages) ||
      (config.forwardMessages.generateClientCorrelationId !== undefined &&
        typeof config.forwardMessages.generateClientCorrelationId !== "function") ||
      (config.forwardMessages.generateIdempotencyKey !== undefined &&
        typeof config.forwardMessages.generateIdempotencyKey !== "function"))
  ) {
    throw new ChatClientConfigurationError("forwardMessages options are invalid");
  }

  const metadataUrl = `${endpoint}/_meta`;
  let replyStyleRuntime: ReturnType<typeof createReplyStyleRuntime> | undefined;
  let messageContextRuntime: ReturnType<typeof createMessageContextRuntime> | undefined;
  let threadListRuntime: ReturnType<typeof createThreadListRuntime> | undefined;
  let threadLifecycleRuntime: ReturnType<typeof createThreadLifecycleRuntime> | undefined;
  let lifecycleState: ChatClientLifecycleState<Feature> = IDLE_STATE;
  const lifecycleListeners = new Set<ChatClientLifecycleListener<Feature>>();
  const setLifecycleState = (
    nextState: ChatClientLifecycleState<Feature>,
  ): void => {
    if (lifecycleState.state === nextState.state) return;
    lifecycleState = nextState;
    replyStyleRuntime?.connectionChanged(nextState.state === "ready" && realtimeSession === undefined);
    threadListRuntime?.connectionChanged(nextState.state === "ready" && realtimeSession === undefined);
    threadLifecycleRuntime?.connectionChanged(nextState.state === "ready" && realtimeSession === undefined);
    messageContextRuntime?.connectionChanged(nextState.state === "ready" && realtimeSession === undefined);
    for (const listener of [...lifecycleListeners]) {
      try {
        listener(nextState);
      } catch {
        // Observer failures cannot alter client lifecycle behavior.
      }
    }
  };
  let activeController: AbortController | undefined;
  let activeStart: Promise<ChatClientLifecycleState<Feature>> | undefined;
  let attempt = 0;
  let commandDispatcher;
  let snapshotReader;
  let threadSnapshotReader;
  let draftSnapshotReader;
  let draftRuntime: ChatDraftRuntime;
  let attachmentUploadManager: ChatAttachmentUploadManager;
  let huddleRuntime: ChatHuddleRuntime;
  let directoryRuntime: ChatHostDirectoryRuntime;
  let messageSearchRuntime: ChatMessageSearchRuntime;
  let realtimeSession: ChatRealtimeSession<Feature> | undefined;
  let coordinator: ChatCrossTabCoordinator | undefined;
  let coordinationStatus: ChatCrossTabStatus | undefined;
  let activeSessionFingerprint: string | undefined;
  const cache = config.cache ?? createNormalizedChatCache();
  let persistenceGeneration = 0;
  let activePersistenceIdentity: ApplicationChatStorageIdentity | undefined;
  let lastPersistenceIdentity: ApplicationChatStorageIdentity | undefined;
  let persistenceCheckpointEnabled = false;
  let lastCheckpointFingerprint: string | undefined;
  let lastCheckpointEncoded: string | null | undefined;
  let persistenceCheckpointOwnershipEpoch = 0;
  let persistenceMutationChain: Promise<void> = Promise.resolve();
  let activeSendMessageQueue: OfflineSendMessageQueue | undefined;
  let releaseSendMessageQueue: (() => void) | undefined;
  let requestRetainedSendRecovery = (): void => {};
  let pauseRetainedSendRecovery = (): void => {};
  let stopRetainedSendRecovery = (): void => {};
  let resumeRetainedSendRecoveryFromStorage = (): void => {};
  let resumeRetainedReadRecoveryFromStorage = (
    _announcement?: { readonly command: string; readonly idempotencyKey: string },
  ): void => {};
  let resumeRetainedDraftRecoveryFromStorage = (
    _announcement?: { readonly command: string; readonly idempotencyKey: string },
  ): void => {};
  let resumeRetainedHuddleRecoveryFromStorage = (
    _announcement?: { readonly command: string; readonly idempotencyKey: string },
  ): void => {};
  let handleRetainedSendCanonicalEvent = (_event: ChatEvent): void => {};
  let handleRetainedSendCoordinatedResult = (
    _command: string,
    _idempotencyKey: string,
    _result: unknown,
  ): void => {};
  let activateRetainedEditRecovery = async (
    _generation: number,
    _identity: ApplicationChatStorageIdentity,
  ): Promise<void> => {};
  let requestRetainedEditRecovery = (): void => {};
  let pauseRetainedEditRecovery = (): void => {};
  let reloadRetainedEditRecovery = (
    _announcement?: { readonly command: string; readonly idempotencyKey: string },
  ): void => {};
  let handleRetainedEditCanonicalEvent = (_event: ChatEvent): void => {};
  let handleRetainedEditCoordinatedResult = (
    _command: string,
    _idempotencyKey: string,
    _result: unknown,
  ): void => {};
  let retainedEditIntents: readonly DurableEditIntent[] = Object.freeze([]);
  let activateRetainedDeleteRecovery = async (
    _generation: number,
    _identity: ApplicationChatStorageIdentity,
  ): Promise<void> => {};
  let requestRetainedDeleteRecovery = (): void => {};
  let pauseRetainedDeleteRecovery = (): void => {};
  let reloadRetainedDeleteRecovery = (
    _announcement?: { readonly command: string; readonly idempotencyKey: string },
  ): void => {};
  let handleRetainedDeleteCanonicalEvent = (_event: ChatEvent): void => {};
  let handleRetainedDeleteCoordinatedResult = (
    _command: string,
    _idempotencyKey: string,
    _result: unknown,
  ): void => {};
  let retainedDeleteIntents: readonly DurableDeleteIntent[] = Object.freeze([]);
  let activateRetainedReactionRecovery = async (
    _generation: number,
    _identity: ApplicationChatStorageIdentity,
  ): Promise<void> => {};
  let requestRetainedReactionRecovery = (): void => {};
  let pauseRetainedReactionRecovery = (): void => {};
  let reloadRetainedReactionRecovery = (
    _announcement?: { readonly command: string; readonly idempotencyKey: string },
  ): void => {};
  let handleRetainedReactionCanonicalEvent = (_event: ChatEvent): void => {};
  let handleRetainedReactionCoordinatedResult = (
    _command: string,
    _idempotencyKey: string,
    _result: unknown,
  ): void => {};
  let retainedReactionIntents: readonly DurableReactionIntent[] = Object.freeze([]);
  let activateRetainedForwardRecovery = async (
    _generation: number,
    _identity: ApplicationChatStorageIdentity,
  ): Promise<void> => {};
  let requestRetainedForwardRecovery = (): void => {};
  let pauseRetainedForwardRecovery = (): void => {};
  let reloadRetainedForwardRecovery = (
    _announcement?: { readonly command: string; readonly idempotencyKey: string },
  ): void => {};
  let handleRetainedForwardCanonicalEvent = (_event: ChatEvent): void => {};
  let handleRetainedForwardCoordinatedResult = (
    _command: string,
    _idempotencyKey: string,
    _result: unknown,
  ): void => {};
  let retainedForwardIntents: readonly DurableForwardIntent[] = Object.freeze([]);
  let requestRetainedMessageMutationRecovery = (): void => {};
  let activateRetainedMembershipRecovery = async (
    _generation: number,
    _identity: ApplicationChatStorageIdentity,
  ): Promise<void> => {};
  let requestRetainedMembershipRecovery = (): void => {};
  let resumeRetainedMembershipRecoveryFromStorage = (
    _announcement?: { readonly command: string; readonly idempotencyKey: string },
  ): void => {};
  let pauseRetainedMembershipRecovery = (): void => {};
  let handleRetainedMembershipCanonicalEvent = (_event: ChatEvent): void => {};
  let handleRetainedMembershipCoordinatedResult = (
    _command: string,
    _idempotencyKey: string,
    _result: unknown,
  ): void => {};
  let retainedMembershipIntents: readonly DurableMembershipIntent[] = Object.freeze([]);
  let activateRetainedConversationCreationRecovery = async (
    _generation: number,
    _identity: ApplicationChatStorageIdentity,
  ): Promise<void> => {};
  let requestRetainedConversationCreationRecovery = (): void => {};
  let resumeRetainedConversationCreationRecoveryFromStorage = (
    _announcement?: { readonly command: string; readonly idempotencyKey: string },
  ): void => {};
  let pauseRetainedConversationCreationRecovery = (): void => {};
  let handleRetainedConversationCreationCoordinatedResult = (
    _command: string,
    _idempotencyKey: string,
    _result: unknown,
  ): void => {};
  let handleRetainedConversationCreationCanonicalEvent = (
    _event: ChatEvent,
  ): void => {};
  let retainedConversationCreationIntents:
    readonly DurableConversationCreationIntent[] = Object.freeze([]);
  let activateRetainedConversationPreferenceRecovery = async (
    _generation: number,
    _identity: ApplicationChatStorageIdentity,
  ): Promise<void> => {};
  let requestRetainedConversationPreferenceRecovery = (): void => {};
  let resumeRetainedConversationPreferenceRecoveryFromStorage = (
    _announcement?: { readonly command: string; readonly idempotencyKey: string },
  ): void => {};
  let pauseRetainedConversationPreferenceRecovery = (): void => {};
  let handleRetainedConversationPreferenceCoordinatedResult = (
    _command: string,
    _idempotencyKey: string,
    _result: unknown,
  ): void => {};
  let handleRetainedConversationPreferenceCanonicalEvent = (
    _event: ChatEvent,
  ): void => {};
  let retainedConversationPreferenceIntents:
    readonly DurableConversationPreferenceIntent[] = Object.freeze([]);
  let activateRetainedConversationArchiveRecovery = async (
    _generation: number,
    _identity: ApplicationChatStorageIdentity,
  ): Promise<void> => {};
  let requestRetainedConversationArchiveRecovery = (): void => {};
  let resumeRetainedConversationArchiveRecoveryFromStorage = (
    _announcement?: { readonly command: string; readonly idempotencyKey: string },
  ): void => {};
  let pauseRetainedConversationArchiveRecovery = (): void => {};
  let handleRetainedConversationArchiveCoordinatedResult = (
    _command: string,
    _idempotencyKey: string,
    _result: unknown,
  ): void => {};
  let handleRetainedConversationArchiveCanonicalEvent = (
    _event: ChatEvent,
  ): boolean => false;
  let retainedConversationArchiveIntents:
    readonly DurableConversationArchiveIntent[] = Object.freeze([]);
  let activateRetainedThreadFollowRecovery = async (
    _generation: number,
    _identity: ApplicationChatStorageIdentity,
  ): Promise<void> => {};
  let requestRetainedThreadFollowRecovery = (): void => {};
  let resumeRetainedThreadFollowRecoveryFromStorage = (
    _announcement?: { readonly command: string; readonly idempotencyKey: string },
  ): void => {};
  let pauseRetainedThreadFollowRecovery = (): void => {};
  let handleRetainedThreadFollowCoordinatedResult = (
    _command: string,
    _idempotencyKey: string,
    _result: unknown,
  ): void => {};
  let handleRetainedThreadFollowCanonicalEvent = (_event: ChatEvent): void => {};
  let retainedThreadFollowIntents:
    readonly DurableThreadFollowIntent[] = Object.freeze([]);
  let activateRetainedSavedMessageRecovery = async (
    _generation: number,
    _identity: ApplicationChatStorageIdentity,
  ): Promise<void> => {};
  let requestRetainedSavedMessageRecovery = (): void => {};
  let resumeRetainedSavedMessageRecoveryFromStorage = (
    _announcement?: { readonly command: string; readonly idempotencyKey: string },
  ): void => {};
  let pauseRetainedSavedMessageRecovery = (): void => {};
  let handleRetainedSavedMessageCoordinatedResult = (
    _command: string,
    _idempotencyKey: string,
    _result: unknown,
  ): void => {};
  let handleRetainedSavedMessageCanonicalEvent = (_event: ChatEvent): void => {};
  let retainedSavedMessageIntents:
    readonly DurableSavedMessageIntent[] = Object.freeze([]);
  let activateRetainedMessageReminderRecovery = async (
    _generation: number,
    _identity: ApplicationChatStorageIdentity,
  ): Promise<void> => {};
  let requestRetainedMessageReminderRecovery = (): void => {};
  let resumeRetainedMessageReminderRecoveryFromStorage = (
    _announcement?: { readonly command: string; readonly idempotencyKey: string },
  ): void => {};
  let pauseRetainedMessageReminderRecovery = (): void => {};
  let handleRetainedMessageReminderCoordinatedResult = (
    _command: string,
    _idempotencyKey: string,
    _result: unknown,
  ): void => {};
  let retainedMessageReminderIntents:
    readonly DurableMessageReminderIntent[] = Object.freeze([]);
  let retainedSendRecoveryEpoch = 0;
  let sendMessageQueueState = EMPTY_SEND_MESSAGE_QUEUE_STATE;
  const sendMessageQueueListeners = new Set<OfflineSendMessageQueueListener>();
  const sendMessageQueueMutationChains = new WeakMap<
    OfflineSendMessageQueue,
    Promise<void>
  >();
  const publishSendMessageQueueState = (
    next: OfflineSendMessageQueueState,
  ): void => {
    if (next === sendMessageQueueState) return;
    sendMessageQueueState = next;
    for (const listener of [...sendMessageQueueListeners]) {
      try {
        listener(next);
      } catch {
        // A public observer cannot alter durable queue behavior.
      }
    }
  };
  const serializeSendMessageQueueMutation = <Result>(
    queue: OfflineSendMessageQueue,
    operation: () => Promise<Result>,
  ): Promise<Result> => {
    const result = (sendMessageQueueMutationChains.get(queue) ?? Promise.resolve())
      .then(operation);
    sendMessageQueueMutationChains.set(queue, result.then(
      () => undefined,
      () => undefined,
    ));
    return result;
  };
  const replaceSendMessageQueue = (
    generation: number,
  ): OfflineSendMessageQueue | undefined => {
    stopRetainedSendRecovery();
    releaseSendMessageQueue?.();
    releaseSendMessageQueue = undefined;
    const previous = activeSendMessageQueue;
    activeSendMessageQueue = undefined;
    if (previous !== undefined) void previous.close();
    publishSendMessageQueueState(EMPTY_SEND_MESSAGE_QUEUE_STATE);
    if (normalizedCachePersistence === undefined) return undefined;
    const queue = createOfflineSendMessageQueue({
      storage: normalizedCachePersistence.storage,
    });
    activeSendMessageQueue = queue;
    releaseSendMessageQueue = queue.subscribe((next) => {
      if (
        generation === persistenceGeneration &&
        queue === activeSendMessageQueue
      ) publishSendMessageQueueState(next);
    });
    return queue;
  };
  const deactivateSendMessageQueue = (): void => {
    stopRetainedSendRecovery();
    releaseSendMessageQueue?.();
    releaseSendMessageQueue = undefined;
    const queue = activeSendMessageQueue;
    activeSendMessageQueue = undefined;
    if (queue !== undefined) void queue.close();
    publishSendMessageQueueState(EMPTY_SEND_MESSAGE_QUEUE_STATE);
  };
  const ownsRetainedSendRecovery = (): boolean => coordinator === undefined ||
    coordinationStatus?.ownsPersistedSendIntents === true;
  const announceRetainedSendAvailability = (): void => {
    const intent = activeSendMessageQueue?.getState().intents[0];
    if (intent === undefined) return;
    coordinator?.announcePersistedCommand("message.send", intent.idempotencyKey);
  };
  const reportPersistenceDiagnostic = (
    code: ChatNormalizedCachePersistenceDiagnosticCode,
    message: string,
  ): void => {
    try {
      normalizedCachePersistence?.onDiagnostic?.(Object.freeze({ code, message }));
    } catch {
      // Diagnostic observers cannot affect persistence or online startup.
    }
  };
  const persistenceScopeIsActive = (
    generation: number,
    identity: ApplicationChatStorageIdentity,
  ): boolean => generation === persistenceGeneration &&
    storageIdentitiesEqual(identity, activePersistenceIdentity);
  const advancePersistenceCheckpointOwnershipEpoch = (): void => {
    ++persistenceCheckpointOwnershipEpoch;
    lastCheckpointFingerprint = undefined;
  };
  const coordinationOwnsPersistenceCheckpoint = (
    status: ChatCrossTabStatus | undefined,
  ): boolean | undefined => status?.role === "leader" || status?.role === "fallback"
    ? true
    : status?.role === "electing" || status?.role === "follower"
    ? false
    : undefined;
  const schedulePersistenceCheckpoint = (): void => {
    if (
      normalizedCachePersistence === undefined ||
      !persistenceCheckpointEnabled ||
      activePersistenceIdentity === undefined
    ) return;
    const identity = activePersistenceIdentity;
    const generation = persistenceGeneration;
    const ownershipEpoch = persistenceCheckpointOwnershipEpoch;
    const cacheIdentity = cache.getState().identity;
    if (
      cacheIdentity === null ||
      cacheIdentity.tenantId !== identity.tenantId ||
      cacheIdentity.userId !== identity.userId
    ) return;

    let record;
    let fingerprint: string;
    let encoded: string;
    try {
      record = createApplicationChatNormalizedSnapshotRecord(
        identity,
        createDurableCacheSnapshot(
          cache.getState(),
          draftRuntime?.createCanonicalCheckpoint(),
        ),
      );
      fingerprint = JSON.stringify(record.snapshot);
      encoded = encodeApplicationChatStorageRecord(record);
    } catch {
      reportPersistenceDiagnostic(
        "snapshot_checkpoint_failed",
        "The normalized cache checkpoint could not be validated.",
      );
      return;
    }
    persistenceMutationChain = persistenceMutationChain.then(async () => {
      if (
        !persistenceScopeIsActive(generation, identity) ||
        ownershipEpoch !== persistenceCheckpointOwnershipEpoch ||
        !persistenceCheckpointEnabled
      ) return;
      if (fingerprint === lastCheckpointFingerprint) return;
      try {
        if (config.crossTab === undefined) {
          await normalizedCachePersistence.storage.replace(record);
        } else {
          const compareExchange = normalizedCachePersistence.storage.compareExchange;
          if (compareExchange === undefined || lastCheckpointEncoded === undefined) {
            throw new Error("normalized snapshot checkpoint baseline unavailable");
          }
          const exchanged = await compareExchange.call(
            normalizedCachePersistence.storage,
            identity,
            ApplicationChatStorageRecordKind.normalizedSnapshot,
            lastCheckpointEncoded,
            encoded,
          );
          if (!exchanged) {
            if (persistenceScopeIsActive(generation, identity)) {
              reportPersistenceDiagnostic(
                "snapshot_checkpoint_failed",
                "The normalized cache checkpoint could not be stored.",
              );
            }
            return;
          }
        }
        if (persistenceScopeIsActive(generation, identity)) {
          lastCheckpointEncoded = encoded;
          lastCheckpointFingerprint = fingerprint;
        }
      } catch {
        if (persistenceScopeIsActive(generation, identity)) {
          reportPersistenceDiagnostic(
            "snapshot_checkpoint_failed",
            "The normalized cache checkpoint could not be stored.",
          );
        }
      }
    });
  };
  const quarantinePersistenceSnapshot = async (
    generation: number,
    identity: ApplicationChatStorageIdentity,
  ): Promise<void> => {
    persistenceMutationChain = persistenceMutationChain.then(async () => {
      if (!persistenceScopeIsActive(generation, identity)) return;
      try {
        await normalizedCachePersistence?.storage.remove(
          identity,
          ApplicationChatStorageRecordKind.normalizedSnapshot,
        );
      } catch {
        if (persistenceScopeIsActive(generation, identity)) {
          reportPersistenceDiagnostic(
            "snapshot_quarantine_failed",
            "The rejected normalized cache snapshot could not be quarantined.",
          );
        }
      }
    });
    await persistenceMutationChain;
  };
  const hydratePersistenceSnapshot = async (
    generation: number,
    sendMessageQueue: OfflineSendMessageQueue | undefined,
  ): Promise<boolean> => {
    if (normalizedCachePersistence === undefined) return false;
    let hydratedSnapshot = false;
    let identity: ApplicationChatStorageIdentity;
    try {
      identity = parseApplicationChatStorageIdentity(
        await normalizedCachePersistence.resolveIdentity(),
      );
    } catch {
      if (generation === persistenceGeneration) {
        if (lastPersistenceIdentity !== undefined) {
          directoryRuntime.resetScope();
          messageSearchRuntime.resetScope();
          cache.setIdentity(null);
        }
        activePersistenceIdentity = undefined;
        persistenceCheckpointEnabled = false;
        reportPersistenceDiagnostic(
          "identity_resolution_failed",
          "The trusted normalized cache storage identity could not be resolved.",
        );
      }
      return false;
    }
    if (generation !== persistenceGeneration) return false;

    const currentCacheIdentity = cache.getState().identity;
    if (
      (lastPersistenceIdentity !== undefined &&
        !storageIdentitiesEqual(lastPersistenceIdentity, identity)) ||
      (currentCacheIdentity !== null &&
        (currentCacheIdentity.tenantId !== identity.tenantId ||
          currentCacheIdentity.userId !== identity.userId))
    ) {
      directoryRuntime.resetScope();
      messageSearchRuntime.resetScope();
      cache.setIdentity(null);
    }
    activePersistenceIdentity = identity;
    lastPersistenceIdentity = identity;
    lastCheckpointFingerprint = undefined;
    lastCheckpointEncoded = undefined;

    try {
      let record;
      try {
        record = await normalizedCachePersistence.storage.read(
          identity,
          ApplicationChatStorageRecordKind.normalizedSnapshot,
        );
      } catch (error) {
        if (!persistenceScopeIsActive(generation, identity)) return false;
        if (error instanceof ApplicationChatStorageValidationError) {
          reportPersistenceDiagnostic(
            "snapshot_rejected",
            "The stored normalized cache snapshot was rejected and quarantined.",
          );
        } else {
          reportPersistenceDiagnostic(
            "snapshot_read_failed",
            "The normalized cache snapshot could not be read.",
          );
        }
        return false;
      }
      if (!persistenceScopeIsActive(generation, identity)) return false;
      if (record === null) {
        lastCheckpointEncoded = null;
        return false;
      }
      if (!cache.hydrateCanonicalState(record.snapshot)) {
        reportPersistenceDiagnostic(
          "snapshot_rejected",
          "The stored normalized cache snapshot was rejected and quarantined.",
        );
        await quarantinePersistenceSnapshot(generation, identity);
        return false;
      }
      lastCheckpointEncoded = encodeApplicationChatStorageRecord(record);
      lastCheckpointFingerprint = JSON.stringify(record.snapshot);
      hydratedSnapshot = true;
    } finally {
      if (sendMessageQueue !== undefined) {
        try {
          await serializeSendMessageQueueMutation(sendMessageQueue, async () => {
            if (
              !persistenceScopeIsActive(generation, identity) ||
              sendMessageQueue !== activeSendMessageQueue
            ) return;
            await sendMessageQueue.activate(identity);
            requestRetainedSendRecovery();
          });
        } catch {
          // The queue remains unhydrated. A send will fail closed before command
          // dispatch unless a later durable read and enqueue both succeed.
        }
      }
    }
    return hydratedSnapshot;
  };
  cache.subscribe(
    (state) => state,
    () => schedulePersistenceCheckpoint(),
  );
  try {
    directoryRuntime = createChatHostDirectoryRuntime({
      endpoint,
      getAccessToken: config.getAccessToken,
      fetch: fetchImplementation,
      cache,
      ...(config.directory === undefined ? {} : { options: config.directory }),
    });
  } catch {
    throw new ChatClientConfigurationError("directory options are invalid");
  }
  try {
    messageSearchRuntime = createChatMessageSearchRuntime({
      endpoint,
      getAccessToken: config.getAccessToken,
      fetch: fetchImplementation,
      cache,
      ...(config.messageSearch === undefined ? {} : { options: config.messageSearch }),
    });
  } catch {
    throw new ChatClientConfigurationError("messageSearch options are invalid");
  }
  let generatedIdentity = 0;
  const generateIdentity = (prefix: string): string => {
    const randomUuid = globalThis.crypto?.randomUUID;
    if (typeof randomUuid === "function") return `${prefix}:${randomUuid.call(globalThis.crypto)}`;
    generatedIdentity += 1;
    return `${prefix}:${Date.now().toString(36)}:${generatedIdentity.toString(36)}`;
  };
  const generateClientMessageId =
    config.optimisticMessages?.generateClientMessageId ??
    (() => generateIdentity("message"));
  const generateSendIdempotencyKey =
    config.optimisticMessages?.generateIdempotencyKey ??
    (() => generateIdentity("send"));
  const generateEditIdempotencyKey =
    config.optimisticEdits?.generateIdempotencyKey ??
    (() => generateIdentity("edit"));
  const generateDeleteIdempotencyKey =
    config.optimisticDeletes?.generateIdempotencyKey ??
    (() => generateIdentity("delete"));
  const generateReactionIdempotencyKey =
    config.optimisticReactions?.generateIdempotencyKey ??
    (() => generateIdentity("reaction"));
  const generateReadStateIdempotencyKey =
    config.readState?.generateIdempotencyKey ??
    (() => generateIdentity("read-state"));
  const generateLifecycleIdempotencyKey =
    config.conversationLifecycle?.generateIdempotencyKey ??
    (() => generateIdentity("conversation"));
  const generateLifecycleClientRequestId =
    config.conversationLifecycle?.generateClientRequestId ??
    defaultLifecycleClientRequestId;
  const generatePreferenceIdempotencyKey =
    config.conversationPreferences?.generateIdempotencyKey ??
    (() => generateIdentity("preference"));
  const preferenceNow = config.conversationPreferences?.now ?? Date.now;
  const generateThreadFollowIdempotencyKey =
    config.threadFollows?.generateIdempotencyKey ??
    (() => generateIdentity("thread-follow"));
  const threadFollowNow = config.threadFollows?.now ?? Date.now;
  const generateSavedMessageIdempotencyKey =
    config.savedMessages?.generateIdempotencyKey ??
    (() => generateIdentity("saved-message"));
  const savedMessageNow = config.savedMessages?.now ?? Date.now;
  const generateMessageReminderIdempotencyKey =
    config.messageReminders?.generateIdempotencyKey ??
    (() => generateIdentity("message-reminder"));
  const messageReminderNow = config.messageReminders?.now ?? Date.now;
  const generateForwardClientCorrelationId =
    config.forwardMessages?.generateClientCorrelationId ??
    (() => generateIdentity("forward-correlation"));
  const generateForwardIdempotencyKey =
    config.forwardMessages?.generateIdempotencyKey ??
    (() => generateIdentity("forward"));
  const optimisticNow = config.optimisticMessages?.now ?? Date.now;
  const logicalSends = new Map<string, SendMessageInput>();
  const forwardInputs = new Map<string, {
    readonly input: ForwardMessageInput;
    readonly identity: ChatCacheIdentity;
    readonly generation: number;
  }>();
  const forwardQueues = new Map<
    string,
    Promise<ChatForwardMessageResult>
  >();
  const forwardSettled = new Map<string, ChatForwardMessageResult>();
  const activeForwardControllers = new Set<AbortController>();
  let forwardGeneration = 0;
  const lifecycleOperations = new Map<
    string,
    Promise<ChatCommandResult<unknown>>
  >();
  const preferenceQueues = new Map<
    ConversationId,
    Promise<ChatUpdateConversationPreferenceResult>
  >();
  let preferenceGeneration = 0;
  const threadFollowQueues = new Map<
    ConversationId,
    Promise<ChatSetThreadFollowResult>
  >();
  let threadFollowGeneration = 0;
  const savedMessageQueues = new Map<
    MessageId,
    Promise<ChatSetSavedMessageResult>
  >();
  const savedMessageInputs = new Map<string, SetSavedMessageInput>();
  let savedMessageGeneration = 0;
  const messageReminderQueues = new Map<
    MessageId,
    Promise<ChatMessageReminderResult>
  >();
  const messageReminderInputs = new Map<string, MessageReminderInput>();
  let messageReminderGeneration = 0;
  const threadOpeningStates = new Map<MessageId, ChatThreadOpeningState>();
  const threadCreationInputs = new Map<MessageId, ThreadCreationInput>();
  const existingThreadOpeningStates = new Map<ConversationId, ChatExistingThreadOpeningState>();
  const existingThreadOpeningListeners = new Map<ConversationId, Set<ChatExistingThreadOpeningListener>>();
  const activeExistingThreadOpenings = new Map<ConversationId, {
    controller: AbortController;
    promise: Promise<ChatExistingThreadOpeningState>;
  }>();
  const threadRootSequences = new Map<MessageId, number>();
  const threadOpeningListeners = new Map<
    MessageId,
    Set<ChatThreadOpeningListener>
  >();
  const activeThreadOpenings = new Map<
    MessageId,
    {
      readonly controller: AbortController;
      readonly promise: Promise<ChatThreadOpeningState>;
    }
  >();
  const retainedThreadSubscriptions = new Map<ConversationId, () => void>();
  let threadOpeningGeneration = 0;
  try {
    attachmentUploadManager = createChatAttachmentUploadManager({
      endpoint,
      getAccessToken: config.getAccessToken,
      fetch: fetchImplementation,
      cache,
      generateIdentity,
      ...(config.commands === undefined ? {} : { commands: config.commands }),
      ...(config.attachments === undefined ? {} : { options: config.attachments }),
    });
  } catch {
    throw new ChatClientConfigurationError("attachments options are invalid");
  }
  try {
    commandDispatcher = createChatCommandDispatcher({
      endpoint,
      getAccessToken: config.getAccessToken,
      fetch: fetchImplementation,
      ...(config.commands === undefined ? {} : { options: config.commands }),
    });
  } catch {
    throw new ChatClientConfigurationError("commands options are invalid");
  }
  try {
    snapshotReader = createChatSnapshotReader({
      endpoint,
      getAccessToken: config.getAccessToken,
      fetch: fetchImplementation,
      cache,
      ...(config.queries === undefined ? {} : { options: config.queries }),
    });
    threadSnapshotReader = createChatSnapshotReader({
      endpoint,
      getAccessToken: config.getAccessToken,
      fetch: fetchImplementation,
      ...(config.queries === undefined ? {} : { options: config.queries }),
    });
    draftSnapshotReader = createChatSnapshotReader({
      endpoint,
      getAccessToken: config.getAccessToken,
      fetch: fetchImplementation,
      ...(config.queries === undefined ? {} : { options: config.queries }),
    });
  } catch {
    throw new ChatClientConfigurationError("queries options are invalid");
  }
  const unreadMentionRefresh = createUnreadMentionRefresh(cache, createChatSnapshotReader({
    endpoint,
    getAccessToken: config.getAccessToken,
    fetch: fetchImplementation,
    ...(config.queries === undefined ? {} : { options: config.queries }),
  }));
  replyStyleRuntime = createReplyStyleRuntime({
    cache, reader: snapshotReader,
    dispatch: (descriptor, input, options) => client.dispatch(descriptor, input, options),
    enabledFeatures: () => lifecycleState.state === "ready" ? lifecycleState.enabledFeatures : undefined,
    online: () => lifecycleState.state === "ready" &&
      (realtimeSession === undefined || realtimeSession.state.state === "connected" || coordinationStatus?.role === "follower"),
    generateIdempotencyKey: () => config.commands?.generateIdempotencyKey?.() ?? generateIdentity("reply-style"),
    ...(config.replyStyle === undefined ? {} : { configuration: config.replyStyle }),
  });
  messageContextRuntime = createMessageContextRuntime({
    cache,
    reader: createChatSnapshotReader({
      endpoint, getAccessToken: config.getAccessToken, fetch: fetchImplementation,
      ...(config.queries === undefined ? {} : { options: config.queries }),
    }),
    online: () => lifecycleState.state === "ready" &&
      (realtimeSession === undefined || realtimeSession.state.state === "connected"),
    subscribeConversation: id => realtimeSession?.subscribeConversation(id),
  });
  threadListRuntime = createThreadListRuntime({
    cache, reader: threadSnapshotReader,
    online: () => lifecycleState.state === "ready" &&
      (realtimeSession === undefined || realtimeSession.state.state === "connected"),
    subscribeConversation: id => realtimeSession?.subscribeConversation(id),
    ...config.threadList,
  });
  threadLifecycleRuntime = createThreadLifecycleRuntime({
    cache,
    reader: createChatSnapshotReader({
      endpoint, getAccessToken: config.getAccessToken, fetch: fetchImplementation,
      ...(config.queries === undefined ? {} : { options: config.queries }),
    }),
    dispatch: (descriptor, input, options) => client.dispatch(descriptor, input, options),
    enabledFeatures: () => lifecycleState.state === "ready" ? lifecycleState.enabledFeatures : {},
    online: () => lifecycleState.state === "ready" &&
      (realtimeSession === undefined || realtimeSession.state.state === "connected"),
    generateIdempotencyKey: () => config.commands?.generateIdempotencyKey?.() ?? generateIdentity("thread-lifecycle"),
    subscribeConversation: id => realtimeSession?.subscribeConversation(id),
  });
  const refreshConversationDetail = (conversationId: ConversationId): void => {
    void snapshotReader
      .getConversation<Feature>({ conversationId })
      .then((result) => {
        if (
          result.status === "success" &&
          cache.getState().entities.conversations[conversationId]?.archivedAt !==
            undefined
        ) {
          const release = retainedThreadSubscriptions.get(conversationId);
          if (release !== undefined) {
            retainedThreadSubscriptions.delete(conversationId);
            release();
          }
        }
      })
      .catch(() => undefined);
  };
  if (config.realtime !== undefined) {
    try {
      const onRealtimeStateChange = config.realtime.onStateChange;
      const onCanonicalRealtimeEvent = config.realtime.onCanonicalEvent;
      const requestedByName = requestedFeatures as
        | Readonly<Record<string, boolean>>
        | undefined;
      const locallyEnabled = config.realtime.ephemeralSignals?.enabledFeatures;
      const ephemeralSignals = {
        ...config.realtime.ephemeralSignals,
        enabledFeatures: Object.freeze({
          typing:
            locallyEnabled?.typing !== false &&
            (requestedByName === undefined || requestedByName["typing"] === true),
          presence:
            locallyEnabled?.presence !== false &&
            (requestedByName === undefined || requestedByName["presence"] === true),
        }),
      };
      realtimeSession = createChatRealtimeSession({
        ...config.realtime,
        ephemeralSignals,
        endpoint,
        clientPackageVersion: CHAT_CLIENT_PACKAGE_VERSION,
        protocolVersion: CHAT_PROTOCOL_VERSION,
        getAccessToken: config.getAccessToken,
        cache,
        onConversationAccessRevoked(conversationId) {
          unreadMentionRefresh.revoke(conversationId as ConversationId);
          threadListRuntime?.revoke(conversationId as ConversationId);
          threadLifecycleRuntime?.revoke(conversationId as ConversationId);
          messageContextRuntime?.revoke(conversationId as ConversationId);
          config.realtime?.onConversationAccessRevoked?.(conversationId);
        },
        onStateChange(nextState) {
          huddleRuntime?.handleRealtimeState(nextState.state);
          replyStyleRuntime?.connectionChanged(nextState.state === "connected");
          threadListRuntime?.connectionChanged(nextState.state === "connected");
          threadLifecycleRuntime?.connectionChanged(nextState.state === "connected");
          messageContextRuntime?.connectionChanged(nextState.state === "connected");
          if (nextState.state === "connected") {
            unreadMentionRefresh.connected();
            requestRetainedSendRecovery();
            requestRetainedMessageMutationRecovery();
            resumeRetainedMembershipRecoveryFromStorage();
            resumeRetainedConversationCreationRecoveryFromStorage();
            resumeRetainedConversationPreferenceRecoveryFromStorage();
            resumeRetainedConversationArchiveRecoveryFromStorage();
            resumeRetainedThreadFollowRecoveryFromStorage();
            resumeRetainedSavedMessageRecoveryFromStorage();
            resumeRetainedMessageReminderRecoveryFromStorage();
            resumeRetainedReadRecoveryFromStorage();
            resumeRetainedDraftRecoveryFromStorage();
            resumeRetainedHuddleRecoveryFromStorage();
          } else {
            pauseRetainedSendRecovery();
            pauseRetainedEditRecovery();
            pauseRetainedDeleteRecovery();
            pauseRetainedReactionRecovery();
            pauseRetainedForwardRecovery();
            pauseRetainedMembershipRecovery();
            pauseRetainedConversationCreationRecovery();
            pauseRetainedConversationPreferenceRecovery();
            pauseRetainedConversationArchiveRecovery();
            pauseRetainedThreadFollowRecovery();
            pauseRetainedSavedMessageRecovery();
            pauseRetainedMessageReminderRecovery();
            huddleRuntime?.pauseRetained();
            readStateRuntime?.pauseRetained();
            draftRuntime?.pauseRetained();
          }
          if (nextState.state === "refresh_required") {
            setLifecycleState(Object.freeze({
              state: "refresh_required",
              reason: nextState.reason,
              message: nextState.message,
              requestedProtocolVersion: CHAT_PROTOCOL_VERSION,
              clientPackageVersion: CHAT_CLIENT_PACKAGE_VERSION,
              metadata: nextState.metadata,
            }));
          }
          onRealtimeStateChange?.(nextState);
        },
        onCanonicalEvent(event) {
          replyStyleRuntime?.handleCanonicalEvent(event);
          threadListRuntime?.handleCanonicalEvent(event);
          threadLifecycleRuntime?.handleCanonicalEvent(event);
          messageContextRuntime?.handleCanonicalEvent(event);
          handleRetainedSendCanonicalEvent(event);
          handleRetainedEditCanonicalEvent(event);
          handleRetainedDeleteCanonicalEvent(event);
          handleRetainedReactionCanonicalEvent(event);
          handleRetainedForwardCanonicalEvent(event);
          handleRetainedMembershipCanonicalEvent(event);
          handleRetainedConversationCreationCanonicalEvent(event);
          handleRetainedConversationPreferenceCanonicalEvent(event);
          const archiveEventHandled =
            handleRetainedConversationArchiveCanonicalEvent(event);
          handleRetainedThreadFollowCanonicalEvent(event);
          handleRetainedSavedMessageCanonicalEvent(event);
          readStateRuntime?.handleCanonicalEvent(event);
          draftRuntime?.handleCanonicalEvent(event);
          onCanonicalRealtimeEvent?.(event);
          coordinator?.publishCanonicalEvent(event);
          if (
            !archiveEventHandled &&
            (event.type === "conversation.archived" ||
              event.type === "conversation.restored")
          ) {
            refreshConversationDetail(event.streamId as ConversationId);
          }
        },
      });
    } catch {
      throw new ChatClientConfigurationError("realtime options are invalid");
    }
  }

  const resolveSessionFingerprint = async (): Promise<string | undefined> => {
    const crossTab = config.crossTab;
    if (crossTab === undefined) return undefined;
    try {
      const value = crossTab.getSessionFingerprint === undefined
        ? crossTab.sessionFingerprint
        : await crossTab.getSessionFingerprint();
      return typeof value === "string" && value.trim().length > 0
        ? value.trim()
        : undefined;
    } catch {
      return undefined;
    }
  };

  const configureCoordination = async (): Promise<void> => {
    const fingerprint = await resolveSessionFingerprint();
    if (fingerprint === undefined || config.crossTab === undefined) {
      advancePersistenceCheckpointOwnershipEpoch();
      if (activeSessionFingerprint !== undefined) {
        directoryRuntime.resetScope();
        messageSearchRuntime.resetScope();
      }
      activeSessionFingerprint = undefined;
      coordinator?.close();
      coordinator = undefined;
      coordinationStatus = undefined;
      realtimeSession?.setCoordinationScope(undefined);
      persistenceCheckpointEnabled = activePersistenceIdentity !== undefined;
      schedulePersistenceCheckpoint();
      return;
    }
    if (coordinator !== undefined && activeSessionFingerprint === fingerprint) return;
    advancePersistenceCheckpointOwnershipEpoch();
    coordinator?.close();
    coordinator = undefined;
    coordinationStatus = undefined;
    persistenceCheckpointEnabled = false;
    if (
      activeSessionFingerprint !== undefined &&
      activeSessionFingerprint !== fingerprint
    ) {
      directoryRuntime.resetScope();
      messageSearchRuntime.resetScope();
      realtimeSession?.close();
      cache.setIdentity(null);
    }
    activeSessionFingerprint = fingerprint;
    const {
      sessionFingerprint: _configuredFingerprint,
      getSessionFingerprint: _getFingerprint,
      onStatusChange,
      ...crossTabRuntime
    } = config.crossTab;
    try {
      coordinator = createChatCrossTabCoordinator({
        ...crossTabRuntime,
        endpoint,
        sessionFingerprint: fingerprint,
        onStatusChange(nextStatus) {
          const previouslyOwnedCheckpoint =
            coordinationOwnsPersistenceCheckpoint(coordinationStatus);
          const nextOwnsCheckpoint = coordinationOwnsPersistenceCheckpoint(nextStatus);
          coordinationStatus = nextStatus;
          if (
            previouslyOwnedCheckpoint !== undefined &&
            nextOwnsCheckpoint !== undefined &&
            previouslyOwnedCheckpoint !== nextOwnsCheckpoint
          ) advancePersistenceCheckpointOwnershipEpoch();
          try {
            onStatusChange?.(nextStatus);
          } catch {
            // Public status observers cannot alter fail-open behavior.
          }
          if (
            nextStatus.role === "leader" ||
            nextStatus.role === "fallback"
          ) {
            persistenceCheckpointEnabled = activePersistenceIdentity !== undefined;
            schedulePersistenceCheckpoint();
            if (nextStatus.role === "leader") {
              realtimeSession?.adoptReplayCursor(
                cache.getState().metadata.realtimeCursor,
              );
              coordinator?.publishCanonicalState(cache.getState());
            }
            if (lifecycleState.state === "ready") realtimeSession?.start();
            resumeRetainedSendRecoveryFromStorage();
            reloadRetainedEditRecovery();
            reloadRetainedDeleteRecovery();
            reloadRetainedReactionRecovery();
            reloadRetainedForwardRecovery();
            resumeRetainedMembershipRecoveryFromStorage();
            resumeRetainedConversationCreationRecoveryFromStorage();
            resumeRetainedConversationPreferenceRecoveryFromStorage();
            resumeRetainedConversationArchiveRecoveryFromStorage();
            resumeRetainedThreadFollowRecoveryFromStorage();
            resumeRetainedSavedMessageRecoveryFromStorage();
            resumeRetainedMessageReminderRecoveryFromStorage();
            resumeRetainedReadRecoveryFromStorage();
            resumeRetainedDraftRecoveryFromStorage();
            resumeRetainedHuddleRecoveryFromStorage();
          } else if (
            nextStatus.role === "electing" ||
            nextStatus.role === "follower"
          ) {
            persistenceCheckpointEnabled = false;
            pauseRetainedSendRecovery();
            pauseRetainedEditRecovery();
            pauseRetainedDeleteRecovery();
            pauseRetainedReactionRecovery();
            pauseRetainedForwardRecovery();
            pauseRetainedMembershipRecovery();
            pauseRetainedConversationCreationRecovery();
            pauseRetainedConversationPreferenceRecovery();
            pauseRetainedConversationArchiveRecovery();
            pauseRetainedThreadFollowRecovery();
            pauseRetainedSavedMessageRecovery();
            pauseRetainedMessageReminderRecovery();
            readStateRuntime?.pauseRetained();
            draftRuntime?.pauseRetained();
            huddleRuntime?.pauseRetained();
            realtimeSession?.close();
            if (nextStatus.role === "follower") {
              replyStyleRuntime?.connectionChanged(lifecycleState.state === "ready");
              announceRetainedSendAvailability();
              for (const intent of retainedEditIntents) {
                coordinator?.announcePersistedCommand(
                  "message.edit",
                  intent.request.idempotencyKey,
                );
              }
              for (const intent of retainedDeleteIntents) {
                coordinator?.announcePersistedCommand(
                  "message.delete",
                  intent.request.idempotencyKey,
                );
              }
              for (const intent of retainedReactionIntents) {
                coordinator?.announcePersistedCommand(
                  "reaction.set",
                  intent.request.idempotencyKey,
                );
              }
              for (const intent of retainedForwardIntents) {
                coordinator?.announcePersistedCommand(
                  "message.forward",
                  intent.request.idempotencyKey,
                );
              }
              for (const intent of retainedMembershipIntents) {
                coordinator?.announcePersistedCommand(
                  "conversation.membership.mutate",
                  intent.request.idempotencyKey,
                );
              }
              for (const intent of retainedConversationCreationIntents) {
                coordinator?.announcePersistedCommand(
                  "conversation.create",
                  intent.request.idempotencyKey,
                );
              }
              for (const intent of retainedConversationPreferenceIntents) {
                coordinator?.announcePersistedCommand(
                  "conversation.preference.update",
                  intent.request.idempotencyKey,
                );
              }
              for (const intent of retainedConversationArchiveIntents) {
                coordinator?.announcePersistedCommand(
                  "conversation.archive.set",
                  intent.request.idempotencyKey,
                );
              }
              for (const intent of retainedThreadFollowIntents) {
                coordinator?.announcePersistedCommand(
                  "thread.follow.set",
                  intent.request.idempotencyKey,
                );
              }
              for (const intent of retainedSavedMessageIntents) {
                coordinator?.announcePersistedCommand(
                  "saved_message.set",
                  intent.request.idempotencyKey,
                );
              }
              for (const intent of retainedMessageReminderIntents) {
                coordinator?.announcePersistedCommand(
                  "message.reminder.set",
                  intent.request.idempotencyKey,
                );
              }
              draftRuntime?.announceRetained();
              huddleRuntime?.announceRetained();
            }
          }
        },
        onHydrationRequest() {
          coordinator?.publishCanonicalState(cache.getState());
        },
        onCanonicalState(value) {
          if (cache.hydrateCanonicalState(value)) {
            void replyStyleRuntime?.api.load();
            readStateRuntime?.markAuthoritative(
              Object.values(cache.getState().currentUser.readStates),
            );
            const identity = activePersistenceIdentity;
            const generation = persistenceGeneration;
            if (identity !== undefined) {
              const scope = Object.freeze({ identity, generation });
              void draftRuntime.activateRetained(scope).then(() => {
                if (!persistenceScopeIsActive(generation, identity)) return;
                if (ownsRetainedSendRecovery()) draftRuntime.resumeRetained();
                else draftRuntime.announceRetained();
              }).catch(() => undefined);
            }
            persistenceCheckpointEnabled = activePersistenceIdentity !== undefined;
            schedulePersistenceCheckpoint();
            requestRetainedMembershipRecovery();
            requestRetainedConversationCreationRecovery();
            requestRetainedConversationPreferenceRecovery();
            requestRetainedConversationArchiveRecovery();
            requestRetainedThreadFollowRecovery();
            requestRetainedSavedMessageRecovery();
            requestRetainedMessageReminderRecovery();
          }
        },
        onCanonicalEvent(value) {
          if (realtimeSession?.applyCanonicalEvent(value) === true) {
            replyStyleRuntime?.handleCanonicalEvent(value);
            threadListRuntime?.handleCanonicalEvent(value);
            threadLifecycleRuntime?.handleCanonicalEvent(value);
            messageContextRuntime?.handleCanonicalEvent(value);
            handleRetainedSendCanonicalEvent(value as ChatEvent);
            handleRetainedEditCanonicalEvent(value as ChatEvent);
            handleRetainedDeleteCanonicalEvent(value as ChatEvent);
            handleRetainedReactionCanonicalEvent(value as ChatEvent);
            handleRetainedForwardCanonicalEvent(value as ChatEvent);
            handleRetainedMembershipCanonicalEvent(value as ChatEvent);
            handleRetainedConversationCreationCanonicalEvent(value as ChatEvent);
            handleRetainedConversationPreferenceCanonicalEvent(value as ChatEvent);
            handleRetainedConversationArchiveCanonicalEvent(value as ChatEvent);
            handleRetainedThreadFollowCanonicalEvent(value as ChatEvent);
            handleRetainedSavedMessageCanonicalEvent(value as ChatEvent);
            readStateRuntime?.handleCanonicalEvent(value as ChatEvent);
            draftRuntime?.handleCanonicalEvent(value);
          }
        },
        onPersistedCommandAvailable(command, idempotencyKey) {
          if (command === "message.send") {
            resumeRetainedSendRecoveryFromStorage();
          } else if (command === "message.edit") {
            reloadRetainedEditRecovery({ command, idempotencyKey });
          } else if (command === "message.delete") {
            reloadRetainedDeleteRecovery({ command, idempotencyKey });
          } else if (command === "reaction.set") {
            reloadRetainedReactionRecovery({ command, idempotencyKey });
          } else if (command === "message.forward") {
            reloadRetainedForwardRecovery({ command, idempotencyKey });
          } else if (command === "conversation.membership.mutate") {
            resumeRetainedMembershipRecoveryFromStorage({ command, idempotencyKey });
          } else if (command === "conversation.create") {
            resumeRetainedConversationCreationRecoveryFromStorage({
              command,
              idempotencyKey,
            });
          } else if (command === "conversation.preference.update") {
            resumeRetainedConversationPreferenceRecoveryFromStorage({
              command,
              idempotencyKey,
            });
          } else if (command === "conversation.archive.set") {
            resumeRetainedConversationArchiveRecoveryFromStorage({
              command,
              idempotencyKey,
            });
          } else if (command === "thread.follow.set") {
            resumeRetainedThreadFollowRecoveryFromStorage({
              command,
              idempotencyKey,
            });
          } else if (command === "saved_message.set") {
            resumeRetainedSavedMessageRecoveryFromStorage({
              command,
              idempotencyKey,
            });
          } else if (command === "message.reminder.set") {
            resumeRetainedMessageReminderRecoveryFromStorage({
              command,
              idempotencyKey,
            });
          } else if (command === "conversation.draft.synchronize") {
            resumeRetainedDraftRecoveryFromStorage({ command, idempotencyKey });
          } else if (
            command === "conversation.mark_read" ||
            command === "conversation.mark_unread"
          ) {
            resumeRetainedReadRecoveryFromStorage({ command, idempotencyKey });
          } else if (command === "huddle.command") {
            resumeRetainedHuddleRecoveryFromStorage({ command, idempotencyKey });
          }
        },
        onCoordinatedCommandResult(command, idempotencyKey, result) {
          handleRetainedSendCoordinatedResult(command, idempotencyKey, result);
          handleRetainedEditCoordinatedResult(command, idempotencyKey, result);
          handleRetainedDeleteCoordinatedResult(command, idempotencyKey, result);
          handleRetainedReactionCoordinatedResult(command, idempotencyKey, result);
          handleRetainedForwardCoordinatedResult(command, idempotencyKey, result);
          handleRetainedMembershipCoordinatedResult(command, idempotencyKey, result);
          handleRetainedConversationCreationCoordinatedResult(
            command,
            idempotencyKey,
            result,
          );
          handleRetainedConversationPreferenceCoordinatedResult(
            command,
            idempotencyKey,
            result,
          );
          handleRetainedConversationArchiveCoordinatedResult(
            command,
            idempotencyKey,
            result,
          );
          handleRetainedThreadFollowCoordinatedResult(
            command,
            idempotencyKey,
            result,
          );
          handleRetainedSavedMessageCoordinatedResult(
            command,
            idempotencyKey,
            result,
          );
          handleRetainedMessageReminderCoordinatedResult(
            command,
            idempotencyKey,
            result,
          );
          readStateRuntime?.handleCoordinatedResult(command, idempotencyKey, result);
          draftRuntime?.handleCoordinatedResult(command, idempotencyKey, result);
          huddleRuntime?.handleCoordinatedResult(command, idempotencyKey, result);
        },
      });
      realtimeSession?.setCoordinationScope(coordinator.channelName);
      coordinator.start();
    } catch {
      coordinator = undefined;
      coordinationStatus = undefined;
      realtimeSession?.setCoordinationScope(undefined);
      persistenceCheckpointEnabled = activePersistenceIdentity !== undefined;
      schedulePersistenceCheckpoint();
    }
  };

  const idleThreadOpeningState = (
    rootMessageId: MessageId,
  ): ChatThreadOpeningIdleState => Object.freeze({
    state: "idle",
    rootMessageId,
  });

  const setThreadOpeningState = (next: ChatThreadOpeningState): void => {
    const previous =
      threadOpeningStates.get(next.rootMessageId) ??
      idleThreadOpeningState(next.rootMessageId);
    if (previous === next) return;
    threadOpeningStates.set(next.rootMessageId, next);
    for (const listener of threadOpeningListeners.get(next.rootMessageId) ?? []) {
      try {
        listener(next, previous);
      } catch {
        // View-state observers cannot alter canonical opening work.
      }
    }
  };

  const threadOpeningError = (
    rootMessageId: MessageId,
    code: ChatThreadOpeningErrorCode,
    message: string,
    parentConversationId?: ConversationId,
    httpStatus?: number,
  ): ChatThreadOpeningErrorState => Object.freeze({
    state: "error",
    rootMessageId,
    ...(parentConversationId === undefined ? {} : { parentConversationId }),
    code,
    message,
    ...(httpStatus === undefined ? {} : { httpStatus }),
  });

  const beginThreadOpening = (
    rootMessageId: MessageId,
    name?: string,
  ): Promise<ChatThreadOpeningState> => {
    if (
      typeof rootMessageId !== "string" ||
      rootMessageId.trim().length === 0 ||
      rootMessageId !== rootMessageId.trim()
    ) {
      return Promise.resolve(threadOpeningError(
        rootMessageId,
        "root_message_unavailable",
        "The canonical thread root message is unavailable.",
      ));
    }
    const active = activeThreadOpenings.get(rootMessageId);
    if (active !== undefined) return active.promise;
    const current = threadOpeningStates.get(rootMessageId);
    // A sibling's canonical snapshot can replace this tab's cached detail
    // without replacing its local opening lifecycle. Only reuse a usable open.
    if (current?.state === "ready" &&
        cache.getState().entities.messages[rootMessageId] !== undefined &&
        cache.getState().entities.conversations[current.threadConversationId] !== undefined) {
      return Promise.resolve(current);
    }

    const root = cache.getState().entities.messages[rootMessageId];
    const parentConversationId = root?.conversationId ??
      (current !== undefined && "parentConversationId" in current ? current.parentConversationId : undefined);
    if (parentConversationId === undefined) {
      const failure = threadOpeningError(
        rootMessageId,
        "root_message_unavailable",
        "The canonical thread root message is unavailable.",
      );
      setThreadOpeningState(failure);
      return Promise.resolve(failure);
    }
    if (root !== undefined) threadRootSequences.set(rootMessageId, root.sequence);
    // A canonical root summary already identifies the discussion. Opening it is
    // a read, including when archive policy forbids create-thread reconciliation.
    if (root?.isThreadRoot === true) {
      const generation = threadOpeningGeneration;
      const controller = new AbortController();
      setThreadOpeningState(Object.freeze({ state: "loading", rootMessageId, parentConversationId }));
      const opening = beginExistingThreadOpening(root.threadSummary.threadId).then((result): ChatThreadOpeningState => {
        if (controller.signal.aborted || generation !== threadOpeningGeneration) {
          return threadOpeningStates.get(rootMessageId) ?? idleThreadOpeningState(rootMessageId);
        }
        const next: ChatThreadOpeningState = result.state === "ready"
          ? Object.freeze({
              state: "ready", rootMessageId, parentConversationId,
              threadConversationId: result.threadConversationId,
              reconciliationStatus: "existing_for_root",
            })
          : threadOpeningError(
              rootMessageId,
              result.state === "error" ? result.code : "snapshot_failed",
              result.state === "error" ? result.message : "The thread could not be loaded.",
              parentConversationId,
              result.state === "error" ? result.httpStatus : undefined,
            );
        setThreadOpeningState(next);
        return next;
      });
      const tracked = opening.finally(() => {
        if (activeThreadOpenings.get(rootMessageId)?.promise === tracked) {
          activeThreadOpenings.delete(rootMessageId);
        }
      });
      activeThreadOpenings.set(rootMessageId, { controller, promise: tracked });
      return tracked;
    }
    let input: ThreadCreationInput;
    try {
      if (cache.getState().entities.conversations[parentConversationId]?.type === "thread") {
        throw new TypeError("Nested threads are not supported");
      }
      input = threadCreationInputs.get(rootMessageId) ?? parseThreadCreationInput({
        operation: "create_thread",
        parentConversationId,
        rootMessageId,
        ...(name === undefined ? {} : { name }),
        idempotencyKey: generateLifecycleIdempotencyKey(),
      });
      threadCreationInputs.set(rootMessageId, input);
    } catch {
      const failure = threadOpeningError(
        rootMessageId,
        "command_failed",
        "The thread could not be resolved.",
        parentConversationId,
      );
      setThreadOpeningState(failure);
      return Promise.resolve(failure);
    }

    const controller = new AbortController();
    const generation = threadOpeningGeneration;
    setThreadOpeningState(Object.freeze({
      state: "loading",
      rootMessageId,
      parentConversationId,
    }));

    const opening = (async (): Promise<ChatThreadOpeningState> => {
      const currentState = (): ChatThreadOpeningState =>
        threadOpeningStates.get(rootMessageId) ??
        idleThreadOpeningState(rootMessageId);
      const isClosed = (): boolean =>
        controller.signal.aborted || generation !== threadOpeningGeneration;

      const command = await client.dispatch(
        createThreadDescriptor(input),
        input,
        {
          idempotencyKey: input.idempotencyKey,
          coordinationKey: `thread:${stableLogicalHash(rootMessageId)}`,
          signal: controller.signal,
        },
      );
      if (isClosed()) return currentState();
      if (command.status !== "success") {
        const failure = threadOpeningError(
          rootMessageId,
          "command_failed",
          "The thread could not be resolved.",
          parentConversationId,
          "httpStatus" in command ? command.httpStatus : undefined,
        );
        setThreadOpeningState(failure);
        return failure;
      }

      const result = command.value;
      const threadConversationId = result.conversation.conversation.id;
      const timeline = await threadSnapshotReader.getMessageTimeline({
        conversationId: threadConversationId,
        direction: "backward",
        limit: 50,
      }, { signal: controller.signal });
      if (isClosed()) return currentState();
      if (timeline.status !== "success") {
        const failure = threadOpeningError(
          rootMessageId,
          "snapshot_failed",
          "The thread message snapshot could not be loaded.",
          parentConversationId,
          "httpStatus" in timeline ? timeline.httpStatus : undefined,
        );
        setThreadOpeningState(failure);
        return failure;
      }

      // Creation/replay snapshots can predate private follow mutations. Read
      // current actor authority before publishing an actionable thread panel.
      const detail = await threadSnapshotReader.getConversation<Feature>(
        { conversationId: threadConversationId },
        { signal: controller.signal },
      );
      if (isClosed()) return currentState();
      if (detail.status !== "success" ||
          detail.value.conversation.currentThreadFollow === undefined) {
        const failure = threadOpeningError(
          rootMessageId, "snapshot_failed", "The thread follow state could not be loaded.",
          parentConversationId, "httpStatus" in detail ? detail.httpStatus : undefined,
        );
        setThreadOpeningState(failure);
        return failure;
      }

      // Hydration may evict the root before opening or during the awaits above.
      // Retain only its position; fetch canonical content once, immediately before
      // reconciliation, without scanning history or restoring a stale message.
      if (cache.getState().entities.messages[rootMessageId] === undefined) {
        const sequence = threadRootSequences.get(rootMessageId);
        const parentPage = await threadSnapshotReader.getMessageTimeline({
          conversationId: parentConversationId,
          direction: sequence === undefined ? "backward" : "forward",
          ...(sequence === undefined ? {} : { cursor: sequence - 1 }),
          limit: sequence === undefined ? 50 : 1,
        }, { signal: controller.signal });
        if (isClosed()) return currentState();
        if (parentPage.status !== "success" || !parentPage.value.messages.some(
          (message) => message.id === rootMessageId && message.conversationId === parentConversationId,
        )) {
          const failure = threadOpeningError(
            rootMessageId, "snapshot_failed", "The canonical thread root message could not be loaded.",
            parentConversationId, "httpStatus" in parentPage ? parentPage.httpStatus : undefined,
          );
          setThreadOpeningState(failure);
          return failure;
        }
        cache.hydrateMessageTimeline(parentPage.value);
      }

      let releaseSubscription: (() => void) | undefined;
      if (
        realtimeSession !== undefined &&
        !retainedThreadSubscriptions.has(threadConversationId)
      ) {
        try {
          releaseSubscription = realtimeSession.subscribeConversation(
            threadConversationId,
          );
        } catch {
          const failure = threadOpeningError(
            rootMessageId,
            "subscription_failed",
            "The thread realtime subscription could not be established.",
            parentConversationId,
          );
          setThreadOpeningState(failure);
          return failure;
        }
      }
      if (isClosed()) {
        releaseSubscription?.();
        return currentState();
      }

      try {
        cache.reconcileThreadOpening(input, result, timeline.value);
        cache.hydrateConversationDetail(detail.value);
      } catch {
        releaseSubscription?.();
        const failure = threadOpeningError(
          rootMessageId,
          "cache_reconciliation_failed",
          "The canonical thread state could not be reconciled.",
          parentConversationId,
        );
        setThreadOpeningState(failure);
        return failure;
      }
      if (releaseSubscription !== undefined) {
        retainedThreadSubscriptions.set(
          threadConversationId,
          releaseSubscription,
        );
      }
      const ready: ChatThreadOpeningReadyState = Object.freeze({
        state: "ready",
        rootMessageId,
        parentConversationId,
        threadConversationId,
        reconciliationStatus: result.reconciliationStatus,
      });
      setThreadOpeningState(ready);
      return ready;
    })().catch(() => {
      if (generation !== threadOpeningGeneration) {
        return threadOpeningStates.get(rootMessageId) ??
          idleThreadOpeningState(rootMessageId);
      }
      const failure = threadOpeningError(
        rootMessageId,
        "command_failed",
        "The thread could not be resolved.",
        parentConversationId,
      );
      setThreadOpeningState(failure);
      return failure;
    });
    const tracked = opening.finally(() => {
      if (activeThreadOpenings.get(rootMessageId)?.promise === tracked) {
        activeThreadOpenings.delete(rootMessageId);
      }
    });
    activeThreadOpenings.set(rootMessageId, { controller, promise: tracked });
    return tracked;
  };

  const idleExistingThreadOpeningState = (
    threadConversationId: ConversationId,
  ): ChatExistingThreadOpeningState => Object.freeze({ state: "idle", threadConversationId });

  const setExistingThreadOpeningState = (next: ChatExistingThreadOpeningState): void => {
    const previous = existingThreadOpeningStates.get(next.threadConversationId) ??
      idleExistingThreadOpeningState(next.threadConversationId);
    existingThreadOpeningStates.set(next.threadConversationId, next);
    for (const listener of existingThreadOpeningListeners.get(next.threadConversationId) ?? []) {
      try { listener(next, previous); } catch { /* Observers cannot alter opening work. */ }
    }
  };

  const beginExistingThreadOpening = (
    threadConversationId: ConversationId,
  ): Promise<ChatExistingThreadOpeningState> => {
    const active = activeExistingThreadOpenings.get(threadConversationId);
    if (active !== undefined) return active.promise;
    const fail = (
      code: ChatThreadOpeningErrorCode,
      message: string,
      httpStatus?: number,
    ): ChatExistingThreadOpeningState => {
      if (httpStatus === 401 || httpStatus === 403 || httpStatus === 404) {
        retainedThreadSubscriptions.get(threadConversationId)?.();
        retainedThreadSubscriptions.delete(threadConversationId);
        cache.dispatch({ type: "threads/discard-history", threadId: threadConversationId });
      }
      const failure: ChatExistingThreadOpeningState = Object.freeze({
        state: "error", threadConversationId, code, message,
        ...(httpStatus === undefined ? {} : { httpStatus }),
      });
      setExistingThreadOpeningState(failure);
      return failure;
    };
    if (typeof threadConversationId !== "string" || threadConversationId.trim().length === 0 ||
        threadConversationId !== threadConversationId.trim()) {
      return Promise.resolve(fail("snapshot_failed", "The thread is unavailable."));
    }
    const controller = new AbortController();
    const generation = threadOpeningGeneration;
    const isClosed = () => controller.signal.aborted || generation !== threadOpeningGeneration;
    const currentState = () => existingThreadOpeningStates.get(threadConversationId) ??
      idleExistingThreadOpeningState(threadConversationId);
    // Revalidate even a previously ready thread: cached history is not access authority.
    const reconcileLifecycle = threadLifecycleRuntime?.beginAuthorizedOpening(threadConversationId);
    setExistingThreadOpeningState(Object.freeze({ state: "loading", threadConversationId }));
    const opening = (async (): Promise<ChatExistingThreadOpeningState> => {
      const detail = await threadSnapshotReader.getConversation<Feature>(
        { conversationId: threadConversationId }, { signal: controller.signal },
      );
      if (isClosed()) return currentState();
      if (detail.status !== "success") {
        return fail("snapshot_failed", "The thread could not be loaded.",
          "httpStatus" in detail ? detail.httpStatus : undefined);
      }
      const thread = detail.value.conversation;
      if (thread.type !== "thread" || thread.id !== threadConversationId) {
        return fail("snapshot_failed", "The requested conversation is not a thread.");
      }
      const { parentConversationId, rootMessageId } = thread;
      const page = await threadSnapshotReader.getMessageTimeline({
        conversationId: threadConversationId, direction: "backward", limit: 50,
      }, { signal: controller.signal });
      if (isClosed()) return currentState();
      if (page.status !== "success") {
        return fail("snapshot_failed", "The thread message snapshot could not be loaded.",
          "httpStatus" in page ? page.httpStatus : undefined);
      }
      // A root is context, not a prerequisite for reading authorized thread history.
      // Read at most one bounded parent page and never reuse cached source content.
      const cachedRoot = cache.getState().entities.messages[rootMessageId];
      const sequence = cachedRoot?.conversationId === parentConversationId ? cachedRoot.sequence :
        threadRootSequences.get(rootMessageId);
      const rootPage = await threadSnapshotReader.getMessageTimeline({
        conversationId: parentConversationId,
        direction: sequence === undefined ? "backward" : "forward",
        ...(sequence === undefined ? {} : { cursor: sequence - 1 }),
        limit: sequence === undefined ? 50 : 1,
      }, { signal: controller.signal });
      if (isClosed()) return currentState();
      if (rootPage.status !== "success" && "httpStatus" in rootPage &&
          (rootPage.httpStatus === 401 || rootPage.httpStatus === 403 || rootPage.httpStatus === 404)) {
        return fail("snapshot_failed", "The thread is no longer accessible.", rootPage.httpStatus);
      }

      let releaseSubscription: (() => void) | undefined;
      try {
        if (realtimeSession !== undefined && !retainedThreadSubscriptions.has(threadConversationId)) {
          releaseSubscription = realtimeSession.subscribeConversation(threadConversationId);
        }
      } catch {
        return fail("subscription_failed", "The thread realtime subscription could not be established.");
      }
      if (isClosed()) {
        releaseSubscription?.();
        return currentState();
      }
      try {
        cache.dispatch({
          type: "threads/hydrate-existing",
          snapshot: detail.value as ConversationDetailSnapshot,
          page: page.value,
          ...(rootPage.status === "success" ? { rootPage: rootPage.value } : {}),
        });
      } catch {
        releaseSubscription?.();
        return fail("cache_reconciliation_failed", "The canonical thread state could not be reconciled.");
      }
      if (isClosed()) {
        releaseSubscription?.();
        return currentState();
      }
      if (releaseSubscription !== undefined) {
        retainedThreadSubscriptions.set(threadConversationId, releaseSubscription);
      }
      reconcileLifecycle?.(parentConversationId);
      const root = cache.getState().entities.messages[rootMessageId];
      if (root !== undefined) threadRootSequences.set(rootMessageId, root.sequence);
      const ready: ChatExistingThreadOpeningState = Object.freeze({
        state: "ready", threadConversationId, parentConversationId, rootMessageId,
        rootContext: root === undefined ? "unavailable" : root.deletedAt === undefined ? "available" : "deleted",
        ...(thread.name === undefined ? {} : { name: thread.name }),
      });
      setExistingThreadOpeningState(ready);
      return ready;
    })().catch(() => isClosed() ? currentState() :
      fail("snapshot_failed", "The thread could not be loaded."));
    const tracked = opening.finally(() => {
      if (activeExistingThreadOpenings.get(threadConversationId)?.promise === tracked) {
        activeExistingThreadOpenings.delete(threadConversationId);
      }
    });
    activeExistingThreadOpenings.set(threadConversationId, { controller, promise: tracked });
    return tracked;
  };

  interface DurableLogicalSend {
    readonly queue: OfflineSendMessageQueue;
    readonly intent: OfflineSendMessageIntent;
    readonly identity: ApplicationChatStorageIdentity;
    readonly generation: number;
    /** Present for work that is valid only during one cross-tab ownership epoch. */
    readonly recoveryEpoch?: number;
  }

  const durableSendScopeIsActive = (
    pending: DurableLogicalSend,
  ): boolean => pending.generation === persistenceGeneration &&
    pending.queue === activeSendMessageQueue &&
    storageIdentitiesEqual(pending.identity, activePersistenceIdentity) &&
    (pending.recoveryEpoch === undefined ||
      (pending.recoveryEpoch === retainedSendRecoveryEpoch &&
        ownsRetainedSendRecovery()));

  const intentIsExact = (
    candidate: OfflineSendMessageIntent,
    expected: OfflineSendMessageIntent,
  ): boolean => candidate.enqueueOrder === expected.enqueueOrder &&
    candidate.enqueuedAt === expected.enqueuedAt &&
    candidate.clientMessageId === expected.clientMessageId &&
    candidate.idempotencyKey === expected.idempotencyKey &&
    storageIdentitiesEqual(candidate.identity, expected.identity);

  const durableIntentIsCurrent = (pending: DurableLogicalSend): boolean =>
    durableSendScopeIsActive(pending) &&
    pending.queue.getState().intents.some((candidate) =>
      intentIsExact(candidate, pending.intent));

  const settleDurableIntent = (
    pending: DurableLogicalSend,
  ): Promise<boolean> => serializeSendMessageQueueMutation(pending.queue, async () => {
    if (!durableSendScopeIsActive(pending)) return false;
    await pending.queue.reload();
    if (!durableIntentIsCurrent(pending)) return false;
    return pending.queue.cancel(pending.intent.clientMessageId);
  });

  const isRetainedReplyCapabilityFailure = (
    status: ChatCommandResult<unknown>["status"],
    input: SendMessageInput,
  ): boolean => input.replyTo !== undefined &&
    (status === "unsupported" || status === "feature_disabled");

  const isTerminalDurableSendResult = (
    status: ChatCommandResult<unknown>["status"],
    input: SendMessageInput,
  ): boolean => !isRetainedReplyCapabilityFailure(status, input) && (status === "validation" ||
    status === "authentication" ||
    status === "conflict" ||
    status === "feature_disabled" ||
    status === "unsupported" ||
    status === "rejected");

  const restoreRetainedReplyProjection = (pending: DurableLogicalSend): void => {
    const input = pending.intent.request;
    if (input.replyTo === undefined || logicalSends.has(input.clientMessageId)) return;
    const state = cache.getState();
    if (state.identity === null ||
      state.identity.tenantId !== pending.identity.tenantId ||
      state.identity.userId !== pending.identity.userId) return;
    // Canonical checkpoints exclude optimistic rows. Recreate the retained
    // reply from its frozen request so failures expose the existing retry action.
    const attachments = (input.content.attachments ?? []).flatMap(({ attachmentId }) => {
      const attachment = state.entities.attachments[attachmentId];
      return attachment === undefined ? [] : [attachment];
    });
    cache.insertOptimisticMessage(createOptimisticSendProjection(input, state.identity, attachments));
    logicalSends.set(input.clientMessageId, input);
  };

  type DurableSendAttemptOutcome = Readonly<{
    source: "http" | "realtime";
    result: ChatSendMessageResult;
  }>;

  interface ActiveDurableSendAttempt {
    readonly pending: DurableLogicalSend;
    readonly controller: AbortController;
    readonly resolve: (outcome: DurableSendAttemptOutcome) => void;
    winner: DurableSendAttemptOutcome["source"] | undefined;
  }

  interface DurableSendAttemptWaiter {
    readonly pending: DurableLogicalSend;
    readonly resolve: (result: ChatSendMessageResult) => void;
  }

  const activeDurableSendAttempts = new Map<string, ActiveDurableSendAttempt>();
  const durableSendAttemptWaiters = new Map<string, Set<DurableSendAttemptWaiter>>();

  const messageCreatedResult = (
    event: ChatEvent,
    intent: OfflineSendMessageIntent,
  ): ChatSendMessageResult | undefined => {
    if (event.type !== "message.created" || !isRecord(event.payload)) return undefined;
    const message = event.payload.message;
    if (
      event.payload.clientMessageId !== intent.clientMessageId ||
      !isRecord(message) ||
      message.tenantId !== intent.identity.tenantId ||
      message.conversationId !== intent.conversationId ||
      !isRecord(message.author) ||
      message.author.type !== "user" ||
      message.author.userId !== intent.identity.userId ||
      !isRecord(message.revision) ||
      !Number.isSafeInteger(message.revision.revision) ||
      (message.revision.revision as number) < 1
    ) return undefined;
    return Object.freeze({
      status: "success",
      value: Object.freeze({
        operation: "send",
        reconciliationStatus: "replayed",
        clientMessageId: intent.clientMessageId,
        message,
        canonicalRevision: message.revision.revision,
      }) as unknown as SendMessageResult,
    });
  };

  const waitForDurableSendAttempt = <Block extends MessageBlock>(
    pending: DurableLogicalSend,
  ): Promise<ChatSendMessageResult<Block>> => new Promise((resolve) => {
    const waiter: DurableSendAttemptWaiter = {
      pending,
      resolve: resolve as (result: ChatSendMessageResult) => void,
    };
    const waiters = durableSendAttemptWaiters.get(pending.intent.clientMessageId) ??
      new Set<DurableSendAttemptWaiter>();
    waiters.add(waiter);
    durableSendAttemptWaiters.set(pending.intent.clientMessageId, waiters);
  });

  const resolveDurableSendAttemptWaiters = (
    pending: DurableLogicalSend,
    result: ChatSendMessageResult,
  ): void => {
    const clientMessageId = pending.intent.clientMessageId;
    const waiters = durableSendAttemptWaiters.get(clientMessageId);
    if (waiters === undefined) return;
    for (const waiter of [...waiters]) {
      if (!intentIsExact(waiter.pending.intent, pending.intent) ||
        waiter.pending.queue !== pending.queue ||
        waiter.pending.generation !== pending.generation) continue;
      waiters.delete(waiter);
      waiter.resolve(result);
    }
    if (waiters.size === 0) durableSendAttemptWaiters.delete(clientMessageId);
  };

  const closeDurableSendAttemptWaiters = (): void => {
    for (const waiters of durableSendAttemptWaiters.values()) {
      for (const waiter of waiters) waiter.resolve(PREFERENCE_CLOSED_RESULT);
    }
    durableSendAttemptWaiters.clear();
  };

  const executeLogicalSend = async <Block extends MessageBlock>(
    input: SendMessageInput<Block>,
    durable?: DurableLogicalSend,
  ): Promise<ChatSendMessageResult<Block>> => {
    let activeAttempt: ActiveDurableSendAttempt | undefined;
    let outcomePromise: Promise<DurableSendAttemptOutcome> | undefined;
    if (durable !== undefined) {
      if (!durableIntentIsCurrent(durable)) return PREFERENCE_CLOSED_RESULT;
      restoreRetainedReplyProjection(durable);
      let resolveOutcome!: (outcome: DurableSendAttemptOutcome) => void;
      outcomePromise = new Promise((resolve) => {
        resolveOutcome = resolve;
      });
      activeAttempt = {
        pending: durable,
        controller: new AbortController(),
        resolve: resolveOutcome,
        winner: undefined,
      };
      activeDurableSendAttempts.set(input.clientMessageId, activeAttempt);
    }
    const dispatchPromise = client.dispatch(
      createSendMessageDescriptor<Block>(),
      input,
      {
        idempotencyKey: input.idempotencyKey,
        ...(activeAttempt === undefined ? {} : { signal: activeAttempt.controller.signal }),
      },
    );
    let result: ChatSendMessageResult<Block>;
    if (activeAttempt === undefined || outcomePromise === undefined) {
      result = await dispatchPromise;
    } else {
      void dispatchPromise.then((httpResult) => {
        if (activeAttempt?.winner !== undefined) return;
        activeAttempt.winner = "http";
        activeAttempt.resolve(Object.freeze({
          source: "http",
          result: httpResult as ChatSendMessageResult,
        }));
      });
      const outcome = await outcomePromise;
      result = outcome.result as ChatSendMessageResult<Block>;
    }
    if (durable !== undefined && !durableSendScopeIsActive(durable)) {
      if (activeAttempt !== undefined &&
        activeDurableSendAttempts.get(input.clientMessageId) === activeAttempt) {
        activeDurableSendAttempts.delete(input.clientMessageId);
      }
      return result;
    }
    try {
      if (result.status === "success") {
        if (result.value.clientMessageId !== input.clientMessageId) {
          cache.failOptimisticMessage(input.clientMessageId, "malformed_response", true);
          return SEND_MALFORMED_RESPONSE;
        }
        try {
          cache.reconcileOptimisticMessage(result.value);
        } catch {
          cache.failOptimisticMessage(input.clientMessageId, "malformed_response", true);
          return SEND_MALFORMED_RESPONSE;
        }
        if (durable === undefined || await settleDurableIntent(durable).catch(() => false)) {
          logicalSends.delete(input.clientMessageId);
        }
      } else {
        cache.failOptimisticMessage(
          input.clientMessageId,
          result.status,
          isRetryableSendFailure(result.status) ||
            (durable !== undefined && isRetainedReplyCapabilityFailure(result.status, input)),
        );
        if (
          durable !== undefined &&
          isTerminalDurableSendResult(result.status, input) &&
          await settleDurableIntent(durable).catch(() => false)
        ) logicalSends.delete(input.clientMessageId);
      }
      return result;
    } finally {
      if (activeAttempt !== undefined &&
        activeDurableSendAttempts.get(input.clientMessageId) === activeAttempt) {
        activeDurableSendAttempts.delete(input.clientMessageId);
      }
    }
  };

  let retainedSendPump: Promise<void> | undefined;
  let retainedSendRetryController: AbortController | undefined;
  let retainedSendRecoveryRequested = false;

  const retainedSendRecoveryPermitted = (): boolean => {
    const queue = activeSendMessageQueue;
    const identity = activePersistenceIdentity;
    return lifecycleState.state === "ready" &&
      queue !== undefined &&
      identity !== undefined &&
      queue.getState().isHydrated &&
      storageIdentitiesEqual(queue.getState().identity ?? undefined, identity) &&
      ownsRetainedSendRecovery() &&
      (realtimeSession === undefined || realtimeSession.state.state === "connected");
  };

  const retainedSendDelay = (retryNumber: number): number => Math.min(
    retainedSendMaximumDelayMs,
    Math.max(
      0,
      Math.round(retainedSendInitialDelayMs *
        retainedSendRetryMultiplier ** Math.max(0, retryNumber - 1)),
    ),
  );

  const waitForRetainedSendRetry = (
    delayMs: number,
    signal: AbortSignal,
  ): Promise<void> => {
    if (signal.aborted) return Promise.reject(ABORTED);
    return new Promise<void>((resolve, reject) => {
      const abort = () => {
        reject(ABORTED);
      };
      signal.addEventListener("abort", abort, { once: true });
      Promise.resolve()
        .then(() => retainedSendWait(delayMs, signal))
        .then(
          () => {
            signal.removeEventListener("abort", abort);
            resolve();
          },
          () => {
            signal.removeEventListener("abort", abort);
            reject(ABORTED);
          },
        );
    });
  };

  const runRetainedSendPump = async (epoch: number): Promise<void> => {
    let retryingIntent: OfflineSendMessageIntent | undefined;
    let retryNumber = 0;
    while (epoch === retainedSendRecoveryEpoch && retainedSendRecoveryPermitted()) {
      const queue = activeSendMessageQueue;
      const identity = activePersistenceIdentity;
      if (queue === undefined || identity === undefined) return;
      const intent = queue.getState().intents[0];
      if (intent === undefined) return;
      const pending: DurableLogicalSend = {
        queue,
        identity,
        generation: persistenceGeneration,
        intent,
        recoveryEpoch: epoch,
      };
      if (!durableIntentIsCurrent(pending)) return;
      if (activeDurableSendAttempts.has(intent.clientMessageId)) return;

      const result = await executeLogicalSend(intent.request, pending);
      resolveDurableSendAttemptWaiters(pending, result);
      if (epoch !== retainedSendRecoveryEpoch || !retainedSendRecoveryPermitted()) return;
      if (!durableIntentIsCurrent(pending)) {
        retryingIntent = undefined;
        retryNumber = 0;
        continue;
      }
      if (result.status === "success" || isTerminalDurableSendResult(result.status, intent.request)) {
        let removalRetry = 1;
        while (durableIntentIsCurrent(pending)) {
          const controller = new AbortController();
          retainedSendRetryController = controller;
          try {
            await waitForRetainedSendRetry(
              retainedSendDelay(removalRetry),
              controller.signal,
            );
          } catch {
            if (epoch !== retainedSendRecoveryEpoch ||
              !retainedSendRecoveryPermitted()) return;
          } finally {
            if (retainedSendRetryController === controller) {
              retainedSendRetryController = undefined;
            }
          }
          try {
            if (await settleDurableIntent(pending)) break;
          } catch {
            // Canonical settlement is already known; retry only the exact
            // durable removal and never redeliver the request.
          }
          removalRetry += 1;
        }
        retryingIntent = undefined;
        retryNumber = 0;
        continue;
      }
      if (!isRetryableSendFailure(result.status)) {
        return;
      }

      if (retryingIntent === undefined || !intentIsExact(retryingIntent, intent)) {
        retryingIntent = intent;
        retryNumber = 1;
      } else {
        retryNumber += 1;
      }
      const controller = new AbortController();
      retainedSendRetryController = controller;
      try {
        await waitForRetainedSendRetry(retainedSendDelay(retryNumber), controller.signal);
      } catch {
        if (epoch !== retainedSendRecoveryEpoch || !retainedSendRecoveryPermitted()) return;
      } finally {
        if (retainedSendRetryController === controller) {
          retainedSendRetryController = undefined;
        }
      }
    }
  };

  const startRetainedSendRecovery = (): void => {
    if (!retainedSendRecoveryPermitted() || retainedSendPump !== undefined) return;
    retainedSendRecoveryRequested = false;
    const epoch = retainedSendRecoveryEpoch;
    const pump = runRetainedSendPump(epoch).finally(() => {
      if (retainedSendPump !== pump) return;
      retainedSendPump = undefined;
      if (retainedSendRecoveryRequested && retainedSendRecoveryPermitted()) {
        queueMicrotask(startRetainedSendRecovery);
      }
    });
    retainedSendPump = pump;
  };

  requestRetainedSendRecovery = (): void => {
    retainedSendRecoveryRequested = true;
    startRetainedSendRecovery();
  };
  pauseRetainedSendRecovery = (): void => {
    retainedSendRecoveryEpoch += 1;
    retainedSendRecoveryRequested = false;
    retainedSendPump = undefined;
    retainedSendRetryController?.abort();
    retainedSendRetryController = undefined;
    for (const attempt of activeDurableSendAttempts.values()) {
      attempt.controller.abort();
    }
    activeDurableSendAttempts.clear();
  };
  stopRetainedSendRecovery = (): void => {
    pauseRetainedSendRecovery();
    closeDurableSendAttemptWaiters();
  };

  resumeRetainedSendRecoveryFromStorage = (): void => {
    const queue = activeSendMessageQueue;
    const identity = activePersistenceIdentity;
    const generation = persistenceGeneration;
    const ownershipEpoch = retainedSendRecoveryEpoch;
    if (
      queue === undefined ||
      identity === undefined ||
      !ownsRetainedSendRecovery()
    ) return;
    void serializeSendMessageQueueMutation(queue, async () => {
      if (
        generation !== persistenceGeneration ||
        ownershipEpoch !== retainedSendRecoveryEpoch ||
        queue !== activeSendMessageQueue ||
        !storageIdentitiesEqual(identity, activePersistenceIdentity) ||
        !ownsRetainedSendRecovery()
      ) return;
      await queue.reload();
    }).catch(() => undefined).finally(() => {
      if (
        generation === persistenceGeneration &&
        ownershipEpoch === retainedSendRecoveryEpoch &&
        queue === activeSendMessageQueue &&
        storageIdentitiesEqual(identity, activePersistenceIdentity) &&
        ownsRetainedSendRecovery()
      ) requestRetainedSendRecovery();
    });
  };

  handleRetainedSendCoordinatedResult = (command, idempotencyKey, value): void => {
    if (command !== "message.send") return;
    const result = parseCoordinatedCommandResult(
      createSendMessageDescriptor(),
      value,
    ) as ChatSendMessageResult | undefined;
    if (result === undefined) return;
    const queue = activeSendMessageQueue;
    const identity = activePersistenceIdentity;
    if (queue === undefined || identity === undefined) return;
    const intent = queue.getState().intents.find((candidate) =>
      candidate.idempotencyKey === idempotencyKey &&
      storageIdentitiesEqual(candidate.identity, identity));
    if (intent === undefined) return;
    const pending: DurableLogicalSend = {
      queue,
      identity,
      generation: persistenceGeneration,
      intent,
    };
    if (!durableIntentIsCurrent(pending)) return;
    void (async () => {
      restoreRetainedReplyProjection(pending);
      if (result.status === "success") {
        if (result.value.clientMessageId !== intent.clientMessageId) return;
        try {
          cache.reconcileOptimisticMessage(result.value);
        } catch {
          return;
        }
        logicalSends.delete(intent.clientMessageId);
      } else {
        cache.failOptimisticMessage(
          intent.clientMessageId,
          result.status,
          isRetryableSendFailure(result.status) ||
            isRetainedReplyCapabilityFailure(result.status, intent.request),
        );
        if (isTerminalDurableSendResult(result.status, intent.request)) {
          logicalSends.delete(intent.clientMessageId);
        }
      }
      resolveDurableSendAttemptWaiters(pending, result);
    })().catch(() => undefined);
  };

  handleRetainedSendCanonicalEvent = (event: ChatEvent): void => {
    if (event.type !== "message.created") return;
    const queue = activeSendMessageQueue;
    const identity = activePersistenceIdentity;
    if (queue === undefined || identity === undefined) return;
    const intent = queue.getState().intents.find((candidate) =>
      messageCreatedResult(event, candidate) !== undefined &&
      storageIdentitiesEqual(candidate.identity, identity));
    if (intent === undefined) return;
    const pending: DurableLogicalSend = {
      queue,
      identity,
      generation: persistenceGeneration,
      intent,
    };
    if (!durableIntentIsCurrent(pending)) return;
    const result = messageCreatedResult(event, intent);
    if (result === undefined) return;
    const active = activeDurableSendAttempts.get(intent.clientMessageId);
    if (active !== undefined && active.winner === undefined &&
      active.pending.queue === queue &&
      active.pending.generation === pending.generation &&
      intentIsExact(active.pending.intent, intent)) {
      active.winner = "realtime";
      active.controller.abort();
      active.resolve(Object.freeze({ source: "realtime", result }));
      return;
    }
    resolveDurableSendAttemptWaiters(pending, result);
    void settleDurableIntent(pending).then((removed) => {
      if (!removed) return;
      logicalSends.delete(intent.clientMessageId);
      requestRetainedSendRecovery();
    }).catch(() => undefined);
  };

  const createOptimisticSendProjection = <Block extends MessageBlock>(
    input: SendMessageInput<Block>,
    identity: ChatCacheIdentity,
    attachmentMetadata: readonly MessageAttachmentMetadata[],
  ): OptimisticMessageProjection => {
    const state = cache.getState();
    const sequence = Object.values(state.entities.messages).reduce(
      (latest, message) =>
        message.conversationId === input.conversationId
          ? Math.max(latest, message.sequence)
          : latest,
      state.metadata.conversations[input.conversationId]?.latestSequence ?? 0,
    ) + 1;
    const occurredAt = new Date(optimisticNow()).toISOString() as IsoTimestamp;
    return Object.freeze({
      id: `optimistic:${input.clientMessageId}` as MessageId,
      tenantId: identity.tenantId,
      conversationId: input.conversationId,
      author: Object.freeze({ type: "user" as const, userId: identity.userId }),
      sequence: sequence as MessageSequence,
      createdAt: occurredAt,
      updatedAt: occurredAt,
      revision: Object.freeze({ revision: 1 }),
      content: input.content,
      ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
      isThreadRoot: false as const,
      reactions: Object.freeze([]),
      attachmentMetadata: Object.freeze([...attachmentMetadata]),
      delivery: Object.freeze({
        state: "sending" as const,
        clientMessageId: input.clientMessageId,
        idempotencyKey: input.idempotencyKey,
        retryable: false,
        attempt: 1,
      }),
    });
  };

  const beginLogicalSend = <Block extends MessageBlock>(
    authored: ChatSendMessageInput<Block>,
  ): Promise<ChatSendMessageResult<Block>> => {
    let input: SendMessageInput<Block>;
    let identity: ChatCacheIdentity;
    let attachmentMetadata: readonly MessageAttachmentMetadata[];
    try {
      input = freezeLogicalSend(parseSendMessageInput<Block>({
        operation: "send",
        conversationId: authored.conversationId,
        clientMessageId: generateClientMessageId(),
        idempotencyKey: generateSendIdempotencyKey(),
        content: authored.content,
        ...(authored.replyTo === undefined ? {} : { replyTo: authored.replyTo }),
      }));
      const cacheIdentity = cache.getState().identity;
      if (cacheIdentity === null) return Promise.resolve(SEND_VALIDATION_FAILURE);
      identity = cacheIdentity;
      const state = cache.getState();
      const references = input.content.attachments ?? [];
      const metadata = references.map(
        ({ attachmentId }) => state.entities.attachments[attachmentId],
      );
      const finalizedAttachmentIds = new Set(
        Object.values(state.attachmentUploads)
          .filter((upload) => upload.status === "finalized")
          .map((upload) => upload.attachment?.attachmentId),
      );
      if (
        metadata.some((attachment) => attachment === undefined) ||
        references.some(({ attachmentId }) => !finalizedAttachmentIds.has(attachmentId))
      ) {
        return Promise.resolve(SEND_VALIDATION_FAILURE);
      }
      attachmentMetadata = metadata as MessageAttachmentMetadata[];
    } catch {
      return Promise.resolve(SEND_VALIDATION_FAILURE);
    }

    if (normalizedCachePersistence === undefined) {
      try {
        cache.insertOptimisticMessage(
          createOptimisticSendProjection(input, identity, attachmentMetadata),
        );
        logicalSends.set(input.clientMessageId, input as SendMessageInput);
      } catch {
        return Promise.resolve(SEND_VALIDATION_FAILURE);
      }
      return executeLogicalSend(input);
    }

    const queue = activeSendMessageQueue;
    const storageIdentity = activePersistenceIdentity;
    const generation = persistenceGeneration;
    if (
      queue === undefined ||
      storageIdentity === undefined ||
      identity.tenantId !== storageIdentity.tenantId ||
      identity.userId !== storageIdentity.userId
    ) return Promise.resolve(SEND_VALIDATION_FAILURE);

    return (async (): Promise<ChatSendMessageResult<Block>> => {
      let intent: OfflineSendMessageIntent;
      try {
        intent = await serializeSendMessageQueueMutation(queue, async () => {
          if (
            generation !== persistenceGeneration ||
            queue !== activeSendMessageQueue ||
            !storageIdentitiesEqual(storageIdentity, activePersistenceIdentity)
          ) throw new Error("inactive durable send scope");
          await queue.reload();
          if (
            generation !== persistenceGeneration ||
            queue !== activeSendMessageQueue ||
            !storageIdentitiesEqual(storageIdentity, activePersistenceIdentity)
          ) throw new Error("inactive durable send scope");
          return queue.enqueue(input);
        });
      } catch {
        return SEND_VALIDATION_FAILURE;
      }
      const pending: DurableLogicalSend = {
        queue,
        intent,
        identity: storageIdentity,
        generation,
      };
      const mayDispatch = await serializeSendMessageQueueMutation(queue, async () =>
        durableIntentIsCurrent(pending));
      if (!mayDispatch) return PREFERENCE_CLOSED_RESULT;

      const queuedInput = intent.request as SendMessageInput<Block>;
      try {
        cache.insertOptimisticMessage(
          createOptimisticSendProjection(
            queuedInput,
            identity,
            attachmentMetadata,
          ),
        );
        logicalSends.set(queuedInput.clientMessageId, queuedInput as SendMessageInput);
      } catch {
        await settleDurableIntent(pending).catch(() => false);
        return SEND_VALIDATION_FAILURE;
      }
      const result = waitForDurableSendAttempt<Block>(pending);
      coordinator?.announcePersistedCommand("message.send", intent.idempotencyKey);
      requestRetainedSendRecovery();
      return result;
    })();
  };

  const retryLogicalSend = <Block extends MessageBlock>(
    clientMessageId: string,
  ): Promise<ChatSendMessageResult<Block>> => {
    const input = logicalSends.get(clientMessageId) as
      | SendMessageInput<Block>
      | undefined;
    const projection = Object.values(cache.getState().entities.messages).find(
      (message): message is OptimisticMessageProjection =>
        "delivery" in message &&
        message.delivery.clientMessageId === clientMessageId,
    );
    if (
      input === undefined ||
      projection === undefined ||
      projection.delivery.state !== "failed" ||
      !projection.delivery.retryable
    ) {
      return Promise.resolve(SEND_VALIDATION_FAILURE);
    }
    const finalizedAttachmentIds = new Set(
      Object.values(cache.getState().attachmentUploads)
        .filter((upload) => upload.status === "finalized")
        .map((upload) => upload.attachment?.attachmentId),
    );
    if (
      (input.content.attachments ?? []).some(
        ({ attachmentId }) => !finalizedAttachmentIds.has(attachmentId),
      )
    ) return Promise.resolve(SEND_VALIDATION_FAILURE);
    cache.insertOptimisticMessage(Object.freeze({
      ...projection,
      delivery: Object.freeze({
        state: "sending" as const,
        clientMessageId,
        idempotencyKey: input.idempotencyKey,
        retryable: false,
        attempt: projection.delivery.attempt + 1,
      }),
    }));
    if (normalizedCachePersistence === undefined) return executeLogicalSend(input);
    const queue = activeSendMessageQueue;
    const identity = activePersistenceIdentity;
    const generation = persistenceGeneration;
    if (queue === undefined || identity === undefined) {
      return Promise.resolve(SEND_VALIDATION_FAILURE);
    }
    const intent = queue.getState().intents.find((candidate) =>
      candidate.clientMessageId === input.clientMessageId &&
      candidate.idempotencyKey === input.idempotencyKey &&
      storageIdentitiesEqual(candidate.identity, identity));
    if (intent === undefined) return Promise.resolve(SEND_VALIDATION_FAILURE);
    const pending = { queue, identity, generation, intent };
    const result = waitForDurableSendAttempt<Block>(pending);
    retainedSendRetryController?.abort();
    requestRetainedSendRecovery();
    return result;
  };

  const forwardFailureIsAmbiguous = (
    status: ChatCommandResult<unknown>["status"],
  ): status is "transport" | "malformed_response" =>
    status === "transport" || status === "malformed_response";

  const clearForwardState = (abortActive: boolean): void => {
    ++forwardGeneration;
    if (abortActive) {
      for (const controller of activeForwardControllers) controller.abort();
    }
    activeForwardControllers.clear();
    forwardInputs.clear();
    forwardQueues.clear();
    forwardSettled.clear();
  };

  cache.subscribePrivateStateBoundary(() => clearForwardState(true));

  const enqueueVolatileForwardMessage = <Block extends MessageBlock>(
    logicalKey: string,
    pending: {
      readonly input: ForwardMessageInput;
      readonly identity: ChatCacheIdentity;
      readonly generation: number;
    },
  ): Promise<ChatForwardMessageResult<Block>> => {
    const correlationKey = pending.input.clientCorrelationId;
    const identityStillMatches = (): boolean => {
      const current = cache.getState().identity;
      return current !== null &&
        current.tenantId === pending.identity.tenantId &&
        current.userId === pending.identity.userId &&
        current.sessionId === pending.identity.sessionId;
    };
    const execute = async (): Promise<ChatForwardMessageResult> => {
      const settled = forwardSettled.get(correlationKey);
      if (settled !== undefined) return settled;
      if (
        pending.generation !== forwardGeneration ||
        !identityStillMatches() ||
        forwardInputs.get(logicalKey) !== pending
      ) {
        return PREFERENCE_CLOSED_RESULT;
      }

      const controller = new AbortController();
      activeForwardControllers.add(controller);
      let result: ChatForwardMessageResult;
      try {
        result = await client.dispatch(
          createForwardMessageDescriptor(pending.input),
          pending.input,
          {
            idempotencyKey: pending.input.idempotencyKey,
            coordinationKey: `forward:${stableLogicalHash(logicalKey)}`,
            signal: controller.signal,
          },
        );
      } finally {
        activeForwardControllers.delete(controller);
      }
      if (
        pending.generation !== forwardGeneration ||
        !identityStillMatches()
      ) {
        return result;
      }
      if (result.status === "success") {
        try {
          cache.reconcileAuthoritativeMessageCreated(
            result.value.message,
            result.value.clientCorrelationId,
          );
        } catch {
          // The authoritative result remains valid even when a missing cache
          // prerequisite requires a later snapshot or durable-event recovery.
        }
        if (forwardInputs.get(logicalKey) === pending) {
          forwardInputs.delete(logicalKey);
        }
        forwardSettled.set(correlationKey, result);
      } else if (!forwardFailureIsAmbiguous(result.status)) {
        if (forwardInputs.get(logicalKey) === pending) {
          forwardInputs.delete(logicalKey);
        }
        forwardSettled.set(correlationKey, result);
      }
      return result;
    };

    const previous = forwardQueues.get(correlationKey);
    const promise = previous === undefined
      ? Promise.resolve().then(execute)
      : previous.then(execute, execute);
    const tracked = promise.finally(() => {
      if (forwardQueues.get(correlationKey) === tracked) {
        forwardQueues.delete(correlationKey);
        forwardSettled.delete(correlationKey);
      }
    });
    forwardQueues.set(correlationKey, tracked);
    return tracked as Promise<ChatForwardMessageResult<Block>>;
  };

  const beginVolatileForwardMessage = <Block extends MessageBlock>(
    authored: ChatForwardMessageInput,
  ): Promise<ChatForwardMessageResult<Block>> => {
    try {
      if (!isRecord(authored)) throw new TypeError("forward-message input required");
      const validation = parseForwardMessageInput({
        ...authored,
        operation: "forward_message.v1",
        clientCorrelationId: "forward-validation",
        idempotencyKey: "forward-validation",
      });
      const logicalKey = JSON.stringify([
        validation.sourceMessageId,
        validation.destinationConversationId,
      ]);
      const state = cache.getState();
      if (state.identity === null) throw new TypeError("forward-message identity required");
      let pending = forwardInputs.get(logicalKey);
      if (pending === undefined) {
        pending = Object.freeze({
          input: parseForwardMessageInput({
            ...authored,
            operation: "forward_message.v1",
            clientCorrelationId: generateForwardClientCorrelationId(),
            idempotencyKey: generateForwardIdempotencyKey(),
          }),
          identity: state.identity,
          generation: forwardGeneration,
        });
        forwardInputs.set(logicalKey, pending);
      }
      return enqueueVolatileForwardMessage<Block>(logicalKey, pending);
    } catch {
      return Promise.resolve(SEND_VALIDATION_FAILURE);
    }
  };

  interface DurableEditScope {
    readonly generation: number;
    readonly epoch: number;
    readonly identity: ApplicationChatStorageIdentity;
  }

  let messageMutationChain: Promise<void> = Promise.resolve();
  let retainedEditRecoveryEpoch = 0;
  let retainedEditPump: Promise<void> | undefined;
  const activeEditControllers = new Map<string, AbortController>();
  const editResultWaiters = new Map<
    string,
    Set<(result: ChatEditMessageResult) => void>
  >();

  const serializeMessageMutation = <Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> => {
    const result = messageMutationChain.then(operation);
    messageMutationChain = result.then(() => undefined, () => undefined);
    return result;
  };

  const editScopeIsActive = (scope: DurableEditScope): boolean => {
    const cacheIdentity = cache.getState().identity;
    return scope.epoch === retainedEditRecoveryEpoch &&
      persistenceScopeIsActive(scope.generation, scope.identity) &&
      cacheIdentity !== null &&
      cacheIdentity.tenantId === scope.identity.tenantId &&
      cacheIdentity.userId === scope.identity.userId;
  };

  const currentEditScope = (): DurableEditScope | undefined =>
    activePersistenceIdentity === undefined
      ? undefined
      : Object.freeze({
          generation: persistenceGeneration,
          epoch: retainedEditRecoveryEpoch,
          identity: activePersistenceIdentity,
        });

  const mutationRecordEdits = (
    record: ApplicationChatQueuedMessageMutationIntentsRecord | null,
  ): readonly DurableEditIntent[] => Object.freeze(
    (record?.intents ?? []).filter(
      (intent): intent is DurableEditIntent => intent.request.operation === "edit",
    ),
  );

  const mutationRecordDeletes = (
    record: ApplicationChatQueuedMessageMutationIntentsRecord | null,
  ): readonly DurableDeleteIntent[] => Object.freeze(
    (record?.intents ?? []).filter(
      (intent): intent is DurableDeleteIntent =>
        intent.request.operation === "soft_delete",
    ),
  );

  const mutationRecordReactions = (
    record: ApplicationChatQueuedMessageMutationIntentsRecord | null,
  ): readonly DurableReactionIntent[] => Object.freeze(
    (record?.intents ?? []).filter(
      (intent): intent is DurableReactionIntent =>
        intent.request.operation === "add_reaction" ||
        intent.request.operation === "remove_reaction",
    ),
  );

  const mutationRecordForwards = (
    record: ApplicationChatQueuedMessageMutationIntentsRecord | null,
  ): readonly DurableForwardIntent[] => Object.freeze(
    (record?.intents ?? []).filter(
      (intent): intent is DurableForwardIntent =>
        intent.request.operation === "forward_message.v1",
    ),
  );

  const sameEditRequest = (
    left: EditMessageInput,
    right: EditMessageInput,
  ): boolean => left.messageId === right.messageId &&
    left.expectedRevision === right.expectedRevision &&
    left.idempotencyKey === right.idempotencyKey &&
    JSON.stringify(left.content) === JSON.stringify(right.content);

  const sameEditIntent = (
    left: DurableEditIntent,
    right: DurableEditIntent,
  ): boolean => left.enqueueOrder === right.enqueueOrder &&
    left.enqueuedAt === right.enqueuedAt &&
    sameEditRequest(left.request, right.request);

  const publishRetainedMessageMutations = (
    record: ApplicationChatQueuedMessageMutationIntentsRecord | null,
  ): void => {
    retainedEditIntents = mutationRecordEdits(record);
    retainedDeleteIntents = mutationRecordDeletes(record);
    retainedReactionIntents = mutationRecordReactions(record);
    retainedForwardIntents = mutationRecordForwards(record);
  };

  const mutateMessageMutationRecord = async (
    scope: DurableEditScope,
    scopeIsActive: (scope: DurableEditScope) => boolean,
    updater: (
      current: ApplicationChatQueuedMessageMutationIntentsRecord | null,
    ) => ApplicationChatQueuedMessageMutationIntentsRecord | null,
  ): Promise<ApplicationChatQueuedMessageMutationIntentsRecord | null> => {
    if (!scopeIsActive(scope) || normalizedCachePersistence === undefined) {
      throw new Error("inactive durable message-mutation scope");
    }
    const committed = await normalizedCachePersistence.storage.mutate(
      scope.identity,
      ApplicationChatStorageRecordKind.queuedMessageMutationIntents,
      (current) => {
        if (!scopeIsActive(scope)) {
          throw new Error("inactive durable message-mutation scope");
        }
        return updater(current);
      },
    );
    if (!scopeIsActive(scope)) {
      throw new Error("inactive durable message-mutation scope");
    }
    publishRetainedMessageMutations(committed);
    return committed;
  };

  const settleMessageMutationIntent = async (
    scope: DurableEditScope,
    scopeIsActive: (scope: DurableEditScope) => boolean,
    matches: (candidate: ApplicationChatQueuedMessageMutationIntent) => boolean,
  ): Promise<boolean> => {
    if (!scopeIsActive(scope) || normalizedCachePersistence === undefined) return false;
    await mutateMessageMutationRecord(scope, scopeIsActive, (current) => {
      if (current === null) return null;
      const remaining = current.intents.filter((candidate) => !matches(candidate));
      if (remaining.length === current.intents.length) return current;
      return remaining.length === 0
        ? null
        : createApplicationChatQueuedMessageMutationIntentsRecord(
            scope.identity,
            remaining,
          );
    });
    return scopeIsActive(scope);
  };

  const readMutationRecord = async (
    scope: DurableEditScope,
    scopeIsActive: (scope: DurableEditScope) => boolean,
  ): Promise<ApplicationChatQueuedMessageMutationIntentsRecord | null> => {
    if (!scopeIsActive(scope) || normalizedCachePersistence === undefined) {
      throw new Error("inactive durable message-mutation scope");
    }
    const record = await normalizedCachePersistence.storage.read(
      scope.identity,
      ApplicationChatStorageRecordKind.queuedMessageMutationIntents,
    );
    if (!scopeIsActive(scope)) {
      throw new Error("inactive durable message-mutation scope");
    }
    return record;
  };

  const reloadMutationRecord = (
    scope: DurableEditScope,
    scopeIsActive: (scope: DurableEditScope) => boolean,
  ): Promise<boolean> => serializeMessageMutation(async () => {
    try {
      const record = await readMutationRecord(scope, scopeIsActive);
      publishRetainedMessageMutations(record);
      return true;
    } catch (error) {
      if (!scopeIsActive(scope)) return false;
      if (error instanceof ApplicationChatStorageValidationError) {
        reportPersistenceDiagnostic(
          "message_mutation_intents_rejected",
          "The stored message-mutation intents were rejected and quarantined.",
        );
        publishRetainedMessageMutations(null);
      } else {
        reportPersistenceDiagnostic(
          "message_mutation_intents_read_failed",
          "The stored message-mutation intents could not be read.",
        );
      }
      return false;
    }
  });

  const persistEditIntent = (
    scope: DurableEditScope,
    input: EditMessageInput,
  ): Promise<DurableEditIntent | undefined> => serializeMessageMutation(async () => {
    try {
      const enqueuedAt = new Date().toISOString() as IsoTimestamp;
      const committed = await mutateMessageMutationRecord(
        scope,
        editScopeIsActive,
        (current) => {
          const enqueueOrder = (current?.intents.reduce(
            (highest, intent) => Math.max(highest, intent.enqueueOrder),
            0,
          ) ?? 0) + 1;
          const intent = createApplicationChatQueuedMessageMutationIntent(input, {
            enqueueOrder,
            enqueuedAt,
          }) as DurableEditIntent;
          return createApplicationChatQueuedMessageMutationIntentsRecord(
            scope.identity,
            [...(current?.intents ?? []), intent],
          );
        },
      );
      return mutationRecordEdits(committed).find((candidate) =>
        candidate.request.idempotencyKey === input.idempotencyKey &&
        sameEditRequest(candidate.request, input));
    } catch {
      if (editScopeIsActive(scope)) {
        reportPersistenceDiagnostic(
          "message_mutation_intents_write_failed",
          "The message edit could not be stored before dispatch.",
        );
      }
      return undefined;
    }
  });

  const removeEditIntent = (
    scope: DurableEditScope,
    intent: DurableEditIntent,
  ): Promise<boolean> => serializeMessageMutation(async () => {
    if (!editScopeIsActive(scope) || normalizedCachePersistence === undefined) return false;
    try {
      return await settleMessageMutationIntent(scope, editScopeIsActive, (candidate) =>
        candidate.request.operation === "edit" &&
        sameEditIntent(candidate as DurableEditIntent, intent));
    } catch {
      if (editScopeIsActive(scope)) {
        reportPersistenceDiagnostic(
          "message_mutation_intents_write_failed",
          "A settled message edit could not be removed from storage.",
        );
      }
      return false;
    }
  });

  const isTerminalMessageMutationResult = (
    status: ChatCommandResult<unknown>["status"],
  ): boolean => status === "validation" ||
    status === "authentication" ||
    status === "conflict" ||
    status === "feature_disabled" ||
    status === "unsupported" ||
    status === "rejected";

  const editResultMatches = (
    scope: DurableEditScope,
    intent: DurableEditIntent,
    result: EditMessageResult,
  ): boolean => result.expectedRevision === intent.request.expectedRevision &&
    result.message.id === intent.request.messageId &&
    result.message.tenantId === scope.identity.tenantId;

  const resolveEditWaiters = (
    idempotencyKey: string,
    result: ChatEditMessageResult,
  ): void => {
    const waiters = editResultWaiters.get(idempotencyKey);
    if (waiters === undefined) return;
    editResultWaiters.delete(idempotencyKey);
    for (const resolve of waiters) resolve(result);
  };

  const waitForCoordinatedEdit = (
    idempotencyKey: string,
  ): Promise<ChatEditMessageResult> => new Promise((resolve) => {
    const waiters = editResultWaiters.get(idempotencyKey) ?? new Set();
    waiters.add(resolve);
    editResultWaiters.set(idempotencyKey, waiters);
  });

  const settleEditResult = async (
    scope: DurableEditScope,
    intent: DurableEditIntent,
    result: ChatEditMessageResult,
  ): Promise<ChatEditMessageResult> => {
    if (!editScopeIsActive(scope)) return PREFERENCE_CLOSED_RESULT;
    if (result.status === "success") {
      if (!editResultMatches(scope, intent, result.value)) {
        return SEND_MALFORMED_RESPONSE;
      }
      try {
        cache.reconcileOptimisticMessageEdit(
          intent.request.idempotencyKey,
          result.value,
        );
      } catch {
        return SEND_MALFORMED_RESPONSE;
      }
      await removeEditIntent(scope, intent);
    } else if (isTerminalMessageMutationResult(result.status)) {
      cache.rollbackOptimisticMessageEdit(
        intent.request.messageId,
        intent.request.idempotencyKey,
      );
      await removeEditIntent(scope, intent);
    }
    return result;
  };

  const executeDurableEdit = async (
    scope: DurableEditScope,
    intent: DurableEditIntent,
  ): Promise<ChatEditMessageResult> => {
    const key = intent.request.idempotencyKey;
    const existing = activeEditControllers.get(key);
    if (existing !== undefined) return waitForCoordinatedEdit(key);
    if (!editScopeIsActive(scope)) return PREFERENCE_CLOSED_RESULT;
    const controller = new AbortController();
    activeEditControllers.set(key, controller);
    let result: ChatEditMessageResult;
    try {
      result = await client.dispatch(
        createEditMessageDescriptor(),
        intent.request,
        { idempotencyKey: key, signal: controller.signal },
      );
      result = await settleEditResult(scope, intent, result);
    } finally {
      if (activeEditControllers.get(key) === controller) {
        activeEditControllers.delete(key);
      }
    }
    resolveEditWaiters(key, result);
    return result;
  };

  const prepareRetainedEdit = (
    scope: DurableEditScope,
    intent: DurableEditIntent,
  ): "ready" | "await_canonical" | "inactive" => {
    if (!editScopeIsActive(scope)) return "inactive";
    const current = cache.getState().entities.messages[intent.request.messageId];
    if (current === undefined || "delivery" in current) return "await_canonical";
    if ("editState" in current) {
      return current.editState.state === "pending" &&
        current.editState.idempotencyKey === intent.request.idempotencyKey
        ? "ready"
        : "await_canonical";
    }
    if ("deleteState" in current) return "await_canonical";
    if (current.revision.revision < intent.request.expectedRevision) {
      return "await_canonical";
    }
    if (current.revision.revision === intent.request.expectedRevision) {
      try {
        cache.beginOptimisticMessageEdit(intent.request);
      } catch {
        return "await_canonical";
      }
    }
    return "ready";
  };

  const retainedEditRecoveryPermitted = (): boolean =>
    lifecycleState.state === "ready" &&
    currentEditScope() !== undefined &&
    ownsRetainedSendRecovery() &&
    (realtimeSession === undefined || realtimeSession.state.state === "connected");

  const runRetainedEditPump = async (epoch: number): Promise<void> => {
    while (epoch === retainedEditRecoveryEpoch && retainedEditRecoveryPermitted()) {
      const scope = currentEditScope();
      const intent = retainedEditIntents[0];
      if (scope === undefined || intent === undefined || scope.epoch !== epoch) return;
      const preparation = prepareRetainedEdit(scope, intent);
      if (preparation !== "ready") return;
      const result = await executeDurableEdit(scope, intent);
      if (scope.epoch !== retainedEditRecoveryEpoch || !editScopeIsActive(scope)) return;
      if (
        result.status === "transport" ||
        result.status === "malformed_response" ||
        result.status === "aborted" ||
        result.status === "closed"
      ) return;
      if (retainedEditIntents.some((candidate) => sameEditIntent(candidate, intent))) {
        return;
      }
    }
  };

  const startRetainedEditRecovery = (): void => {
    if (!retainedEditRecoveryPermitted() || retainedEditPump !== undefined) return;
    const epoch = retainedEditRecoveryEpoch;
    const pump = runRetainedEditPump(epoch).finally(() => {
      if (retainedEditPump === pump) retainedEditPump = undefined;
    });
    retainedEditPump = pump;
  };

  requestRetainedEditRecovery = (): void => startRetainedEditRecovery();

  pauseRetainedEditRecovery = (): void => {
    retainedEditRecoveryEpoch += 1;
    retainedEditPump = undefined;
    for (const controller of activeEditControllers.values()) controller.abort();
    activeEditControllers.clear();
  };

  activateRetainedEditRecovery = async (generation, identity): Promise<void> => {
    const scope = Object.freeze({
      generation,
      epoch: retainedEditRecoveryEpoch,
      identity,
    });
    await reloadMutationRecord(scope, editScopeIsActive);
  };

  reloadRetainedEditRecovery = (announcement): void => {
    if (announcement !== undefined && announcement.command !== "message.edit") return;
    const scope = currentEditScope();
    if (scope === undefined || !ownsRetainedSendRecovery()) return;
    void reloadMutationRecord(scope, editScopeIsActive).then((loaded) => {
      if (loaded && editScopeIsActive(scope) && ownsRetainedSendRecovery()) {
        requestRetainedMessageMutationRecovery();
      }
    });
  };

  handleRetainedEditCoordinatedResult = (command, idempotencyKey, value): void => {
    if (command !== "message.edit") return;
    const intent = retainedEditIntents.find(
      (candidate) => candidate.request.idempotencyKey === idempotencyKey,
    );
    const scope = currentEditScope();
    if (intent === undefined || scope === undefined) return;
    const result = parseCoordinatedCommandResult(
      createEditMessageDescriptor(),
      value,
    ) as ChatEditMessageResult | undefined;
    if (result === undefined) return;
    void settleEditResult(scope, intent, result).then((settled) => {
      if (!editScopeIsActive(scope)) return;
      resolveEditWaiters(idempotencyKey, settled);
      requestRetainedMessageMutationRecovery();
    });
  };

  handleRetainedEditCanonicalEvent = (event): void => {
    if (event.type !== "message.updated") {
      if (event.type === "message.created") requestRetainedMessageMutationRecovery();
      return;
    }
    const scope = currentEditScope();
    if (
      scope === undefined ||
      !isRecord(event.payload) ||
      !isRecord(event.payload.message) ||
      typeof event.payload.message.id !== "string"
    ) return;
    let matched = false;
    for (const intent of retainedEditIntents) {
      if (intent.request.messageId !== event.payload.message.id) continue;
      let value: EditMessageResult;
      try {
        value = parseEditMessageResult({
          operation: "edit",
          reconciliationStatus: "applied",
          expectedRevision: intent.request.expectedRevision,
          message: event.payload.message,
          canonicalRevision: intent.request.expectedRevision + 1,
        });
      } catch {
        continue;
      }
      if (
        !editResultMatches(scope, intent, value) ||
        value.message.content === null ||
        JSON.stringify(value.message.content) !== JSON.stringify(intent.request.content)
      ) continue;
      matched = true;
      const result: ChatEditMessageResult = Object.freeze({
        status: "success" as const,
        value,
      });
      resolveEditWaiters(intent.request.idempotencyKey, result);
      void removeEditIntent(scope, intent).then(() =>
        requestRetainedMessageMutationRecovery());
    }
    if (!matched) requestRetainedMessageMutationRecovery();
  };

  cache.subscribePrivateStateBoundary(() => {
    pauseRetainedEditRecovery();
    retainedEditIntents = Object.freeze([]);
    for (const waiters of editResultWaiters.values()) {
      for (const resolve of waiters) resolve(PREFERENCE_CLOSED_RESULT);
    }
    editResultWaiters.clear();
  });
  cache.subscribe(
    (state) => state.entities.messages,
    (messages, previous) => {
      if (retainedEditIntents.some((intent) => {
        const current = messages[intent.request.messageId];
        const prior = previous[intent.request.messageId];
        return current !== undefined &&
          !("delivery" in current) &&
          !("editState" in current) &&
          !("deleteState" in current) &&
          current.revision.revision === intent.request.expectedRevision &&
          (prior === undefined || prior.revision.revision !== current.revision.revision);
      })) requestRetainedMessageMutationRecovery();
    },
  );

  type DurableDeleteScope = DurableEditScope;

  let retainedDeleteRecoveryEpoch = 0;
  let retainedDeletePump: Promise<void> | undefined;
  const activeDeleteControllers = new Map<string, AbortController>();
  const deleteResultWaiters = new Map<
    string,
    Set<(result: ChatDeleteMessageResult) => void>
  >();

  const deleteScopeIsActive = (scope: DurableDeleteScope): boolean => {
    const cacheIdentity = cache.getState().identity;
    return scope.epoch === retainedDeleteRecoveryEpoch &&
      persistenceScopeIsActive(scope.generation, scope.identity) &&
      cacheIdentity !== null &&
      cacheIdentity.tenantId === scope.identity.tenantId &&
      cacheIdentity.userId === scope.identity.userId;
  };

  const currentDeleteScope = (): DurableDeleteScope | undefined =>
    activePersistenceIdentity === undefined
      ? undefined
      : Object.freeze({
          generation: persistenceGeneration,
          epoch: retainedDeleteRecoveryEpoch,
          identity: activePersistenceIdentity,
        });

  const sameDeleteRequest = (
    left: SoftDeleteMessageInput,
    right: SoftDeleteMessageInput,
  ): boolean => left.messageId === right.messageId &&
    left.expectedRevision === right.expectedRevision &&
    left.idempotencyKey === right.idempotencyKey;

  const sameDeleteIntent = (
    left: DurableDeleteIntent,
    right: DurableDeleteIntent,
  ): boolean => left.enqueueOrder === right.enqueueOrder &&
    left.enqueuedAt === right.enqueuedAt &&
    sameDeleteRequest(left.request, right.request);

  const persistDeleteIntent = (
    scope: DurableDeleteScope,
    input: SoftDeleteMessageInput,
  ): Promise<DurableDeleteIntent | undefined> => serializeMessageMutation(async () => {
    try {
      const enqueuedAt = new Date().toISOString() as IsoTimestamp;
      const committed = await mutateMessageMutationRecord(
        scope,
        deleteScopeIsActive,
        (current) => {
          const enqueueOrder = (current?.intents.reduce(
            (highest, intent) => Math.max(highest, intent.enqueueOrder),
            0,
          ) ?? 0) + 1;
          const intent = createApplicationChatQueuedMessageMutationIntent(input, {
            enqueueOrder,
            enqueuedAt,
          }) as DurableDeleteIntent;
          return createApplicationChatQueuedMessageMutationIntentsRecord(
            scope.identity,
            [...(current?.intents ?? []), intent],
          );
        },
      );
      return mutationRecordDeletes(committed).find((candidate) =>
        candidate.request.idempotencyKey === input.idempotencyKey &&
        sameDeleteRequest(candidate.request, input));
    } catch {
      if (deleteScopeIsActive(scope)) {
        reportPersistenceDiagnostic(
          "message_mutation_intents_write_failed",
          "The message deletion could not be stored before dispatch.",
        );
      }
      return undefined;
    }
  });

  const removeDeleteIntent = (
    scope: DurableDeleteScope,
    intent: DurableDeleteIntent,
  ): Promise<boolean> => serializeMessageMutation(async () => {
    if (!deleteScopeIsActive(scope) || normalizedCachePersistence === undefined) {
      return false;
    }
    try {
      return await settleMessageMutationIntent(scope, deleteScopeIsActive, (candidate) =>
        candidate.request.operation === "soft_delete" &&
        sameDeleteIntent(candidate as DurableDeleteIntent, intent));
    } catch {
      if (deleteScopeIsActive(scope)) {
        reportPersistenceDiagnostic(
          "message_mutation_intents_write_failed",
          "A settled message deletion could not be removed from storage.",
        );
      }
      return false;
    }
  });

  const deleteResultMatches = (
    scope: DurableDeleteScope,
    intent: DurableDeleteIntent,
    result: SoftDeleteMessageResult,
  ): boolean => result.expectedRevision === intent.request.expectedRevision &&
    result.message.id === intent.request.messageId &&
    result.message.tenantId === scope.identity.tenantId;

  const resolveDeleteWaiters = (
    idempotencyKey: string,
    result: ChatDeleteMessageResult,
  ): void => {
    const waiters = deleteResultWaiters.get(idempotencyKey);
    if (waiters === undefined) return;
    deleteResultWaiters.delete(idempotencyKey);
    for (const resolve of waiters) resolve(result);
  };

  const waitForCoordinatedDelete = (
    idempotencyKey: string,
  ): Promise<ChatDeleteMessageResult> => new Promise((resolve) => {
    const waiters = deleteResultWaiters.get(idempotencyKey) ?? new Set();
    waiters.add(resolve);
    deleteResultWaiters.set(idempotencyKey, waiters);
  });

  const settleDeleteResult = async (
    scope: DurableDeleteScope,
    intent: DurableDeleteIntent,
    result: ChatDeleteMessageResult,
  ): Promise<ChatDeleteMessageResult> => {
    if (!deleteScopeIsActive(scope)) return PREFERENCE_CLOSED_RESULT;
    if (result.status === "success") {
      if (!deleteResultMatches(scope, intent, result.value)) {
        return SEND_MALFORMED_RESPONSE;
      }
      try {
        cache.reconcileOptimisticMessageDelete(
          intent.request.idempotencyKey,
          result.value,
        );
      } catch {
        return SEND_MALFORMED_RESPONSE;
      }
      await removeDeleteIntent(scope, intent);
    } else if (isTerminalMessageMutationResult(result.status)) {
      cache.rollbackOptimisticMessageDelete(
        intent.request.messageId,
        intent.request.idempotencyKey,
      );
      await removeDeleteIntent(scope, intent);
    }
    return result;
  };

  const executeDurableDelete = async (
    scope: DurableDeleteScope,
    intent: DurableDeleteIntent,
  ): Promise<ChatDeleteMessageResult> => {
    const key = intent.request.idempotencyKey;
    const existing = activeDeleteControllers.get(key);
    if (existing !== undefined) return waitForCoordinatedDelete(key);
    if (!deleteScopeIsActive(scope)) return PREFERENCE_CLOSED_RESULT;
    const controller = new AbortController();
    activeDeleteControllers.set(key, controller);
    let result: ChatDeleteMessageResult;
    try {
      result = await client.dispatch(
        createDeleteMessageDescriptor(),
        intent.request,
        { idempotencyKey: key, signal: controller.signal },
      );
      result = await settleDeleteResult(scope, intent, result);
    } finally {
      if (activeDeleteControllers.get(key) === controller) {
        activeDeleteControllers.delete(key);
      }
    }
    resolveDeleteWaiters(key, result);
    return result;
  };

  const prepareRetainedDelete = (
    scope: DurableDeleteScope,
    intent: DurableDeleteIntent,
  ): "ready" | "settled" | "await_canonical" | "inactive" => {
    if (!deleteScopeIsActive(scope)) return "inactive";
    const current = cache.getState().entities.messages[intent.request.messageId];
    if (current === undefined || "delivery" in current) return "await_canonical";
    if ("deleteState" in current) {
      return current.deleteState.state === "pending" &&
        current.deleteState.idempotencyKey === intent.request.idempotencyKey
        ? "ready"
        : "await_canonical";
    }
    if ("editState" in current) return "await_canonical";
    if (
      current.content === null &&
      current.revision.revision > intent.request.expectedRevision
    ) return "settled";
    if (current.revision.revision < intent.request.expectedRevision) {
      return "await_canonical";
    }
    if (current.revision.revision === intent.request.expectedRevision) {
      try {
        cache.beginOptimisticMessageDelete(intent.request);
      } catch {
        return "await_canonical";
      }
    }
    return "ready";
  };

  const retainedDeleteRecoveryPermitted = (): boolean =>
    lifecycleState.state === "ready" &&
    currentDeleteScope() !== undefined &&
    ownsRetainedSendRecovery() &&
    (realtimeSession === undefined || realtimeSession.state.state === "connected");

  const runRetainedDeletePump = async (epoch: number): Promise<void> => {
    while (epoch === retainedDeleteRecoveryEpoch && retainedDeleteRecoveryPermitted()) {
      const scope = currentDeleteScope();
      const intent = retainedDeleteIntents[0];
      if (scope === undefined || intent === undefined || scope.epoch !== epoch) return;
      const preparation = prepareRetainedDelete(scope, intent);
      if (preparation === "settled") {
        if (!await removeDeleteIntent(scope, intent)) return;
        continue;
      }
      if (preparation !== "ready") return;
      const result = await executeDurableDelete(scope, intent);
      if (
        scope.epoch !== retainedDeleteRecoveryEpoch ||
        !deleteScopeIsActive(scope)
      ) return;
      if (
        result.status === "transport" ||
        result.status === "malformed_response" ||
        result.status === "aborted" ||
        result.status === "closed"
      ) return;
      if (retainedDeleteIntents.some((candidate) =>
        sameDeleteIntent(candidate, intent))) return;
    }
  };

  const startRetainedDeleteRecovery = (): void => {
    if (!retainedDeleteRecoveryPermitted() || retainedDeletePump !== undefined) return;
    const epoch = retainedDeleteRecoveryEpoch;
    const pump = runRetainedDeletePump(epoch).finally(() => {
      if (retainedDeletePump === pump) retainedDeletePump = undefined;
    });
    retainedDeletePump = pump;
  };

  requestRetainedDeleteRecovery = (): void => startRetainedDeleteRecovery();

  pauseRetainedDeleteRecovery = (): void => {
    retainedDeleteRecoveryEpoch += 1;
    retainedDeletePump = undefined;
    for (const controller of activeDeleteControllers.values()) controller.abort();
    activeDeleteControllers.clear();
  };

  activateRetainedDeleteRecovery = async (generation, identity): Promise<void> => {
    const scope = Object.freeze({
      generation,
      epoch: retainedDeleteRecoveryEpoch,
      identity,
    });
    await reloadMutationRecord(scope, deleteScopeIsActive);
  };

  reloadRetainedDeleteRecovery = (announcement): void => {
    if (announcement !== undefined && announcement.command !== "message.delete") return;
    const scope = currentDeleteScope();
    if (scope === undefined || !ownsRetainedSendRecovery()) return;
    void reloadMutationRecord(scope, deleteScopeIsActive).then((loaded) => {
      if (loaded && deleteScopeIsActive(scope) && ownsRetainedSendRecovery()) {
        requestRetainedMessageMutationRecovery();
      }
    });
  };

  handleRetainedDeleteCoordinatedResult = (
    command,
    idempotencyKey,
    value,
  ): void => {
    if (command !== "message.delete") return;
    const intent = retainedDeleteIntents.find(
      (candidate) => candidate.request.idempotencyKey === idempotencyKey,
    );
    const scope = currentDeleteScope();
    if (intent === undefined || scope === undefined) return;
    const result = parseCoordinatedCommandResult(
      createDeleteMessageDescriptor(),
      value,
    ) as ChatDeleteMessageResult | undefined;
    if (result === undefined) return;
    void settleDeleteResult(scope, intent, result).then((settled) => {
      if (!deleteScopeIsActive(scope)) return;
      resolveDeleteWaiters(idempotencyKey, settled);
      requestRetainedMessageMutationRecovery();
    });
  };

  handleRetainedDeleteCanonicalEvent = (event): void => {
    if (event.type !== "message.deleted") {
      if (event.type === "message.created" || event.type === "message.updated") {
        requestRetainedMessageMutationRecovery();
      }
      return;
    }
    const scope = currentDeleteScope();
    if (
      scope === undefined ||
      !isRecord(event.payload) ||
      !isRecord(event.payload.message) ||
      typeof event.payload.message.id !== "string" ||
      event.payload.message.tenantId !== scope.identity.tenantId ||
      event.payload.message.content !== null ||
      !isRecord(event.payload.message.revision) ||
      !Number.isSafeInteger(event.payload.message.revision.revision)
    ) return;
    const canonicalRevision = event.payload.message.revision.revision as number;
    for (const intent of retainedDeleteIntents) {
      if (
        intent.request.messageId !== event.payload.message.id ||
        canonicalRevision <= intent.request.expectedRevision
      ) continue;
      if (canonicalRevision === intent.request.expectedRevision + 1) {
        try {
          const value = parseSoftDeleteMessageResult({
            operation: "soft_delete",
            reconciliationStatus: "applied",
            expectedRevision: intent.request.expectedRevision,
            message: event.payload.message,
            canonicalRevision,
          });
          resolveDeleteWaiters(intent.request.idempotencyKey, Object.freeze({
            status: "success" as const,
            value,
          }));
        } catch {
          continue;
        }
      }
      void removeDeleteIntent(scope, intent).then(() =>
        requestRetainedMessageMutationRecovery());
    }
  };

  cache.subscribePrivateStateBoundary(() => {
    pauseRetainedDeleteRecovery();
    retainedDeleteIntents = Object.freeze([]);
    for (const waiters of deleteResultWaiters.values()) {
      for (const resolve of waiters) resolve(PREFERENCE_CLOSED_RESULT);
    }
    deleteResultWaiters.clear();
  });
  cache.subscribe(
    (state) => state.entities.messages,
    (messages, previous) => {
      if (retainedDeleteIntents.some((intent) => {
        const current = messages[intent.request.messageId];
        const prior = previous[intent.request.messageId];
        return current !== undefined &&
          !("delivery" in current) &&
          !("editState" in current) &&
          !("deleteState" in current) &&
          current.revision.revision >= intent.request.expectedRevision &&
          (prior === undefined ||
            prior.revision.revision !== current.revision.revision);
      })) requestRetainedMessageMutationRecovery();
    },
  );

  type DurableReactionScope = DurableEditScope;

  let retainedReactionRecoveryEpoch = 0;
  let retainedReactionPump: Promise<void> | undefined;
  const activeReactionControllers = new Map<string, AbortController>();
  const reactionResultWaiters = new Map<
    string,
    Set<(result: ChatSetReactionResult) => void>
  >();
  const projectedRetainedReactions = new Map<string, ReactionMutationInput>();

  const reactionScopeIsActive = (scope: DurableReactionScope): boolean => {
    const cacheIdentity = cache.getState().identity;
    return scope.epoch === retainedReactionRecoveryEpoch &&
      persistenceScopeIsActive(scope.generation, scope.identity) &&
      cacheIdentity !== null &&
      cacheIdentity.tenantId === scope.identity.tenantId &&
      cacheIdentity.userId === scope.identity.userId;
  };

  const currentReactionScope = (): DurableReactionScope | undefined =>
    activePersistenceIdentity === undefined
      ? undefined
      : Object.freeze({
          generation: persistenceGeneration,
          epoch: retainedReactionRecoveryEpoch,
          identity: activePersistenceIdentity,
        });

  const sameReactionLane = (
    left: ReactionMutationInput,
    right: ReactionMutationInput,
  ): boolean => left.messageId === right.messageId &&
    left.reactionKey === right.reactionKey;

  const sameReactionRequest = (
    left: ReactionMutationInput,
    right: ReactionMutationInput,
  ): boolean => sameReactionLane(left, right) &&
    left.operation === right.operation &&
    left.idempotencyKey === right.idempotencyKey;

  const sameReactionIntent = (
    left: DurableReactionIntent,
    right: DurableReactionIntent,
  ): boolean => left.enqueueOrder === right.enqueueOrder &&
    left.enqueuedAt === right.enqueuedAt &&
    sameReactionRequest(left.request, right.request);

  const persistReactionIntent = (
    scope: DurableReactionScope,
    input: ReactionMutationInput,
  ): Promise<Readonly<{
    intent: DurableReactionIntent;
    superseded?: DurableReactionIntent;
  }> | undefined> => serializeMessageMutation(async () => {
    try {
      const enqueuedAt = new Date().toISOString() as IsoTimestamp;
      let superseded: DurableReactionIntent | undefined;
      const committed = await mutateMessageMutationRecord(
        scope,
        reactionScopeIsActive,
        (current) => {
          const currentIntents = current?.intents ?? [];
          const previous = currentIntents[currentIntents.length - 1];
          superseded = previous !== undefined &&
              (previous.request.operation === "add_reaction" ||
                previous.request.operation === "remove_reaction") &&
              sameReactionLane(previous.request, input)
            ? previous as DurableReactionIntent
            : undefined;
          const enqueueOrder = superseded?.enqueueOrder ?? (currentIntents.reduce(
            (highest, intent) => Math.max(highest, intent.enqueueOrder),
            0,
          ) + 1);
          const appended = createApplicationChatQueuedMessageMutationIntent(input, {
            enqueueOrder,
            enqueuedAt: superseded?.enqueuedAt ?? enqueuedAt,
          }) as DurableReactionIntent;
          return createApplicationChatQueuedMessageMutationIntentsRecord(
            scope.identity,
            superseded === undefined
              ? [...currentIntents, appended]
              : [...currentIntents.slice(0, -1), appended],
          );
        },
      );
      const intent = mutationRecordReactions(committed).find((candidate) =>
        candidate.request.idempotencyKey === input.idempotencyKey &&
        sameReactionRequest(candidate.request, input));
      return intent === undefined
        ? undefined
        : Object.freeze({
            intent,
            ...(superseded === undefined ? {} : { superseded }),
          });
    } catch {
      if (reactionScopeIsActive(scope)) {
        reportPersistenceDiagnostic(
          "message_mutation_intents_write_failed",
          "The reaction change could not be stored before dispatch.",
        );
      }
      return undefined;
    }
  });

  const removeReactionIntent = (
    scope: DurableReactionScope,
    intent: DurableReactionIntent,
  ): Promise<boolean> => serializeMessageMutation(async () => {
    if (!reactionScopeIsActive(scope) || normalizedCachePersistence === undefined) {
      return false;
    }
    try {
      return await settleMessageMutationIntent(scope, reactionScopeIsActive, (candidate) =>
        (candidate.request.operation === "add_reaction" ||
          candidate.request.operation === "remove_reaction") &&
        sameReactionIntent(candidate as DurableReactionIntent, intent));
    } catch {
      if (reactionScopeIsActive(scope)) {
        reportPersistenceDiagnostic(
          "message_mutation_intents_write_failed",
          "A settled reaction change could not be removed from storage.",
        );
      }
      return false;
    }
  });

  const reactionResultMatches = (
    intent: DurableReactionIntent,
    result: ReactionMutationResult,
  ): boolean => result.operation === intent.request.operation &&
    result.messageId === intent.request.messageId &&
    result.reactionKey === intent.request.reactionKey &&
    result.reactedByCurrentUser ===
      (intent.request.operation === "add_reaction");

  const resolveReactionWaiters = (
    idempotencyKey: string,
    result: ChatSetReactionResult,
  ): void => {
    const waiters = reactionResultWaiters.get(idempotencyKey);
    if (waiters === undefined) return;
    reactionResultWaiters.delete(idempotencyKey);
    for (const resolve of waiters) resolve(result);
  };

  const waitForCoordinatedReaction = (
    idempotencyKey: string,
  ): Promise<ChatSetReactionResult> => new Promise((resolve) => {
    const waiters = reactionResultWaiters.get(idempotencyKey) ?? new Set();
    waiters.add(resolve);
    reactionResultWaiters.set(idempotencyKey, waiters);
  });

  const settleReactionResult = async (
    scope: DurableReactionScope,
    intent: DurableReactionIntent,
    result: ChatSetReactionResult,
  ): Promise<ChatSetReactionResult> => {
    if (!reactionScopeIsActive(scope)) return PREFERENCE_CLOSED_RESULT;
    if (result.status === "success") {
      if (!reactionResultMatches(intent, result.value)) {
        return SEND_MALFORMED_RESPONSE;
      }
      try {
        cache.reconcileOptimisticReaction(
          intent.request.idempotencyKey,
          result.value,
        );
      } catch {
        return SEND_MALFORMED_RESPONSE;
      }
      projectedRetainedReactions.delete(intent.request.idempotencyKey);
      await removeReactionIntent(scope, intent);
    } else if (isTerminalMessageMutationResult(result.status)) {
      cache.rollbackOptimisticReaction(
        intent.request.messageId,
        intent.request.reactionKey,
        intent.request.idempotencyKey,
      );
      projectedRetainedReactions.delete(intent.request.idempotencyKey);
      await removeReactionIntent(scope, intent);
    }
    return result;
  };

  const executeDurableReaction = async (
    scope: DurableReactionScope,
    intent: DurableReactionIntent,
  ): Promise<ChatSetReactionResult> => {
    const key = intent.request.idempotencyKey;
    const existing = activeReactionControllers.get(key);
    if (existing !== undefined) return waitForCoordinatedReaction(key);
    if (!reactionScopeIsActive(scope)) return PREFERENCE_CLOSED_RESULT;
    const controller = new AbortController();
    activeReactionControllers.set(key, controller);
    let result: ChatSetReactionResult;
    try {
      result = await client.dispatch(REACTION_DESCRIPTOR, intent.request, {
        idempotencyKey: key,
        signal: controller.signal,
      });
      result = await settleReactionResult(scope, intent, result);
    } finally {
      if (activeReactionControllers.get(key) === controller) {
        activeReactionControllers.delete(key);
      }
    }
    resolveReactionWaiters(key, result);
    return result;
  };

  const restoreRetainedReactionProjections = (
    scope: DurableReactionScope,
  ): void => {
    if (!reactionScopeIsActive(scope)) return;
    const latestByLane = new Map<string, DurableReactionIntent>();
    for (const intent of retainedReactionIntents) {
      latestByLane.set(
        JSON.stringify([intent.request.messageId, intent.request.reactionKey]),
        intent,
      );
    }
    const latestKeys = new Set(
      [...latestByLane.values()].map((intent) => intent.request.idempotencyKey),
    );
    for (const [idempotencyKey, input] of projectedRetainedReactions) {
      if (latestKeys.has(idempotencyKey)) continue;
      projectedRetainedReactions.delete(idempotencyKey);
      cache.rollbackOptimisticReaction(
        input.messageId,
        input.reactionKey,
        idempotencyKey,
      );
    }
    for (const intent of latestByLane.values()) {
      if (projectedRetainedReactions.has(intent.request.idempotencyKey)) continue;
      const message = cache.getState().entities.messages[intent.request.messageId];
      if (
        message === undefined ||
        "delivery" in message ||
        "deleteState" in message ||
        message.content === null
      ) continue;
      try {
        projectedRetainedReactions.set(
          intent.request.idempotencyKey,
          intent.request,
        );
        cache.beginOptimisticReaction(intent.request);
      } catch {
        projectedRetainedReactions.delete(intent.request.idempotencyKey);
        // A later canonical message update will retry projection restoration.
      }
    }
  };

  const retainedReactionRecoveryPermitted = (): boolean =>
    lifecycleState.state === "ready" &&
    currentReactionScope() !== undefined &&
    ownsRetainedSendRecovery() &&
    (realtimeSession === undefined || realtimeSession.state.state === "connected");

  const runRetainedReactionPump = async (epoch: number): Promise<void> => {
    while (
      epoch === retainedReactionRecoveryEpoch &&
      retainedReactionRecoveryPermitted()
    ) {
      const scope = currentReactionScope();
      const intent = retainedReactionIntents[0];
      if (scope === undefined || intent === undefined || scope.epoch !== epoch) return;
      restoreRetainedReactionProjections(scope);
      const result = await executeDurableReaction(scope, intent);
      if (!reactionScopeIsActive(scope)) return;
      if (
        result.status === "transport" ||
        result.status === "malformed_response" ||
        result.status === "aborted" ||
        result.status === "closed"
      ) return;
      if (retainedReactionIntents.some((candidate) =>
        sameReactionIntent(candidate, intent))) return;
    }
  };

  const startRetainedReactionRecovery = (): void => {
    if (!retainedReactionRecoveryPermitted() || retainedReactionPump !== undefined) return;
    const epoch = retainedReactionRecoveryEpoch;
    const pump = runRetainedReactionPump(epoch).finally(() => {
      if (retainedReactionPump === pump) retainedReactionPump = undefined;
    });
    retainedReactionPump = pump;
  };

  requestRetainedReactionRecovery = (): void => startRetainedReactionRecovery();
  requestRetainedMessageMutationRecovery = (): void => {
    requestRetainedEditRecovery();
    requestRetainedDeleteRecovery();
    requestRetainedReactionRecovery();
    requestRetainedForwardRecovery();
  };

  pauseRetainedReactionRecovery = (): void => {
    retainedReactionRecoveryEpoch += 1;
    retainedReactionPump = undefined;
    for (const controller of activeReactionControllers.values()) controller.abort();
    activeReactionControllers.clear();
  };

  activateRetainedReactionRecovery = async (generation, identity): Promise<void> => {
    const scope = Object.freeze({
      generation,
      epoch: retainedReactionRecoveryEpoch,
      identity,
    });
    if (await reloadMutationRecord(scope, reactionScopeIsActive)) {
      restoreRetainedReactionProjections(scope);
    }
  };

  reloadRetainedReactionRecovery = (announcement): void => {
    if (announcement !== undefined && announcement.command !== "reaction.set") return;
    const scope = currentReactionScope();
    if (scope === undefined || !ownsRetainedSendRecovery()) return;
    void reloadMutationRecord(scope, reactionScopeIsActive).then((loaded) => {
      if (loaded && reactionScopeIsActive(scope) && ownsRetainedSendRecovery()) {
        restoreRetainedReactionProjections(scope);
        requestRetainedMessageMutationRecovery();
      }
    });
  };

  handleRetainedReactionCoordinatedResult = (
    command,
    idempotencyKey,
    value,
  ): void => {
    if (command !== "reaction.set") return;
    const intent = retainedReactionIntents.find(
      (candidate) => candidate.request.idempotencyKey === idempotencyKey,
    );
    const scope = currentReactionScope();
    if (intent === undefined || scope === undefined) return;
    const result = parseCoordinatedCommandResult(
      REACTION_DESCRIPTOR,
      value,
    ) as ChatSetReactionResult | undefined;
    if (result === undefined) return;
    void settleReactionResult(scope, intent, result).then((settled) => {
      if (!reactionScopeIsActive(scope)) return;
      resolveReactionWaiters(idempotencyKey, settled);
      requestRetainedMessageMutationRecovery();
    });
  };

  handleRetainedReactionCanonicalEvent = (event): void => {
    // Shared canonical delivery updates reaction aggregates. Broadcasts lack
    // actor/request correlation, so only HTTP or coordinated results settle intents.
    if (event.type === "message.created" || event.type === "message.updated") {
      const scope = currentReactionScope();
      if (scope !== undefined) restoreRetainedReactionProjections(scope);
      requestRetainedMessageMutationRecovery();
    }
  };

  cache.subscribePrivateStateBoundary(() => {
    pauseRetainedReactionRecovery();
    retainedReactionIntents = Object.freeze([]);
    projectedRetainedReactions.clear();
    for (const waiters of reactionResultWaiters.values()) {
      for (const resolve of waiters) resolve(PREFERENCE_CLOSED_RESULT);
    }
    reactionResultWaiters.clear();
  });
  cache.subscribe(
    (state) => state.entities.messages,
    () => {
      if (retainedReactionIntents.length === 0) return;
      const scope = currentReactionScope();
      if (scope === undefined) return;
      restoreRetainedReactionProjections(scope);
      requestRetainedMessageMutationRecovery();
    },
  );

  type DurableForwardScope = DurableEditScope;

  let retainedForwardRecoveryEpoch = 0;
  let retainedForwardPump: Promise<void> | undefined;
  const activeForwardRecoveryControllers = new Map<string, AbortController>();
  const forwardResultWaiters = new Map<
    string,
    Set<(result: ChatForwardMessageResult) => void>
  >();

  const forwardScopeIsActive = (scope: DurableForwardScope): boolean => {
    const cacheIdentity = cache.getState().identity;
    return scope.epoch === retainedForwardRecoveryEpoch &&
      persistenceScopeIsActive(scope.generation, scope.identity) &&
      cacheIdentity !== null &&
      cacheIdentity.tenantId === scope.identity.tenantId &&
      cacheIdentity.userId === scope.identity.userId;
  };

  const currentForwardScope = (): DurableForwardScope | undefined =>
    activePersistenceIdentity === undefined
      ? undefined
      : Object.freeze({
          generation: persistenceGeneration,
          epoch: retainedForwardRecoveryEpoch,
          identity: activePersistenceIdentity,
        });

  const sameForwardLane = (
    left: ForwardMessageInput,
    right: ForwardMessageInput,
  ): boolean => left.sourceMessageId === right.sourceMessageId &&
    left.destinationConversationId === right.destinationConversationId;

  const sameForwardRequest = (
    left: ForwardMessageInput,
    right: ForwardMessageInput,
  ): boolean => sameForwardLane(left, right) &&
    left.clientCorrelationId === right.clientCorrelationId &&
    left.idempotencyKey === right.idempotencyKey;

  const sameForwardIntent = (
    left: DurableForwardIntent,
    right: DurableForwardIntent,
  ): boolean => left.enqueueOrder === right.enqueueOrder &&
    left.enqueuedAt === right.enqueuedAt &&
    sameForwardRequest(left.request, right.request);

  const persistForwardIntent = (
    scope: DurableForwardScope,
    validated: ForwardMessageInput,
  ): Promise<DurableForwardIntent | undefined> => serializeMessageMutation(async () => {
    try {
      const enqueuedAt = new Date().toISOString() as IsoTimestamp;
      let input: ForwardMessageInput | undefined;
      const committed = await mutateMessageMutationRecord(
        scope,
        forwardScopeIsActive,
        (current) => {
          const existing = mutationRecordForwards(current).find((candidate) =>
            sameForwardLane(candidate.request, validated));
          if (existing !== undefined) return current;
          input ??= parseForwardMessageInput({
            operation: "forward_message.v1",
            sourceMessageId: validated.sourceMessageId,
            destinationConversationId: validated.destinationConversationId,
            clientCorrelationId: generateForwardClientCorrelationId(),
            idempotencyKey: generateForwardIdempotencyKey(),
          });
          const enqueueOrder = (current?.intents.reduce(
            (highest, intent) => Math.max(highest, intent.enqueueOrder),
            0,
          ) ?? 0) + 1;
          const intent = createApplicationChatQueuedMessageMutationIntent(input, {
            enqueueOrder,
            enqueuedAt,
          }) as DurableForwardIntent;
          return createApplicationChatQueuedMessageMutationIntentsRecord(
            scope.identity,
            [...(current?.intents ?? []), intent],
          );
        },
      );
      return mutationRecordForwards(committed).find((candidate) =>
        sameForwardLane(candidate.request, validated));
    } catch {
      if (forwardScopeIsActive(scope)) {
        reportPersistenceDiagnostic(
          "message_mutation_intents_write_failed",
          "The message forward could not be stored before dispatch.",
        );
      }
      return undefined;
    }
  });

  const removeForwardIntent = (
    scope: DurableForwardScope,
    intent: DurableForwardIntent,
  ): Promise<boolean> => serializeMessageMutation(async () => {
    if (!forwardScopeIsActive(scope) || normalizedCachePersistence === undefined) {
      return false;
    }
    try {
      return await settleMessageMutationIntent(scope, forwardScopeIsActive, (candidate) =>
        candidate.request.operation === "forward_message.v1" &&
        sameForwardIntent(candidate as DurableForwardIntent, intent));
    } catch {
      if (forwardScopeIsActive(scope)) {
        reportPersistenceDiagnostic(
          "message_mutation_intents_write_failed",
          "A settled message forward could not be removed from storage.",
        );
      }
      return false;
    }
  });

  const forwardResultMatches = (
    scope: DurableForwardScope,
    intent: DurableForwardIntent,
    result: ForwardMessageResult,
  ): boolean => result.message.tenantId === scope.identity.tenantId &&
    result.destinationConversationId === intent.request.destinationConversationId &&
    result.message.conversationId === intent.request.destinationConversationId &&
    result.clientCorrelationId === intent.request.clientCorrelationId &&
    result.message.content?.forwarded?.sourceMessageId ===
      intent.request.sourceMessageId;

  const resolveForwardWaiters = (
    idempotencyKey: string,
    result: ChatForwardMessageResult,
  ): void => {
    const waiters = forwardResultWaiters.get(idempotencyKey);
    if (waiters === undefined) return;
    forwardResultWaiters.delete(idempotencyKey);
    for (const resolve of waiters) resolve(result);
  };

  const waitForCoordinatedForward = (
    idempotencyKey: string,
  ): Promise<ChatForwardMessageResult> => new Promise((resolve) => {
    const waiters = forwardResultWaiters.get(idempotencyKey) ?? new Set();
    waiters.add(resolve);
    forwardResultWaiters.set(idempotencyKey, waiters);
  });

  const settleForwardResult = async (
    scope: DurableForwardScope,
    intent: DurableForwardIntent,
    result: ChatForwardMessageResult,
  ): Promise<ChatForwardMessageResult> => {
    if (!forwardScopeIsActive(scope)) return PREFERENCE_CLOSED_RESULT;
    if (result.status === "success") {
      if (!forwardResultMatches(scope, intent, result.value)) {
        return SEND_MALFORMED_RESPONSE;
      }
      try {
        cache.reconcileAuthoritativeMessageCreated(
          result.value.message,
          result.value.clientCorrelationId,
        );
      } catch {
        // A canonical event or later snapshot can restore missing cache context.
      }
      await removeForwardIntent(scope, intent);
    } else if (isTerminalMessageMutationResult(result.status)) {
      await removeForwardIntent(scope, intent);
    }
    return result;
  };

  const executeDurableForward = async (
    scope: DurableForwardScope,
    intent: DurableForwardIntent,
  ): Promise<ChatForwardMessageResult> => {
    const key = intent.request.idempotencyKey;
    if (activeForwardRecoveryControllers.has(key)) {
      return waitForCoordinatedForward(key);
    }
    if (!forwardScopeIsActive(scope)) return PREFERENCE_CLOSED_RESULT;
    const controller = new AbortController();
    activeForwardRecoveryControllers.set(key, controller);
    let result: ChatForwardMessageResult;
    try {
      result = await client.dispatch(
        createForwardMessageDescriptor(intent.request),
        intent.request,
        { idempotencyKey: key, signal: controller.signal },
      );
      result = await settleForwardResult(scope, intent, result);
    } finally {
      if (activeForwardRecoveryControllers.get(key) === controller) {
        activeForwardRecoveryControllers.delete(key);
      }
    }
    resolveForwardWaiters(key, result);
    return result;
  };

  const retainedForwardRecoveryPermitted = (): boolean =>
    lifecycleState.state === "ready" &&
    currentForwardScope() !== undefined &&
    ownsRetainedSendRecovery() &&
    (realtimeSession === undefined || realtimeSession.state.state === "connected");

  const runRetainedForwardPump = async (epoch: number): Promise<void> => {
    while (
      epoch === retainedForwardRecoveryEpoch &&
      retainedForwardRecoveryPermitted()
    ) {
      const scope = currentForwardScope();
      const intent = retainedForwardIntents[0];
      if (scope === undefined || intent === undefined || scope.epoch !== epoch) return;
      const result = await executeDurableForward(scope, intent);
      if (!forwardScopeIsActive(scope)) return;
      if (
        result.status === "transport" ||
        result.status === "malformed_response" ||
        result.status === "aborted" ||
        result.status === "closed"
      ) return;
      if (retainedForwardIntents.some((candidate) =>
        sameForwardIntent(candidate, intent))) return;
    }
  };

  const startRetainedForwardRecovery = (): void => {
    if (!retainedForwardRecoveryPermitted() || retainedForwardPump !== undefined) return;
    const epoch = retainedForwardRecoveryEpoch;
    const pump = runRetainedForwardPump(epoch).finally(() => {
      if (retainedForwardPump === pump) retainedForwardPump = undefined;
    });
    retainedForwardPump = pump;
  };

  requestRetainedForwardRecovery = (): void => startRetainedForwardRecovery();

  pauseRetainedForwardRecovery = (): void => {
    retainedForwardRecoveryEpoch += 1;
    retainedForwardPump = undefined;
    for (const controller of activeForwardRecoveryControllers.values()) {
      controller.abort();
    }
    activeForwardRecoveryControllers.clear();
  };

  activateRetainedForwardRecovery = async (generation, identity): Promise<void> => {
    const scope = Object.freeze({
      generation,
      epoch: retainedForwardRecoveryEpoch,
      identity,
    });
    await reloadMutationRecord(scope, forwardScopeIsActive);
  };

  reloadRetainedForwardRecovery = (announcement): void => {
    if (announcement !== undefined && announcement.command !== "message.forward") return;
    const scope = currentForwardScope();
    if (scope === undefined || !ownsRetainedSendRecovery()) return;
    void reloadMutationRecord(scope, forwardScopeIsActive).then((loaded) => {
      if (loaded && forwardScopeIsActive(scope) && ownsRetainedSendRecovery()) {
        requestRetainedMessageMutationRecovery();
      }
    });
  };

  handleRetainedForwardCoordinatedResult = (
    command,
    idempotencyKey,
    value,
  ): void => {
    if (command !== "message.forward") return;
    const intent = retainedForwardIntents.find(
      (candidate) => candidate.request.idempotencyKey === idempotencyKey,
    );
    const scope = currentForwardScope();
    if (intent === undefined || scope === undefined) return;
    const result = parseCoordinatedCommandResult(
      createForwardMessageDescriptor(intent.request),
      value,
    ) as ChatForwardMessageResult | undefined;
    if (result === undefined) return;
    void settleForwardResult(scope, intent, result).then((settled) => {
      if (!forwardScopeIsActive(scope)) return;
      resolveForwardWaiters(idempotencyKey, settled);
      requestRetainedMessageMutationRecovery();
    });
  };

  handleRetainedForwardCanonicalEvent = (event): void => {
    if (
      event.type !== "message.created" ||
      !isRecord(event.payload) ||
      typeof event.payload.clientMessageId !== "string" ||
      !isRecord(event.payload.message)
    ) return;
    const scope = currentForwardScope();
    if (
      scope === undefined ||
      event.tenantId !== scope.identity.tenantId ||
      event.streamId !== event.payload.message.conversationId
    ) return;
    for (const intent of retainedForwardIntents) {
      if (
        event.payload.clientMessageId !== intent.request.clientCorrelationId ||
        event.streamId !== intent.request.destinationConversationId
      ) continue;
      let value: ForwardMessageResult;
      try {
        value = parseForwardMessageResult({
          operation: "forward_message.v1",
          reconciliationStatus: "replayed",
          clientCorrelationId: event.payload.clientMessageId,
          destinationConversationId: intent.request.destinationConversationId,
          message: event.payload.message,
          canonicalRevision: 1,
        }, intent.request);
      } catch {
        continue;
      }
      if (!forwardResultMatches(scope, intent, value)) continue;
      const result: ChatForwardMessageResult = Object.freeze({
        status: "success" as const,
        value,
      });
      resolveForwardWaiters(intent.request.idempotencyKey, result);
      void removeForwardIntent(scope, intent).then(() =>
        requestRetainedMessageMutationRecovery());
    }
  };

  cache.subscribePrivateStateBoundary(() => {
    pauseRetainedForwardRecovery();
    retainedForwardIntents = Object.freeze([]);
    for (const waiters of forwardResultWaiters.values()) {
      for (const resolve of waiters) resolve(PREFERENCE_CLOSED_RESULT);
    }
    forwardResultWaiters.clear();
  });

  const requestAuthoredForwardDispatch = (
    scope: DurableForwardScope,
    intent: DurableForwardIntent,
  ): void => {
    const runningPump = retainedForwardPump;
    if (
      runningPump === undefined ||
      activeForwardRecoveryControllers.has(intent.request.idempotencyKey)
    ) {
      requestRetainedForwardRecovery();
      return;
    }
    void runningPump.finally(() => {
      if (
        forwardScopeIsActive(scope) &&
        retainedForwardIntents.some((candidate) =>
          sameForwardIntent(candidate, intent))
      ) requestRetainedForwardRecovery();
    });
  };

  const beginForwardMessage = <Block extends MessageBlock>(
    authored: ChatForwardMessageInput,
  ): Promise<ChatForwardMessageResult<Block>> => {
    let validated: ForwardMessageInput;
    try {
      if (!isRecord(authored)) throw new TypeError("forward-message input required");
      validated = parseForwardMessageInput({
        ...authored,
        operation: "forward_message.v1",
        clientCorrelationId: "forward-validation",
        idempotencyKey: "forward-validation",
      });
    } catch {
      return Promise.resolve(SEND_VALIDATION_FAILURE);
    }
    if (normalizedCachePersistence === undefined) {
      return beginVolatileForwardMessage<Block>(authored);
    }
    const scope = currentForwardScope();
    if (scope === undefined) return Promise.resolve(SEND_VALIDATION_FAILURE);
    return (async (): Promise<ChatForwardMessageResult<Block>> => {
      const intent = await persistForwardIntent(scope, validated);
      if (intent === undefined || !forwardScopeIsActive(scope)) {
        return SEND_VALIDATION_FAILURE;
      }
      coordinator?.announcePersistedCommand(
        "message.forward",
        intent.request.idempotencyKey,
      );
      const result = waitForCoordinatedForward(intent.request.idempotencyKey);
      requestAuthoredForwardDispatch(scope, intent);
      return result as Promise<ChatForwardMessageResult<Block>>;
    })();
  };

  const beginLogicalEdit = <Block extends MessageBlock>(
    authored: ChatEditMessageInput<Block>,
  ): Promise<ChatEditMessageResult<Block>> => {
    let input: EditMessageInput<Block>;
    try {
      input = parseEditMessageInput<Block>({
        operation: "edit",
        messageId: authored.messageId,
        expectedRevision: authored.expectedRevision,
        idempotencyKey: generateEditIdempotencyKey(),
        content: authored.content,
      });
    } catch {
      return Promise.resolve(SEND_VALIDATION_FAILURE);
    }

    if (normalizedCachePersistence === undefined) {
      try {
        cache.beginOptimisticMessageEdit(input as EditMessageInput);
      } catch {
        return Promise.resolve(SEND_VALIDATION_FAILURE);
      }
      return client.dispatch(
        createEditMessageDescriptor<Block>(),
        input,
        { idempotencyKey: input.idempotencyKey },
      ).then((result) => {
        if (result.status === "success") {
          cache.reconcileOptimisticMessageEdit(input.idempotencyKey, result.value);
        } else {
          cache.rollbackOptimisticMessageEdit(input.messageId, input.idempotencyKey);
        }
        return result;
      });
    }

    const scope = currentEditScope();
    if (scope === undefined) return Promise.resolve(SEND_VALIDATION_FAILURE);
    return (async (): Promise<ChatEditMessageResult<Block>> => {
      const intent = await persistEditIntent(scope, input as EditMessageInput);
      if (intent === undefined || !editScopeIsActive(scope)) {
        return SEND_VALIDATION_FAILURE;
      }
      try {
        cache.beginOptimisticMessageEdit(intent.request);
      } catch {
        await removeEditIntent(scope, intent);
        return SEND_VALIDATION_FAILURE;
      }
      coordinator?.announcePersistedCommand("message.edit", intent.request.idempotencyKey);
      if (!ownsRetainedSendRecovery()) {
        return waitForCoordinatedEdit(intent.request.idempotencyKey) as
          Promise<ChatEditMessageResult<Block>>;
      }
      return executeDurableEdit(scope, intent) as Promise<ChatEditMessageResult<Block>>;
    })();
  };

  const beginLogicalDelete = <Block extends MessageBlock>(
    authored: ChatDeleteMessageInput,
  ): Promise<ChatDeleteMessageResult<Block>> => {
    let input: SoftDeleteMessageInput;
    try {
      input = parseSoftDeleteMessageInput({
        operation: "soft_delete",
        messageId: authored.messageId,
        expectedRevision: authored.expectedRevision,
        idempotencyKey: generateDeleteIdempotencyKey(),
      });
    } catch {
      return Promise.resolve(SEND_VALIDATION_FAILURE);
    }

    if (normalizedCachePersistence === undefined) {
      try {
        cache.beginOptimisticMessageDelete(input);
      } catch {
        return Promise.resolve(SEND_VALIDATION_FAILURE);
      }
      return client.dispatch(
        createDeleteMessageDescriptor<Block>(),
        input,
        { idempotencyKey: input.idempotencyKey },
      ).then((result) => {
        if (result.status === "success") {
          cache.reconcileOptimisticMessageDelete(input.idempotencyKey, result.value);
        } else {
          cache.rollbackOptimisticMessageDelete(input.messageId, input.idempotencyKey);
        }
        return result;
      });
    }

    const scope = currentDeleteScope();
    if (scope === undefined) return Promise.resolve(SEND_VALIDATION_FAILURE);
    return (async (): Promise<ChatDeleteMessageResult<Block>> => {
      const intent = await persistDeleteIntent(scope, input);
      if (intent === undefined || !deleteScopeIsActive(scope)) {
        return SEND_VALIDATION_FAILURE;
      }
      try {
        cache.beginOptimisticMessageDelete(intent.request);
      } catch {
        await removeDeleteIntent(scope, intent);
        return SEND_VALIDATION_FAILURE;
      }
      coordinator?.announcePersistedCommand(
        "message.delete",
        intent.request.idempotencyKey,
      );
      if (!ownsRetainedSendRecovery()) {
        return waitForCoordinatedDelete(intent.request.idempotencyKey) as
          Promise<ChatDeleteMessageResult<Block>>;
      }
      return executeDurableDelete(scope, intent) as
        Promise<ChatDeleteMessageResult<Block>>;
    })();
  };

  const volatileReactionQueues = new Map<MessageId, Promise<void>>();

  const executeVolatileReaction = async (
    input: ReactionMutationInput,
  ): Promise<ChatSetReactionResult> => {
    const result = await client.dispatch(REACTION_DESCRIPTOR, input, {
      idempotencyKey: input.idempotencyKey,
    });
    if (result.status === "success") {
      cache.reconcileOptimisticReaction(input.idempotencyKey, result.value);
    } else {
      cache.rollbackOptimisticReaction(
        input.messageId,
        input.reactionKey,
        input.idempotencyKey,
      );
    }
    return result;
  };

  const enqueueVolatileReaction = (
    input: ReactionMutationInput,
  ): Promise<ChatSetReactionResult> => {
    const previous = volatileReactionQueues.get(input.messageId) ?? Promise.resolve();
    const execution = previous.then(() => executeVolatileReaction(input));
    const tail = execution.then(
      () => undefined,
      () => undefined,
    );
    volatileReactionQueues.set(input.messageId, tail);
    void tail.finally(() => {
      if (volatileReactionQueues.get(input.messageId) === tail) {
        volatileReactionQueues.delete(input.messageId);
      }
    });
    return execution;
  };

  const beginLogicalReaction = (
    authored: ChatSetReactionInput,
  ): Promise<ChatSetReactionResult> => {
    let input: ReactionMutationInput;
    try {
      if (typeof authored.reacted !== "boolean") throw new TypeError("invalid reaction state");
      const reactionKey = typeof authored.reactionKey === "string"
        ? authored.reactionKey.normalize("NFC")
        : authored.reactionKey;
      input = parseReactionMutationInput({
        operation: authored.reacted ? "add_reaction" : "remove_reaction",
        messageId: authored.messageId,
        reactionKey,
        idempotencyKey: generateReactionIdempotencyKey(),
      });
    } catch {
      return Promise.resolve(SEND_VALIDATION_FAILURE);
    }

    if (normalizedCachePersistence === undefined) {
      try {
        cache.beginOptimisticReaction(input);
      } catch {
        return Promise.resolve(SEND_VALIDATION_FAILURE);
      }
      return enqueueVolatileReaction(input);
    }

    const scope = currentReactionScope();
    if (scope === undefined) return Promise.resolve(SEND_VALIDATION_FAILURE);
    return (async (): Promise<ChatSetReactionResult> => {
      const persisted = await persistReactionIntent(scope, input);
      if (persisted === undefined || !reactionScopeIsActive(scope)) {
        return SEND_VALIDATION_FAILURE;
      }
      const { intent, superseded } = persisted;
      if (
        superseded !== undefined &&
        !activeReactionControllers.has(superseded.request.idempotencyKey)
      ) {
        projectedRetainedReactions.delete(superseded.request.idempotencyKey);
        cache.rollbackOptimisticReaction(
          superseded.request.messageId,
          superseded.request.reactionKey,
          superseded.request.idempotencyKey,
        );
        resolveReactionWaiters(
          superseded.request.idempotencyKey,
          PREFERENCE_CLOSED_RESULT,
        );
      }
      try {
        projectedRetainedReactions.set(
          intent.request.idempotencyKey,
          intent.request,
        );
        cache.beginOptimisticReaction(intent.request);
      } catch {
        projectedRetainedReactions.delete(intent.request.idempotencyKey);
        await removeReactionIntent(scope, intent);
        return SEND_VALIDATION_FAILURE;
      }
      coordinator?.announcePersistedCommand(
        "reaction.set",
        intent.request.idempotencyKey,
      );
      const result = waitForCoordinatedReaction(intent.request.idempotencyKey);
      requestRetainedMessageMutationRecovery();
      return result;
    })();
  };

  const conversationCreationLogicalKey = (
    input: ConversationCreationInput,
  ): string => input.type === "channel"
    ? JSON.stringify([
        "create",
        input.type,
        input.name,
        input.visibility,
        input.entity?.type ?? null,
        input.entity?.id ?? null,
      ])
    : JSON.stringify([
        "create",
        input.type,
        [...input.intendedMemberUserIds].sort(),
      ]);

  interface DurableConversationCreationScope {
    readonly generation: number;
    readonly epoch: number;
    readonly identity: ApplicationChatStorageIdentity;
  }

  interface ActiveConversationCreation {
    readonly controller: AbortController;
    readonly canonicalResult: Promise<ChatCommandResult<ConversationCreationResult>>;
    readonly resolveCanonicalResult: (
      result: ChatCommandResult<ConversationCreationResult>,
    ) => void;
  }

  let conversationCreationMutationChain: Promise<void> = Promise.resolve();
  let retainedConversationCreationRecoveryEpoch = 0;
  let retainedConversationCreationPump: Promise<void> | undefined;
  let retainedConversationCreationRetryNumber = 0;
  let retainedConversationCreationRetryController: AbortController | undefined;
  const activeConversationCreations = new Map<string, ActiveConversationCreation>();
  const conversationCreationResultWaiters = new Map<
    string,
    Set<(result: ChatCommandResult<ConversationCreationResult>) => void>
  >();

  const serializeConversationCreationMutation = <Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> => {
    const result = conversationCreationMutationChain.then(operation);
    conversationCreationMutationChain = result.then(() => undefined, () => undefined);
    return result;
  };

  const conversationCreationScopeIsActive = (
    scope: DurableConversationCreationScope,
  ): boolean => {
    const cacheIdentity = cache.getState().identity;
    return scope.epoch === retainedConversationCreationRecoveryEpoch &&
      persistenceScopeIsActive(scope.generation, scope.identity) &&
      cacheIdentity !== null &&
      cacheIdentity.tenantId === scope.identity.tenantId &&
      cacheIdentity.userId === scope.identity.userId;
  };

  const currentConversationCreationScope = (
  ): DurableConversationCreationScope | undefined =>
    activePersistenceIdentity === undefined
      ? undefined
      : Object.freeze({
          generation: persistenceGeneration,
          epoch: retainedConversationCreationRecoveryEpoch,
          identity: activePersistenceIdentity,
        });

  const sameConversationCreationRequest = (
    left: ConversationCreationInput,
    right: ConversationCreationInput,
  ): boolean => JSON.stringify(left) === JSON.stringify(right);

  const sameConversationCreationIntent = (
    left: DurableConversationCreationIntent,
    right: DurableConversationCreationIntent,
  ): boolean => left.enqueueOrder === right.enqueueOrder &&
    left.enqueuedAt === right.enqueuedAt &&
    sameConversationCreationRequest(left.request, right.request);

  const sameConversationCreationCorrelation = (
    left: DurableConversationCreationIntent,
    right: DurableConversationCreationIntent,
  ): boolean => left.request.clientRequestId === right.request.clientRequestId &&
    left.request.idempotencyKey === right.request.idempotencyKey;

  const readConversationCreationRecord = async (
    scope: DurableConversationCreationScope,
  ): Promise<ApplicationChatQueuedConversationCreationIntentsRecord | null> => {
    if (
      !conversationCreationScopeIsActive(scope) ||
      normalizedCachePersistence === undefined
    ) {
      throw new Error("inactive durable conversation-creation scope");
    }
    const record = await normalizedCachePersistence.storage.read(
      scope.identity,
      ApplicationChatStorageRecordKind.queuedConversationCreationIntents,
    );
    if (!conversationCreationScopeIsActive(scope)) {
      throw new Error("inactive durable conversation-creation scope");
    }
    return record;
  };

  const publishRetainedConversationCreations = (
    record: ApplicationChatQueuedConversationCreationIntentsRecord | null,
  ): void => {
    retainedConversationCreationIntents = Object.freeze([...(record?.intents ?? [])]);
  };

  const mutateConversationCreationRecord = async (
    scope: DurableConversationCreationScope,
    updater: (
      current: ApplicationChatQueuedConversationCreationIntentsRecord | null,
    ) => ApplicationChatQueuedConversationCreationIntentsRecord | null,
  ): Promise<ApplicationChatQueuedConversationCreationIntentsRecord | null> => {
    if (
      !conversationCreationScopeIsActive(scope) ||
      normalizedCachePersistence === undefined
    ) {
      throw new Error("inactive durable conversation-creation scope");
    }
    const committed = await normalizedCachePersistence.storage.mutate(
      scope.identity,
      ApplicationChatStorageRecordKind.queuedConversationCreationIntents,
      (current) => {
        if (!conversationCreationScopeIsActive(scope)) {
          throw new Error("inactive durable conversation-creation scope");
        }
        const proposal = updater(current);
        if (!conversationCreationScopeIsActive(scope)) {
          throw new Error("inactive durable conversation-creation scope");
        }
        return proposal;
      },
    );
    if (!conversationCreationScopeIsActive(scope)) {
      throw new Error("inactive durable conversation-creation scope");
    }
    publishRetainedConversationCreations(committed);
    return committed;
  };

  const reloadConversationCreationRecord = (
    scope: DurableConversationCreationScope,
  ): Promise<boolean> => serializeConversationCreationMutation(async () => {
    try {
      const record = await readConversationCreationRecord(scope);
      publishRetainedConversationCreations(record);
      return true;
    } catch (error) {
      if (!conversationCreationScopeIsActive(scope)) return false;
      if (error instanceof ApplicationChatStorageValidationError) {
        reportPersistenceDiagnostic(
          "conversation_creation_intents_rejected",
          "The stored conversation-creation intents were rejected and quarantined.",
        );
        publishRetainedConversationCreations(null);
      } else {
        reportPersistenceDiagnostic(
          "conversation_creation_intents_read_failed",
          "The stored conversation-creation intents could not be read.",
        );
      }
      return false;
    }
  });

  const findOrPersistConversationCreationIntent = (
    scope: DurableConversationCreationScope,
    semanticInput: ConversationCreationInput,
  ): Promise<DurableConversationCreationIntent | undefined> =>
    serializeConversationCreationMutation(async () => {
      try {
        const logicalKey = conversationCreationLogicalKey(semanticInput);
        let proposedInput: ConversationCreationInput | undefined;
        let proposedEnqueuedAt: IsoTimestamp | undefined;
        const committed = await mutateConversationCreationRecord(
          scope,
          (current) => {
            const retained = current?.intents.find((intent) =>
              conversationCreationLogicalKey(intent.request) === logicalKey);
            if (retained !== undefined) return current;
            const input = proposedInput ?? (proposedInput = parseConversationCreationInput({
              ...semanticInput,
              idempotencyKey: generateLifecycleIdempotencyKey(),
              clientRequestId: generateLifecycleClientRequestId(logicalKey),
            }));
            const enqueuedAt = proposedEnqueuedAt ??
              (proposedEnqueuedAt = new Date().toISOString() as IsoTimestamp);
            const enqueueOrder = (current?.intents.reduce(
              (highest, intent) => Math.max(highest, intent.enqueueOrder),
              0,
            ) ?? 0) + 1;
            const intent = createApplicationChatQueuedConversationCreationIntent(
              input,
              { enqueueOrder, enqueuedAt },
            );
            return createApplicationChatQueuedConversationCreationIntentsRecord(
              scope.identity,
              [...(current?.intents ?? []), intent],
            );
          },
        );
        return committed?.intents.find((intent) =>
          conversationCreationLogicalKey(intent.request) === logicalKey);
      } catch {
        if (conversationCreationScopeIsActive(scope)) {
          reportPersistenceDiagnostic(
            "conversation_creation_intents_write_failed",
            "The conversation-creation command could not be stored before dispatch.",
          );
        }
        return undefined;
      }
    });

  const removeConversationCreationIntent = (
    scope: DurableConversationCreationScope,
    intent: DurableConversationCreationIntent,
  ): Promise<boolean> => serializeConversationCreationMutation(async () => {
    if (
      !conversationCreationScopeIsActive(scope) ||
      normalizedCachePersistence === undefined
    ) return false;
    try {
      await mutateConversationCreationRecord(scope, (current) => {
        if (current === null) return null;
        const remaining = current.intents.filter((candidate) =>
          !sameConversationCreationCorrelation(candidate, intent));
        if (remaining.length === current.intents.length) return current;
        return remaining.length === 0
          ? null
          : createApplicationChatQueuedConversationCreationIntentsRecord(
              scope.identity,
              remaining,
            );
      });
      if (!conversationCreationScopeIsActive(scope)) return false;
      cache.settleConversationOperation(conversationCreationLogicalKey(intent.request));
      return true;
    } catch {
      if (conversationCreationScopeIsActive(scope)) {
        reportPersistenceDiagnostic(
          "conversation_creation_intents_write_failed",
          "A settled conversation-creation command could not be removed from storage.",
        );
      }
      return false;
    }
  });

  const conversationCreationDetailFromState = (
    scope: DurableConversationCreationScope,
    conversationId: ConversationId,
  ): ConversationDetailSnapshot | undefined => {
    if (!conversationCreationScopeIsActive(scope)) return undefined;
    const state = cache.getState();
    const conversation = state.entities.conversations[conversationId];
    const summary = state.metadata.conversations[conversationId];
    const snapshotMetadata = state.metadata.conversationDetails[conversationId];
    const currentMember = state.currentUser.memberships[conversationId];
    const currentReadState = state.currentUser.readStates[conversationId];
    const currentPreference = state.currentUser.preferences[conversationId];
    const memberUserIds = state.entities.memberUserIdsByConversation[conversationId];
    if (
      conversation === undefined ||
      summary === undefined ||
      snapshotMetadata === undefined ||
      currentMember === undefined ||
      currentReadState === undefined ||
      currentPreference === undefined ||
      memberUserIds === undefined
    ) return undefined;
    return {
      kind: "conversation_detail",
      conversation: {
        ...conversation,
        latestSequence: summary.latestSequence,
        activityAt: summary.activityAt,
        unreadMentionCount:
          state.metadata.conversationListUnreadMentionCounts[conversationId] ?? 0,
        currentMember,
        currentReadState,
        currentPreference,
        activeMemberUserIds: memberUserIds,
        memberUserIds,
        ...(state.metadata.memberListRevisions[conversationId] === undefined
          ? {}
          : { memberListRevision: state.metadata.memberListRevisions[conversationId] }),
      },
      _meta: snapshotMetadata,
    };
  };

  const conversationCreationResultFromState = (
    scope: DurableConversationCreationScope,
    request: ConversationCreationInput,
  ): ConversationCreationResult | undefined => {
    if (request.type === "channel" || !conversationCreationScopeIsActive(scope)) {
      return undefined;
    }
    const expectedMembers = new Set([
      scope.identity.userId,
      ...request.intendedMemberUserIds,
    ]);
    const state = cache.getState();
    for (const [conversationId, conversation] of Object.entries(
      state.entities.conversations,
    )) {
      const canonicalConversationId = conversationId as ConversationId;
      if (
        conversation.tenantId !== scope.identity.tenantId ||
        conversation.type !== request.type
      ) continue;
      const memberUserIds =
        state.entities.memberUserIdsByConversation[canonicalConversationId];
      if (
        memberUserIds === undefined ||
        new Set(memberUserIds).size !== expectedMembers.size ||
        !memberUserIds.every((memberUserId) => expectedMembers.has(memberUserId))
      ) continue;
      const detail = conversationCreationDetailFromState(
        scope,
        canonicalConversationId,
      );
      if (detail === undefined) continue;
      try {
        return parseConversationCreationResult({
          operation: "create_conversation",
          type: request.type,
          reconciliationStatus: "existing_equivalent",
          clientRequestId: request.clientRequestId,
          conversation: detail,
          participantIdentity: deriveCanonicalParticipantIdentity(
            scope.identity.userId,
            request.intendedMemberUserIds,
          ),
        }, request);
      } catch {
        continue;
      }
    }
    return undefined;
  };

  const conversationCreationResultFromEvent = (
    scope: DurableConversationCreationScope,
    request: ConversationCreationInput,
    event: ChatEvent,
  ): ConversationCreationResult | undefined => {
    if (!isRecord(event.payload) || !isRecord(event.payload.conversation)) {
      return undefined;
    }
    const conversationId = event.payload.conversation.id;
    if (typeof conversationId !== "string") return undefined;
    const canonicalConversationId = conversationId as ConversationId;
    let detail = conversationCreationDetailFromState(
      scope,
      canonicalConversationId,
    );
    if (detail === undefined) {
      const state = cache.getState();
      const conversation = state.entities.conversations[canonicalConversationId];
      if (conversation === undefined || lifecycleState.state !== "ready") return undefined;
      const occurredAt = conversation.updatedAt;
      const memberUserIds =
        state.entities.memberUserIdsByConversation[canonicalConversationId] ??
        (request.type === "channel"
          ? [scope.identity.userId]
          : [scope.identity.userId, ...request.intendedMemberUserIds].sort());
      detail = {
        kind: "conversation_detail",
        conversation: {
          ...conversation,
          latestSequence: 0,
          activityAt: occurredAt,
          unreadMentionCount: 0,
          currentMember: {
            tenantId: scope.identity.tenantId,
            conversationId: conversation.id,
            userId: scope.identity.userId,
            role: "owner",
            state: "active",
            joinedAt: occurredAt,
            updatedAt: occurredAt,
          },
          currentReadState: {
            conversationId: conversation.id,
            userId: scope.identity.userId,
            lastReadSequence: 0,
            updatedAt: occurredAt,
          },
          currentPreference: {
            conversationId: conversation.id,
            userId: scope.identity.userId,
            notificationPreference: "all",
            isStarred: false,
            mute: { muted: false },
            updatedAt: occurredAt,
          },
          activeMemberUserIds: memberUserIds,
          memberUserIds,
        },
        _meta: {
          ...lifecycleState.metadata,
          feature: {
            name: CONVERSATION_SNAPSHOT_FEATURE,
            version: CONVERSATION_SNAPSHOT_VERSION,
          },
        },
      };
    }
    try {
      return parseConversationCreationResult({
        operation: "create_conversation",
        type: request.type,
        reconciliationStatus: "replayed",
        clientRequestId: request.clientRequestId,
        conversation: detail,
        ...(request.type === "channel"
          ? {}
          : {
              participantIdentity: deriveCanonicalParticipantIdentity(
                scope.identity.userId,
                request.intendedMemberUserIds,
              ),
            }),
      }, request);
    } catch {
      return undefined;
    }
  };

  const resolveConversationCreationWaiters = (
    idempotencyKey: string,
    result: ChatCommandResult<ConversationCreationResult>,
  ): void => {
    const waiters = conversationCreationResultWaiters.get(idempotencyKey);
    if (waiters === undefined) return;
    conversationCreationResultWaiters.delete(idempotencyKey);
    for (const resolve of waiters) resolve(result);
  };

  const waitForConversationCreationResult = (
    idempotencyKey: string,
  ): Promise<ChatCommandResult<ConversationCreationResult>> =>
    new Promise((resolve) => {
      const waiters = conversationCreationResultWaiters.get(idempotencyKey) ??
        new Set();
      waiters.add(resolve);
      conversationCreationResultWaiters.set(idempotencyKey, waiters);
    });

  const conversationCreationResultIsTerminal = (
    result: ChatCommandResult<ConversationCreationResult>,
  ): boolean => result.status === "validation" ||
    result.status === "authentication" ||
    result.status === "conflict" ||
    result.status === "feature_disabled" ||
    result.status === "unsupported" ||
    result.status === "rejected";

  const settleConversationCreationResult = async (
    scope: DurableConversationCreationScope,
    intent: DurableConversationCreationIntent,
    result: ChatCommandResult<ConversationCreationResult>,
  ): Promise<ChatCommandResult<ConversationCreationResult>> => {
    if (!conversationCreationScopeIsActive(scope)) return PREFERENCE_CLOSED_RESULT;
    if (result.status === "success") {
      try {
        cache.reconcileConversationCreation(
          conversationCreationLogicalKey(intent.request),
          intent.request,
          result.value,
        );
      } catch {
        return SEND_MALFORMED_RESPONSE;
      }
      await removeConversationCreationIntent(scope, intent);
    } else if (conversationCreationResultIsTerminal(result)) {
      await removeConversationCreationIntent(scope, intent);
    }
    return result;
  };

  const executeDurableConversationCreation = async (
    scope: DurableConversationCreationScope,
    intent: DurableConversationCreationIntent,
  ): Promise<ChatCommandResult<ConversationCreationResult> | undefined> => {
    const key = intent.request.idempotencyKey;
    if (activeConversationCreations.has(key)) {
      return waitForConversationCreationResult(key);
    }
    if (!conversationCreationScopeIsActive(scope)) return PREFERENCE_CLOSED_RESULT;
    const canonical = conversationCreationResultFromState(scope, intent.request);
    if (canonical !== undefined) {
      const result = Object.freeze({ status: "success" as const, value: canonical });
      if (await removeConversationCreationIntent(scope, intent)) {
        resolveConversationCreationWaiters(key, result);
      }
      return result;
    }
    try {
      cache.beginConversationOperation(Object.freeze({
        logicalKey: conversationCreationLogicalKey(intent.request),
        idempotencyKey: key,
        family: "creation",
        clientRequestId: intent.request.clientRequestId,
      }));
    } catch {
      return undefined;
    }
    const controller = new AbortController();
    let resolveCanonicalResult!: (
      result: ChatCommandResult<ConversationCreationResult>,
    ) => void;
    const canonicalResult = new Promise<ChatCommandResult<ConversationCreationResult>>(
      (resolve) => { resolveCanonicalResult = resolve; },
    );
    const active = Object.freeze({
      controller,
      canonicalResult,
      resolveCanonicalResult,
    });
    activeConversationCreations.set(key, active);
    let result: ChatCommandResult<ConversationCreationResult> | undefined;
    try {
      const descriptor = createConversationDescriptor(intent.request);
      const dispatch = () => commandDispatcher.dispatch(descriptor, intent.request, {
        idempotencyKey: key,
        signal: controller.signal,
      });
      const coordinatedDispatch = coordinator === undefined ||
          coordinationStatus?.role === "fallback"
        ? dispatch()
        : coordinator.coordinateCommand({
            command: "conversation.create",
            idempotencyKey: key,
            execute: dispatch,
            parseResult: (value) => parseCoordinatedCommandResult(descriptor, value),
          });
      result = await Promise.race([coordinatedDispatch, canonicalResult]);
      if (!conversationCreationScopeIsActive(scope)) {
        return PREFERENCE_CLOSED_RESULT;
      }
      result = await settleConversationCreationResult(scope, intent, result);
      return result;
    } finally {
      if (activeConversationCreations.get(key) === active) {
        activeConversationCreations.delete(key);
      }
      if (result !== undefined) resolveConversationCreationWaiters(key, result);
    }
  };

  const retainedConversationCreationRecoveryPermitted = (): boolean =>
    lifecycleState.state === "ready" &&
    currentConversationCreationScope() !== undefined &&
    ownsRetainedSendRecovery() &&
    (realtimeSession === undefined || realtimeSession.state.state === "connected");

  const retainedConversationCreationDelay = (retryNumber: number): number =>
    Math.min(
      retainedConversationCreationMaximumDelayMs,
      retainedConversationCreationInitialDelayMs *
        retainedConversationCreationRetryMultiplier ** Math.max(0, retryNumber - 1),
    );

  const runRetainedConversationCreationPump = async (
    epoch: number,
  ): Promise<void> => {
    while (
      epoch === retainedConversationCreationRecoveryEpoch &&
      retainedConversationCreationRecoveryPermitted()
    ) {
      const scope = currentConversationCreationScope();
      if (scope === undefined || scope.epoch !== epoch) return;
      const intent = retainedConversationCreationIntents[0];
      if (intent === undefined) return;
      const result = await executeDurableConversationCreation(scope, intent);
      if (!conversationCreationScopeIsActive(scope)) return;
      if (!retainedConversationCreationIntents.some((candidate) =>
        sameConversationCreationIntent(candidate, intent))) {
        retainedConversationCreationRetryNumber = 0;
        continue;
      }
      if (result?.status === "closed") return;
      retainedConversationCreationRetryNumber += 1;
      const controller = new AbortController();
      retainedConversationCreationRetryController = controller;
      try {
        await retainedConversationCreationWait(
          retainedConversationCreationDelay(retainedConversationCreationRetryNumber),
          controller.signal,
        );
      } catch {
        return;
      } finally {
        if (retainedConversationCreationRetryController === controller) {
          retainedConversationCreationRetryController = undefined;
        }
      }
    }
  };

  const startRetainedConversationCreationRecovery = (): void => {
    if (
      !retainedConversationCreationRecoveryPermitted() ||
      retainedConversationCreationPump !== undefined
    ) return;
    const epoch = retainedConversationCreationRecoveryEpoch;
    const pump = runRetainedConversationCreationPump(epoch)
      .catch(() => undefined)
      .finally(() => {
        if (retainedConversationCreationPump === pump) {
          retainedConversationCreationPump = undefined;
        }
      });
    retainedConversationCreationPump = pump;
  };

  requestRetainedConversationCreationRecovery = (): void =>
    startRetainedConversationCreationRecovery();

  pauseRetainedConversationCreationRecovery = (): void => {
    retainedConversationCreationRecoveryEpoch += 1;
    retainedConversationCreationPump = undefined;
    retainedConversationCreationRetryNumber = 0;
    retainedConversationCreationRetryController?.abort();
    retainedConversationCreationRetryController = undefined;
    for (const active of activeConversationCreations.values()) {
      active.controller.abort();
    }
    activeConversationCreations.clear();
  };

  activateRetainedConversationCreationRecovery = async (
    generation,
    identity,
  ): Promise<void> => {
    const scope = Object.freeze({
      generation,
      epoch: retainedConversationCreationRecoveryEpoch,
      identity,
    });
    await reloadConversationCreationRecord(scope);
  };

  resumeRetainedConversationCreationRecoveryFromStorage = (announcement): void => {
    if (
      announcement !== undefined &&
      announcement.command !== "conversation.create"
    ) return;
    const identity = activePersistenceIdentity;
    const generation = persistenceGeneration;
    if (identity === undefined || !ownsRetainedSendRecovery()) return;
    void activateRetainedConversationCreationRecovery(generation, identity).then(() => {
      if (
        !persistenceScopeIsActive(generation, identity) ||
        !ownsRetainedSendRecovery() ||
        (announcement !== undefined && !retainedConversationCreationIntents.some(
          (intent) => intent.request.idempotencyKey === announcement.idempotencyKey,
        ))
      ) return;
      requestRetainedConversationCreationRecovery();
    }).catch(() => undefined);
  };

  handleRetainedConversationCreationCoordinatedResult = (
    command,
    idempotencyKey,
    value,
  ): void => {
    if (command !== "conversation.create") return;
    const intent = retainedConversationCreationIntents.find(
      (candidate) => candidate.request.idempotencyKey === idempotencyKey,
    );
    const scope = currentConversationCreationScope();
    if (intent === undefined || scope === undefined) return;
    const result = parseCoordinatedCommandResult(
      createConversationDescriptor(intent.request),
      value,
    );
    if (result === undefined) return;
    void settleConversationCreationResult(scope, intent, result).then((settled) => {
      if (!conversationCreationScopeIsActive(scope)) return;
      resolveConversationCreationWaiters(idempotencyKey, settled);
      requestRetainedConversationCreationRecovery();
    });
  };

  handleRetainedConversationCreationCanonicalEvent = (event): void => {
    if (
      event.type !== "conversation.created" ||
      !isRecord(event.payload) ||
      typeof event.payload.clientRequestId !== "string"
    ) return;
    const scope = currentConversationCreationScope();
    if (scope === undefined || event.tenantId !== scope.identity.tenantId) return;
    const clientRequestId = event.payload.clientRequestId;
    const intent = retainedConversationCreationIntents.find((candidate) =>
      candidate.request.clientRequestId === clientRequestId);
    if (intent === undefined) return;
    const value = conversationCreationResultFromEvent(scope, intent.request, event);
    if (value === undefined) return;
    const result = Object.freeze({ status: "success" as const, value });
    void removeConversationCreationIntent(scope, intent).then((removed) => {
      if (!removed || !conversationCreationScopeIsActive(scope)) return;
      const active = activeConversationCreations.get(intent.request.idempotencyKey);
      active?.resolveCanonicalResult(result);
      active?.controller.abort();
      resolveConversationCreationWaiters(intent.request.idempotencyKey, result);
      requestRetainedConversationCreationRecovery();
    });
  };

  cache.subscribePrivateStateBoundary(() => {
    pauseRetainedConversationCreationRecovery();
    for (const intent of retainedConversationCreationIntents) {
      cache.settleConversationOperation(
        conversationCreationLogicalKey(intent.request),
      );
    }
    retainedConversationCreationIntents = Object.freeze([]);
    for (const waiters of conversationCreationResultWaiters.values()) {
      for (const resolve of waiters) resolve(PREFERENCE_CLOSED_RESULT);
    }
    conversationCreationResultWaiters.clear();
  });

  interface DurableMembershipScope {
    readonly generation: number;
    readonly epoch: number;
    readonly identity: ApplicationChatStorageIdentity;
  }

  let membershipMutationChain: Promise<void> = Promise.resolve();
  let retainedMembershipRecoveryEpoch = 0;
  let retainedMembershipPump: Promise<void> | undefined;
  let retainedMembershipRetryNumber = 0;
  let retainedMembershipRetryController: AbortController | undefined;
  const activeMembershipControllers = new Map<string, AbortController>();
  const membershipResultWaiters = new Map<
    string,
    Set<(result: ChatCommandResult<ConversationMembershipMutationResult>) => void>
  >();

  const serializeMembershipMutation = <Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> => {
    const result = membershipMutationChain.then(operation);
    membershipMutationChain = result.then(() => undefined, () => undefined);
    return result;
  };

  const membershipScopeIsActive = (scope: DurableMembershipScope): boolean => {
    const cacheIdentity = cache.getState().identity;
    return scope.epoch === retainedMembershipRecoveryEpoch &&
      persistenceScopeIsActive(scope.generation, scope.identity) &&
      cacheIdentity !== null &&
      cacheIdentity.tenantId === scope.identity.tenantId &&
      cacheIdentity.userId === scope.identity.userId;
  };

  const currentMembershipScope = (): DurableMembershipScope | undefined =>
    activePersistenceIdentity === undefined
      ? undefined
      : Object.freeze({
          generation: persistenceGeneration,
          epoch: retainedMembershipRecoveryEpoch,
          identity: activePersistenceIdentity,
        });

  const sameMembershipRequest = (
    left: ConversationMembershipMutationInput,
    right: ConversationMembershipMutationInput,
  ): boolean => left.intent === right.intent &&
    left.conversationId === right.conversationId &&
    left.expectedMemberListRevision === right.expectedMemberListRevision &&
    left.idempotencyKey === right.idempotencyKey &&
    ("targetUserId" in left ? left.targetUserId : undefined) ===
      ("targetUserId" in right ? right.targetUserId : undefined) &&
    ("requestedRole" in left ? left.requestedRole : undefined) ===
      ("requestedRole" in right ? right.requestedRole : undefined);

  const sameMembershipIntent = (
    left: DurableMembershipIntent,
    right: DurableMembershipIntent,
  ): boolean => left.enqueueOrder === right.enqueueOrder &&
    left.enqueuedAt === right.enqueuedAt &&
    sameMembershipRequest(left.request, right.request);

  const readMembershipRecord = async (
    scope: DurableMembershipScope,
  ): Promise<ApplicationChatQueuedConversationMembershipIntentsRecord | null> => {
    if (!membershipScopeIsActive(scope) || normalizedCachePersistence === undefined) {
      throw new Error("inactive durable membership scope");
    }
    const record = await normalizedCachePersistence.storage.read(
      scope.identity,
      ApplicationChatStorageRecordKind.queuedConversationMembershipIntents,
    );
    if (!membershipScopeIsActive(scope)) {
      throw new Error("inactive durable membership scope");
    }
    return record;
  };

  const publishRetainedMemberships = (
    record: ApplicationChatQueuedConversationMembershipIntentsRecord | null,
  ): void => {
    retainedMembershipIntents = Object.freeze([...(record?.intents ?? [])]);
  };

  const mutateMembershipRecord = async (
    scope: DurableMembershipScope,
    updater: (
      current: ApplicationChatQueuedConversationMembershipIntentsRecord | null,
    ) => ApplicationChatQueuedConversationMembershipIntentsRecord | null,
  ): Promise<ApplicationChatQueuedConversationMembershipIntentsRecord | null> => {
    if (!membershipScopeIsActive(scope) || normalizedCachePersistence === undefined) {
      throw new Error("inactive durable membership scope");
    }
    const committed = await normalizedCachePersistence.storage.mutate(
      scope.identity,
      ApplicationChatStorageRecordKind.queuedConversationMembershipIntents,
      (current) => {
        if (!membershipScopeIsActive(scope)) {
          throw new Error("inactive durable membership scope");
        }
        return updater(current);
      },
    );
    if (!membershipScopeIsActive(scope)) {
      throw new Error("inactive durable membership scope");
    }
    publishRetainedMemberships(committed);
    return committed;
  };

  const reloadMembershipRecord = (
    scope: DurableMembershipScope,
  ): Promise<boolean> => serializeMembershipMutation(async () => {
    try {
      const record = await readMembershipRecord(scope);
      publishRetainedMemberships(record);
      return true;
    } catch (error) {
      if (!membershipScopeIsActive(scope)) return false;
      if (error instanceof ApplicationChatStorageValidationError) {
        reportPersistenceDiagnostic(
          "membership_intents_rejected",
          "The stored conversation-membership intents were rejected and quarantined.",
        );
        publishRetainedMemberships(null);
      } else {
        reportPersistenceDiagnostic(
          "membership_intents_read_failed",
          "The stored conversation-membership intents could not be read.",
        );
      }
      return false;
    }
  });

  const persistMembershipIntent = (
    scope: DurableMembershipScope,
    input: ConversationMembershipMutationInput,
  ): Promise<DurableMembershipIntent | undefined> =>
    serializeMembershipMutation(async () => {
      try {
        const enqueuedAt = new Date().toISOString() as IsoTimestamp;
        const committed = await mutateMembershipRecord(scope, (current) => {
          const enqueueOrder = (current?.intents.reduce(
            (highest, intent) => Math.max(highest, intent.enqueueOrder),
            0,
          ) ?? 0) + 1;
          const intent = createApplicationChatQueuedConversationMembershipIntent(
            input,
            {
              enqueueOrder,
              enqueuedAt,
            },
          );
          return createApplicationChatQueuedConversationMembershipIntentsRecord(
            scope.identity,
            [...(current?.intents ?? []), intent],
          );
        });
        return committed?.intents.find((candidate) =>
          sameMembershipRequest(candidate.request, input));
      } catch {
        if (membershipScopeIsActive(scope)) {
          reportPersistenceDiagnostic(
            "membership_intents_write_failed",
            "The conversation-membership command could not be stored before dispatch.",
          );
        }
        return undefined;
      }
    });

  const removeMembershipIntent = (
    scope: DurableMembershipScope,
    intent: DurableMembershipIntent,
  ): Promise<boolean> => serializeMembershipMutation(async () => {
    if (!membershipScopeIsActive(scope) || normalizedCachePersistence === undefined) {
      return false;
    }
    try {
      await mutateMembershipRecord(scope, (current) => {
        if (current === null) return null;
        const remaining = current.intents.filter((candidate) =>
          !sameMembershipIntent(candidate, intent));
        if (remaining.length === current.intents.length) return current;
        return remaining.length === 0
          ? null
          : createApplicationChatQueuedConversationMembershipIntentsRecord(
              scope.identity,
              remaining,
            );
      });
      if (!membershipScopeIsActive(scope)) return false;
      cache.settleConversationOperation(
        conversationMembershipLogicalKey(intent.request),
      );
      return true;
    } catch {
      if (membershipScopeIsActive(scope)) {
        reportPersistenceDiagnostic(
          "membership_intents_write_failed",
          "A settled conversation-membership command could not be removed from storage.",
        );
      }
      return false;
    }
  });

  const membershipStateConverges = (
    scope: DurableMembershipScope,
    request: ConversationMembershipMutationInput,
  ): boolean => {
    if (!membershipScopeIsActive(scope)) return false;
    const state = cache.getState();
    const revision = state.metadata.memberListRevisions[request.conversationId];
    if (revision === undefined || revision < request.expectedMemberListRevision) {
      return false;
    }
    const activeIds = state.entities.memberUserIdsByConversation[request.conversationId];
    const members = state.entities.membersByConversation[request.conversationId];
    if (request.intent === "join") {
      return state.currentUser.memberships[request.conversationId]?.state === "active";
    }
    if (request.intent === "leave") {
      const membership = state.currentUser.memberships[request.conversationId];
      return membership !== undefined
        ? membership.state !== "active"
        : activeIds !== undefined && !activeIds.includes(scope.identity.userId);
    }
    if (request.intent === "remove_member") {
      return activeIds !== undefined && !activeIds.includes(request.targetUserId);
    }
    const target = members?.[request.targetUserId];
    return target?.state === "active" && target.role === request.requestedRole;
  };

  const membershipAuthorityIsReady = (
    scope: DurableMembershipScope,
    request: ConversationMembershipMutationInput,
  ): boolean => {
    if (!membershipScopeIsActive(scope)) return false;
    const state = cache.getState();
    return state.entities.conversations[request.conversationId] !== undefined &&
      (state.metadata.memberListRevisions[request.conversationId] ?? -1) >=
        request.expectedMemberListRevision;
  };

  const refreshMembershipAuthority = async (
    scope: DurableMembershipScope,
    request: ConversationMembershipMutationInput,
    signal: AbortSignal,
  ): Promise<boolean> => {
    if (!membershipScopeIsActive(scope) || signal.aborted) return false;
    const result = await snapshotReader.getConversation<Feature>(
      { conversationId: request.conversationId },
      { signal },
    );
    return membershipScopeIsActive(scope) &&
      !signal.aborted &&
      result.status === "success" &&
      membershipAuthorityIsReady(scope, request);
  };

  const resolveMembershipWaiters = (
    idempotencyKey: string,
    result: ChatCommandResult<ConversationMembershipMutationResult>,
  ): void => {
    const waiters = membershipResultWaiters.get(idempotencyKey);
    if (waiters === undefined) return;
    membershipResultWaiters.delete(idempotencyKey);
    for (const resolve of waiters) resolve(result);
  };

  const waitForMembershipResult = (
    idempotencyKey: string,
  ): Promise<ChatCommandResult<ConversationMembershipMutationResult>> =>
    new Promise((resolve) => {
      const waiters = membershipResultWaiters.get(idempotencyKey) ?? new Set();
      waiters.add(resolve);
      membershipResultWaiters.set(idempotencyKey, waiters);
    });

  const membershipResultIsTerminal = (
    result: ChatCommandResult<ConversationMembershipMutationResult>,
  ): boolean => result.status === "validation" ||
    result.status === "authentication" ||
    result.status === "conflict" ||
    result.status === "feature_disabled" ||
    result.status === "unsupported" ||
    result.status === "rejected" ||
    (result.status === "success" &&
      (result.value.reconciliationStatus === "member_list_conflict" ||
        result.value.reconciliationStatus === "safety_rejected"));

  const settleMembershipResult = async (
    scope: DurableMembershipScope,
    intent: DurableMembershipIntent,
    result: ChatCommandResult<ConversationMembershipMutationResult>,
    controller: AbortController,
  ): Promise<ChatCommandResult<ConversationMembershipMutationResult>> => {
    if (!membershipScopeIsActive(scope)) return PREFERENCE_CLOSED_RESULT;
    if (result.status === "success" && !membershipResultIsTerminal(result)) {
      try {
        cache.reconcileConversationMembership(
          conversationMembershipLogicalKey(intent.request),
          intent.request,
          result.value,
        );
      } catch {
        return SEND_MALFORMED_RESPONSE;
      }
      await removeMembershipIntent(scope, intent);
    } else if (membershipResultIsTerminal(result)) {
      await refreshMembershipAuthority(
        scope,
        intent.request,
        controller.signal,
      ).catch(() => false);
      if (!membershipScopeIsActive(scope)) return PREFERENCE_CLOSED_RESULT;
      await removeMembershipIntent(scope, intent);
    }
    return result;
  };

  const executeDurableMembership = async (
    scope: DurableMembershipScope,
    intent: DurableMembershipIntent,
  ): Promise<ChatCommandResult<ConversationMembershipMutationResult> | undefined> => {
    const key = intent.request.idempotencyKey;
    if (activeMembershipControllers.has(key)) {
      return waitForMembershipResult(key);
    }
    if (!membershipScopeIsActive(scope)) return PREFERENCE_CLOSED_RESULT;
    const controller = new AbortController();
    activeMembershipControllers.set(key, controller);
    let result: ChatCommandResult<ConversationMembershipMutationResult> | undefined;
    try {
      if (
        !membershipAuthorityIsReady(scope, intent.request) &&
        !await refreshMembershipAuthority(
          scope,
          intent.request,
          controller.signal,
        ).catch(() => false)
      ) return undefined;
      if (!membershipScopeIsActive(scope)) return PREFERENCE_CLOSED_RESULT;
      if (
        membershipStateConverges(scope, intent.request) &&
        !membershipResultWaiters.has(key)
      ) {
        await removeMembershipIntent(scope, intent);
        return undefined;
      }
      try {
        cache.beginConversationOperation(Object.freeze({
          logicalKey: conversationMembershipLogicalKey(intent.request),
          idempotencyKey: key,
          family: "membership",
          conversationId: intent.request.conversationId,
        }));
      } catch {
        return undefined;
      }
      const descriptor = createConversationMembershipDescriptor(intent.request);
      const dispatch = () => commandDispatcher.dispatch(
        descriptor,
        intent.request,
        { idempotencyKey: key, signal: controller.signal },
      );
      result = coordinator === undefined || coordinationStatus?.role === "fallback"
        ? await dispatch()
        : await coordinator.coordinateCommand({
            command: "conversation.membership.mutate",
            idempotencyKey: key,
            execute: dispatch,
            parseResult: (value) => parseCoordinatedCommandResult(descriptor, value),
          });
      result = await settleMembershipResult(scope, intent, result, controller);
      return result;
    } finally {
      if (activeMembershipControllers.get(key) === controller) {
        activeMembershipControllers.delete(key);
      }
      if (result !== undefined) resolveMembershipWaiters(key, result);
    }
  };

  const retainedMembershipRecoveryPermitted = (): boolean =>
    lifecycleState.state === "ready" &&
    currentMembershipScope() !== undefined &&
    ownsRetainedSendRecovery() &&
    (realtimeSession === undefined || realtimeSession.state.state === "connected");

  const retainedMembershipDelay = (retryNumber: number): number =>
    Math.min(
      retainedMembershipMaximumDelayMs,
      retainedMembershipInitialDelayMs *
        retainedMembershipRetryMultiplier ** Math.max(0, retryNumber - 1),
    );

  const runRetainedMembershipPump = async (epoch: number): Promise<void> => {
    while (
      epoch === retainedMembershipRecoveryEpoch &&
      retainedMembershipRecoveryPermitted()
    ) {
      const scope = currentMembershipScope();
      if (scope === undefined || scope.epoch !== epoch) return;
      const conversations = new Set<string>();
      const heads = retainedMembershipIntents.filter((intent) => {
        if (conversations.has(intent.request.conversationId)) return false;
        conversations.add(intent.request.conversationId);
        return true;
      });
      if (heads.length === 0) return;
      let retryRequired = false;
      let settledAny = false;
      for (const intent of heads) {
        if (!membershipScopeIsActive(scope)) return;
        if (!retainedMembershipIntents.some((candidate) =>
          sameMembershipIntent(candidate, intent))) continue;
        const result = await executeDurableMembership(scope, intent);
        if (!membershipScopeIsActive(scope)) return;
        const retained = retainedMembershipIntents.some((candidate) =>
          sameMembershipIntent(candidate, intent));
        if (retained) retryRequired = true;
        else settledAny = true;
        if (
          result?.status === "aborted" ||
          result?.status === "closed"
        ) return;
      }
      if (!retryRequired) {
        retainedMembershipRetryNumber = 0;
        if (!settledAny) return;
        continue;
      }
      retainedMembershipRetryNumber += 1;
      const controller = new AbortController();
      retainedMembershipRetryController = controller;
      try {
        await retainedMembershipWait(
          retainedMembershipDelay(retainedMembershipRetryNumber),
          controller.signal,
        );
      } catch {
        return;
      } finally {
        if (retainedMembershipRetryController === controller) {
          retainedMembershipRetryController = undefined;
        }
      }
    }
  };

  const startRetainedMembershipRecovery = (): void => {
    if (
      !retainedMembershipRecoveryPermitted() ||
      retainedMembershipPump !== undefined
    ) return;
    const epoch = retainedMembershipRecoveryEpoch;
    const pump = runRetainedMembershipPump(epoch)
      .catch(() => undefined)
      .finally(() => {
        if (retainedMembershipPump === pump) retainedMembershipPump = undefined;
      });
    retainedMembershipPump = pump;
  };

  requestRetainedMembershipRecovery = (): void =>
    startRetainedMembershipRecovery();

  pauseRetainedMembershipRecovery = (): void => {
    retainedMembershipRecoveryEpoch += 1;
    retainedMembershipPump = undefined;
    retainedMembershipRetryNumber = 0;
    retainedMembershipRetryController?.abort();
    retainedMembershipRetryController = undefined;
    for (const controller of activeMembershipControllers.values()) {
      controller.abort();
    }
    activeMembershipControllers.clear();
  };

  activateRetainedMembershipRecovery = async (
    generation,
    identity,
  ): Promise<void> => {
    const scope = Object.freeze({
      generation,
      epoch: retainedMembershipRecoveryEpoch,
      identity,
    });
    await reloadMembershipRecord(scope);
  };

  resumeRetainedMembershipRecoveryFromStorage = (announcement): void => {
    if (
      announcement !== undefined &&
      announcement.command !== "conversation.membership.mutate"
    ) return;
    const identity = activePersistenceIdentity;
    const generation = persistenceGeneration;
    if (identity === undefined || !ownsRetainedSendRecovery()) return;
    void activateRetainedMembershipRecovery(generation, identity).then(() => {
      if (
        !persistenceScopeIsActive(generation, identity) ||
        !ownsRetainedSendRecovery() ||
        (announcement !== undefined && !retainedMembershipIntents.some(
          (intent) => intent.request.idempotencyKey === announcement.idempotencyKey,
        ))
      ) return;
      requestRetainedMembershipRecovery();
    }).catch(() => undefined);
  };

  handleRetainedMembershipCoordinatedResult = (
    command,
    idempotencyKey,
    value,
  ): void => {
    if (command !== "conversation.membership.mutate") return;
    const intent = retainedMembershipIntents.find(
      (candidate) => candidate.request.idempotencyKey === idempotencyKey,
    );
    const scope = currentMembershipScope();
    if (intent === undefined || scope === undefined) return;
    const result = parseCoordinatedCommandResult(
      createConversationMembershipDescriptor(intent.request),
      value,
    );
    if (result === undefined) return;
    const controller = new AbortController();
    void settleMembershipResult(scope, intent, result, controller).then((settled) => {
      if (!membershipScopeIsActive(scope)) return;
      resolveMembershipWaiters(idempotencyKey, settled);
      requestRetainedMembershipRecovery();
    }).finally(() => controller.abort());
  };

  handleRetainedMembershipCanonicalEvent = (event): void => {
    if (
      event.type !== "conversation.membership.updated" ||
      !isRecord(event.payload)
    ) return;
    const scope = currentMembershipScope();
    if (scope === undefined) return;
    let input: ConversationMembershipMutationInput;
    let value: ConversationMembershipMutationResult;
    try {
      input = parseConversationMembershipMutationInput(event.payload.input);
      const intent = retainedMembershipIntents.find((candidate) =>
        sameMembershipRequest(candidate.request, input));
      if (intent === undefined) return;
      value = parseConversationMembershipMutationResult(
        event.payload.result,
        intent.request,
      );
      const result = Object.freeze({ status: "success" as const, value });
      const existing = activeMembershipControllers.get(
        intent.request.idempotencyKey,
      );
      const controller = existing ?? new AbortController();
      if (existing === undefined) {
        activeMembershipControllers.set(
          intent.request.idempotencyKey,
          controller,
        );
      }
      void settleMembershipResult(scope, intent, result, controller).then(
        (settled) => {
          if (!membershipScopeIsActive(scope)) return;
          resolveMembershipWaiters(intent.request.idempotencyKey, settled);
          requestRetainedMembershipRecovery();
        },
      ).finally(() => {
        if (
          existing === undefined &&
          activeMembershipControllers.get(intent.request.idempotencyKey) === controller
        ) activeMembershipControllers.delete(intent.request.idempotencyKey);
      });
    } catch {
      // Malformed or unrelated events cannot settle durable work.
    }
  };

  cache.subscribePrivateStateBoundary(() => {
    pauseRetainedMembershipRecovery();
    for (const intent of retainedMembershipIntents) {
      cache.settleConversationOperation(
        conversationMembershipLogicalKey(intent.request),
      );
    }
    retainedMembershipIntents = Object.freeze([]);
    for (const waiters of membershipResultWaiters.values()) {
      for (const resolve of waiters) resolve(PREFERENCE_CLOSED_RESULT);
    }
    membershipResultWaiters.clear();
  });

  interface DurableConversationPreferenceScope {
    readonly generation: number;
    readonly epoch: number;
    readonly identity: ApplicationChatStorageIdentity;
  }

  interface ActiveConversationPreference {
    readonly controller: AbortController;
    readonly canonicalResult: Promise<ChatUpdateConversationPreferenceResult>;
    readonly resolveCanonicalResult: (
      result: ChatUpdateConversationPreferenceResult,
    ) => void;
  }

  type ConversationPreferenceAuthorityDecision =
    | { readonly state: "retry" | "dispatch" }
    | {
        readonly state: "settled" | "conflict";
        readonly result: ChatUpdateConversationPreferenceResult;
      };

  let conversationPreferenceMutationChain: Promise<void> = Promise.resolve();
  let retainedConversationPreferenceRecoveryEpoch = 0;
  let retainedConversationPreferencePump: Promise<void> | undefined;
  let retainedConversationPreferenceRetryNumber = 0;
  let retainedConversationPreferenceRetryController: AbortController | undefined;
  const activeConversationPreferences = new Map<
    string,
    ActiveConversationPreference
  >();
  const conversationPreferenceResultWaiters = new Map<
    string,
    Set<(result: ChatUpdateConversationPreferenceResult) => void>
  >();

  const serializeConversationPreferenceMutation = <Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> => {
    const result = conversationPreferenceMutationChain.then(operation);
    conversationPreferenceMutationChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const conversationPreferenceScopeIsActive = (
    scope: DurableConversationPreferenceScope,
  ): boolean => {
    const cacheIdentity = cache.getState().identity;
    return scope.epoch === retainedConversationPreferenceRecoveryEpoch &&
      persistenceScopeIsActive(scope.generation, scope.identity) &&
      cacheIdentity !== null &&
      cacheIdentity.tenantId === scope.identity.tenantId &&
      cacheIdentity.userId === scope.identity.userId;
  };

  const currentConversationPreferenceScope = (
  ): DurableConversationPreferenceScope | undefined =>
    activePersistenceIdentity === undefined
      ? undefined
      : Object.freeze({
          generation: persistenceGeneration,
          epoch: retainedConversationPreferenceRecoveryEpoch,
          identity: activePersistenceIdentity,
        });

  const sameConversationPreferenceRequest = (
    left: UpdateConversationPreferenceInput,
    right: UpdateConversationPreferenceInput,
  ): boolean => JSON.stringify(left) === JSON.stringify(right);

  const sameConversationPreferenceIntent = (
    left: DurableConversationPreferenceIntent,
    right: DurableConversationPreferenceIntent,
  ): boolean => left.enqueueOrder === right.enqueueOrder &&
    left.enqueuedAt === right.enqueuedAt &&
    sameConversationPreferenceRequest(left.request, right.request);

  const readConversationPreferenceRecord = async (
    scope: DurableConversationPreferenceScope,
  ): Promise<ApplicationChatQueuedConversationPreferenceIntentsRecord | null> => {
    if (
      !conversationPreferenceScopeIsActive(scope) ||
      normalizedCachePersistence === undefined
    ) {
      throw new Error("inactive durable conversation-preference scope");
    }
    const record = await normalizedCachePersistence.storage.read(
      scope.identity,
      ApplicationChatStorageRecordKind.queuedConversationPreferenceIntents,
    );
    if (!conversationPreferenceScopeIsActive(scope)) {
      throw new Error("inactive durable conversation-preference scope");
    }
    return record;
  };

  const publishRetainedConversationPreferences = (
    record: ApplicationChatQueuedConversationPreferenceIntentsRecord | null,
  ): void => {
    const next = Object.freeze([...(record?.intents ?? [])]);
    for (const previous of retainedConversationPreferenceIntents) {
      const superseded = next.some((intent) =>
        intent.request.conversationId === previous.request.conversationId &&
        intent.request.idempotencyKey !== previous.request.idempotencyKey);
      if (!superseded) continue;
      cache.rollbackOptimisticConversationPreference(
        previous.request.conversationId,
        previous.request.idempotencyKey,
      );
      const active = activeConversationPreferences.get(
        previous.request.idempotencyKey,
      );
      active?.resolveCanonicalResult(PREFERENCE_CLOSED_RESULT);
      active?.controller.abort();
      resolveConversationPreferenceWaiters(
        previous.request.idempotencyKey,
        PREFERENCE_CLOSED_RESULT,
      );
    }
    retainedConversationPreferenceIntents = next;
  };

  const mutateConversationPreferenceRecord = async (
    scope: DurableConversationPreferenceScope,
    updater: (
      current: ApplicationChatQueuedConversationPreferenceIntentsRecord | null,
    ) => ApplicationChatQueuedConversationPreferenceIntentsRecord | null,
  ): Promise<ApplicationChatQueuedConversationPreferenceIntentsRecord | null> => {
    if (
      !conversationPreferenceScopeIsActive(scope) ||
      normalizedCachePersistence === undefined
    ) {
      throw new Error("inactive durable conversation-preference scope");
    }
    const committed = await normalizedCachePersistence.storage.mutate(
      scope.identity,
      ApplicationChatStorageRecordKind.queuedConversationPreferenceIntents,
      (current) => {
        if (!conversationPreferenceScopeIsActive(scope)) {
          throw new Error("inactive durable conversation-preference scope");
        }
        return updater(current);
      },
    );
    if (!conversationPreferenceScopeIsActive(scope)) {
      throw new Error("inactive durable conversation-preference scope");
    }
    publishRetainedConversationPreferences(committed);
    return committed;
  };

  const reloadConversationPreferenceRecord = (
    scope: DurableConversationPreferenceScope,
  ): Promise<boolean> => serializeConversationPreferenceMutation(async () => {
    try {
      const record = await readConversationPreferenceRecord(scope);
      publishRetainedConversationPreferences(record);
      return true;
    } catch (error) {
      if (!conversationPreferenceScopeIsActive(scope)) return false;
      if (error instanceof ApplicationChatStorageValidationError) {
        reportPersistenceDiagnostic(
          "conversation_preference_intents_rejected",
          "The stored conversation-preference intents were rejected and quarantined.",
        );
        publishRetainedConversationPreferences(null);
      } else {
        reportPersistenceDiagnostic(
          "conversation_preference_intents_read_failed",
          "The stored conversation-preference intents could not be read.",
        );
      }
      return false;
    }
  });

  const resolveConversationPreferenceWaiters = (
    idempotencyKey: string,
    result: ChatUpdateConversationPreferenceResult,
  ): void => {
    const waiters = conversationPreferenceResultWaiters.get(idempotencyKey);
    if (waiters === undefined) return;
    conversationPreferenceResultWaiters.delete(idempotencyKey);
    for (const resolve of waiters) resolve(result);
  };

  const waitForConversationPreferenceResult = (
    idempotencyKey: string,
  ): Promise<ChatUpdateConversationPreferenceResult> =>
    new Promise((resolve) => {
      const waiters = conversationPreferenceResultWaiters.get(idempotencyKey) ??
        new Set();
      waiters.add(resolve);
      conversationPreferenceResultWaiters.set(idempotencyKey, waiters);
    });

  const persistConversationPreferenceIntent = (
    scope: DurableConversationPreferenceScope,
    input: UpdateConversationPreferenceInput,
    enqueuedAt: IsoTimestamp,
  ): Promise<DurableConversationPreferenceIntent | undefined> =>
    serializeConversationPreferenceMutation(async () => {
      try {
        let superseded: DurableConversationPreferenceIntent | undefined;
        const committed = await mutateConversationPreferenceRecord(
          scope,
          (current) => {
            superseded = current?.intents.find((intent) =>
              intent.request.conversationId === input.conversationId);
            const enqueueOrder = (current?.intents.reduce(
              (highest, intent) => Math.max(highest, intent.enqueueOrder),
              0,
            ) ?? 0) + 1;
            const intent = createApplicationChatQueuedConversationPreferenceIntent(
              input,
              { enqueueOrder, enqueuedAt },
            );
            return createApplicationChatQueuedConversationPreferenceIntentsRecord(
              scope.identity,
              [...(current?.intents ?? []), intent],
            );
          },
        );
        const retained = committed?.intents.find((candidate) =>
          candidate.request.idempotencyKey === input.idempotencyKey);
        if (
          superseded !== undefined &&
          superseded.request.idempotencyKey !== input.idempotencyKey
        ) {
          cache.rollbackOptimisticConversationPreference(
            superseded.request.conversationId,
            superseded.request.idempotencyKey,
          );
          const active = activeConversationPreferences.get(
            superseded.request.idempotencyKey,
          );
          active?.resolveCanonicalResult(PREFERENCE_CLOSED_RESULT);
          active?.controller.abort();
          resolveConversationPreferenceWaiters(
            superseded.request.idempotencyKey,
            PREFERENCE_CLOSED_RESULT,
          );
        }
        return retained;
      } catch {
        if (conversationPreferenceScopeIsActive(scope)) {
          reportPersistenceDiagnostic(
            "conversation_preference_intents_write_failed",
            "The conversation-preference command could not be stored before projection or dispatch.",
          );
        }
        return undefined;
      }
    });

  const removeConversationPreferenceIntent = (
    scope: DurableConversationPreferenceScope,
    intent: DurableConversationPreferenceIntent,
  ): Promise<boolean> => serializeConversationPreferenceMutation(async () => {
    if (
      !conversationPreferenceScopeIsActive(scope) ||
      normalizedCachePersistence === undefined
    ) return false;
    try {
      await mutateConversationPreferenceRecord(scope, (current) => {
        if (current === null) return null;
        const remaining = current.intents.filter((candidate) =>
          !sameConversationPreferenceIntent(candidate, intent));
        if (remaining.length === current.intents.length) return current;
        return remaining.length === 0
          ? null
          : createApplicationChatQueuedConversationPreferenceIntentsRecord(
              scope.identity,
              remaining,
            );
      });
      if (!conversationPreferenceScopeIsActive(scope)) return false;
      cache.rollbackOptimisticConversationPreference(
        intent.request.conversationId,
        intent.request.idempotencyKey,
      );
      return true;
    } catch {
      if (conversationPreferenceScopeIsActive(scope)) {
        reportPersistenceDiagnostic(
          "conversation_preference_intents_write_failed",
          "A settled conversation-preference command could not be removed from storage.",
        );
      }
      return false;
    }
  });

  const conversationPreferencesEqual = (
    desired: UpdateConversationPreferenceInput,
    canonical: ConversationMemberPreference,
  ): boolean => desired.notificationPreference === canonical.notificationPreference &&
    desired.isStarred === canonical.isStarred &&
    desired.mute.muted === canonical.mute.muted &&
    (desired.mute.muted === false ||
      (canonical.mute.muted === true &&
        desired.mute.mutedUntil === canonical.mute.mutedUntil));

  const authoritativeConversationPreference = (
    request: UpdateConversationPreferenceInput,
  ): ConversationMemberPreference | undefined => {
    const state = cache.getState();
    const pending = state.currentUser.pendingPreferenceUpdates[
      request.conversationId
    ];
    return pending?.authoritativePreference ??
      state.currentUser.preferences[request.conversationId];
  };

  const conversationPreferenceAuthorityIsReady = (
    scope: DurableConversationPreferenceScope,
    request: UpdateConversationPreferenceInput,
  ): boolean => {
    if (!conversationPreferenceScopeIsActive(scope)) return false;
    const state = cache.getState();
    return state.entities.conversations[request.conversationId] !== undefined &&
      authoritativeConversationPreference(request) !== undefined &&
      (state.currentUser.preferenceRevisions[request.conversationId] ?? 0) >=
        request.expectedPreferenceRevision;
  };

  const refreshConversationPreferenceAuthority = async (
    scope: DurableConversationPreferenceScope,
    request: UpdateConversationPreferenceInput,
    signal: AbortSignal,
  ): Promise<boolean> => {
    if (!conversationPreferenceScopeIsActive(scope) || signal.aborted) return false;
    const result = await snapshotReader.getConversation<Feature>(
      { conversationId: request.conversationId },
      { signal },
    );
    return conversationPreferenceScopeIsActive(scope) &&
      !signal.aborted &&
      result.status === "success" &&
      conversationPreferenceAuthorityIsReady(scope, request);
  };

  const canonicalConversationPreferenceResult = (
    request: UpdateConversationPreferenceInput,
  ): UpdateConversationPreferenceResult | undefined => {
    const state = cache.getState();
    const preference = authoritativeConversationPreference(request);
    if (preference === undefined) return undefined;
    const preferenceRevision =
      state.currentUser.preferenceRevisions[request.conversationId] ?? 0;
    if (preferenceRevision < request.expectedPreferenceRevision) return undefined;
    try {
      return parseUpdateConversationPreferenceResult({
        operation: "update_conversation_preference",
        reconciliationStatus: preferenceRevision === request.expectedPreferenceRevision
          ? "already_requested_state"
          : "preference_revision_conflict",
        conversationId: request.conversationId,
        expectedPreferenceRevision: request.expectedPreferenceRevision,
        idempotencyKey: request.idempotencyKey,
        requestedPreference: {
          notificationPreference: request.notificationPreference,
          isStarred: request.isStarred,
          mute: request.mute,
        },
        preferenceRevision,
        preference: {
          notificationPreference: preference.notificationPreference,
          isStarred: preference.isStarred,
          mute: preference.mute,
          updatedAt: preference.updatedAt,
        },
      }, request);
    } catch {
      return undefined;
    }
  };

  const decideConversationPreferenceAuthority = (
    scope: DurableConversationPreferenceScope,
    intent: DurableConversationPreferenceIntent,
  ): ConversationPreferenceAuthorityDecision => {
    if (!conversationPreferenceAuthorityIsReady(scope, intent.request)) {
      return { state: "retry" };
    }
    const state = cache.getState();
    const revision =
      state.currentUser.preferenceRevisions[intent.request.conversationId] ?? 0;
    const canonical = authoritativeConversationPreference(intent.request);
    if (canonical === undefined) return { state: "retry" };
    const result = canonicalConversationPreferenceResult(intent.request);
    if (conversationPreferencesEqual(intent.request, canonical)) {
      return result === undefined
        ? { state: "retry" }
        : { state: "settled", result: { status: "success", value: result } };
    }
    if (revision > intent.request.expectedPreferenceRevision) {
      try {
        cache.markConversationPreferenceConflict(intent.request);
      } catch {
        return { state: "retry" };
      }
      return result === undefined
        ? { state: "retry" }
        : { state: "conflict", result: { status: "success", value: result } };
    }
    const pending = state.currentUser.pendingPreferenceUpdates[
      intent.request.conversationId
    ];
    if (
      pending?.idempotencyKey !== intent.request.idempotencyKey ||
      pending.state !== "pending"
    ) {
      try {
        cache.beginOptimisticConversationPreference(
          intent.request,
          new Date(preferenceNow()).toISOString() as IsoTimestamp,
        );
      } catch {
        return { state: "retry" };
      }
    }
    return { state: "dispatch" };
  };

  const conversationPreferenceResultIsTerminal = (
    result: ChatUpdateConversationPreferenceResult,
  ): boolean => result.status === "validation" ||
    result.status === "authentication" ||
    result.status === "conflict" ||
    result.status === "feature_disabled" ||
    result.status === "unsupported" ||
    (result.status === "rejected" && result.httpStatus !== 429);

  const settleConversationPreferenceResult = async (
    scope: DurableConversationPreferenceScope,
    intent: DurableConversationPreferenceIntent,
    result: ChatUpdateConversationPreferenceResult,
  ): Promise<ChatUpdateConversationPreferenceResult> => {
    if (!conversationPreferenceScopeIsActive(scope)) return PREFERENCE_CLOSED_RESULT;
    if (result.status === "success") {
      try {
        cache.reconcileCurrentUserConversationPreference(intent.request, result.value);
      } catch {
        return SEND_MALFORMED_RESPONSE;
      }
      const decision = decideConversationPreferenceAuthority(scope, intent);
      if (decision.state === "settled") {
        await removeConversationPreferenceIntent(scope, intent);
      } else if (decision.state === "conflict") {
        return result;
      } else if (
        result.value.reconciliationStatus !== "preference_revision_conflict"
      ) {
        return SEND_MALFORMED_RESPONSE;
      }
    } else if (conversationPreferenceResultIsTerminal(result)) {
      await removeConversationPreferenceIntent(scope, intent);
    }
    return result;
  };

  const executeDurableConversationPreference = async (
    scope: DurableConversationPreferenceScope,
    intent: DurableConversationPreferenceIntent,
  ): Promise<ChatUpdateConversationPreferenceResult | undefined> => {
    const key = intent.request.idempotencyKey;
    if (activeConversationPreferences.has(key)) {
      return waitForConversationPreferenceResult(key);
    }
    if (!conversationPreferenceScopeIsActive(scope)) return PREFERENCE_CLOSED_RESULT;
    const controller = new AbortController();
    let resolveCanonicalResult!: (
      result: ChatUpdateConversationPreferenceResult,
    ) => void;
    const canonicalResult = new Promise<ChatUpdateConversationPreferenceResult>(
      (resolve) => { resolveCanonicalResult = resolve; },
    );
    const active = Object.freeze({
      controller,
      canonicalResult,
      resolveCanonicalResult,
    });
    activeConversationPreferences.set(key, active);
    let result: ChatUpdateConversationPreferenceResult | undefined;
    try {
      if (
        !conversationPreferenceAuthorityIsReady(scope, intent.request) &&
        !await refreshConversationPreferenceAuthority(
          scope,
          intent.request,
          controller.signal,
        ).catch(() => false)
      ) return undefined;
      if (!conversationPreferenceScopeIsActive(scope)) return PREFERENCE_CLOSED_RESULT;
      const decision = decideConversationPreferenceAuthority(scope, intent);
      if (decision.state === "retry") return undefined;
      if (decision.state === "settled") {
        await removeConversationPreferenceIntent(scope, intent);
        result = decision.result;
        return result;
      }
      if (decision.state === "conflict") {
        result = decision.result;
        return result;
      }
      const descriptor = createConversationPreferenceDescriptor(intent.request);
      const dispatch = () => commandDispatcher.dispatch(descriptor, intent.request, {
          idempotencyKey: key,
          signal: controller.signal,
        });
      const coordinatedDispatch = coordinator === undefined ||
          coordinationStatus?.role === "fallback"
        ? dispatch()
        : coordinator.coordinateCommand({
            command: "conversation.preference.update",
            idempotencyKey: key,
            execute: dispatch,
            parseResult: (value) => parseCoordinatedCommandResult(descriptor, value),
          });
      result = await Promise.race([coordinatedDispatch, canonicalResult]);
      if (!conversationPreferenceScopeIsActive(scope)) {
        return PREFERENCE_CLOSED_RESULT;
      }
      result = await settleConversationPreferenceResult(scope, intent, result);
      return result;
    } finally {
      if (activeConversationPreferences.get(key) === active) {
        activeConversationPreferences.delete(key);
      }
      if (result !== undefined) resolveConversationPreferenceWaiters(key, result);
    }
  };

  const retainedConversationPreferenceRecoveryPermitted = (): boolean =>
    lifecycleState.state === "ready" &&
    currentConversationPreferenceScope() !== undefined &&
    ownsRetainedSendRecovery() &&
    (realtimeSession === undefined || realtimeSession.state.state === "connected");

  const retainedConversationPreferenceDelay = (retryNumber: number): number =>
    Math.min(
      retainedConversationPreferenceMaximumDelayMs,
      retainedConversationPreferenceInitialDelayMs *
        retainedConversationPreferenceRetryMultiplier ** Math.max(0, retryNumber - 1),
    );

  const runRetainedConversationPreferencePump = async (
    epoch: number,
  ): Promise<void> => {
    while (
      epoch === retainedConversationPreferenceRecoveryEpoch &&
      retainedConversationPreferenceRecoveryPermitted()
    ) {
      const scope = currentConversationPreferenceScope();
      if (scope === undefined || scope.epoch !== epoch) return;
      const heads = [...retainedConversationPreferenceIntents];
      if (heads.length === 0) return;
      let retryRequired = false;
      let settledAny = false;
      for (const intent of heads) {
        if (!conversationPreferenceScopeIsActive(scope)) return;
        if (!retainedConversationPreferenceIntents.some((candidate) =>
          sameConversationPreferenceIntent(candidate, intent))) continue;
        const pending = cache.getState().currentUser.pendingPreferenceUpdates[
          intent.request.conversationId
        ];
        if (
          pending?.state === "conflict" &&
          pending.idempotencyKey === intent.request.idempotencyKey
        ) continue;
        const result = await executeDurableConversationPreference(scope, intent);
        if (!conversationPreferenceScopeIsActive(scope)) return;
        const retained = retainedConversationPreferenceIntents.some((candidate) =>
          sameConversationPreferenceIntent(candidate, intent));
        if (retained) {
          const current = cache.getState().currentUser.pendingPreferenceUpdates[
            intent.request.conversationId
          ];
          if (current?.state !== "conflict") retryRequired = true;
        } else {
          settledAny = true;
        }
        if (result?.status === "closed" || result?.status === "aborted") return;
      }
      if (!retryRequired) {
        retainedConversationPreferenceRetryNumber = 0;
        if (!settledAny) return;
        continue;
      }
      retainedConversationPreferenceRetryNumber += 1;
      const controller = new AbortController();
      retainedConversationPreferenceRetryController = controller;
      try {
        await retainedConversationPreferenceWait(
          retainedConversationPreferenceDelay(
            retainedConversationPreferenceRetryNumber,
          ),
          controller.signal,
        );
      } catch {
        return;
      } finally {
        if (retainedConversationPreferenceRetryController === controller) {
          retainedConversationPreferenceRetryController = undefined;
        }
      }
    }
  };

  const startRetainedConversationPreferenceRecovery = (): void => {
    if (
      !retainedConversationPreferenceRecoveryPermitted() ||
      retainedConversationPreferencePump !== undefined
    ) return;
    const epoch = retainedConversationPreferenceRecoveryEpoch;
    const pump = runRetainedConversationPreferencePump(epoch)
      .catch(() => undefined)
      .finally(() => {
        if (retainedConversationPreferencePump === pump) {
          retainedConversationPreferencePump = undefined;
          const replayable = retainedConversationPreferenceIntents.some((intent) => {
            const pending = cache.getState().currentUser.pendingPreferenceUpdates[
              intent.request.conversationId
            ];
            return pending?.state !== "conflict" ||
              pending.idempotencyKey !== intent.request.idempotencyKey;
          });
          if (replayable && retainedConversationPreferenceRecoveryPermitted()) {
            queueMicrotask(startRetainedConversationPreferenceRecovery);
          }
        }
      });
    retainedConversationPreferencePump = pump;
  };

  requestRetainedConversationPreferenceRecovery = (): void =>
    startRetainedConversationPreferenceRecovery();

  pauseRetainedConversationPreferenceRecovery = (): void => {
    retainedConversationPreferenceRecoveryEpoch += 1;
    retainedConversationPreferencePump = undefined;
    retainedConversationPreferenceRetryNumber = 0;
    retainedConversationPreferenceRetryController?.abort();
    retainedConversationPreferenceRetryController = undefined;
    for (const active of activeConversationPreferences.values()) {
      active.resolveCanonicalResult(PREFERENCE_CLOSED_RESULT);
      active.controller.abort();
    }
    activeConversationPreferences.clear();
  };

  activateRetainedConversationPreferenceRecovery = async (
    generation,
    identity,
  ): Promise<void> => {
    const scope = Object.freeze({
      generation,
      epoch: retainedConversationPreferenceRecoveryEpoch,
      identity,
    });
    await reloadConversationPreferenceRecord(scope);
  };

  resumeRetainedConversationPreferenceRecoveryFromStorage = (announcement): void => {
    if (
      announcement !== undefined &&
      announcement.command !== "conversation.preference.update"
    ) return;
    const identity = activePersistenceIdentity;
    const generation = persistenceGeneration;
    if (identity === undefined || !ownsRetainedSendRecovery()) return;
    void activateRetainedConversationPreferenceRecovery(generation, identity)
      .then(() => {
        if (
          !persistenceScopeIsActive(generation, identity) ||
          !ownsRetainedSendRecovery() ||
          (announcement !== undefined && !retainedConversationPreferenceIntents.some(
            (intent) => intent.request.idempotencyKey === announcement.idempotencyKey,
          ))
        ) return;
        requestRetainedConversationPreferenceRecovery();
      })
      .catch(() => undefined);
  };

  handleRetainedConversationPreferenceCoordinatedResult = (
    command,
    idempotencyKey,
    value,
  ): void => {
    if (command !== "conversation.preference.update") return;
    const intent = retainedConversationPreferenceIntents.find(
      (candidate) => candidate.request.idempotencyKey === idempotencyKey,
    );
    const scope = currentConversationPreferenceScope();
    if (intent === undefined || scope === undefined) return;
    const result = parseCoordinatedCommandResult(
      createConversationPreferenceDescriptor(intent.request),
      value,
    );
    if (result === undefined) return;
    void settleConversationPreferenceResult(scope, intent, result).then((settled) => {
      if (!conversationPreferenceScopeIsActive(scope)) return;
      resolveConversationPreferenceWaiters(idempotencyKey, settled);
      requestRetainedConversationPreferenceRecovery();
    });
  };

  handleRetainedConversationPreferenceCanonicalEvent = (event): void => {
    if (
      event.type !== "conversation.preference.updated" ||
      !isRecord(event.payload) ||
      event.tenantId === undefined
    ) return;
    const scope = currentConversationPreferenceScope();
    if (scope === undefined || event.tenantId !== scope.identity.tenantId) return;
    let eventInput: UpdateConversationPreferenceInput;
    let eventResult: UpdateConversationPreferenceResult;
    try {
      eventInput = parseUpdateConversationPreferenceInput(event.payload.input);
      eventResult = parseUpdateConversationPreferenceResult(
        event.payload.result,
        eventInput,
      );
    } catch {
      return;
    }
    const intents = retainedConversationPreferenceIntents.filter((intent) =>
      intent.request.conversationId === eventInput.conversationId);
    for (const intent of intents) {
      void (async () => {
        if (!conversationPreferenceScopeIsActive(scope)) return;
        let result: ChatUpdateConversationPreferenceResult | undefined;
        if (intent.request.idempotencyKey === eventInput.idempotencyKey) {
          result = { status: "success", value: eventResult };
          if (
            eventResult.reconciliationStatus === "preference_revision_conflict" &&
            !conversationPreferencesEqual(intent.request, {
              ...eventResult.preference,
              conversationId: intent.request.conversationId,
              userId: scope.identity.userId,
            })
          ) {
            cache.markConversationPreferenceConflict(intent.request);
          } else {
            await removeConversationPreferenceIntent(scope, intent);
          }
        } else {
          const decision = decideConversationPreferenceAuthority(scope, intent);
          if (decision.state === "settled") {
            await removeConversationPreferenceIntent(scope, intent);
            result = decision.result;
          } else if (decision.state === "conflict") {
            result = decision.result;
          }
        }
        if (result === undefined || !conversationPreferenceScopeIsActive(scope)) return;
        const active = activeConversationPreferences.get(
          intent.request.idempotencyKey,
        );
        active?.resolveCanonicalResult(result);
        active?.controller.abort();
        resolveConversationPreferenceWaiters(
          intent.request.idempotencyKey,
          result,
        );
        retainedConversationPreferenceRetryController?.abort();
        queueMicrotask(requestRetainedConversationPreferenceRecovery);
      })().catch(() => undefined);
    }
  };

  const beginDurableConversationPreferenceUpdate = (
    authored: ChatUpdateConversationPreferenceInput,
  ): Promise<ChatUpdateConversationPreferenceResult> => {
    let input: UpdateConversationPreferenceInput;
    let enqueuedAt: IsoTimestamp;
    const scope = currentConversationPreferenceScope();
    try {
      if (scope === undefined) throw new TypeError("preference persistence required");
      const state = cache.getState();
      if (state.identity === null) throw new TypeError("preference identity required");
      const expectedPreferenceRevision =
        state.currentUser.preferenceRevisions[authored.conversationId] ?? 0;
      parseUpdateConversationPreferenceInput({
        ...authored,
        operation: "update_conversation_preference",
        expectedPreferenceRevision,
        idempotencyKey: "preference-validation",
      });
      input = parseUpdateConversationPreferenceInput({
        ...authored,
        operation: "update_conversation_preference",
        expectedPreferenceRevision,
        idempotencyKey: generatePreferenceIdempotencyKey(),
      });
      enqueuedAt = new Date(preferenceNow()).toISOString() as IsoTimestamp;
    } catch {
      return Promise.resolve(SEND_VALIDATION_FAILURE);
    }
    return (async () => {
      const intent = await persistConversationPreferenceIntent(
        scope,
        input,
        enqueuedAt,
      );
      if (intent === undefined || !conversationPreferenceScopeIsActive(scope)) {
        return SEND_VALIDATION_FAILURE;
      }
      const result = waitForConversationPreferenceResult(
        intent.request.idempotencyKey,
      );
      coordinator?.announcePersistedCommand(
        "conversation.preference.update",
        intent.request.idempotencyKey,
      );
      requestRetainedConversationPreferenceRecovery();
      return result;
    })();
  };

  cache.subscribePrivateStateBoundary(() => {
    pauseRetainedConversationPreferenceRecovery();
    for (const intent of retainedConversationPreferenceIntents) {
      cache.rollbackOptimisticConversationPreference(
        intent.request.conversationId,
        intent.request.idempotencyKey,
      );
    }
    retainedConversationPreferenceIntents = Object.freeze([]);
    for (const waiters of conversationPreferenceResultWaiters.values()) {
      for (const resolve of waiters) resolve(PREFERENCE_CLOSED_RESULT);
    }
    conversationPreferenceResultWaiters.clear();
  });

  interface DurableConversationArchiveScope {
    readonly generation: number;
    readonly epoch: number;
    readonly identity: ApplicationChatStorageIdentity;
  }

  interface ActiveConversationArchive {
    readonly controller: AbortController;
    readonly canonicalResult: Promise<ChatCommandResult<ConversationArchiveResult>>;
    readonly resolveCanonicalResult: (
      result: ChatCommandResult<ConversationArchiveResult>,
    ) => void;
  }

  type ConversationArchiveAuthorityDecision =
    | { readonly state: "retry" | "dispatch" }
    | {
        readonly state: "settled" | "conflict";
        readonly result: ChatCommandResult<ConversationArchiveResult>;
      };

  let conversationArchiveMutationChain: Promise<void> = Promise.resolve();
  let retainedConversationArchiveRecoveryEpoch = 0;
  let retainedConversationArchivePump: Promise<void> | undefined;
  let retainedConversationArchiveRetryNumber = 0;
  let retainedConversationArchiveRetryController: AbortController | undefined;
  const settlingCoordinatedConversationArchives = new Set<string>();
  const activeConversationArchives = new Map<string, ActiveConversationArchive>();
  const conversationArchiveResultWaiters = new Map<
    string,
    Set<(result: ChatCommandResult<ConversationArchiveResult>) => void>
  >();

  const conversationArchiveLogicalKey = (
    input: ConversationArchiveInput,
  ): string => JSON.stringify([
    "archive",
    input.intent,
    input.conversationId,
    input.expectedLifecycleRevision,
  ]);

  const serializeConversationArchiveMutation = <Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> => {
    const result = conversationArchiveMutationChain.then(operation);
    conversationArchiveMutationChain = result.then(() => undefined, () => undefined);
    return result;
  };

  const conversationArchiveScopeIsActive = (
    scope: DurableConversationArchiveScope,
  ): boolean => {
    const cacheIdentity = cache.getState().identity;
    return scope.epoch === retainedConversationArchiveRecoveryEpoch &&
      persistenceScopeIsActive(scope.generation, scope.identity) &&
      cacheIdentity !== null &&
      cacheIdentity.tenantId === scope.identity.tenantId &&
      cacheIdentity.userId === scope.identity.userId;
  };

  const currentConversationArchiveScope = (
  ): DurableConversationArchiveScope | undefined =>
    activePersistenceIdentity === undefined
      ? undefined
      : Object.freeze({
          generation: persistenceGeneration,
          epoch: retainedConversationArchiveRecoveryEpoch,
          identity: activePersistenceIdentity,
        });

  const sameConversationArchiveRequest = (
    left: ConversationArchiveInput,
    right: ConversationArchiveInput,
  ): boolean => left.intent === right.intent &&
    left.conversationId === right.conversationId &&
    left.expectedLifecycleRevision === right.expectedLifecycleRevision &&
    left.idempotencyKey === right.idempotencyKey;

  const sameConversationArchiveIntent = (
    left: DurableConversationArchiveIntent,
    right: DurableConversationArchiveIntent,
  ): boolean => left.enqueueOrder === right.enqueueOrder &&
    left.enqueuedAt === right.enqueuedAt &&
    sameConversationArchiveRequest(left.request, right.request);

  const sameConversationArchiveCorrelation = (
    left: DurableConversationArchiveIntent,
    right: DurableConversationArchiveIntent,
  ): boolean => left.request.conversationId === right.request.conversationId &&
    left.request.idempotencyKey === right.request.idempotencyKey;

  const readConversationArchiveRecord = async (
    scope: DurableConversationArchiveScope,
  ): Promise<ApplicationChatQueuedConversationArchiveIntentsRecord | null> => {
    if (
      !conversationArchiveScopeIsActive(scope) ||
      normalizedCachePersistence === undefined
    ) throw new Error("inactive durable conversation-archive scope");
    const record = await normalizedCachePersistence.storage.read(
      scope.identity,
      ApplicationChatStorageRecordKind.queuedConversationArchiveIntents,
    );
    if (!conversationArchiveScopeIsActive(scope)) {
      throw new Error("inactive durable conversation-archive scope");
    }
    return record;
  };

  const resolveConversationArchiveWaiters = (
    idempotencyKey: string,
    result: ChatCommandResult<ConversationArchiveResult>,
  ): void => {
    const waiters = conversationArchiveResultWaiters.get(idempotencyKey);
    if (waiters === undefined) return;
    conversationArchiveResultWaiters.delete(idempotencyKey);
    for (const resolve of waiters) resolve(result);
  };

  const waitForConversationArchiveResult = (
    idempotencyKey: string,
  ): Promise<ChatCommandResult<ConversationArchiveResult>> =>
    new Promise((resolve) => {
      const waiters = conversationArchiveResultWaiters.get(idempotencyKey) ??
        new Set();
      waiters.add(resolve);
      conversationArchiveResultWaiters.set(idempotencyKey, waiters);
    });

  const publishRetainedConversationArchives = (
    record: ApplicationChatQueuedConversationArchiveIntentsRecord | null,
  ): void => {
    const next = Object.freeze([...(record?.intents ?? [])]);
    for (const previous of retainedConversationArchiveIntents) {
      const stillRetained = next.some((candidate) =>
        sameConversationArchiveIntent(candidate, previous));
      if (stillRetained) continue;
      cache.settleConversationOperation(
        conversationArchiveLogicalKey(previous.request),
      );
      const superseded = next.some((candidate) =>
        candidate.request.conversationId === previous.request.conversationId);
      if (!superseded) continue;
      activeConversationArchives.get(previous.request.idempotencyKey)?.controller.abort();
      resolveConversationArchiveWaiters(
        previous.request.idempotencyKey,
        PREFERENCE_CLOSED_RESULT,
      );
    }
    retainedConversationArchiveIntents = next;
  };

  const mutateConversationArchiveRecord = async (
    scope: DurableConversationArchiveScope,
    updater: (
      current: ApplicationChatQueuedConversationArchiveIntentsRecord | null,
    ) => ApplicationChatQueuedConversationArchiveIntentsRecord | null,
  ): Promise<ApplicationChatQueuedConversationArchiveIntentsRecord | null> => {
    if (
      !conversationArchiveScopeIsActive(scope) ||
      normalizedCachePersistence === undefined
    ) throw new Error("inactive durable conversation-archive scope");
    const committed = await normalizedCachePersistence.storage.mutate(
      scope.identity,
      ApplicationChatStorageRecordKind.queuedConversationArchiveIntents,
      (current) => {
        if (!conversationArchiveScopeIsActive(scope)) {
          throw new Error("inactive durable conversation-archive scope");
        }
        const proposal = updater(current);
        if (!conversationArchiveScopeIsActive(scope)) {
          throw new Error("inactive durable conversation-archive scope");
        }
        return proposal;
      },
    );
    if (!conversationArchiveScopeIsActive(scope)) {
      throw new Error("inactive durable conversation-archive scope");
    }
    publishRetainedConversationArchives(committed);
    return committed;
  };

  const reloadConversationArchiveRecord = (
    scope: DurableConversationArchiveScope,
  ): Promise<boolean> => serializeConversationArchiveMutation(async () => {
    try {
      const record = await readConversationArchiveRecord(scope);
      publishRetainedConversationArchives(record);
      return true;
    } catch (error) {
      if (!conversationArchiveScopeIsActive(scope)) return false;
      if (error instanceof ApplicationChatStorageValidationError) {
        reportPersistenceDiagnostic(
          "conversation_archive_intents_rejected",
          "The stored conversation-archive intents were rejected and quarantined.",
        );
        publishRetainedConversationArchives(null);
      } else {
        reportPersistenceDiagnostic(
          "conversation_archive_intents_read_failed",
          "The stored conversation-archive intents could not be read.",
        );
      }
      return false;
    }
  });

  const persistConversationArchiveIntent = (
    scope: DurableConversationArchiveScope,
    input: ConversationArchiveInput,
  ): Promise<DurableConversationArchiveIntent | undefined> =>
    serializeConversationArchiveMutation(async () => {
      try {
        const enqueuedAt = new Date().toISOString() as IsoTimestamp;
        const committed = await mutateConversationArchiveRecord(
          scope,
          (current) => {
            const currentIntents = current?.intents ?? [];
            const supersededIndex = currentIntents.findIndex((intent) =>
              intent.request.conversationId === input.conversationId);
            const superseded = supersededIndex < 0
              ? undefined
              : currentIntents[supersededIndex];
            const enqueueOrder = superseded?.enqueueOrder ??
              (currentIntents.reduce(
                (highest, intent) => Math.max(highest, intent.enqueueOrder),
                0,
              ) + 1);
            const intent = createApplicationChatQueuedConversationArchiveIntent(
              input,
              {
                enqueueOrder,
                enqueuedAt: superseded?.enqueuedAt ?? enqueuedAt,
              },
            );
            return createApplicationChatQueuedConversationArchiveIntentsRecord(
              scope.identity,
              supersededIndex < 0
                ? [...currentIntents, intent]
                : currentIntents.map((candidate, index) =>
                    index === supersededIndex ? intent : candidate),
            );
          },
        );
        return committed?.intents.find((candidate) =>
          candidate.request.conversationId === input.conversationId &&
          sameConversationArchiveRequest(candidate.request, input));
      } catch {
        if (conversationArchiveScopeIsActive(scope)) {
          reportPersistenceDiagnostic(
            "conversation_archive_intents_write_failed",
            "The conversation-archive command could not be stored before projection or dispatch.",
          );
        }
        return undefined;
      }
    });

  const removeConversationArchiveIntent = (
    scope: DurableConversationArchiveScope,
    intent: DurableConversationArchiveIntent,
  ): Promise<boolean> => serializeConversationArchiveMutation(async () => {
    if (
      !conversationArchiveScopeIsActive(scope) ||
      normalizedCachePersistence === undefined
    ) return false;
    try {
      let removed = false;
      await mutateConversationArchiveRecord(scope, (current) => {
        removed = false;
        if (current === null) return null;
        const remaining = current.intents.filter((candidate) =>
          !sameConversationArchiveCorrelation(candidate, intent));
        removed = remaining.length !== current.intents.length;
        if (!removed) return current;
        return remaining.length === 0
          ? null
          : createApplicationChatQueuedConversationArchiveIntentsRecord(
              scope.identity,
              remaining,
            );
      });
      if (!conversationArchiveScopeIsActive(scope)) return false;
      if (removed) {
        cache.settleConversationOperation(
          conversationArchiveLogicalKey(intent.request),
        );
      }
      return true;
    } catch {
      if (conversationArchiveScopeIsActive(scope)) {
        reportPersistenceDiagnostic(
          "conversation_archive_intents_write_failed",
          "A settled conversation-archive command could not be removed from storage.",
        );
      }
      return false;
    }
  });

  const clearArchivedConversationSubscription = (
    conversationId: ConversationId,
  ): void => {
    const release = retainedThreadSubscriptions.get(conversationId);
    if (release === undefined) return;
    retainedThreadSubscriptions.delete(conversationId);
    release();
  };

  const conversationArchiveAuthorityDecision = (
    scope: DurableConversationArchiveScope,
    intent: DurableConversationArchiveIntent,
  ): ConversationArchiveAuthorityDecision => {
    if (!conversationArchiveScopeIsActive(scope)) return { state: "retry" };
    const state = cache.getState();
    const conversation = state.entities.conversations[intent.request.conversationId];
    if (conversation === undefined) return { state: "retry" };
    const knownRevision = state.metadata.lifecycleRevisions[
      intent.request.conversationId
    ];
    const revision = knownRevision ?? intent.request.expectedLifecycleRevision;
    if (revision < intent.request.expectedLifecycleRevision) return { state: "retry" };
    const isArchived = conversation.archivedAt !== undefined;
    const desiredArchived = intent.request.intent === "archive";
    if (isArchived === desiredArchived) {
      if (
        desiredArchived &&
        (conversation.archivedAt === undefined ||
          conversation.archivedByUserId === undefined)
      ) return { state: "retry" };
      const value = parseConversationArchiveResult({
        operation: "set_conversation_archive",
        intent: intent.request.intent,
        reconciliationStatus: revision === intent.request.expectedLifecycleRevision
          ? "already_requested_state"
          : "replayed",
        conversationId: intent.request.conversationId,
        expectedLifecycleRevision: intent.request.expectedLifecycleRevision,
        lifecycleRevision: revision,
        archiveState: desiredArchived
          ? {
              status: "archived",
              archivedAt: conversation.archivedAt,
              archivedByUserId: conversation.archivedByUserId,
            }
          : { status: "active" },
      }, intent.request);
      return { state: "settled", result: { status: "success", value } };
    }
    if (revision > intent.request.expectedLifecycleRevision) {
      if (
        isArchived &&
        (conversation.archivedAt === undefined ||
          conversation.archivedByUserId === undefined)
      ) return { state: "retry" };
      const value = parseConversationArchiveResult({
        operation: "set_conversation_archive",
        intent: intent.request.intent,
        reconciliationStatus: "lifecycle_conflict",
        conversationId: intent.request.conversationId,
        expectedLifecycleRevision: intent.request.expectedLifecycleRevision,
        lifecycleRevision: revision,
        archiveState: isArchived
          ? {
              status: "archived",
              archivedAt: conversation.archivedAt,
              archivedByUserId: conversation.archivedByUserId,
            }
          : { status: "active" },
      }, intent.request);
      return { state: "conflict", result: { status: "success", value } };
    }
    return { state: "dispatch" };
  };

  const refreshConversationArchiveAuthority = async (
    scope: DurableConversationArchiveScope,
    intent: DurableConversationArchiveIntent,
    signal: AbortSignal,
  ): Promise<boolean> => {
    if (!conversationArchiveScopeIsActive(scope) || signal.aborted) return false;
    const result = await snapshotReader.getConversation<Feature>(
      { conversationId: intent.request.conversationId },
      { signal },
    );
    return conversationArchiveScopeIsActive(scope) &&
      !signal.aborted &&
      result.status === "success" &&
      cache.getState().entities.conversations[intent.request.conversationId] !==
        undefined;
  };

  const conversationArchiveResultIsTerminal = (
    result: ChatCommandResult<ConversationArchiveResult>,
  ): boolean => result.status === "validation" ||
    result.status === "authentication" ||
    result.status === "feature_disabled" ||
    result.status === "unsupported" ||
    result.status === "rejected";

  const settleConversationArchiveResult = async (
    scope: DurableConversationArchiveScope,
    intent: DurableConversationArchiveIntent,
    result: ChatCommandResult<ConversationArchiveResult>,
  ): Promise<ChatCommandResult<ConversationArchiveResult>> => {
    if (!conversationArchiveScopeIsActive(scope)) return PREFERENCE_CLOSED_RESULT;
    if (result.status === "success") {
      try {
        cache.reconcileConversationArchive(
          conversationArchiveLogicalKey(intent.request),
          intent.request,
          result.value,
        );
      } catch {
        return SEND_MALFORMED_RESPONSE;
      }
      await removeConversationArchiveIntent(scope, intent);
      if (result.value.archiveState.status === "archived") {
        clearArchivedConversationSubscription(intent.request.conversationId);
      }
    } else if (conversationArchiveResultIsTerminal(result)) {
      await removeConversationArchiveIntent(scope, intent);
    }
    return result;
  };

  const settleConversationArchiveFromAuthority = async (
    scope: DurableConversationArchiveScope,
    intent: DurableConversationArchiveIntent,
  ): Promise<ChatCommandResult<ConversationArchiveResult> | undefined> => {
    const decision = conversationArchiveAuthorityDecision(scope, intent);
    if (decision.state !== "settled" && decision.state !== "conflict") {
      return undefined;
    }
    const result = await settleConversationArchiveResult(
      scope,
      intent,
      decision.result,
    );
    if (!conversationArchiveScopeIsActive(scope)) return PREFERENCE_CLOSED_RESULT;
    const active = activeConversationArchives.get(intent.request.idempotencyKey);
    active?.resolveCanonicalResult(result);
    active?.controller.abort();
    resolveConversationArchiveWaiters(intent.request.idempotencyKey, result);
    return result;
  };

  const executeDurableConversationArchive = async (
    scope: DurableConversationArchiveScope,
    intent: DurableConversationArchiveIntent,
  ): Promise<ChatCommandResult<ConversationArchiveResult> | undefined> => {
    const key = intent.request.idempotencyKey;
    if (activeConversationArchives.has(key)) {
      return waitForConversationArchiveResult(key);
    }
    if (!conversationArchiveScopeIsActive(scope)) return PREFERENCE_CLOSED_RESULT;
    if (
      cache.getState().entities.conversations[intent.request.conversationId] ===
        undefined &&
      !await refreshConversationArchiveAuthority(
        scope,
        intent,
        new AbortController().signal,
      ).catch(() => false)
    ) return undefined;
    const authority = conversationArchiveAuthorityDecision(scope, intent);
    if (authority.state === "settled" || authority.state === "conflict") {
      const descriptor = createConversationArchiveDescriptor(intent.request);
      const coordinated = coordinator === undefined ||
          coordinationStatus?.role === "fallback"
        ? Promise.resolve(authority.result)
        : coordinator.coordinateCommand({
            command: "conversation.archive.set",
            idempotencyKey: key,
            execute: async () => authority.result,
            parseResult: (value) => parseCoordinatedCommandResult(descriptor, value),
            projectResultForRelay: (parsed) => parsed.status === "success"
              ? CONVERSATION_ARCHIVE_AUTHORITY_REFRESH_RESULT
              : parsed,
          });
      const result = await coordinated;
      if (!conversationArchiveScopeIsActive(scope)) {
        return PREFERENCE_CLOSED_RESULT;
      }
      const settled = await settleConversationArchiveResult(scope, intent, result);
      resolveConversationArchiveWaiters(key, settled);
      return settled;
    }
    if (!conversationArchiveScopeIsActive(scope)) return PREFERENCE_CLOSED_RESULT;
    try {
      cache.beginConversationOperation(Object.freeze({
        logicalKey: conversationArchiveLogicalKey(intent.request),
        idempotencyKey: key,
        family: "archive",
        conversationId: intent.request.conversationId,
      }));
    } catch {
      return undefined;
    }
    const controller = new AbortController();
    let resolveCanonicalResult!: (
      result: ChatCommandResult<ConversationArchiveResult>,
    ) => void;
    const canonicalResult = new Promise<ChatCommandResult<ConversationArchiveResult>>(
      (resolve) => { resolveCanonicalResult = resolve; },
    );
    const active = Object.freeze({
      controller,
      canonicalResult,
      resolveCanonicalResult,
    });
    activeConversationArchives.set(key, active);
    let result: ChatCommandResult<ConversationArchiveResult> | undefined;
    try {
      const descriptor = createConversationArchiveDescriptor(intent.request);
      const dispatch = () => commandDispatcher.dispatch(
        descriptor,
        intent.request,
        {
          idempotencyKey: key,
          signal: controller.signal,
        },
      );
      const coordinatedDispatch = coordinator === undefined ||
          coordinationStatus?.role === "fallback"
        ? dispatch()
        : coordinator.coordinateCommand({
            command: "conversation.archive.set",
            idempotencyKey: key,
            execute: dispatch,
            parseResult: (value) => parseCoordinatedCommandResult(descriptor, value),
            projectResultForRelay: (parsed) => parsed.status === "success"
              ? CONVERSATION_ARCHIVE_AUTHORITY_REFRESH_RESULT
              : parsed,
          });
      result = await Promise.race([
        coordinatedDispatch,
        canonicalResult,
      ]);
      if (!conversationArchiveScopeIsActive(scope)) {
        return PREFERENCE_CLOSED_RESULT;
      }
      result = await settleConversationArchiveResult(scope, intent, result);
      return result;
    } finally {
      if (activeConversationArchives.get(key) === active) {
        activeConversationArchives.delete(key);
      }
      if (result !== undefined) resolveConversationArchiveWaiters(key, result);
    }
  };

  const retainedConversationArchiveRecoveryPermitted = (): boolean =>
    lifecycleState.state === "ready" &&
    currentConversationArchiveScope() !== undefined &&
    ownsRetainedSendRecovery() &&
    (realtimeSession === undefined || realtimeSession.state.state === "connected");

  const retainedConversationArchiveDelay = (retryNumber: number): number =>
    Math.min(
      retainedConversationArchiveMaximumDelayMs,
      retainedConversationArchiveInitialDelayMs *
        retainedConversationArchiveRetryMultiplier ** Math.max(0, retryNumber - 1),
    );

  const runRetainedConversationArchivePump = async (
    epoch: number,
  ): Promise<void> => {
    while (
      epoch === retainedConversationArchiveRecoveryEpoch &&
      retainedConversationArchiveRecoveryPermitted()
    ) {
      const scope = currentConversationArchiveScope();
      if (scope === undefined || scope.epoch !== epoch) return;
      const intent = retainedConversationArchiveIntents[0];
      if (intent === undefined) return;
      const result = await executeDurableConversationArchive(scope, intent);
      if (!conversationArchiveScopeIsActive(scope)) return;
      if (!retainedConversationArchiveIntents.some((candidate) =>
        sameConversationArchiveIntent(candidate, intent))) {
        retainedConversationArchiveRetryNumber = 0;
        continue;
      }
      if (result?.status === "closed" || result?.status === "aborted") return;
      retainedConversationArchiveRetryNumber += 1;
      const controller = new AbortController();
      retainedConversationArchiveRetryController = controller;
      try {
        await retainedConversationArchiveWait(
          retainedConversationArchiveDelay(retainedConversationArchiveRetryNumber),
          controller.signal,
        );
      } catch {
        return;
      } finally {
        if (retainedConversationArchiveRetryController === controller) {
          retainedConversationArchiveRetryController = undefined;
        }
      }
    }
  };

  const startRetainedConversationArchiveRecovery = (): void => {
    if (
      !retainedConversationArchiveRecoveryPermitted() ||
      retainedConversationArchivePump !== undefined
    ) return;
    const epoch = retainedConversationArchiveRecoveryEpoch;
    const pump = runRetainedConversationArchivePump(epoch)
      .catch(() => undefined)
      .finally(() => {
        if (retainedConversationArchivePump === pump) {
          retainedConversationArchivePump = undefined;
        }
      });
    retainedConversationArchivePump = pump;
  };

  requestRetainedConversationArchiveRecovery = (): void =>
    startRetainedConversationArchiveRecovery();

  pauseRetainedConversationArchiveRecovery = (): void => {
    retainedConversationArchiveRecoveryEpoch += 1;
    retainedConversationArchivePump = undefined;
    retainedConversationArchiveRetryNumber = 0;
    retainedConversationArchiveRetryController?.abort();
    retainedConversationArchiveRetryController = undefined;
    for (const active of activeConversationArchives.values()) {
      active.resolveCanonicalResult(PREFERENCE_CLOSED_RESULT);
      active.controller.abort();
    }
    activeConversationArchives.clear();
  };

  activateRetainedConversationArchiveRecovery = async (
    generation,
    identity,
  ): Promise<void> => {
    const scope = Object.freeze({
      generation,
      epoch: retainedConversationArchiveRecoveryEpoch,
      identity,
    });
    if (!await reloadConversationArchiveRecord(scope)) return;
    for (const intent of retainedConversationArchiveIntents) {
      if (!conversationArchiveScopeIsActive(scope)) return;
      try {
        cache.beginConversationOperation(Object.freeze({
          logicalKey: conversationArchiveLogicalKey(intent.request),
          idempotencyKey: intent.request.idempotencyKey,
          family: "archive",
          conversationId: intent.request.conversationId,
        }));
      } catch {
        // A mismatched in-memory operation is retried after the next identity boundary.
      }
    }
  };

  resumeRetainedConversationArchiveRecoveryFromStorage = (announcement): void => {
    if (
      announcement !== undefined &&
      announcement.command !== "conversation.archive.set"
    ) return;
    const identity = activePersistenceIdentity;
    const generation = persistenceGeneration;
    if (identity === undefined || !ownsRetainedSendRecovery()) return;
    void activateRetainedConversationArchiveRecovery(generation, identity).then(() => {
      if (
        !persistenceScopeIsActive(generation, identity) ||
        !ownsRetainedSendRecovery() ||
        (announcement !== undefined && !retainedConversationArchiveIntents.some(
          (intent) => intent.request.idempotencyKey === announcement.idempotencyKey,
        ))
      ) return;
      requestRetainedConversationArchiveRecovery();
    }).catch(() => undefined);
  };

  handleRetainedConversationArchiveCoordinatedResult = (
    command,
    idempotencyKey,
    value,
  ): void => {
    if (
      command !== "conversation.archive.set" ||
      settlingCoordinatedConversationArchives.has(idempotencyKey)
    ) return;
    const intent = retainedConversationArchiveIntents.find(
      (candidate) => candidate.request.idempotencyKey === idempotencyKey,
    );
    const scope = currentConversationArchiveScope();
    if (intent === undefined || scope === undefined) return;
    const descriptor = createConversationArchiveDescriptor(intent.request);
    const parsed = parseCoordinatedCommandResult(descriptor, value);
    if (
      parsed === undefined &&
      !isConversationArchiveAuthorityRefreshResult(value)
    ) return;
    settlingCoordinatedConversationArchives.add(idempotencyKey);
    void (async () => {
      let settled: ChatCommandResult<ConversationArchiveResult> | undefined;
      if (parsed !== undefined) {
        settled = await settleConversationArchiveResult(scope, intent, parsed);
      } else {
        const controller = new AbortController();
        if (!await refreshConversationArchiveAuthority(
          scope,
          intent,
          controller.signal,
        ).catch(() => false)) return;
        const decision = conversationArchiveAuthorityDecision(scope, intent);
        if (decision.state !== "settled" && decision.state !== "conflict") return;
        settled = await settleConversationArchiveResult(
          scope,
          intent,
          decision.result,
        );
      }
      if (!conversationArchiveScopeIsActive(scope) || settled === undefined) return;
      const active = activeConversationArchives.get(idempotencyKey);
      active?.resolveCanonicalResult(settled);
      active?.controller.abort();
      resolveConversationArchiveWaiters(idempotencyKey, settled);
      retainedConversationArchiveRetryController?.abort();
      requestRetainedConversationArchiveRecovery();
    })().catch(() => undefined).finally(() => {
      settlingCoordinatedConversationArchives.delete(idempotencyKey);
    });
  };

  handleRetainedConversationArchiveCanonicalEvent = (event): boolean => {
    if (
      (event.type !== "conversation.archived" &&
        event.type !== "conversation.restored") ||
      !isRecord(event.payload)
    ) return false;
    const conversationId = event.payload.conversationId;
    const intent = retainedConversationArchiveIntents.find((candidate) =>
      candidate.request.conversationId === conversationId);
    const scope = currentConversationArchiveScope();
    if (intent === undefined || scope === undefined) return false;
    const controller = new AbortController();
    void refreshConversationArchiveAuthority(scope, intent, controller.signal)
      .then(async (refreshed) => {
        if (!refreshed || !conversationArchiveScopeIsActive(scope)) return;
        await settleConversationArchiveFromAuthority(scope, intent);
        if (conversationArchiveScopeIsActive(scope)) {
          retainedConversationArchiveRetryController?.abort();
          requestRetainedConversationArchiveRecovery();
        }
      })
      .catch(() => undefined)
      .finally(() => controller.abort());
    return true;
  };

  cache.subscribePrivateStateBoundary(() => {
    pauseRetainedConversationArchiveRecovery();
    for (const intent of retainedConversationArchiveIntents) {
      cache.settleConversationOperation(
        conversationArchiveLogicalKey(intent.request),
      );
    }
    retainedConversationArchiveIntents = Object.freeze([]);
    for (const waiters of conversationArchiveResultWaiters.values()) {
      for (const resolve of waiters) resolve(PREFERENCE_CLOSED_RESULT);
    }
    conversationArchiveResultWaiters.clear();
  });

  const executeConversationLifecycle = <Input, Result>(options: {
    readonly logicalKey: string;
    readonly family: "creation" | "archive" | "membership";
    readonly conversationId?: ConversationId;
    readonly clientRequestId?: string;
    readonly idempotencyKey: string;
    readonly input: Input;
    readonly descriptor: ChatCommandDescriptor<Input, Input, Result>;
    readonly reconcile: (result: Result) => void;
    readonly refreshWhenSettled?: (result: Result) => boolean;
  }): Promise<ChatCommandResult<Result>> => {
    const existing = lifecycleOperations.get(options.logicalKey);
    if (existing !== undefined) {
      return existing as Promise<ChatCommandResult<Result>>;
    }
    try {
      cache.beginConversationOperation(Object.freeze({
        logicalKey: options.logicalKey,
        idempotencyKey: options.idempotencyKey,
        family: options.family,
        ...(options.conversationId === undefined
          ? {}
          : { conversationId: options.conversationId }),
        ...(options.clientRequestId === undefined
          ? {}
          : { clientRequestId: options.clientRequestId }),
      }));
    } catch {
      return Promise.resolve(SEND_VALIDATION_FAILURE);
    }
    const promise = client.dispatch(options.descriptor, options.input, {
      idempotencyKey: options.idempotencyKey,
      coordinationKey: lifecycleCoordinationKey(options.logicalKey),
    }).then((result) => {
      let refresh =
        result.status === "malformed_response" &&
        options.conversationId !== undefined;
      if (result.status === "success") {
        try {
          options.reconcile(result.value);
          refresh ||= options.refreshWhenSettled?.(result.value) === true;
        } catch {
          cache.settleConversationOperation(options.logicalKey);
          refresh = options.conversationId !== undefined;
        }
      } else {
        cache.settleConversationOperation(options.logicalKey);
      }
      if (refresh && options.conversationId !== undefined) {
        refreshConversationDetail(options.conversationId);
      }
      return result;
    });
    const tracked = promise.finally(() => {
      if (lifecycleOperations.get(options.logicalKey) === tracked) {
        lifecycleOperations.delete(options.logicalKey);
      }
    });
    lifecycleOperations.set(
      options.logicalKey,
      tracked as Promise<ChatCommandResult<unknown>>,
    );
    return tracked;
  };

  const pendingCorrelation = (
    logicalKey: string,
    family: "creation" | "archive" | "membership",
  ) => {
    const pending =
      cache.getState().metadata.pendingConversationOperations[logicalKey];
    return pending?.family === family ? pending : undefined;
  };

  const beginConversationCreation = (
    type: "channel" | "direct" | "group_direct",
    authored: ChatCreateChannelInput | ChatCreateDirectInput | ChatCreateGroupDirectInput,
  ): Promise<ChatCommandResult<ConversationCreationResult>> => {
    try {
      const validationIdentity = "conversation-validation";
      const candidate = {
        ...authored,
        operation: "create_conversation",
        type,
        ...(type === "channel" ? {} : { visibility: "private" }),
        idempotencyKey: validationIdentity,
        clientRequestId: validationIdentity,
      };
      const validated = type === "channel"
        ? parseCreateChannelConversationInput(candidate)
        : type === "direct"
          ? parseCreateDirectConversationInput(candidate)
          : parseCreateGroupDirectConversationInput(candidate);
      const logicalKey = conversationCreationLogicalKey(validated);
      if (normalizedCachePersistence !== undefined) {
        const scope = currentConversationCreationScope();
        if (scope === undefined) return Promise.resolve(SEND_VALIDATION_FAILURE);
        return (async (): Promise<ChatCommandResult<ConversationCreationResult>> => {
          const intent = await findOrPersistConversationCreationIntent(
            scope,
            validated,
          );
          if (intent === undefined || !conversationCreationScopeIsActive(scope)) {
            return SEND_VALIDATION_FAILURE;
          }
          const result = waitForConversationCreationResult(
            intent.request.idempotencyKey,
          );
          coordinator?.announcePersistedCommand(
            "conversation.create",
            intent.request.idempotencyKey,
          );
          requestRetainedConversationCreationRecovery();
          return result;
        })();
      }
      const active = lifecycleOperations.get(logicalKey);
      if (active !== undefined) {
        return active as Promise<ChatCommandResult<ConversationCreationResult>>;
      }
      const pending = pendingCorrelation(logicalKey, "creation");
      const idempotencyKey =
        pending?.idempotencyKey ?? generateLifecycleIdempotencyKey();
      const clientRequestId =
        pending?.clientRequestId ?? generateLifecycleClientRequestId(logicalKey);
      const input = type === "channel"
        ? parseCreateChannelConversationInput({
            ...authored,
            operation: "create_conversation",
            type,
            idempotencyKey,
            clientRequestId,
          })
        : type === "direct"
          ? parseCreateDirectConversationInput({
              ...authored,
              operation: "create_conversation",
              type,
              visibility: "private",
              idempotencyKey,
              clientRequestId,
            })
          : parseCreateGroupDirectConversationInput({
              ...authored,
              operation: "create_conversation",
              type,
              visibility: "private",
              idempotencyKey,
              clientRequestId,
            });
      return executeConversationLifecycle({
        logicalKey,
        family: "creation",
        clientRequestId,
        idempotencyKey,
        input: input as ConversationCreationInput,
        descriptor: createConversationDescriptor(input),
        reconcile: (result) =>
          cache.reconcileConversationCreation(logicalKey, input, result),
      });
    } catch {
      return Promise.resolve(SEND_VALIDATION_FAILURE);
    }
  };

  const beginConversationArchive = (
    intent: "archive" | "restore",
    authored: ChatSetConversationArchiveInput,
  ): Promise<ChatCommandResult<ConversationArchiveResult>> => {
    try {
      const validation = parseConversationArchiveInput({
        ...authored,
        operation: "set_conversation_archive",
        intent,
        idempotencyKey: "conversation-validation",
      });
      const logicalKey = conversationArchiveLogicalKey(validation);
      const active = lifecycleOperations.get(logicalKey);
      if (active !== undefined) {
        return active as Promise<ChatCommandResult<ConversationArchiveResult>>;
      }
      const retained = retainedConversationArchiveIntents.find((candidate) =>
        conversationArchiveLogicalKey(candidate.request) === logicalKey);
      if (normalizedCachePersistence !== undefined && retained !== undefined) {
        const result = waitForConversationArchiveResult(
          retained.request.idempotencyKey,
        );
        coordinator?.announcePersistedCommand(
          "conversation.archive.set",
          retained.request.idempotencyKey,
        );
        resumeRetainedConversationArchiveRecoveryFromStorage({
          command: "conversation.archive.set",
          idempotencyKey: retained.request.idempotencyKey,
        });
        return result;
      }
      const pending = pendingCorrelation(logicalKey, "archive");
      const idempotencyKey =
        pending?.idempotencyKey ?? generateLifecycleIdempotencyKey();
      const input = parseConversationArchiveInput({
        ...authored,
        operation: "set_conversation_archive",
        intent,
        idempotencyKey,
      });
      if (normalizedCachePersistence !== undefined) {
        const scope = currentConversationArchiveScope();
        if (scope === undefined) return Promise.resolve(SEND_VALIDATION_FAILURE);
        const operation = (async () => {
          const persisted = await persistConversationArchiveIntent(scope, input);
          if (
            persisted === undefined ||
            !conversationArchiveScopeIsActive(scope)
          ) return SEND_VALIDATION_FAILURE;
          try {
            cache.beginConversationOperation(Object.freeze({
              logicalKey: conversationArchiveLogicalKey(persisted.request),
              idempotencyKey: persisted.request.idempotencyKey,
              family: "archive",
              conversationId: persisted.request.conversationId,
            }));
          } catch {
            await removeConversationArchiveIntent(scope, persisted);
            return SEND_VALIDATION_FAILURE;
          }
          const result = waitForConversationArchiveResult(
            persisted.request.idempotencyKey,
          );
          coordinator?.announcePersistedCommand(
            "conversation.archive.set",
            persisted.request.idempotencyKey,
          );
          resumeRetainedConversationArchiveRecoveryFromStorage({
            command: "conversation.archive.set",
            idempotencyKey: persisted.request.idempotencyKey,
          });
          return result;
        })();
        const tracked = operation.finally(() => {
          if (lifecycleOperations.get(logicalKey) === tracked) {
            lifecycleOperations.delete(logicalKey);
          }
        });
        lifecycleOperations.set(
          logicalKey,
          tracked as Promise<ChatCommandResult<unknown>>,
        );
        return tracked;
      }
      return executeConversationLifecycle({
        logicalKey,
        family: "archive",
        conversationId: input.conversationId,
        idempotencyKey,
        input,
        descriptor: createConversationArchiveDescriptor(input),
        reconcile: (result) => {
          cache.reconcileConversationArchive(logicalKey, input, result);
          if (result.archiveState.status === "archived") {
            clearArchivedConversationSubscription(input.conversationId);
          }
        },
        refreshWhenSettled: (result) =>
          result.reconciliationStatus === "lifecycle_conflict",
      });
    } catch {
      return Promise.resolve(SEND_VALIDATION_FAILURE);
    }
  };

  const beginConversationMembership = (
    intent: ConversationMembershipMutationInput["intent"],
    authored: ChatMutateConversationMembershipInput<ConversationMembershipMutationInput>,
  ): Promise<ChatCommandResult<ConversationMembershipMutationResult>> => {
    try {
      const candidate = {
        ...authored,
        operation: "mutate_conversation_membership",
        intent,
        idempotencyKey: "conversation-validation",
      };
      const validation = intent === "join"
        ? parseJoinConversationInput(candidate)
        : intent === "leave"
          ? parseLeaveConversationInput(candidate)
          : intent === "add_member"
            ? parseAddConversationMemberInput(candidate)
            : intent === "remove_member"
              ? parseRemoveConversationMemberInput(candidate)
              : parseChangeConversationMemberRoleInput(candidate);
      const logicalKey = conversationMembershipLogicalKey(validation);
      const active = lifecycleOperations.get(logicalKey);
      if (active !== undefined) {
        return active as Promise<ChatCommandResult<ConversationMembershipMutationResult>>;
      }
      const retained = retainedMembershipIntents.find((candidate) =>
        conversationMembershipLogicalKey(candidate.request) === logicalKey);
      if (normalizedCachePersistence !== undefined && retained !== undefined) {
        const result = waitForMembershipResult(retained.request.idempotencyKey);
        requestRetainedMembershipRecovery();
        return result;
      }
      const pending = pendingCorrelation(logicalKey, "membership");
      const idempotencyKey =
        pending?.idempotencyKey ?? generateLifecycleIdempotencyKey();
      const finalCandidate = { ...candidate, idempotencyKey };
      const input = intent === "join"
        ? parseJoinConversationInput(finalCandidate)
        : intent === "leave"
          ? parseLeaveConversationInput(finalCandidate)
          : intent === "add_member"
            ? parseAddConversationMemberInput(finalCandidate)
            : intent === "remove_member"
              ? parseRemoveConversationMemberInput(finalCandidate)
              : parseChangeConversationMemberRoleInput(finalCandidate);
      if (normalizedCachePersistence === undefined) {
        return executeConversationLifecycle({
          logicalKey,
          family: "membership",
          conversationId: input.conversationId,
          idempotencyKey,
          input: input as ConversationMembershipMutationInput,
          descriptor: createConversationMembershipDescriptor(input),
          reconcile: (result) =>
            cache.reconcileConversationMembership(logicalKey, input, result),
          refreshWhenSettled: (result) =>
            result.reconciliationStatus === "member_list_conflict" ||
            result.reconciliationStatus === "safety_rejected",
        });
      }
      const scope = currentMembershipScope();
      if (scope === undefined) return Promise.resolve(SEND_VALIDATION_FAILURE);
      const operation = (async () => {
        const persisted = await persistMembershipIntent(scope, input);
        if (persisted === undefined || !membershipScopeIsActive(scope)) {
          return SEND_VALIDATION_FAILURE;
        }
        const result = waitForMembershipResult(persisted.request.idempotencyKey);
        coordinator?.announcePersistedCommand(
          "conversation.membership.mutate",
          persisted.request.idempotencyKey,
        );
        requestRetainedMembershipRecovery();
        return result;
      })();
      const tracked = operation.finally(() => {
        if (lifecycleOperations.get(logicalKey) === tracked) {
          lifecycleOperations.delete(logicalKey);
        }
      });
      lifecycleOperations.set(
        logicalKey,
        tracked as Promise<ChatCommandResult<unknown>>,
      );
      return tracked;
    } catch {
      return Promise.resolve(SEND_VALIDATION_FAILURE);
    }
  };

  const beginConversationPreferenceUpdate = (
    authored: ChatUpdateConversationPreferenceInput,
  ): Promise<ChatUpdateConversationPreferenceResult> => {
    if (normalizedCachePersistence !== undefined) {
      return beginDurableConversationPreferenceUpdate(authored);
    }
    let initialInput: UpdateConversationPreferenceInput;
    let projectedAt: IsoTimestamp;
    let capturedIdentity: ChatCacheIdentity;
    try {
      const state = cache.getState();
      if (state.identity === null) throw new TypeError("preference identity required");
      capturedIdentity = state.identity;
      const expectedPreferenceRevision =
        state.currentUser.preferenceRevisions[authored.conversationId] ?? 0;
      parseUpdateConversationPreferenceInput({
        ...authored,
        operation: "update_conversation_preference",
        expectedPreferenceRevision,
        idempotencyKey: "preference-validation",
      });
      const idempotencyKey = generatePreferenceIdempotencyKey();
      initialInput = parseUpdateConversationPreferenceInput({
        ...authored,
        operation: "update_conversation_preference",
        expectedPreferenceRevision,
        idempotencyKey,
      });
      projectedAt = new Date(preferenceNow()).toISOString() as IsoTimestamp;
      cache.beginOptimisticConversationPreference(initialInput, projectedAt);
    } catch {
      return Promise.resolve(SEND_VALIDATION_FAILURE);
    }

    const conversationId = initialInput.conversationId;
    const idempotencyKey = initialInput.idempotencyKey;
    const generation = preferenceGeneration;
    const identityStillMatches = (): boolean => {
      const current = cache.getState().identity;
      return current !== null &&
        current.tenantId === capturedIdentity.tenantId &&
        current.userId === capturedIdentity.userId &&
        current.sessionId === capturedIdentity.sessionId;
    };
    const execute = async (): Promise<ChatUpdateConversationPreferenceResult> => {
      if (generation !== preferenceGeneration || !identityStillMatches()) {
        if (identityStillMatches()) {
          cache.rollbackOptimisticConversationPreference(
            conversationId,
            idempotencyKey,
          );
        }
        return PREFERENCE_CLOSED_RESULT;
      }
      const state = cache.getState();
      const input = parseUpdateConversationPreferenceInput({
        ...authored,
        operation: "update_conversation_preference",
        expectedPreferenceRevision:
          state.currentUser.preferenceRevisions[conversationId] ?? 0,
        idempotencyKey,
      });
      if (
        state.currentUser.pendingPreferenceUpdates[conversationId]
          ?.idempotencyKey === idempotencyKey
      ) {
        cache.beginOptimisticConversationPreference(input, projectedAt);
      }
      const result = await client.dispatch(
        createConversationPreferenceDescriptor(input),
        input,
        { idempotencyKey },
      );
      if (generation !== preferenceGeneration || !identityStillMatches()) {
        return result;
      }
      if (result.status === "success") {
        try {
          cache.reconcileCurrentUserConversationPreference(input, result.value);
        } catch {
          cache.rollbackOptimisticConversationPreference(
            conversationId,
            idempotencyKey,
          );
        }
      } else {
        cache.rollbackOptimisticConversationPreference(
          conversationId,
          idempotencyKey,
        );
      }
      return result;
    };

    const previous = preferenceQueues.get(conversationId);
    const promise = previous === undefined
      ? Promise.resolve().then(execute)
      : previous.then(execute, execute);
    const tracked = promise.finally(() => {
      if (preferenceQueues.get(conversationId) === tracked) {
        preferenceQueues.delete(conversationId);
      }
    });
    preferenceQueues.set(conversationId, tracked);
    return tracked;
  };

  interface DurableThreadFollowScope {
    readonly generation: number;
    readonly epoch: number;
    readonly identity: ApplicationChatStorageIdentity;
  }

  interface ActiveThreadFollow {
    readonly controller: AbortController;
    readonly canonicalResult: Promise<ChatSetThreadFollowResult>;
    readonly resolveCanonicalResult: (result: ChatSetThreadFollowResult) => void;
  }

  type ThreadFollowAuthorityDecision =
    | { readonly state: "retry" | "dispatch" }
    | {
        readonly state: "settled" | "conflict";
        readonly result: ChatSetThreadFollowResult;
      };

  let threadFollowMutationChain: Promise<void> = Promise.resolve();
  let retainedThreadFollowRecoveryEpoch = 0;
  let retainedThreadFollowPump: Promise<void> | undefined;
  let retainedThreadFollowRetryNumber = 0;
  let retainedThreadFollowRetryController: AbortController | undefined;
  const activeThreadFollows = new Map<string, ActiveThreadFollow>();
  const threadFollowResultWaiters = new Map<
    string,
    Set<(result: ChatSetThreadFollowResult) => void>
  >();

  const serializeThreadFollowMutation = <Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> => {
    const result = threadFollowMutationChain.then(operation);
    threadFollowMutationChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const threadFollowScopeIsActive = (
    scope: DurableThreadFollowScope,
  ): boolean => {
    const cacheIdentity = cache.getState().identity;
    return scope.epoch === retainedThreadFollowRecoveryEpoch &&
      persistenceScopeIsActive(scope.generation, scope.identity) &&
      cacheIdentity !== null &&
      cacheIdentity.tenantId === scope.identity.tenantId &&
      cacheIdentity.userId === scope.identity.userId;
  };

  const currentThreadFollowScope = (): DurableThreadFollowScope | undefined =>
    activePersistenceIdentity === undefined
      ? undefined
      : Object.freeze({
          generation: persistenceGeneration,
          epoch: retainedThreadFollowRecoveryEpoch,
          identity: activePersistenceIdentity,
        });

  const sameThreadFollowIntent = (
    left: DurableThreadFollowIntent,
    right: DurableThreadFollowIntent,
  ): boolean => left.enqueueOrder === right.enqueueOrder &&
    left.enqueuedAt === right.enqueuedAt &&
    JSON.stringify(left.request) === JSON.stringify(right.request);

  const sameThreadFollowCorrelation = (
    left: DurableThreadFollowIntent,
    right: DurableThreadFollowIntent,
  ): boolean => left.request.target.id === right.request.target.id &&
    left.request.idempotencyKey === right.request.idempotencyKey;

  const resolveThreadFollowWaiters = (
    idempotencyKey: string,
    result: ChatSetThreadFollowResult,
  ): void => {
    const waiters = threadFollowResultWaiters.get(idempotencyKey);
    if (waiters === undefined) return;
    threadFollowResultWaiters.delete(idempotencyKey);
    for (const resolve of waiters) resolve(result);
  };

  const waitForThreadFollowResult = (
    idempotencyKey: string,
  ): Promise<ChatSetThreadFollowResult> => new Promise((resolve) => {
    const waiters = threadFollowResultWaiters.get(idempotencyKey) ?? new Set();
    waiters.add(resolve);
    threadFollowResultWaiters.set(idempotencyKey, waiters);
  });

  const readThreadFollowRecord = async (
    scope: DurableThreadFollowScope,
  ): Promise<ApplicationChatQueuedThreadFollowIntentsRecord | null> => {
    if (!threadFollowScopeIsActive(scope) || normalizedCachePersistence === undefined) {
      throw new Error("inactive durable thread-follow scope");
    }
    const record = await normalizedCachePersistence.storage.read(
      scope.identity,
      ApplicationChatStorageRecordKind.queuedThreadFollowIntents,
    );
    if (!threadFollowScopeIsActive(scope)) {
      throw new Error("inactive durable thread-follow scope");
    }
    return record;
  };

  const publishRetainedThreadFollows = (
    record: ApplicationChatQueuedThreadFollowIntentsRecord | null,
  ): void => {
    const next = Object.freeze([...(record?.intents ?? [])]);
    for (const previous of retainedThreadFollowIntents) {
      const superseded = next.some((intent) =>
        intent.request.target.id === previous.request.target.id &&
        intent.request.idempotencyKey !== previous.request.idempotencyKey);
      if (!superseded) continue;
      cache.rollbackOptimisticThreadFollow(
        previous.request.target.id,
        previous.request.idempotencyKey,
      );
      const active = activeThreadFollows.get(previous.request.idempotencyKey);
      active?.resolveCanonicalResult(THREAD_FOLLOW_CLOSED_RESULT);
      active?.controller.abort();
      resolveThreadFollowWaiters(
        previous.request.idempotencyKey,
        THREAD_FOLLOW_CLOSED_RESULT,
      );
    }
    retainedThreadFollowIntents = next;
  };

  const mutateThreadFollowRecord = async (
    scope: DurableThreadFollowScope,
    updater: (
      current: ApplicationChatQueuedThreadFollowIntentsRecord | null,
    ) => ApplicationChatQueuedThreadFollowIntentsRecord | null,
  ): Promise<ApplicationChatQueuedThreadFollowIntentsRecord | null> => {
    if (!threadFollowScopeIsActive(scope) || normalizedCachePersistence === undefined) {
      throw new Error("inactive durable thread-follow scope");
    }
    const committed = await normalizedCachePersistence.storage.mutate(
      scope.identity,
      ApplicationChatStorageRecordKind.queuedThreadFollowIntents,
      (current) => {
        if (!threadFollowScopeIsActive(scope)) {
          throw new Error("inactive durable thread-follow scope");
        }
        const proposal = updater(current);
        if (!threadFollowScopeIsActive(scope)) {
          throw new Error("inactive durable thread-follow scope");
        }
        return proposal;
      },
    );
    if (!threadFollowScopeIsActive(scope)) {
      throw new Error("inactive durable thread-follow scope");
    }
    publishRetainedThreadFollows(committed);
    return committed;
  };

  const reloadThreadFollowRecord = (
    scope: DurableThreadFollowScope,
  ): Promise<boolean> => serializeThreadFollowMutation(async () => {
    try {
      const record = await readThreadFollowRecord(scope);
      publishRetainedThreadFollows(record);
      return true;
    } catch (error) {
      if (!threadFollowScopeIsActive(scope)) return false;
      if (error instanceof ApplicationChatStorageValidationError) {
        reportPersistenceDiagnostic(
          "thread_follow_intents_rejected",
          "The stored thread-follow intents were rejected and quarantined.",
        );
        publishRetainedThreadFollows(null);
      } else {
        reportPersistenceDiagnostic(
          "thread_follow_intents_read_failed",
          "The stored thread-follow intents could not be read.",
        );
      }
      return false;
    }
  });

  const persistThreadFollowIntent = (
    scope: DurableThreadFollowScope,
    input: SetThreadFollowInput,
    enqueuedAt: IsoTimestamp,
  ): Promise<DurableThreadFollowIntent | undefined> =>
    serializeThreadFollowMutation(async () => {
      try {
        let superseded: DurableThreadFollowIntent | undefined;
        const committed = await mutateThreadFollowRecord(
          scope,
          (current) => {
            const currentIntents = current?.intents ?? [];
            const supersededIndex = currentIntents.findIndex((intent) =>
              intent.request.target.id === input.target.id);
            superseded = supersededIndex < 0
              ? undefined
              : currentIntents[supersededIndex];
            const enqueueOrder = superseded?.enqueueOrder ??
              (currentIntents.reduce(
                (highest, intent) => Math.max(highest, intent.enqueueOrder),
                0,
              ) + 1);
            const intent = createApplicationChatQueuedThreadFollowIntent(
              input,
              {
                enqueueOrder,
                enqueuedAt: superseded?.enqueuedAt ?? enqueuedAt,
              },
            );
            return createApplicationChatQueuedThreadFollowIntentsRecord(
              scope.identity,
              supersededIndex < 0
                ? [...currentIntents, intent]
                : currentIntents.map((candidate, index) =>
                    index === supersededIndex ? intent : candidate),
            );
          },
        );
        if (
          superseded !== undefined &&
          superseded.request.idempotencyKey !== input.idempotencyKey
        ) {
          cache.rollbackOptimisticThreadFollow(
            superseded.request.target.id,
            superseded.request.idempotencyKey,
          );
          const active = activeThreadFollows.get(superseded.request.idempotencyKey);
          active?.resolveCanonicalResult(THREAD_FOLLOW_CLOSED_RESULT);
          active?.controller.abort();
          resolveThreadFollowWaiters(
            superseded.request.idempotencyKey,
            THREAD_FOLLOW_CLOSED_RESULT,
          );
        }
        return committed?.intents.find((candidate) =>
          candidate.request.target.id === input.target.id &&
          candidate.request.idempotencyKey === input.idempotencyKey);
      } catch {
        if (threadFollowScopeIsActive(scope)) {
          reportPersistenceDiagnostic(
            "thread_follow_intents_write_failed",
            "The thread-follow command could not be stored before projection or dispatch.",
          );
        }
        return undefined;
      }
    });

  const removeThreadFollowIntent = (
    scope: DurableThreadFollowScope,
    intent: DurableThreadFollowIntent,
  ): Promise<boolean> => serializeThreadFollowMutation(async () => {
    if (!threadFollowScopeIsActive(scope) || normalizedCachePersistence === undefined) {
      return false;
    }
    try {
      await mutateThreadFollowRecord(scope, (current) => {
        if (current === null) return null;
        const remaining = current.intents.filter((candidate) =>
          !sameThreadFollowCorrelation(candidate, intent));
        if (remaining.length === current.intents.length) return current;
        return remaining.length === 0
          ? null
          : createApplicationChatQueuedThreadFollowIntentsRecord(
              scope.identity,
              remaining,
            );
      });
      if (!threadFollowScopeIsActive(scope)) return false;
      cache.rollbackOptimisticThreadFollow(
        intent.request.target.id,
        intent.request.idempotencyKey,
      );
      return true;
    } catch {
      if (threadFollowScopeIsActive(scope)) {
        reportPersistenceDiagnostic(
          "thread_follow_intents_write_failed",
          "A settled thread-follow command could not be removed from storage.",
        );
      }
      return false;
    }
  });

  const authoritativeThreadFollow = (
    request: SetThreadFollowInput,
  ) => {
    const state = cache.getState();
    const pending = state.currentUser.pendingThreadFollowUpdates[request.target.id];
    return pending === undefined
      ? state.currentUser.threadFollows[request.target.id]
      : pending.authoritativeFollow;
  };

  const threadFollowAuthorityIsReady = (
    scope: DurableThreadFollowScope,
    request: SetThreadFollowInput,
  ): boolean => {
    if (!threadFollowScopeIsActive(scope)) return false;
    const state = cache.getState();
    const revision = state.currentUser.threadFollowRevisions[request.target.id] ?? 0;
    return state.entities.conversations[request.target.id]?.type === "thread" &&
      revision >= request.expectedFollowRevision &&
      (revision === 0 || authoritativeThreadFollow(request) !== undefined);
  };

  const refreshThreadFollowAuthority = async (
    scope: DurableThreadFollowScope,
    request: SetThreadFollowInput,
    signal: AbortSignal,
  ): Promise<boolean> => {
    if (!threadFollowScopeIsActive(scope) || signal.aborted) return false;
    const result = await snapshotReader.getConversation<Feature>(
      { conversationId: request.target.id },
      { signal },
    );
    return threadFollowScopeIsActive(scope) &&
      !signal.aborted &&
      result.status === "success" &&
      threadFollowAuthorityIsReady(scope, request);
  };

  const threadFollowMatchesDesired = (
    request: SetThreadFollowInput,
    follow: ReturnType<typeof authoritativeThreadFollow>,
  ): boolean => follow !== undefined &&
    follow.isFollowing === (request.intent === "follow") &&
    follow.source === "manual";

  const canonicalThreadFollowResult = (
    request: SetThreadFollowInput,
  ): ChatSetThreadFollowResult | undefined => {
    const follow = authoritativeThreadFollow(request);
    if (follow === undefined) return undefined;
    const followRevision =
      cache.getState().currentUser.threadFollowRevisions[request.target.id] ?? 0;
    if (followRevision < request.expectedFollowRevision) return undefined;
    const matches = threadFollowMatchesDesired(request, follow);
    if (!matches && followRevision === request.expectedFollowRevision) return undefined;
    const reconciliationStatus = matches
      ? followRevision === request.expectedFollowRevision
        ? "already_requested_state"
        : followRevision === request.expectedFollowRevision + 1
          ? "replayed"
          : "follow_revision_conflict"
      : "follow_revision_conflict";
    return {
      status: "success",
      value: {
        operation: "set_thread_follow",
        intent: request.intent,
        reconciliationStatus,
        target: request.target,
        expectedFollowRevision: request.expectedFollowRevision,
        idempotencyKey: request.idempotencyKey,
        followRevision,
        follow,
      } as SetThreadFollowResult,
    };
  };

  const decideThreadFollowAuthority = (
    scope: DurableThreadFollowScope,
    intent: DurableThreadFollowIntent,
  ): ThreadFollowAuthorityDecision => {
    if (!threadFollowAuthorityIsReady(scope, intent.request)) return { state: "retry" };
    const state = cache.getState();
    const revision = state.currentUser.threadFollowRevisions[intent.request.target.id] ?? 0;
    const follow = authoritativeThreadFollow(intent.request);
    const result = canonicalThreadFollowResult(intent.request);
    if (threadFollowMatchesDesired(intent.request, follow)) {
      return result === undefined
        ? { state: "retry" }
        : { state: "settled", result };
    }
    if (revision > intent.request.expectedFollowRevision) {
      try {
        cache.markThreadFollowConflict(intent.request);
      } catch {
        return { state: "retry" };
      }
      return result === undefined
        ? { state: "retry" }
        : { state: "conflict", result };
    }
    const pending = state.currentUser.pendingThreadFollowUpdates[intent.request.target.id];
    if (
      pending?.idempotencyKey !== intent.request.idempotencyKey ||
      pending.state !== "pending"
    ) {
      try {
        cache.beginOptimisticThreadFollow(intent.request, intent.enqueuedAt);
      } catch {
        return { state: "retry" };
      }
    }
    return { state: "dispatch" };
  };

  const threadFollowResultIsTerminal = (
    result: ChatSetThreadFollowResult,
  ): boolean => result.status === "validation" ||
    result.status === "authentication" ||
    result.status === "conflict" ||
    result.status === "feature_disabled" ||
    result.status === "unsupported" ||
    (result.status === "rejected" && result.httpStatus !== 429);

  const settleThreadFollowResult = async (
    scope: DurableThreadFollowScope,
    intent: DurableThreadFollowIntent,
    result: ChatSetThreadFollowResult,
  ): Promise<ChatSetThreadFollowResult> => {
    if (!threadFollowScopeIsActive(scope)) return THREAD_FOLLOW_CLOSED_RESULT;
    if (result.status === "success") {
      try {
        cache.reconcileCurrentUserThreadFollow(intent.request, result.value);
      } catch {
        return SEND_MALFORMED_RESPONSE;
      }
      const decision = decideThreadFollowAuthority(scope, intent);
      if (decision.state === "settled") {
        await removeThreadFollowIntent(scope, intent);
      } else if (decision.state === "conflict") {
        return result;
      } else if (result.value.reconciliationStatus !== "follow_revision_conflict") {
        return SEND_MALFORMED_RESPONSE;
      }
    } else if (threadFollowResultIsTerminal(result)) {
      await removeThreadFollowIntent(scope, intent);
    }
    return result;
  };

  const executeDurableThreadFollow = async (
    scope: DurableThreadFollowScope,
    intent: DurableThreadFollowIntent,
  ): Promise<ChatSetThreadFollowResult | undefined> => {
    const key = intent.request.idempotencyKey;
    if (activeThreadFollows.has(key)) return waitForThreadFollowResult(key);
    if (!threadFollowScopeIsActive(scope)) return THREAD_FOLLOW_CLOSED_RESULT;
    const controller = new AbortController();
    let resolveCanonicalResult!: (result: ChatSetThreadFollowResult) => void;
    const canonicalResult = new Promise<ChatSetThreadFollowResult>((resolve) => {
      resolveCanonicalResult = resolve;
    });
    const active = Object.freeze({ controller, canonicalResult, resolveCanonicalResult });
    activeThreadFollows.set(key, active);
    let result: ChatSetThreadFollowResult | undefined;
    try {
      if (
        !threadFollowAuthorityIsReady(scope, intent.request) &&
        !await refreshThreadFollowAuthority(
          scope,
          intent.request,
          controller.signal,
        ).catch(() => false)
      ) return undefined;
      if (!threadFollowScopeIsActive(scope) || controller.signal.aborted) {
        return THREAD_FOLLOW_CLOSED_RESULT;
      }
      const decision = decideThreadFollowAuthority(scope, intent);
      if (decision.state === "retry") return undefined;
      if (decision.state === "settled") {
        await removeThreadFollowIntent(scope, intent);
        result = decision.result;
        return result;
      }
      if (decision.state === "conflict") {
        result = decision.result;
        return result;
      }
      if (controller.signal.aborted || !threadFollowScopeIsActive(scope)) {
        return THREAD_FOLLOW_CLOSED_RESULT;
      }
      const descriptor = createThreadFollowDescriptor(intent.request);
      const dispatch = () => commandDispatcher.dispatch(
        descriptor,
        intent.request,
        { idempotencyKey: key, signal: controller.signal },
      );
      const coordinatedDispatch = coordinator === undefined ||
          coordinationStatus?.role === "fallback"
        ? dispatch()
        : coordinator.coordinateCommand({
            command: "thread.follow.set",
            idempotencyKey: key,
            execute: dispatch,
            parseResult: (value) => parseCoordinatedCommandResult(descriptor, value),
          });
      result = await Promise.race([coordinatedDispatch, canonicalResult]);
      if (!threadFollowScopeIsActive(scope)) return THREAD_FOLLOW_CLOSED_RESULT;
      if (result.status === "transport" || result.status === "malformed_response") {
        const refreshed = await refreshThreadFollowAuthority(
          scope, intent.request, controller.signal,
        ).catch(() => false);
        if (refreshed) {
          const authority = decideThreadFollowAuthority(scope, intent);
          if (authority.state === "settled" || authority.state === "conflict") result = authority.result;
        }
        if (threadFollowScopeIsActive(scope) &&
            (result.status === "transport" || result.status === "malformed_response")) {
          cache.rollbackOptimisticThreadFollow(intent.request.target.id, key);
        }
      }
      result = await settleThreadFollowResult(scope, intent, result);
      return result;
    } finally {
      if (activeThreadFollows.get(key) === active) activeThreadFollows.delete(key);
      if (result !== undefined) resolveThreadFollowWaiters(key, result);
    }
  };

  const retainedThreadFollowRecoveryPermitted = (): boolean =>
    lifecycleState.state === "ready" &&
    currentThreadFollowScope() !== undefined &&
    ownsRetainedSendRecovery() &&
    (realtimeSession === undefined || realtimeSession.state.state === "connected");

  const retainedThreadFollowDelay = (retryNumber: number): number => Math.min(
    retainedThreadFollowMaximumDelayMs,
    retainedThreadFollowInitialDelayMs *
      retainedThreadFollowRetryMultiplier ** Math.max(0, retryNumber - 1),
  );

  const runRetainedThreadFollowPump = async (epoch: number): Promise<void> => {
    while (
      epoch === retainedThreadFollowRecoveryEpoch &&
      retainedThreadFollowRecoveryPermitted()
    ) {
      const scope = currentThreadFollowScope();
      if (scope === undefined || scope.epoch !== epoch) return;
      const intents = [...retainedThreadFollowIntents];
      if (intents.length === 0) return;
      let retryRequired = false;
      let settledAny = false;
      for (const intent of intents) {
        if (!threadFollowScopeIsActive(scope)) return;
        if (!retainedThreadFollowIntents.some((candidate) =>
          sameThreadFollowIntent(candidate, intent))) continue;
        const pending = cache.getState().currentUser.pendingThreadFollowUpdates[
          intent.request.target.id
        ];
        if (
          pending?.state === "conflict" &&
          pending.idempotencyKey === intent.request.idempotencyKey
        ) continue;
        const result = await executeDurableThreadFollow(scope, intent);
        if (!threadFollowScopeIsActive(scope)) return;
        const retained = retainedThreadFollowIntents.some((candidate) =>
          sameThreadFollowIntent(candidate, intent));
        if (retained) {
          const current = cache.getState().currentUser.pendingThreadFollowUpdates[
            intent.request.target.id
          ];
          if (current?.state !== "conflict") retryRequired = true;
        } else {
          settledAny = true;
        }
        if (result?.status === "closed" || result?.status === "aborted") return;
      }
      if (!retryRequired) {
        retainedThreadFollowRetryNumber = 0;
        if (!settledAny) return;
        continue;
      }
      retainedThreadFollowRetryNumber += 1;
      const controller = new AbortController();
      retainedThreadFollowRetryController = controller;
      try {
        await retainedThreadFollowWait(
          retainedThreadFollowDelay(retainedThreadFollowRetryNumber),
          controller.signal,
        );
      } catch {
        return;
      } finally {
        if (retainedThreadFollowRetryController === controller) {
          retainedThreadFollowRetryController = undefined;
        }
      }
    }
  };

  const startRetainedThreadFollowRecovery = (): void => {
    if (!retainedThreadFollowRecoveryPermitted() || retainedThreadFollowPump !== undefined) {
      return;
    }
    const epoch = retainedThreadFollowRecoveryEpoch;
    const pump = runRetainedThreadFollowPump(epoch)
      .catch(() => undefined)
      .finally(() => {
        if (retainedThreadFollowPump !== pump) return;
        retainedThreadFollowPump = undefined;
        const replayable = retainedThreadFollowIntents.some((intent) => {
          const pending = cache.getState().currentUser.pendingThreadFollowUpdates[
            intent.request.target.id
          ];
          return pending?.state !== "conflict" ||
            pending.idempotencyKey !== intent.request.idempotencyKey;
        });
        if (replayable && retainedThreadFollowRecoveryPermitted()) {
          queueMicrotask(startRetainedThreadFollowRecovery);
        }
      });
    retainedThreadFollowPump = pump;
  };

  requestRetainedThreadFollowRecovery = (): void => startRetainedThreadFollowRecovery();

  pauseRetainedThreadFollowRecovery = (): void => {
    retainedThreadFollowRecoveryEpoch += 1;
    retainedThreadFollowPump = undefined;
    retainedThreadFollowRetryNumber = 0;
    retainedThreadFollowRetryController?.abort();
    retainedThreadFollowRetryController = undefined;
    for (const active of activeThreadFollows.values()) {
      active.resolveCanonicalResult(THREAD_FOLLOW_CLOSED_RESULT);
      active.controller.abort();
    }
    activeThreadFollows.clear();
  };

  activateRetainedThreadFollowRecovery = async (generation, identity): Promise<void> => {
    const scope = Object.freeze({
      generation,
      epoch: retainedThreadFollowRecoveryEpoch,
      identity,
    });
    await reloadThreadFollowRecord(scope);
  };

  resumeRetainedThreadFollowRecoveryFromStorage = (announcement): void => {
    if (
      announcement !== undefined &&
      announcement.command !== "thread.follow.set"
    ) return;
    const identity = activePersistenceIdentity;
    const generation = persistenceGeneration;
    if (identity === undefined || !ownsRetainedSendRecovery()) return;
    void activateRetainedThreadFollowRecovery(generation, identity)
      .then(() => {
        if (
          !persistenceScopeIsActive(generation, identity) ||
          !ownsRetainedSendRecovery() ||
          (announcement !== undefined && !retainedThreadFollowIntents.some(
            (intent) => intent.request.idempotencyKey === announcement.idempotencyKey,
          ))
        ) return;
        requestRetainedThreadFollowRecovery();
      })
      .catch(() => undefined);
  };

  handleRetainedThreadFollowCoordinatedResult = (
    command,
    idempotencyKey,
    value,
  ): void => {
    if (command !== "thread.follow.set") return;
    const intent = retainedThreadFollowIntents.find(
      (candidate) => candidate.request.idempotencyKey === idempotencyKey,
    );
    const scope = currentThreadFollowScope();
    if (intent === undefined || scope === undefined) return;
    const result = parseCoordinatedCommandResult(
      createThreadFollowDescriptor(intent.request),
      value,
    );
    if (result === undefined) return;
    void settleThreadFollowResult(scope, intent, result).then((settled) => {
      if (!threadFollowScopeIsActive(scope)) return;
      resolveThreadFollowWaiters(idempotencyKey, settled);
      requestRetainedThreadFollowRecovery();
    });
  };

  handleRetainedThreadFollowCanonicalEvent = (event): void => {
    if (
      event.type !== "thread.follow.updated" ||
      !isRecord(event.payload) ||
      event.tenantId === undefined ||
      !isRecord(event.payload.target) ||
      event.payload.target.type !== "thread" ||
      typeof event.payload.target.id !== "string"
    ) return;
    const scope = currentThreadFollowScope();
    if (scope === undefined || event.tenantId !== scope.identity.tenantId) return;
    const eventThreadId = event.payload.target.id;
    const intents = retainedThreadFollowIntents.filter((intent) =>
      intent.request.target.id === eventThreadId);
    for (const intent of intents) {
      void (async () => {
        if (!threadFollowScopeIsActive(scope)) return;
        const decision = decideThreadFollowAuthority(scope, intent);
        if (decision.state !== "settled" && decision.state !== "conflict") return;
        if (decision.state === "settled") {
          await removeThreadFollowIntent(scope, intent);
        }
        if (!threadFollowScopeIsActive(scope)) return;
        const active = activeThreadFollows.get(intent.request.idempotencyKey);
        active?.resolveCanonicalResult(decision.result);
        active?.controller.abort();
        resolveThreadFollowWaiters(intent.request.idempotencyKey, decision.result);
        retainedThreadFollowRetryController?.abort();
        queueMicrotask(requestRetainedThreadFollowRecovery);
      })().catch(() => undefined);
    }
  };

  const beginDurableThreadFollow = (
    authored: ChatSetThreadFollowInput,
  ): Promise<ChatSetThreadFollowResult> => {
    let input: SetThreadFollowInput;
    let enqueuedAt: IsoTimestamp;
    const scope = currentThreadFollowScope();
    try {
      if (scope === undefined) throw new TypeError("thread-follow persistence required");
      if (!isRecord(authored)) throw new TypeError("thread follow input required");
      const state = cache.getState();
      if (state.identity === null) throw new TypeError("thread follow identity required");
      const expectedFollowRevision =
        state.currentUser.threadFollowRevisions[authored.threadId as ConversationId] ?? 0;
      parseSetThreadFollowInput({
        operation: "set_thread_follow",
        intent: authored.intent,
        target: { type: "thread", id: authored.threadId },
        expectedFollowRevision,
        idempotencyKey: "thread-follow-validation",
      });
      input = parseSetThreadFollowInput({
        operation: "set_thread_follow",
        intent: authored.intent,
        target: { type: "thread", id: authored.threadId },
        expectedFollowRevision,
        idempotencyKey: generateThreadFollowIdempotencyKey(),
      });
      const thread = state.entities.conversations[input.target.id];
      const parent = thread?.type === "thread"
        ? state.entities.conversations[thread.parentConversationId]
        : undefined;
      const root = thread?.type === "thread"
        ? state.entities.messages[thread.rootMessageId]
        : undefined;
      if (
        thread?.type !== "thread" ||
        parent === undefined ||
        parent.type === "thread" ||
        root === undefined ||
        root.conversationId !== parent.id
      ) throw new TypeError("thread follow target required");
      enqueuedAt = new Date(threadFollowNow()).toISOString() as IsoTimestamp;
    } catch {
      return Promise.resolve(SEND_VALIDATION_FAILURE);
    }
    return (async () => {
      const intent = await persistThreadFollowIntent(scope, input, enqueuedAt);
      if (intent === undefined || !threadFollowScopeIsActive(scope)) {
        return SEND_VALIDATION_FAILURE;
      }
      const result = waitForThreadFollowResult(intent.request.idempotencyKey);
      coordinator?.announcePersistedCommand(
        "thread.follow.set",
        intent.request.idempotencyKey,
      );
      requestRetainedThreadFollowRecovery();
      return result;
    })();
  };

  cache.subscribePrivateStateBoundary(() => {
    pauseRetainedThreadFollowRecovery();
    for (const intent of retainedThreadFollowIntents) {
      cache.rollbackOptimisticThreadFollow(
        intent.request.target.id,
        intent.request.idempotencyKey,
      );
    }
    retainedThreadFollowIntents = Object.freeze([]);
    for (const waiters of threadFollowResultWaiters.values()) {
      for (const resolve of waiters) resolve(THREAD_FOLLOW_CLOSED_RESULT);
    }
    threadFollowResultWaiters.clear();
  });

  const beginInMemoryThreadFollow = (
    authored: ChatSetThreadFollowInput,
  ): Promise<ChatSetThreadFollowResult> => {
    let initialInput: SetThreadFollowInput;
    let projectedAt: IsoTimestamp;
    let capturedIdentity: ChatCacheIdentity;
    try {
      if (!isRecord(authored)) throw new TypeError("thread follow input required");
      const state = cache.getState();
      if (state.identity === null) throw new TypeError("thread follow identity required");
      capturedIdentity = state.identity;
      const expectedFollowRevision =
        state.currentUser.threadFollowRevisions[authored.threadId as ConversationId] ?? 0;
      parseSetThreadFollowInput({
        operation: "set_thread_follow",
        intent: authored.intent,
        target: { type: "thread", id: authored.threadId },
        expectedFollowRevision,
        idempotencyKey: "thread-follow-validation",
      });
      const idempotencyKey = generateThreadFollowIdempotencyKey();
      initialInput = parseSetThreadFollowInput({
        operation: "set_thread_follow",
        intent: authored.intent,
        target: { type: "thread", id: authored.threadId },
        expectedFollowRevision,
        idempotencyKey,
      });
      projectedAt = new Date(threadFollowNow()).toISOString() as IsoTimestamp;
      cache.beginOptimisticThreadFollow(initialInput, projectedAt);
    } catch {
      return Promise.resolve(SEND_VALIDATION_FAILURE);
    }

    const threadId = initialInput.target.id;
    const idempotencyKey = initialInput.idempotencyKey;
    const generation = threadFollowGeneration;
    const identityStillMatches = (): boolean => {
      const current = cache.getState().identity;
      return current !== null &&
        current.tenantId === capturedIdentity.tenantId &&
        current.userId === capturedIdentity.userId &&
        current.sessionId === capturedIdentity.sessionId;
    };
    const execute = async (): Promise<ChatSetThreadFollowResult> => {
      if (generation !== threadFollowGeneration || !identityStillMatches()) {
        if (identityStillMatches()) {
          cache.rollbackOptimisticThreadFollow(threadId, idempotencyKey);
        }
        return THREAD_FOLLOW_CLOSED_RESULT;
      }
      const state = cache.getState();
      const input = parseSetThreadFollowInput({
        operation: "set_thread_follow",
        intent: initialInput.intent,
        target: initialInput.target,
        expectedFollowRevision:
          state.currentUser.threadFollowRevisions[threadId] ?? 0,
        idempotencyKey,
      });
      if (
        state.currentUser.pendingThreadFollowUpdates[threadId]
          ?.idempotencyKey === idempotencyKey
      ) {
        cache.beginOptimisticThreadFollow(input, projectedAt);
      }
      const result = await client.dispatch(
        createThreadFollowDescriptor(input),
        input,
        { idempotencyKey },
      );
      if (generation !== threadFollowGeneration || !identityStillMatches()) {
        return result;
      }
      if (result.status === "success") {
        try {
          cache.reconcileCurrentUserThreadFollow(input, result.value);
        } catch {
          cache.rollbackOptimisticThreadFollow(threadId, idempotencyKey);
        }
      } else {
        if (result.status === "transport" || result.status === "malformed_response") {
          const refreshed = await snapshotReader.getConversation<Feature>(
            { conversationId: threadId },
          ).catch(() => undefined);
          if (generation !== threadFollowGeneration || !identityStillMatches()) return result;
          if (refreshed?.status === "success") {
            const canonical = canonicalThreadFollowResult(input);
            if (canonical !== undefined) {
              cache.rollbackOptimisticThreadFollow(threadId, idempotencyKey);
              return canonical;
            }
          }
        }
        cache.rollbackOptimisticThreadFollow(threadId, idempotencyKey);
      }
      return result;
    };

    const previous = threadFollowQueues.get(threadId);
    const promise = previous === undefined
      ? Promise.resolve().then(execute)
      : previous.then(execute, execute);
    const tracked = promise.finally(() => {
      if (threadFollowQueues.get(threadId) === tracked) {
        threadFollowQueues.delete(threadId);
      }
    });
    threadFollowQueues.set(threadId, tracked);
    return tracked;
  };

  const beginThreadFollow = (
    authored: ChatSetThreadFollowInput,
  ): Promise<ChatSetThreadFollowResult> => normalizedCachePersistence === undefined
    ? beginInMemoryThreadFollow(authored)
    : beginDurableThreadFollow(authored);

  interface DurableSavedMessageScope {
    readonly generation: number;
    readonly epoch: number;
    readonly identity: ApplicationChatStorageIdentity;
  }

  interface ActiveSavedMessage {
    readonly controller: AbortController;
    readonly canonicalResult: Promise<ChatSetSavedMessageResult>;
    readonly resolveCanonicalResult: (result: ChatSetSavedMessageResult) => void;
  }

  interface SavedMessageAuthority {
    readonly revision: number;
    readonly savedMessage: SetSavedMessageResult["savedMessage"];
  }

  type SavedMessageAuthorityDecision =
    | { readonly state: "retry" | "dispatch" }
    | {
        readonly state: "settled" | "conflict";
        readonly result: ChatSetSavedMessageResult;
      };

  let savedMessageMutationChain: Promise<void> = Promise.resolve();
  let retainedSavedMessageRecoveryEpoch = 0;
  let retainedSavedMessagePump: Promise<void> | undefined;
  let retainedSavedMessageRetryNumber = 0;
  let retainedSavedMessageRetryController: AbortController | undefined;
  const activeSavedMessages = new Map<string, ActiveSavedMessage>();
  const savedMessageResultWaiters = new Map<
    string,
    Set<(result: ChatSetSavedMessageResult) => void>
  >();
  const savedMessageAuthorities = new Map<MessageId, SavedMessageAuthority>();
  const settlingCoordinatedSavedMessages = new Set<string>();

  const serializeSavedMessageMutation = <Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> => {
    const result = savedMessageMutationChain.then(operation);
    savedMessageMutationChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const savedMessageScopeIsActive = (
    scope: DurableSavedMessageScope,
  ): boolean => {
    const cacheIdentity = cache.getState().identity;
    return scope.epoch === retainedSavedMessageRecoveryEpoch &&
      persistenceScopeIsActive(scope.generation, scope.identity) &&
      cacheIdentity !== null &&
      cacheIdentity.tenantId === scope.identity.tenantId &&
      cacheIdentity.userId === scope.identity.userId;
  };

  const currentSavedMessageScope = (): DurableSavedMessageScope | undefined =>
    activePersistenceIdentity === undefined
      ? undefined
      : Object.freeze({
          generation: persistenceGeneration,
          epoch: retainedSavedMessageRecoveryEpoch,
          identity: activePersistenceIdentity,
        });

  const sameSavedMessageIntent = (
    left: DurableSavedMessageIntent,
    right: DurableSavedMessageIntent,
  ): boolean => left.enqueueOrder === right.enqueueOrder &&
    left.enqueuedAt === right.enqueuedAt &&
    JSON.stringify(left.request) === JSON.stringify(right.request);

  const sameSavedMessageCorrelation = (
    left: DurableSavedMessageIntent,
    right: DurableSavedMessageIntent,
  ): boolean => left.request.messageId === right.request.messageId &&
    left.request.idempotencyKey === right.request.idempotencyKey;

  const resolveSavedMessageWaiters = (
    idempotencyKey: string,
    result: ChatSetSavedMessageResult,
  ): void => {
    const waiters = savedMessageResultWaiters.get(idempotencyKey);
    if (waiters === undefined) return;
    savedMessageResultWaiters.delete(idempotencyKey);
    for (const resolve of waiters) resolve(result);
  };

  const waitForSavedMessageResult = (
    idempotencyKey: string,
  ): Promise<ChatSetSavedMessageResult> => new Promise((resolve) => {
    const waiters = savedMessageResultWaiters.get(idempotencyKey) ?? new Set();
    waiters.add(resolve);
    savedMessageResultWaiters.set(idempotencyKey, waiters);
  });

  const readSavedMessageRecord = async (
    scope: DurableSavedMessageScope,
  ): Promise<ApplicationChatQueuedSavedMessageIntentsRecord | null> => {
    if (!savedMessageScopeIsActive(scope) || normalizedCachePersistence === undefined) {
      throw new Error("inactive durable saved-message scope");
    }
    const record = await normalizedCachePersistence.storage.read(
      scope.identity,
      ApplicationChatStorageRecordKind.queuedSavedMessageIntents,
    );
    if (!savedMessageScopeIsActive(scope)) {
      throw new Error("inactive durable saved-message scope");
    }
    return record;
  };

  const publishRetainedSavedMessages = (
    record: ApplicationChatQueuedSavedMessageIntentsRecord | null,
  ): void => {
    const next = Object.freeze([...(record?.intents ?? [])]);
    for (const previous of retainedSavedMessageIntents) {
      const superseded = next.some((intent) =>
        intent.request.messageId === previous.request.messageId &&
        intent.request.idempotencyKey !== previous.request.idempotencyKey);
      if (!superseded) continue;
      cache.rollbackOptimisticSavedMessage(
        previous.request.messageId,
        previous.request.idempotencyKey,
      );
      const active = activeSavedMessages.get(previous.request.idempotencyKey);
      active?.resolveCanonicalResult(PREFERENCE_CLOSED_RESULT);
      active?.controller.abort();
      resolveSavedMessageWaiters(
        previous.request.idempotencyKey,
        PREFERENCE_CLOSED_RESULT,
      );
    }
    retainedSavedMessageIntents = next;
  };

  const mutateSavedMessageRecord = async (
    scope: DurableSavedMessageScope,
    updater: (
      current: ApplicationChatQueuedSavedMessageIntentsRecord | null,
    ) => ApplicationChatQueuedSavedMessageIntentsRecord | null,
  ): Promise<ApplicationChatQueuedSavedMessageIntentsRecord | null> => {
    if (!savedMessageScopeIsActive(scope) || normalizedCachePersistence === undefined) {
      throw new Error("inactive durable saved-message scope");
    }
    const committed = await normalizedCachePersistence.storage.mutate(
      scope.identity,
      ApplicationChatStorageRecordKind.queuedSavedMessageIntents,
      (current) => {
        if (!savedMessageScopeIsActive(scope)) {
          throw new Error("inactive durable saved-message scope");
        }
        const proposal = updater(current);
        if (!savedMessageScopeIsActive(scope)) {
          throw new Error("inactive durable saved-message scope");
        }
        return proposal;
      },
    );
    if (!savedMessageScopeIsActive(scope)) {
      throw new Error("inactive durable saved-message scope");
    }
    publishRetainedSavedMessages(committed);
    return committed;
  };

  const reloadSavedMessageRecord = (
    scope: DurableSavedMessageScope,
  ): Promise<boolean> => serializeSavedMessageMutation(async () => {
    try {
      const record = await readSavedMessageRecord(scope);
      publishRetainedSavedMessages(record);
      return true;
    } catch (error) {
      if (!savedMessageScopeIsActive(scope)) return false;
      if (error instanceof ApplicationChatStorageValidationError) {
        reportPersistenceDiagnostic(
          "saved_message_intents_rejected",
          "The stored saved-message intents were rejected and quarantined.",
        );
        publishRetainedSavedMessages(null);
      } else {
        reportPersistenceDiagnostic(
          "saved_message_intents_read_failed",
          "The stored saved-message intents could not be read.",
        );
      }
      return false;
    }
  });

  const persistSavedMessageIntent = (
    scope: DurableSavedMessageScope,
    input: SetSavedMessageInput,
    enqueuedAt: IsoTimestamp,
  ): Promise<DurableSavedMessageIntent | undefined> =>
    serializeSavedMessageMutation(async () => {
      try {
        let superseded: DurableSavedMessageIntent | undefined;
        const committed = await mutateSavedMessageRecord(
          scope,
          (current) => {
            const currentIntents = current?.intents ?? [];
            const supersededIndex = currentIntents.findIndex((intent) =>
              intent.request.messageId === input.messageId);
            superseded = supersededIndex < 0
              ? undefined
              : currentIntents[supersededIndex];
            const enqueueOrder = superseded?.enqueueOrder ??
              (currentIntents.reduce(
                (highest, intent) => Math.max(highest, intent.enqueueOrder),
                0,
              ) + 1);
            const intent = createApplicationChatQueuedSavedMessageIntent(
              input,
              {
                enqueueOrder,
                enqueuedAt: superseded?.enqueuedAt ?? enqueuedAt,
              },
            );
            return createApplicationChatQueuedSavedMessageIntentsRecord(
              scope.identity,
              supersededIndex < 0
                ? [...currentIntents, intent]
                : currentIntents.map((candidate, index) =>
                    index === supersededIndex ? intent : candidate),
            );
          },
        );
        savedMessageAuthorities.delete(input.messageId);
        if (
          superseded !== undefined &&
          superseded.request.idempotencyKey !== input.idempotencyKey
        ) {
          cache.rollbackOptimisticSavedMessage(
            superseded.request.messageId,
            superseded.request.idempotencyKey,
          );
          const active = activeSavedMessages.get(superseded.request.idempotencyKey);
          active?.resolveCanonicalResult(PREFERENCE_CLOSED_RESULT);
          active?.controller.abort();
          resolveSavedMessageWaiters(
            superseded.request.idempotencyKey,
            PREFERENCE_CLOSED_RESULT,
          );
        }
        return committed?.intents.find((candidate) =>
          candidate.request.messageId === input.messageId &&
          candidate.request.idempotencyKey === input.idempotencyKey);
      } catch {
        if (savedMessageScopeIsActive(scope)) {
          reportPersistenceDiagnostic(
            "saved_message_intents_write_failed",
            "The saved-message command could not be stored before projection or dispatch.",
          );
        }
        return undefined;
      }
    });

  const removeSavedMessageIntent = (
    scope: DurableSavedMessageScope,
    intent: DurableSavedMessageIntent,
  ): Promise<boolean> => serializeSavedMessageMutation(async () => {
    if (!savedMessageScopeIsActive(scope) || normalizedCachePersistence === undefined) {
      return false;
    }
    try {
      await mutateSavedMessageRecord(scope, (current) => {
        if (current === null) return null;
        const remaining = current.intents.filter((candidate) =>
          !sameSavedMessageCorrelation(candidate, intent));
        if (remaining.length === current.intents.length) return current;
        return remaining.length === 0
          ? null
          : createApplicationChatQueuedSavedMessageIntentsRecord(
              scope.identity,
              remaining,
            );
      });
      if (!savedMessageScopeIsActive(scope)) return false;
      cache.rollbackOptimisticSavedMessage(
        intent.request.messageId,
        intent.request.idempotencyKey,
      );
      return true;
    } catch {
      if (savedMessageScopeIsActive(scope)) {
        reportPersistenceDiagnostic(
          "saved_message_intents_write_failed",
          "A settled saved-message command could not be removed from storage.",
        );
      }
      return false;
    }
  });

  const savedMessageMatchesDesired = (
    request: SetSavedMessageInput,
    authority: SavedMessageAuthority,
  ): boolean => authority.savedMessage.isSaved === (request.intent === "save") &&
    authority.savedMessage.privateNote ===
      (request.intent === "save" ? request.privateNote : undefined);

  const canonicalSavedMessageResult = (
    request: SetSavedMessageInput,
    authority: SavedMessageAuthority,
  ): ChatSetSavedMessageResult => {
    const matches = savedMessageMatchesDesired(request, authority);
    const reconciliationStatus = matches
      ? authority.revision === request.expectedSavedMessageRevision
        ? "already_requested_state"
        : "replayed"
      : "saved_message_revision_conflict";
    const savedMessageRevision = matches &&
        authority.revision > request.expectedSavedMessageRevision + 1
      ? request.expectedSavedMessageRevision + 1
      : authority.revision;
    return {
      status: "success",
      value: {
        operation: "set_saved_message",
        intent: request.intent,
        reconciliationStatus,
        messageId: request.messageId,
        expectedSavedMessageRevision: request.expectedSavedMessageRevision,
        idempotencyKey: request.idempotencyKey,
        savedMessageRevision,
        savedMessage: authority.savedMessage,
      } as SetSavedMessageResult,
    };
  };

  const refreshSavedMessageAuthority = async (
    scope: DurableSavedMessageScope,
    request: SetSavedMessageInput,
    signal: AbortSignal,
  ): Promise<boolean> => {
    let cursor: SavedMessageListSnapshotInput["cursor"];
    const seenCursors = new Set<string>();
    let matching: SavedMessageListSnapshot["items"][number] | undefined;
    while (savedMessageScopeIsActive(scope) && !signal.aborted) {
      const result = await snapshotReader.listSavedMessages(
        {
          limit: MAX_SAVED_MESSAGE_SNAPSHOT_PAGE_LIMIT,
          ...(cursor === undefined ? {} : { cursor }),
        },
        { signal },
      );
      if (
        !savedMessageScopeIsActive(scope) ||
        signal.aborted ||
        result.status !== "success"
      ) return false;
      matching = result.value.items.find((item) => item.messageId === request.messageId);
      if (matching !== undefined || result.value.page.nextCursor === null) break;
      const nextCursor = result.value.page.nextCursor;
      if (seenCursors.has(nextCursor)) return false;
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    if (!savedMessageScopeIsActive(scope) || signal.aborted) return false;
    if (matching !== undefined) {
      const savedMessage = Object.freeze({
        messageId: request.messageId,
        isSaved: true,
        ...(matching.privateNote === undefined
          ? {}
          : { privateNote: matching.privateNote.text }),
      });
      cache.reconcileSavedMessageAuthority(
        request.messageId,
        matching.savedMessageRevision,
        savedMessage,
      );
      savedMessageAuthorities.set(request.messageId, Object.freeze({
        revision: matching.savedMessageRevision,
        savedMessage,
      }));
      return true;
    }
    const state = cache.getState();
    const knownRevision = state.currentUser.savedMessageRevisions[request.messageId] ?? 0;
    const known = state.currentUser.pendingSavedMessageUpdates[request.messageId]
      ?.authoritativeSavedMessage ?? state.currentUser.savedMessages[request.messageId];
    const revision = known?.isSaved === true
      ? Math.max(knownRevision + 1, request.expectedSavedMessageRevision + 1)
      : Math.max(knownRevision, request.expectedSavedMessageRevision);
    const savedMessage = Object.freeze({
      messageId: request.messageId,
      isSaved: false,
    });
    cache.reconcileSavedMessageAuthority(request.messageId, revision, savedMessage);
    savedMessageAuthorities.set(request.messageId, Object.freeze({
      revision,
      savedMessage,
    }));
    return true;
  };

  const decideSavedMessageAuthority = (
    scope: DurableSavedMessageScope,
    intent: DurableSavedMessageIntent,
  ): SavedMessageAuthorityDecision => {
    if (!savedMessageScopeIsActive(scope)) return { state: "retry" };
    const authority = savedMessageAuthorities.get(intent.request.messageId);
    if (
      authority === undefined ||
      authority.revision < intent.request.expectedSavedMessageRevision
    ) return { state: "retry" };
    const result = canonicalSavedMessageResult(intent.request, authority);
    if (savedMessageMatchesDesired(intent.request, authority)) {
      return { state: "settled", result };
    }
    if (authority.revision > intent.request.expectedSavedMessageRevision) {
      try {
        cache.markSavedMessageConflict(intent.request);
      } catch {
        return { state: "retry" };
      }
      return { state: "conflict", result };
    }
    const pending = cache.getState().currentUser
      .pendingSavedMessageUpdates[intent.request.messageId];
    if (
      pending?.idempotencyKey !== intent.request.idempotencyKey ||
      pending.state !== "pending"
    ) {
      try {
        cache.beginOptimisticSavedMessage(intent.request);
      } catch {
        return { state: "retry" };
      }
    }
    return { state: "dispatch" };
  };

  const savedMessageResultIsTerminal = (
    result: ChatSetSavedMessageResult,
  ): boolean => result.status === "validation" ||
    result.status === "authentication" ||
    result.status === "conflict" ||
    result.status === "feature_disabled" ||
    result.status === "unsupported" ||
    (result.status === "rejected" && result.httpStatus !== 429);

  const settleSavedMessageResult = async (
    scope: DurableSavedMessageScope,
    intent: DurableSavedMessageIntent,
    result: ChatSetSavedMessageResult,
  ): Promise<ChatSetSavedMessageResult> => {
    if (!savedMessageScopeIsActive(scope)) return PREFERENCE_CLOSED_RESULT;
    if (result.status === "success") {
      try {
        cache.reconcileCurrentUserSavedMessage(intent.request, result.value);
        savedMessageAuthorities.set(intent.request.messageId, Object.freeze({
          revision: result.value.savedMessageRevision,
          savedMessage: result.value.savedMessage,
        }));
      } catch {
        return SEND_MALFORMED_RESPONSE;
      }
      const decision = decideSavedMessageAuthority(scope, intent);
      if (decision.state === "settled") {
        await removeSavedMessageIntent(scope, intent);
      } else if (decision.state === "conflict") {
        return result;
      } else if (
        result.value.reconciliationStatus !== "saved_message_revision_conflict"
      ) {
        return SEND_MALFORMED_RESPONSE;
      }
    } else if (savedMessageResultIsTerminal(result)) {
      await removeSavedMessageIntent(scope, intent);
    } else if (
      result.status === "transport" ||
      result.status === "malformed_response" ||
      result.status === "aborted"
    ) {
      cache.failOptimisticSavedMessage(
        intent.request.messageId,
        intent.request.idempotencyKey,
        result.status,
      );
    }
    return result;
  };

  const executeDurableSavedMessage = async (
    scope: DurableSavedMessageScope,
    intent: DurableSavedMessageIntent,
  ): Promise<ChatSetSavedMessageResult | undefined> => {
    const key = intent.request.idempotencyKey;
    if (activeSavedMessages.has(key)) return waitForSavedMessageResult(key);
    if (!savedMessageScopeIsActive(scope)) return PREFERENCE_CLOSED_RESULT;
    const controller = new AbortController();
    let resolveCanonicalResult!: (result: ChatSetSavedMessageResult) => void;
    const canonicalResult = new Promise<ChatSetSavedMessageResult>((resolve) => {
      resolveCanonicalResult = resolve;
    });
    const active = Object.freeze({ controller, canonicalResult, resolveCanonicalResult });
    activeSavedMessages.set(key, active);
    let result: ChatSetSavedMessageResult | undefined;
    try {
      if (
        !savedMessageAuthorities.has(intent.request.messageId) &&
        !await refreshSavedMessageAuthority(
          scope,
          intent.request,
          controller.signal,
        ).catch(() => false)
      ) return undefined;
      if (!savedMessageScopeIsActive(scope) || controller.signal.aborted) {
        return PREFERENCE_CLOSED_RESULT;
      }
      const decision = decideSavedMessageAuthority(scope, intent);
      if (decision.state === "retry") return undefined;
      if (decision.state === "settled") {
        await removeSavedMessageIntent(scope, intent);
        result = decision.result;
        return result;
      }
      if (decision.state === "conflict") {
        result = decision.result;
        return result;
      }
      const descriptor = createSavedMessageDescriptor(intent.request);
      const dispatch = () => commandDispatcher.dispatch(
        descriptor,
        intent.request,
        { idempotencyKey: key, signal: controller.signal },
      );
      const coordinatedDispatch = coordinator === undefined ||
          coordinationStatus?.role === "fallback"
        ? dispatch()
        : coordinator.coordinateCommand({
            command: "saved_message.set",
            idempotencyKey: key,
            execute: dispatch,
            parseResult: (value) => parseCoordinatedCommandResult(descriptor, value),
            projectResultForRelay: (parsed) => parsed.status === "success"
              ? SAVED_MESSAGE_AUTHORITY_REFRESH_RESULT
              : parsed,
          });
      result = await Promise.race([coordinatedDispatch, canonicalResult]);
      if (!savedMessageScopeIsActive(scope)) return PREFERENCE_CLOSED_RESULT;
      result = await settleSavedMessageResult(scope, intent, result);
      return result;
    } finally {
      if (activeSavedMessages.get(key) === active) activeSavedMessages.delete(key);
      if (result !== undefined) resolveSavedMessageWaiters(key, result);
    }
  };

  const retainedSavedMessageRecoveryPermitted = (): boolean =>
    lifecycleState.state === "ready" &&
    currentSavedMessageScope() !== undefined &&
    ownsRetainedSendRecovery() &&
    (realtimeSession === undefined || realtimeSession.state.state === "connected");

  const retainedSavedMessageDelay = (retryNumber: number): number => Math.min(
    retainedSavedMessageMaximumDelayMs,
    retainedSavedMessageInitialDelayMs *
      retainedSavedMessageRetryMultiplier ** Math.max(0, retryNumber - 1),
  );

  const runRetainedSavedMessagePump = async (epoch: number): Promise<void> => {
    while (
      epoch === retainedSavedMessageRecoveryEpoch &&
      retainedSavedMessageRecoveryPermitted()
    ) {
      const scope = currentSavedMessageScope();
      if (scope === undefined || scope.epoch !== epoch) return;
      const intents = [...retainedSavedMessageIntents];
      if (intents.length === 0) return;
      let retryRequired = false;
      let settledAny = false;
      for (const intent of intents) {
        if (!savedMessageScopeIsActive(scope)) return;
        if (!retainedSavedMessageIntents.some((candidate) =>
          sameSavedMessageIntent(candidate, intent))) continue;
        const pending = cache.getState().currentUser
          .pendingSavedMessageUpdates[intent.request.messageId];
        if (
          pending?.state === "conflict" &&
          pending.idempotencyKey === intent.request.idempotencyKey
        ) continue;
        const result = await executeDurableSavedMessage(scope, intent);
        if (!savedMessageScopeIsActive(scope)) return;
        const retained = retainedSavedMessageIntents.some((candidate) =>
          sameSavedMessageIntent(candidate, intent));
        if (retained) {
          const current = cache.getState().currentUser
            .pendingSavedMessageUpdates[intent.request.messageId];
          if (current?.state !== "conflict") retryRequired = true;
        } else {
          settledAny = true;
        }
        if (result?.status === "closed" || result?.status === "aborted") return;
      }
      if (!retryRequired) {
        retainedSavedMessageRetryNumber = 0;
        if (!settledAny) return;
        continue;
      }
      retainedSavedMessageRetryNumber += 1;
      const controller = new AbortController();
      retainedSavedMessageRetryController = controller;
      try {
        await retainedSavedMessageWait(
          retainedSavedMessageDelay(retainedSavedMessageRetryNumber),
          controller.signal,
        );
      } catch {
        return;
      } finally {
        if (retainedSavedMessageRetryController === controller) {
          retainedSavedMessageRetryController = undefined;
        }
      }
      savedMessageAuthorities.clear();
    }
  };

  const startRetainedSavedMessageRecovery = (): void => {
    if (!retainedSavedMessageRecoveryPermitted() || retainedSavedMessagePump !== undefined) {
      return;
    }
    const epoch = retainedSavedMessageRecoveryEpoch;
    const pump = runRetainedSavedMessagePump(epoch)
      .catch(() => undefined)
      .finally(() => {
        if (retainedSavedMessagePump !== pump) return;
        retainedSavedMessagePump = undefined;
        const replayable = retainedSavedMessageIntents.some((intent) => {
          const pending = cache.getState().currentUser
            .pendingSavedMessageUpdates[intent.request.messageId];
          return pending?.state !== "conflict" ||
            pending.idempotencyKey !== intent.request.idempotencyKey;
        });
        if (replayable && retainedSavedMessageRecoveryPermitted()) {
          queueMicrotask(startRetainedSavedMessageRecovery);
        }
      });
    retainedSavedMessagePump = pump;
  };

  requestRetainedSavedMessageRecovery = (): void => startRetainedSavedMessageRecovery();

  pauseRetainedSavedMessageRecovery = (): void => {
    retainedSavedMessageRecoveryEpoch += 1;
    retainedSavedMessagePump = undefined;
    retainedSavedMessageRetryNumber = 0;
    retainedSavedMessageRetryController?.abort();
    retainedSavedMessageRetryController = undefined;
    savedMessageAuthorities.clear();
    for (const active of activeSavedMessages.values()) {
      active.resolveCanonicalResult(PREFERENCE_CLOSED_RESULT);
      active.controller.abort();
    }
    activeSavedMessages.clear();
  };

  activateRetainedSavedMessageRecovery = async (generation, identity): Promise<void> => {
    const scope = Object.freeze({
      generation,
      epoch: retainedSavedMessageRecoveryEpoch,
      identity,
    });
    await reloadSavedMessageRecord(scope);
  };

  resumeRetainedSavedMessageRecoveryFromStorage = (announcement): void => {
    if (
      announcement !== undefined &&
      announcement.command !== "saved_message.set"
    ) return;
    const identity = activePersistenceIdentity;
    const generation = persistenceGeneration;
    if (identity === undefined || !ownsRetainedSendRecovery()) return;
    void activateRetainedSavedMessageRecovery(generation, identity)
      .then(() => {
        if (
          !persistenceScopeIsActive(generation, identity) ||
          !ownsRetainedSendRecovery() ||
          (announcement !== undefined && !retainedSavedMessageIntents.some(
            (intent) => intent.request.idempotencyKey === announcement.idempotencyKey,
          ))
        ) return;
        requestRetainedSavedMessageRecovery();
      })
      .catch(() => undefined);
  };

  handleRetainedSavedMessageCoordinatedResult = (
    command,
    idempotencyKey,
    value,
  ): void => {
    if (
      command !== "saved_message.set" ||
      settlingCoordinatedSavedMessages.has(idempotencyKey)
    ) return;
    const intent = retainedSavedMessageIntents.find(
      (candidate) => candidate.request.idempotencyKey === idempotencyKey,
    );
    const scope = currentSavedMessageScope();
    if (intent === undefined || scope === undefined) return;
    const descriptor = createSavedMessageDescriptor(intent.request);
    const parsed = parseCoordinatedCommandResult(descriptor, value);
    if (parsed === undefined && !isSavedMessageAuthorityRefreshResult(value)) return;
    settlingCoordinatedSavedMessages.add(idempotencyKey);
    void (async () => {
      let settled: ChatSetSavedMessageResult | undefined;
      if (parsed !== undefined) {
        settled = await settleSavedMessageResult(scope, intent, parsed);
      } else {
        const controller = new AbortController();
        if (!await refreshSavedMessageAuthority(
          scope,
          intent.request,
          controller.signal,
        ).catch(() => false)) return;
        const decision = decideSavedMessageAuthority(scope, intent);
        if (decision.state !== "settled" && decision.state !== "conflict") return;
        if (decision.state === "settled") {
          await removeSavedMessageIntent(scope, intent);
        }
        settled = decision.result;
      }
      if (!savedMessageScopeIsActive(scope) || settled === undefined) return;
      const active = activeSavedMessages.get(idempotencyKey);
      active?.resolveCanonicalResult(settled);
      active?.controller.abort();
      resolveSavedMessageWaiters(idempotencyKey, settled);
      retainedSavedMessageRetryController?.abort();
      requestRetainedSavedMessageRecovery();
    })().catch(() => undefined).finally(() => {
      settlingCoordinatedSavedMessages.delete(idempotencyKey);
    });
  };

  handleRetainedSavedMessageCanonicalEvent = (event): void => {
    if (
      event.type !== "saved_message.updated" ||
      !isRecord(event.payload) ||
      event.tenantId === undefined ||
      typeof event.payload.messageId !== "string" ||
      !Number.isSafeInteger(event.payload.savedMessageRevision) ||
      !isRecord(event.payload.savedMessage)
    ) return;
    const scope = currentSavedMessageScope();
    if (scope === undefined || event.tenantId !== scope.identity.tenantId) return;
    const messageId = event.payload.messageId as MessageId;
    const canonical = cache.getState().currentUser.pendingSavedMessageUpdates[messageId]
      ?.authoritativeSavedMessage ?? cache.getState().currentUser.savedMessages[messageId];
    if (canonical === undefined) return;
    savedMessageAuthorities.set(messageId, Object.freeze({
      revision: event.payload.savedMessageRevision as number,
      savedMessage: canonical,
    }));
    const intents = retainedSavedMessageIntents.filter((intent) =>
      intent.request.messageId === messageId);
    for (const intent of intents) {
      void (async () => {
        if (!savedMessageScopeIsActive(scope)) return;
        const decision = decideSavedMessageAuthority(scope, intent);
        if (decision.state !== "settled" && decision.state !== "conflict") return;
        if (decision.state === "settled") {
          await removeSavedMessageIntent(scope, intent);
        }
        if (!savedMessageScopeIsActive(scope)) return;
        const active = activeSavedMessages.get(intent.request.idempotencyKey);
        active?.resolveCanonicalResult(decision.result);
        active?.controller.abort();
        resolveSavedMessageWaiters(intent.request.idempotencyKey, decision.result);
        retainedSavedMessageRetryController?.abort();
        queueMicrotask(requestRetainedSavedMessageRecovery);
      })().catch(() => undefined);
    }
  };

  const beginDurableSavedMessage = (
    intent: "save" | "unsave",
    authored: ChatSaveMessageInput | ChatUnsaveMessageInput,
  ): Promise<ChatSetSavedMessageResult> => {
    let input: SetSavedMessageInput;
    let enqueuedAt: IsoTimestamp;
    const scope = currentSavedMessageScope();
    try {
      if (scope === undefined) throw new TypeError("saved-message persistence required");
      if (!isRecord(authored)) throw new TypeError("saved-message input required");
      const state = cache.getState();
      if (state.identity === null) throw new TypeError("saved-message identity required");
      input = parseSetSavedMessageInput({
        operation: "set_saved_message",
        intent,
        messageId: authored.messageId,
        expectedSavedMessageRevision:
          state.currentUser.savedMessageRevisions[authored.messageId as MessageId] ?? 0,
        idempotencyKey: generateSavedMessageIdempotencyKey(),
        ...(intent === "save" && "privateNote" in authored &&
          authored.privateNote !== undefined
          ? { privateNote: authored.privateNote }
          : {}),
      });
      if (intent === "save") {
        const message = state.entities.messages[input.messageId];
        const conversation = message === undefined
          ? undefined
          : state.entities.conversations[message.conversationId];
        if (
          message?.content == null ||
          conversation === undefined ||
          conversation.archivedAt !== undefined ||
          (conversation.visibility === "private" &&
            state.currentUser.memberships[conversation.id]?.state !== "active")
        ) throw new TypeError("saved-message target required");
      }
      enqueuedAt = new Date(savedMessageNow()).toISOString() as IsoTimestamp;
    } catch {
      return Promise.resolve(SEND_VALIDATION_FAILURE);
    }
    return (async () => {
      const durable = await persistSavedMessageIntent(scope, input, enqueuedAt);
      if (durable === undefined || !savedMessageScopeIsActive(scope)) {
        return SEND_VALIDATION_FAILURE;
      }
      const result = waitForSavedMessageResult(durable.request.idempotencyKey);
      coordinator?.announcePersistedCommand(
        "saved_message.set",
        durable.request.idempotencyKey,
      );
      resumeRetainedSavedMessageRecoveryFromStorage({
        command: "saved_message.set",
        idempotencyKey: durable.request.idempotencyKey,
      });
      return result;
    })();
  };

  cache.subscribePrivateStateBoundary(() => {
    pauseRetainedSavedMessageRecovery();
    for (const intent of retainedSavedMessageIntents) {
      cache.rollbackOptimisticSavedMessage(
        intent.request.messageId,
        intent.request.idempotencyKey,
      );
    }
    retainedSavedMessageIntents = Object.freeze([]);
    for (const waiters of savedMessageResultWaiters.values()) {
      for (const resolve of waiters) resolve(PREFERENCE_CLOSED_RESULT);
    }
    savedMessageResultWaiters.clear();
  });

  const savedMessageFailureIsRetryable = (
    status: ChatCommandResult<unknown>["status"],
  ): status is "transport" | "malformed_response" | "aborted" =>
    status === "transport" ||
    status === "malformed_response" ||
    status === "aborted";

  const executeInMemorySavedMessage = async (
    initialInput: SetSavedMessageInput,
    capturedIdentity: ChatCacheIdentity,
    generation: number,
    prepareAuthoritativeRevision: boolean,
  ): Promise<ChatSetSavedMessageResult> => {
    const identityStillMatches = (): boolean => {
      const current = cache.getState().identity;
      return current !== null &&
        current.tenantId === capturedIdentity.tenantId &&
        current.userId === capturedIdentity.userId &&
        current.sessionId === capturedIdentity.sessionId;
    };
    if (generation !== savedMessageGeneration || !identityStillMatches()) {
      if (identityStillMatches()) {
        cache.rollbackOptimisticSavedMessage(
          initialInput.messageId,
          initialInput.idempotencyKey,
        );
      }
      savedMessageInputs.delete(initialInput.idempotencyKey);
      return PREFERENCE_CLOSED_RESULT;
    }

    let input = initialInput;
    const pending = cache.getState().currentUser
      .pendingSavedMessageUpdates[input.messageId];
    if (
      prepareAuthoritativeRevision &&
      pending?.idempotencyKey === input.idempotencyKey
    ) {
      input = parseSetSavedMessageInput({
        ...input,
        expectedSavedMessageRevision:
          cache.getState().currentUser.savedMessageRevisions[input.messageId] ?? 0,
      });
      cache.beginOptimisticSavedMessage(input);
    }
    savedMessageInputs.set(input.idempotencyKey, input);
    const result = await client.dispatch(
      createSavedMessageDescriptor(input),
      input,
      { idempotencyKey: input.idempotencyKey },
    );
    if (generation !== savedMessageGeneration || !identityStillMatches()) {
      return result;
    }
    if (result.status === "success") {
      try {
        cache.reconcileCurrentUserSavedMessage(input, result.value);
      } catch {
        cache.rollbackOptimisticSavedMessage(
          input.messageId,
          input.idempotencyKey,
        );
      }
      savedMessageInputs.delete(input.idempotencyKey);
    } else if (savedMessageFailureIsRetryable(result.status)) {
      cache.failOptimisticSavedMessage(
        input.messageId,
        input.idempotencyKey,
        result.status,
      );
      if (
        cache.getState().currentUser.pendingSavedMessageUpdates[input.messageId]
          ?.idempotencyKey !== input.idempotencyKey
      ) {
        savedMessageInputs.delete(input.idempotencyKey);
      }
    } else {
      cache.rollbackOptimisticSavedMessage(
        input.messageId,
        input.idempotencyKey,
      );
      savedMessageInputs.delete(input.idempotencyKey);
    }
    return result;
  };

  const enqueueInMemorySavedMessage = (
    input: SetSavedMessageInput,
    capturedIdentity: ChatCacheIdentity,
    generation: number,
    prepareAuthoritativeRevision: boolean,
  ): Promise<ChatSetSavedMessageResult> => {
    const previous = savedMessageQueues.get(input.messageId);
    const execute = () => executeInMemorySavedMessage(
      input,
      capturedIdentity,
      generation,
      prepareAuthoritativeRevision,
    );
    const promise = previous === undefined
      ? Promise.resolve().then(execute)
      : previous.then(execute, execute);
    const tracked = promise.finally(() => {
      if (savedMessageQueues.get(input.messageId) === tracked) {
        savedMessageQueues.delete(input.messageId);
      }
    });
    savedMessageQueues.set(input.messageId, tracked);
    return tracked;
  };

  const beginInMemorySavedMessage = (
    intent: "save" | "unsave",
    authored: ChatSaveMessageInput | ChatUnsaveMessageInput,
  ): Promise<ChatSetSavedMessageResult> => {
    let input: SetSavedMessageInput;
    let capturedIdentity: ChatCacheIdentity;
    try {
      if (!isRecord(authored)) throw new TypeError("saved-message input required");
      const state = cache.getState();
      if (state.identity === null) throw new TypeError("saved-message identity required");
      capturedIdentity = state.identity;
      input = parseSetSavedMessageInput({
        operation: "set_saved_message",
        intent,
        messageId: authored.messageId,
        expectedSavedMessageRevision:
          state.currentUser.savedMessageRevisions[authored.messageId as MessageId] ?? 0,
        idempotencyKey: generateSavedMessageIdempotencyKey(),
        ...(intent === "save" && "privateNote" in authored &&
          authored.privateNote !== undefined
          ? { privateNote: authored.privateNote }
          : {}),
      });
      cache.beginOptimisticSavedMessage(input);
    } catch {
      return Promise.resolve(SEND_VALIDATION_FAILURE);
    }
    return enqueueInMemorySavedMessage(
      input,
      capturedIdentity,
      savedMessageGeneration,
      true,
    );
  };

  const beginSavedMessage = (
    intent: "save" | "unsave",
    authored: ChatSaveMessageInput | ChatUnsaveMessageInput,
  ): Promise<ChatSetSavedMessageResult> => normalizedCachePersistence === undefined
    ? beginInMemorySavedMessage(intent, authored)
    : beginDurableSavedMessage(intent, authored);

  const retrySavedMessageMutation = (
    messageId: MessageId,
  ): Promise<ChatSetSavedMessageResult> => {
    try {
      const state = cache.getState();
      if (state.identity === null) throw new TypeError("saved-message identity required");
      const pending = state.currentUser.pendingSavedMessageUpdates[messageId];
      if (pending?.state !== "failed" || !pending.retryable) {
        throw new TypeError("saved-message update is not retryable");
      }
      if (normalizedCachePersistence !== undefined) {
        const intent = retainedSavedMessageIntents.find((candidate) =>
          candidate.request.messageId === messageId &&
          candidate.request.idempotencyKey === pending.idempotencyKey);
        if (intent === undefined) {
          throw new TypeError("saved-message retry correlation is unavailable");
        }
        cache.retryOptimisticSavedMessage(messageId, intent.request.idempotencyKey);
        savedMessageAuthorities.clear();
        const result = waitForSavedMessageResult(intent.request.idempotencyKey);
        retainedSavedMessageRetryController?.abort();
        requestRetainedSavedMessageRecovery();
        return result;
      }
      const input = savedMessageInputs.get(pending.idempotencyKey);
      if (input === undefined || input.messageId !== messageId) {
        throw new TypeError("saved-message retry correlation is unavailable");
      }
      cache.retryOptimisticSavedMessage(messageId, input.idempotencyKey);
      return enqueueInMemorySavedMessage(
        input,
        state.identity,
        savedMessageGeneration,
        false,
      );
    } catch {
      return Promise.resolve(SEND_VALIDATION_FAILURE);
    }
  };

  interface DurableMessageReminderScope {
    readonly generation: number;
    readonly epoch: number;
    readonly identity: ApplicationChatStorageIdentity;
  }

  interface ActiveMessageReminder {
    readonly controller: AbortController;
  }

  interface MessageReminderAuthority {
    readonly revision: number;
    readonly reminder: CanonicalMessageReminder;
  }

  type MessageReminderAuthorityDecision =
    | { readonly state: "retry" | "dispatch" }
    | {
        readonly state: "settled" | "conflict";
        readonly result: ChatMessageReminderResult;
      };

  let messageReminderMutationChain: Promise<void> = Promise.resolve();
  let retainedMessageReminderRecoveryEpoch = 0;
  let retainedMessageReminderPump: Promise<void> | undefined;
  let retainedMessageReminderRetryNumber = 0;
  let retainedMessageReminderRetryController: AbortController | undefined;
  const activeMessageReminders = new Map<string, ActiveMessageReminder>();
  const settlingCoordinatedMessageReminders = new Set<string>();
  const messageReminderResultWaiters = new Map<
    string,
    Set<(result: ChatMessageReminderResult) => void>
  >();
  const messageReminderAuthorities = new Map<MessageId, MessageReminderAuthority>();

  const serializeMessageReminderMutation = <Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> => {
    const result = messageReminderMutationChain.then(operation);
    messageReminderMutationChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const messageReminderScopeIsActive = (
    scope: DurableMessageReminderScope,
  ): boolean => {
    const cacheIdentity = cache.getState().identity;
    return scope.epoch === retainedMessageReminderRecoveryEpoch &&
      persistenceScopeIsActive(scope.generation, scope.identity) &&
      cacheIdentity !== null &&
      cacheIdentity.tenantId === scope.identity.tenantId &&
      cacheIdentity.userId === scope.identity.userId;
  };

  const currentMessageReminderScope = (): DurableMessageReminderScope | undefined =>
    activePersistenceIdentity === undefined
      ? undefined
      : Object.freeze({
          generation: persistenceGeneration,
          epoch: retainedMessageReminderRecoveryEpoch,
          identity: activePersistenceIdentity,
        });

  const sameMessageReminderIntent = (
    left: DurableMessageReminderIntent,
    right: DurableMessageReminderIntent,
  ): boolean => left.enqueueOrder === right.enqueueOrder &&
    left.enqueuedAt === right.enqueuedAt &&
    JSON.stringify(left.request) === JSON.stringify(right.request);

  const sameMessageReminderCorrelation = (
    left: DurableMessageReminderIntent,
    right: DurableMessageReminderIntent,
  ): boolean => left.request.messageId === right.request.messageId &&
    left.request.idempotencyKey === right.request.idempotencyKey;

  const resolveMessageReminderWaiters = (
    idempotencyKey: string,
    result: ChatMessageReminderResult,
  ): void => {
    const waiters = messageReminderResultWaiters.get(idempotencyKey);
    if (waiters === undefined) return;
    messageReminderResultWaiters.delete(idempotencyKey);
    for (const resolve of waiters) resolve(result);
  };

  const waitForMessageReminderResult = (
    idempotencyKey: string,
  ): Promise<ChatMessageReminderResult> => new Promise((resolve) => {
    const waiters = messageReminderResultWaiters.get(idempotencyKey) ?? new Set();
    waiters.add(resolve);
    messageReminderResultWaiters.set(idempotencyKey, waiters);
  });

  const readMessageReminderRecord = async (
    scope: DurableMessageReminderScope,
  ): Promise<ApplicationChatQueuedMessageReminderIntentsRecord | null> => {
    if (!messageReminderScopeIsActive(scope) || normalizedCachePersistence === undefined) {
      throw new Error("inactive durable message-reminder scope");
    }
    const record = await normalizedCachePersistence.storage.read(
      scope.identity,
      ApplicationChatStorageRecordKind.queuedMessageReminderIntents,
    );
    if (!messageReminderScopeIsActive(scope)) {
      throw new Error("inactive durable message-reminder scope");
    }
    return record;
  };

  const publishRetainedMessageReminders = (
    record: ApplicationChatQueuedMessageReminderIntentsRecord | null,
  ): void => {
    const next = Object.freeze([...(record?.intents ?? [])]);
    for (const previous of retainedMessageReminderIntents) {
      const superseded = next.some((intent) =>
        intent.request.messageId === previous.request.messageId &&
        intent.request.idempotencyKey !== previous.request.idempotencyKey);
      if (!superseded) continue;
      cache.rollbackOptimisticMessageReminder(
        previous.request.messageId,
        previous.request.idempotencyKey,
      );
      activeMessageReminders.get(previous.request.idempotencyKey)?.controller.abort();
      resolveMessageReminderWaiters(
        previous.request.idempotencyKey,
        PREFERENCE_CLOSED_RESULT,
      );
    }
    retainedMessageReminderIntents = next;
  };

  const mutateMessageReminderRecord = async (
    scope: DurableMessageReminderScope,
    updater: (
      current: ApplicationChatQueuedMessageReminderIntentsRecord | null,
    ) => ApplicationChatQueuedMessageReminderIntentsRecord | null,
  ): Promise<ApplicationChatQueuedMessageReminderIntentsRecord | null> => {
    if (!messageReminderScopeIsActive(scope) || normalizedCachePersistence === undefined) {
      throw new Error("inactive durable message-reminder scope");
    }
    const committed = await normalizedCachePersistence.storage.mutate(
      scope.identity,
      ApplicationChatStorageRecordKind.queuedMessageReminderIntents,
      (current) => {
        if (!messageReminderScopeIsActive(scope)) {
          throw new Error("inactive durable message-reminder scope");
        }
        const proposal = updater(current);
        if (!messageReminderScopeIsActive(scope)) {
          throw new Error("inactive durable message-reminder scope");
        }
        return proposal;
      },
    );
    if (!messageReminderScopeIsActive(scope)) {
      throw new Error("inactive durable message-reminder scope");
    }
    publishRetainedMessageReminders(committed);
    return committed;
  };

  const reloadMessageReminderRecord = (
    scope: DurableMessageReminderScope,
  ): Promise<boolean> => serializeMessageReminderMutation(async () => {
    try {
      const record = await readMessageReminderRecord(scope);
      publishRetainedMessageReminders(record);
      return true;
    } catch (error) {
      if (!messageReminderScopeIsActive(scope)) return false;
      if (error instanceof ApplicationChatStorageValidationError) {
        reportPersistenceDiagnostic(
          "message_reminder_intents_rejected",
          "The stored message-reminder intents were rejected and quarantined.",
        );
        publishRetainedMessageReminders(null);
      } else {
        reportPersistenceDiagnostic(
          "message_reminder_intents_read_failed",
          "The stored message-reminder intents could not be read.",
        );
      }
      return false;
    }
  });

  const persistMessageReminderIntent = (
    scope: DurableMessageReminderScope,
    input: MessageReminderInput,
    enqueuedAt: IsoTimestamp,
  ): Promise<DurableMessageReminderIntent | undefined> =>
    serializeMessageReminderMutation(async () => {
      try {
        let superseded: DurableMessageReminderIntent | undefined;
        const committed = await mutateMessageReminderRecord(
          scope,
          (current) => {
            const currentIntents = current?.intents ?? [];
            const supersededIndex = currentIntents.findIndex((intent) =>
              intent.request.messageId === input.messageId);
            superseded = supersededIndex < 0
              ? undefined
              : currentIntents[supersededIndex];
            const enqueueOrder = superseded?.enqueueOrder ??
              (currentIntents.reduce(
                (highest, intent) => Math.max(highest, intent.enqueueOrder),
                0,
              ) + 1);
            const intent = createApplicationChatQueuedMessageReminderIntent(
              input,
              {
                enqueueOrder,
                enqueuedAt: superseded?.enqueuedAt ?? enqueuedAt,
              },
            );
            return createApplicationChatQueuedMessageReminderIntentsRecord(
              scope.identity,
              supersededIndex < 0
                ? [...currentIntents, intent]
                : currentIntents.map((candidate, index) =>
                    index === supersededIndex ? intent : candidate),
            );
          },
        );
        messageReminderAuthorities.delete(input.messageId);
        if (
          superseded !== undefined &&
          superseded.request.idempotencyKey !== input.idempotencyKey
        ) {
          cache.rollbackOptimisticMessageReminder(
            superseded.request.messageId,
            superseded.request.idempotencyKey,
          );
          activeMessageReminders.get(superseded.request.idempotencyKey)
            ?.controller.abort();
          resolveMessageReminderWaiters(
            superseded.request.idempotencyKey,
            PREFERENCE_CLOSED_RESULT,
          );
        }
        return committed?.intents.find((candidate) =>
          candidate.request.messageId === input.messageId &&
          candidate.request.idempotencyKey === input.idempotencyKey);
      } catch {
        if (messageReminderScopeIsActive(scope)) {
          reportPersistenceDiagnostic(
            "message_reminder_intents_write_failed",
            "The message-reminder command could not be stored before projection or dispatch.",
          );
        }
        return undefined;
      }
    });

  const removeMessageReminderIntent = (
    scope: DurableMessageReminderScope,
    intent: DurableMessageReminderIntent,
  ): Promise<boolean> => serializeMessageReminderMutation(async () => {
    if (!messageReminderScopeIsActive(scope) || normalizedCachePersistence === undefined) {
      return false;
    }
    try {
      await mutateMessageReminderRecord(scope, (current) => {
        if (current === null) return null;
        const remaining = current.intents.filter((candidate) =>
          !sameMessageReminderCorrelation(candidate, intent));
        if (remaining.length === current.intents.length) return current;
        return remaining.length === 0
          ? null
          : createApplicationChatQueuedMessageReminderIntentsRecord(
              scope.identity,
              remaining,
            );
      });
      if (!messageReminderScopeIsActive(scope)) return false;
      cache.rollbackOptimisticMessageReminder(
        intent.request.messageId,
        intent.request.idempotencyKey,
      );
      return true;
    } catch {
      if (messageReminderScopeIsActive(scope)) {
        reportPersistenceDiagnostic(
          "message_reminder_intents_write_failed",
          "A settled message-reminder command could not be removed from storage.",
        );
      }
      return false;
    }
  });

  const messageReminderMatchesDesired = (
    request: MessageReminderInput,
    authority: MessageReminderAuthority,
  ): boolean => request.intent === "cancel"
    ? authority.reminder.state === "cancelled"
    : authority.reminder.state === "scheduled" &&
      authority.reminder.dueAt === request.dueAt;

  const canonicalMessageReminderResult = (
    request: MessageReminderInput,
    authority: MessageReminderAuthority,
  ): ChatMessageReminderResult => {
    const matches = messageReminderMatchesDesired(request, authority);
    const reconciliationStatus = matches
      ? authority.revision === request.expectedReminderRevision
        ? "already-requested"
        : "replayed"
      : "revision-conflict";
    const reminderRevision = matches &&
        authority.revision > request.expectedReminderRevision + 1
      ? request.expectedReminderRevision + 1
      : authority.revision;
    return {
      status: "success",
      value: {
        operation: "message_reminder.v1",
        intent: request.intent,
        reconciliationStatus,
        conversationId: request.conversationId,
        messageId: request.messageId,
        expectedReminderRevision: request.expectedReminderRevision,
        idempotencyKey: request.idempotencyKey,
        reminderRevision,
        reminder: authority.reminder,
      } as MessageReminderResult,
    };
  };

  const refreshMessageReminderAuthority = async (
    scope: DurableMessageReminderScope,
    request: MessageReminderInput,
    signal: AbortSignal,
  ): Promise<boolean> => {
    let cursor: MessageReminderListSnapshotInput["cursor"];
    const seenCursors = new Set<string>();
    let pageCount = 0;
    let matching: MessageReminderListSnapshot["items"][number] | undefined;
    while (messageReminderScopeIsActive(scope) && !signal.aborted) {
      pageCount += 1;
      if (pageCount > MAX_RETAINED_MESSAGE_REMINDER_AUTHORITY_PAGES) return false;
      const result = await snapshotReader.listMessageReminders(
        {
          limit: MAX_MESSAGE_REMINDER_SNAPSHOT_PAGE_LIMIT,
          ...(cursor === undefined ? {} : { cursor }),
        },
        { signal },
      );
      if (
        !messageReminderScopeIsActive(scope) ||
        signal.aborted ||
        result.status !== "success"
      ) return false;
      matching = result.value.items.find((item) => item.messageId === request.messageId);
      if (matching !== undefined || result.value.page.nextCursor === null) break;
      const nextCursor = result.value.page.nextCursor;
      if (seenCursors.has(nextCursor)) return false;
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    if (!messageReminderScopeIsActive(scope) || signal.aborted) return false;
    if (matching !== undefined) {
      cache.reconcileMessageReminderAuthority(
        matching.conversationId,
        matching.messageId,
        matching.reminderRevision,
        matching.reminder,
      );
      messageReminderAuthorities.set(request.messageId, Object.freeze({
        revision: matching.reminderRevision,
        reminder: matching.reminder,
      }));
      return true;
    }
    const state = cache.getState();
    const knownRevision = state.currentUser.messageReminderRevisions[request.messageId] ?? 0;
    const known = state.currentUser.pendingMessageReminderUpdates[request.messageId]
      ?.authoritativeReminder ?? state.currentUser.messageReminders[request.messageId];
    const revision = known?.state === "scheduled"
      ? Math.max(knownRevision + 1, request.expectedReminderRevision + 1)
      : Math.max(knownRevision, request.expectedReminderRevision);
    const reminder = Object.freeze({
      privacy: "affected_authenticated_actor" as const,
      state: "cancelled" as const,
    });
    cache.reconcileMessageReminderAuthority(
      request.conversationId,
      request.messageId,
      revision,
      reminder,
    );
    messageReminderAuthorities.set(request.messageId, Object.freeze({
      revision,
      reminder,
    }));
    return true;
  };

  const decideMessageReminderAuthority = (
    scope: DurableMessageReminderScope,
    intent: DurableMessageReminderIntent,
  ): MessageReminderAuthorityDecision => {
    if (!messageReminderScopeIsActive(scope)) return { state: "retry" };
    const authority = messageReminderAuthorities.get(intent.request.messageId);
    if (
      authority === undefined ||
      authority.revision < intent.request.expectedReminderRevision
    ) return { state: "retry" };
    const result = canonicalMessageReminderResult(intent.request, authority);
    if (messageReminderMatchesDesired(intent.request, authority)) {
      return { state: "settled", result };
    }
    if (authority.revision > intent.request.expectedReminderRevision) {
      try {
        cache.markMessageReminderConflict(intent.request);
      } catch {
        return { state: "retry" };
      }
      return { state: "conflict", result };
    }
    const pending = cache.getState().currentUser
      .pendingMessageReminderUpdates[intent.request.messageId];
    if (
      pending?.idempotencyKey !== intent.request.idempotencyKey ||
      pending.state !== "pending"
    ) {
      try {
        cache.beginOptimisticMessageReminder(intent.request);
      } catch {
        return { state: "retry" };
      }
    }
    return { state: "dispatch" };
  };

  const messageReminderResultIsTerminal = (
    result: ChatMessageReminderResult,
  ): boolean => result.status === "validation" ||
    result.status === "authentication" ||
    result.status === "conflict" ||
    result.status === "feature_disabled" ||
    result.status === "unsupported" ||
    (result.status === "rejected" && result.httpStatus !== 429);

  const settleMessageReminderResult = async (
    scope: DurableMessageReminderScope,
    intent: DurableMessageReminderIntent,
    result: ChatMessageReminderResult,
  ): Promise<ChatMessageReminderResult> => {
    if (!messageReminderScopeIsActive(scope)) return PREFERENCE_CLOSED_RESULT;
    if (result.status === "success") {
      try {
        cache.reconcileCurrentUserMessageReminder(intent.request, result.value);
        if (
          result.value.reminderRevision !== null &&
          result.value.reminder !== null
        ) {
          messageReminderAuthorities.set(intent.request.messageId, Object.freeze({
            revision: result.value.reminderRevision,
            reminder: result.value.reminder,
          }));
        }
      } catch {
        return SEND_MALFORMED_RESPONSE;
      }
      if (result.value.reconciliationStatus === "revision-conflict") {
        const authority = messageReminderAuthorities.get(intent.request.messageId);
        if (authority !== undefined) {
          try {
            cache.markMessageReminderConflict(intent.request);
          } catch {
            return SEND_MALFORMED_RESPONSE;
          }
        }
        return result;
      }
      await removeMessageReminderIntent(scope, intent);
    } else if (messageReminderResultIsTerminal(result)) {
      await removeMessageReminderIntent(scope, intent);
    } else if (
      result.status === "transport" ||
      result.status === "malformed_response" ||
      result.status === "aborted"
    ) {
      cache.failOptimisticMessageReminder(
        intent.request.messageId,
        intent.request.idempotencyKey,
        result.status,
      );
    }
    return result;
  };

  const executeDurableMessageReminder = async (
    scope: DurableMessageReminderScope,
    intent: DurableMessageReminderIntent,
  ): Promise<ChatMessageReminderResult | undefined> => {
    const key = intent.request.idempotencyKey;
    if (activeMessageReminders.has(key)) return waitForMessageReminderResult(key);
    if (!messageReminderScopeIsActive(scope)) return PREFERENCE_CLOSED_RESULT;
    if (
      intent.request.intent === "set" &&
      Date.parse(intent.request.dueAt) <= messageReminderNow()
    ) {
      await removeMessageReminderIntent(scope, intent);
      const result = SEND_VALIDATION_FAILURE;
      resolveMessageReminderWaiters(key, result);
      return result;
    }
    const controller = new AbortController();
    const active = Object.freeze({ controller });
    activeMessageReminders.set(key, active);
    let result: ChatMessageReminderResult | undefined;
    try {
      if (
        !messageReminderAuthorities.has(intent.request.messageId) &&
        !await refreshMessageReminderAuthority(
          scope,
          intent.request,
          controller.signal,
        ).catch(() => false)
      ) return undefined;
      if (!messageReminderScopeIsActive(scope) || controller.signal.aborted) {
        return PREFERENCE_CLOSED_RESULT;
      }
      const decision = decideMessageReminderAuthority(scope, intent);
      if (decision.state === "retry") return undefined;
      if (decision.state === "settled") {
        await removeMessageReminderIntent(scope, intent);
        result = decision.result;
        return result;
      }
      if (decision.state === "conflict") {
        result = decision.result;
        return result;
      }
      const descriptor = createMessageReminderDescriptor(intent.request);
      const dispatch = () => commandDispatcher.dispatch(
        descriptor,
        intent.request,
        { idempotencyKey: key, signal: controller.signal },
      );
      result = await (coordinator === undefined ||
          coordinationStatus?.role === "fallback"
        ? dispatch()
        : coordinator.coordinateCommand({
            command: "message.reminder.set",
            idempotencyKey: key,
            execute: dispatch,
            parseResult: (value) => parseCoordinatedCommandResult(descriptor, value),
            projectResultForRelay: (parsed) => parsed.status === "success"
              ? MESSAGE_REMINDER_AUTHORITY_REFRESH_RESULT
              : parsed,
          }));
      if (!messageReminderScopeIsActive(scope)) return PREFERENCE_CLOSED_RESULT;
      result = await settleMessageReminderResult(scope, intent, result);
      return result;
    } finally {
      if (activeMessageReminders.get(key) === active) activeMessageReminders.delete(key);
      if (result !== undefined) resolveMessageReminderWaiters(key, result);
    }
  };

  const retainedMessageReminderRecoveryPermitted = (): boolean =>
    lifecycleState.state === "ready" &&
    currentMessageReminderScope() !== undefined &&
    ownsRetainedSendRecovery() &&
    (realtimeSession === undefined || realtimeSession.state.state === "connected");

  const retainedMessageReminderDelay = (retryNumber: number): number => Math.min(
    retainedMessageReminderMaximumDelayMs,
    retainedMessageReminderInitialDelayMs *
      retainedMessageReminderRetryMultiplier ** Math.max(0, retryNumber - 1),
  );

  const runRetainedMessageReminderPump = async (epoch: number): Promise<void> => {
    while (
      epoch === retainedMessageReminderRecoveryEpoch &&
      retainedMessageReminderRecoveryPermitted()
    ) {
      const scope = currentMessageReminderScope();
      if (scope === undefined || scope.epoch !== epoch) return;
      const intents = [...retainedMessageReminderIntents];
      if (intents.length === 0) return;
      let retryRequired = false;
      let settledAny = false;
      for (const intent of intents) {
        if (!messageReminderScopeIsActive(scope)) return;
        if (!retainedMessageReminderIntents.some((candidate) =>
          sameMessageReminderIntent(candidate, intent))) continue;
        const pending = cache.getState().currentUser
          .pendingMessageReminderUpdates[intent.request.messageId];
        if (
          pending?.state === "conflict" &&
          pending.idempotencyKey === intent.request.idempotencyKey
        ) continue;
        const result = await executeDurableMessageReminder(scope, intent);
        if (!messageReminderScopeIsActive(scope)) return;
        const retained = retainedMessageReminderIntents.some((candidate) =>
          sameMessageReminderIntent(candidate, intent));
        if (retained) {
          const current = cache.getState().currentUser
            .pendingMessageReminderUpdates[intent.request.messageId];
          if (current?.state !== "conflict") retryRequired = true;
        } else {
          settledAny = true;
        }
        if (result?.status === "closed" || result?.status === "aborted") return;
      }
      if (!retryRequired) {
        retainedMessageReminderRetryNumber = 0;
        if (!settledAny) return;
        continue;
      }
      retainedMessageReminderRetryNumber += 1;
      const controller = new AbortController();
      retainedMessageReminderRetryController = controller;
      try {
        await retainedMessageReminderWait(
          retainedMessageReminderDelay(retainedMessageReminderRetryNumber),
          controller.signal,
        );
      } catch {
        return;
      } finally {
        if (retainedMessageReminderRetryController === controller) {
          retainedMessageReminderRetryController = undefined;
        }
      }
      messageReminderAuthorities.clear();
    }
  };

  const startRetainedMessageReminderRecovery = (): void => {
    if (
      !retainedMessageReminderRecoveryPermitted() ||
      retainedMessageReminderPump !== undefined
    ) return;
    const epoch = retainedMessageReminderRecoveryEpoch;
    const pump = runRetainedMessageReminderPump(epoch)
      .catch(() => undefined)
      .finally(() => {
        if (retainedMessageReminderPump !== pump) return;
        retainedMessageReminderPump = undefined;
        const replayable = retainedMessageReminderIntents.some((intent) => {
          const pending = cache.getState().currentUser
            .pendingMessageReminderUpdates[intent.request.messageId];
          return pending?.state !== "conflict" ||
            pending.idempotencyKey !== intent.request.idempotencyKey;
        });
        if (replayable && retainedMessageReminderRecoveryPermitted()) {
          queueMicrotask(startRetainedMessageReminderRecovery);
        }
      });
    retainedMessageReminderPump = pump;
  };

  requestRetainedMessageReminderRecovery = (): void =>
    startRetainedMessageReminderRecovery();

  pauseRetainedMessageReminderRecovery = (): void => {
    retainedMessageReminderRecoveryEpoch += 1;
    retainedMessageReminderPump = undefined;
    retainedMessageReminderRetryNumber = 0;
    retainedMessageReminderRetryController?.abort();
    retainedMessageReminderRetryController = undefined;
    messageReminderAuthorities.clear();
    for (const active of activeMessageReminders.values()) active.controller.abort();
    activeMessageReminders.clear();
  };

  activateRetainedMessageReminderRecovery = async (
    generation,
    identity,
  ): Promise<void> => {
    const scope = Object.freeze({
      generation,
      epoch: retainedMessageReminderRecoveryEpoch,
      identity,
    });
    await reloadMessageReminderRecord(scope);
  };

  resumeRetainedMessageReminderRecoveryFromStorage = (announcement): void => {
    if (
      announcement !== undefined &&
      announcement.command !== "message.reminder.set"
    ) return;
    const identity = activePersistenceIdentity;
    const generation = persistenceGeneration;
    if (identity === undefined || !ownsRetainedSendRecovery()) return;
    void activateRetainedMessageReminderRecovery(generation, identity)
      .then(() => {
        if (
          !persistenceScopeIsActive(generation, identity) ||
          !ownsRetainedSendRecovery() ||
          (announcement !== undefined && !retainedMessageReminderIntents.some(
            (intent) => intent.request.idempotencyKey === announcement.idempotencyKey,
          ))
        ) return;
        requestRetainedMessageReminderRecovery();
      })
      .catch(() => undefined);
  };

  handleRetainedMessageReminderCoordinatedResult = (
    command,
    idempotencyKey,
    value,
  ): void => {
    if (
      command !== "message.reminder.set" ||
      settlingCoordinatedMessageReminders.has(idempotencyKey)
    ) return;
    const intent = retainedMessageReminderIntents.find(
      (candidate) => candidate.request.idempotencyKey === idempotencyKey,
    );
    const scope = currentMessageReminderScope();
    if (intent === undefined || scope === undefined) return;
    const descriptor = createMessageReminderDescriptor(intent.request);
    const parsed = parseCoordinatedCommandResult(descriptor, value);
    if (parsed === undefined && !isMessageReminderAuthorityRefreshResult(value)) return;
    settlingCoordinatedMessageReminders.add(idempotencyKey);
    void (async () => {
      let settled: ChatMessageReminderResult | undefined;
      if (parsed !== undefined) {
        settled = await settleMessageReminderResult(scope, intent, parsed);
      } else {
        const controller = new AbortController();
        if (!await refreshMessageReminderAuthority(
          scope,
          intent.request,
          controller.signal,
        ).catch(() => false)) return;
        const decision = decideMessageReminderAuthority(scope, intent);
        if (decision.state !== "settled" && decision.state !== "conflict") return;
        if (decision.state === "settled") {
          await removeMessageReminderIntent(scope, intent);
        }
        settled = decision.result;
      }
      if (!messageReminderScopeIsActive(scope) || settled === undefined) return;
      activeMessageReminders.get(idempotencyKey)?.controller.abort();
      resolveMessageReminderWaiters(idempotencyKey, settled);
      retainedMessageReminderRetryController?.abort();
      requestRetainedMessageReminderRecovery();
    })().catch(() => undefined).finally(() => {
      settlingCoordinatedMessageReminders.delete(idempotencyKey);
    });
  };

  const beginDurableMessageReminder = (
    intent: "set" | "cancel",
    authored: ChatSetMessageReminderInput | ChatCancelMessageReminderInput,
  ): Promise<ChatMessageReminderResult> => {
    let input: MessageReminderInput;
    let enqueuedAt: IsoTimestamp;
    const scope = currentMessageReminderScope();
    try {
      if (scope === undefined) throw new TypeError("message-reminder persistence required");
      if (!isRecord(authored)) throw new TypeError("message-reminder input required");
      const state = cache.getState();
      if (state.identity === null) throw new TypeError("message-reminder identity required");
      enqueuedAt = new Date(messageReminderNow()).toISOString() as IsoTimestamp;
      const candidate = {
        operation: "message_reminder.v1" as const,
        intent,
        conversationId: authored.conversationId,
        messageId: authored.messageId,
        expectedReminderRevision:
          state.currentUser.messageReminderRevisions[authored.messageId as MessageId] ?? 0,
        idempotencyKey: generateMessageReminderIdempotencyKey(),
        ...(intent === "set"
          ? { dueAt: (authored as ChatSetMessageReminderInput).dueAt }
          : {}),
      };
      input = intent === "set"
        ? parseSetMessageReminderInput(candidate, { referenceTime: enqueuedAt })
        : parseCancelMessageReminderInput(candidate);
    } catch {
      return Promise.resolve(SEND_VALIDATION_FAILURE);
    }
    return (async () => {
      const durable = await persistMessageReminderIntent(scope, input, enqueuedAt);
      if (durable === undefined || !messageReminderScopeIsActive(scope)) {
        return SEND_VALIDATION_FAILURE;
      }
      const result = waitForMessageReminderResult(durable.request.idempotencyKey);
      coordinator?.announcePersistedCommand(
        "message.reminder.set",
        durable.request.idempotencyKey,
      );
      resumeRetainedMessageReminderRecoveryFromStorage({
        command: "message.reminder.set",
        idempotencyKey: durable.request.idempotencyKey,
      });
      return result;
    })();
  };

  cache.subscribePrivateStateBoundary(() => {
    pauseRetainedMessageReminderRecovery();
    for (const intent of retainedMessageReminderIntents) {
      cache.rollbackOptimisticMessageReminder(
        intent.request.messageId,
        intent.request.idempotencyKey,
      );
    }
    retainedMessageReminderIntents = Object.freeze([]);
    for (const waiters of messageReminderResultWaiters.values()) {
      for (const resolve of waiters) resolve(PREFERENCE_CLOSED_RESULT);
    }
    messageReminderResultWaiters.clear();
  });

  const reminderFailureIsRetryable = (
    status: ChatCommandResult<unknown>["status"],
  ): status is "transport" | "malformed_response" | "aborted" =>
    status === "transport" || status === "malformed_response" || status === "aborted";

  const executeInMemoryMessageReminder = async (
    initialInput: MessageReminderInput,
    capturedIdentity: ChatCacheIdentity,
    generation: number,
    prepareAuthoritativeRevision: boolean,
  ): Promise<ChatMessageReminderResult> => {
    const identityStillMatches = (): boolean => {
      const current = cache.getState().identity;
      return current !== null && current.tenantId === capturedIdentity.tenantId &&
        current.userId === capturedIdentity.userId &&
        current.sessionId === capturedIdentity.sessionId;
    };
    if (generation !== messageReminderGeneration || !identityStillMatches()) {
      if (identityStillMatches()) {
        cache.rollbackOptimisticMessageReminder(initialInput.messageId, initialInput.idempotencyKey);
      }
      messageReminderInputs.delete(initialInput.idempotencyKey);
      return PREFERENCE_CLOSED_RESULT;
    }

    let input = initialInput;
    const pending = cache.getState().currentUser.pendingMessageReminderUpdates[input.messageId];
    if (prepareAuthoritativeRevision && pending?.idempotencyKey === input.idempotencyKey) {
      const candidate = {
        ...input,
        expectedReminderRevision:
          cache.getState().currentUser.messageReminderRevisions[input.messageId] ?? 0,
      };
      input = input.intent === "set"
        ? parseSetMessageReminderInput(candidate, { referenceTime: new Date(0) })
        : parseCancelMessageReminderInput(candidate);
      cache.beginOptimisticMessageReminder(input);
    }
    messageReminderInputs.set(input.idempotencyKey, input);
    const result = await client.dispatch(
      createMessageReminderDescriptor(input),
      input,
      { idempotencyKey: input.idempotencyKey },
    );
    if (generation !== messageReminderGeneration || !identityStillMatches()) return result;
    if (result.status === "success") {
      try {
        cache.reconcileCurrentUserMessageReminder(input, result.value);
      } catch {
        cache.rollbackOptimisticMessageReminder(input.messageId, input.idempotencyKey);
      }
      messageReminderInputs.delete(input.idempotencyKey);
    } else if (reminderFailureIsRetryable(result.status)) {
      cache.failOptimisticMessageReminder(input.messageId, input.idempotencyKey, result.status);
      if (cache.getState().currentUser.pendingMessageReminderUpdates[input.messageId]
          ?.idempotencyKey !== input.idempotencyKey) {
        messageReminderInputs.delete(input.idempotencyKey);
      }
    } else {
      cache.rollbackOptimisticMessageReminder(input.messageId, input.idempotencyKey);
      messageReminderInputs.delete(input.idempotencyKey);
    }
    return result;
  };

  const enqueueInMemoryMessageReminder = (
    input: MessageReminderInput,
    identity: ChatCacheIdentity,
    generation: number,
    prepareAuthoritativeRevision: boolean,
  ): Promise<ChatMessageReminderResult> => {
    const previous = messageReminderQueues.get(input.messageId);
    const execute = () => executeInMemoryMessageReminder(
      input,
      identity,
      generation,
      prepareAuthoritativeRevision,
    );
    const promise = previous === undefined
      ? Promise.resolve().then(execute)
      : previous.then(execute, execute);
    const tracked = promise.finally(() => {
      if (messageReminderQueues.get(input.messageId) === tracked) {
        messageReminderQueues.delete(input.messageId);
      }
    });
    messageReminderQueues.set(input.messageId, tracked);
    return tracked;
  };

  const beginInMemoryMessageReminder = (
    intent: "set" | "cancel",
    authored: ChatSetMessageReminderInput | ChatCancelMessageReminderInput,
  ): Promise<ChatMessageReminderResult> => {
    try {
      if (!isRecord(authored)) throw new TypeError("message-reminder input required");
      const state = cache.getState();
      if (state.identity === null) throw new TypeError("message-reminder identity required");
      const candidate = {
        operation: "message_reminder.v1" as const,
        intent,
        conversationId: authored.conversationId,
        messageId: authored.messageId,
        expectedReminderRevision:
          state.currentUser.messageReminderRevisions[authored.messageId as MessageId] ?? 0,
        idempotencyKey: generateMessageReminderIdempotencyKey(),
        ...(intent === "set" ? { dueAt: (authored as ChatSetMessageReminderInput).dueAt } : {}),
      };
      const input: MessageReminderInput = intent === "set"
        ? parseSetMessageReminderInput(candidate, { referenceTime: new Date(messageReminderNow()) })
        : parseCancelMessageReminderInput(candidate);
      cache.beginOptimisticMessageReminder(input);
      return enqueueInMemoryMessageReminder(input, state.identity, messageReminderGeneration, true);
    } catch {
      return Promise.resolve(SEND_VALIDATION_FAILURE);
    }
  };

  const beginMessageReminder = (
    intent: "set" | "cancel",
    authored: ChatSetMessageReminderInput | ChatCancelMessageReminderInput,
  ): Promise<ChatMessageReminderResult> => normalizedCachePersistence === undefined
    ? beginInMemoryMessageReminder(intent, authored)
    : beginDurableMessageReminder(intent, authored);

  const retryMessageReminderMutation = (
    messageId: MessageId,
  ): Promise<ChatMessageReminderResult> => {
    try {
      const state = cache.getState();
      if (state.identity === null) throw new TypeError("message-reminder identity required");
      const pending = state.currentUser.pendingMessageReminderUpdates[messageId];
      if (pending?.state !== "failed" || !pending.retryable) {
        throw new TypeError("message-reminder update is not retryable");
      }
      if (normalizedCachePersistence !== undefined) {
        const retained = retainedMessageReminderIntents.find((candidate) =>
          candidate.request.messageId === messageId &&
          candidate.request.idempotencyKey === pending.idempotencyKey);
        if (retained === undefined) {
          throw new TypeError("message-reminder retry correlation unavailable");
        }
        cache.retryOptimisticMessageReminder(messageId, retained.request.idempotencyKey);
        messageReminderAuthorities.clear();
        const result = waitForMessageReminderResult(retained.request.idempotencyKey);
        retainedMessageReminderRetryController?.abort();
        requestRetainedMessageReminderRecovery();
        return result;
      }
      const input = messageReminderInputs.get(pending.idempotencyKey);
      if (input === undefined || input.messageId !== messageId) {
        throw new TypeError("message-reminder retry correlation unavailable");
      }
      cache.retryOptimisticMessageReminder(messageId, input.idempotencyKey);
      return enqueueInMemoryMessageReminder(input, state.identity, messageReminderGeneration, false);
    } catch {
      return Promise.resolve(SEND_VALIDATION_FAILURE);
    }
  };

  cache.subscribePrivateStateBoundary(() => {
    ++messageReminderGeneration;
    messageReminderInputs.clear();
    messageReminderQueues.clear();
  });

  let readStateRuntime: ChatReadStateRuntime;
  let client!: ChatClient<Feature>;
  try {
    draftRuntime = createChatDraftRuntime({
      cache,
      snapshots: draftSnapshotReader,
      dispatch: (descriptor, input, options) =>
        client.dispatch(descriptor, input, options),
      ...(config.drafts === undefined ? {} : { options: config.drafts }),
      ...(normalizedCachePersistence === undefined
        ? {}
        : {
            persistence: {
              storage: normalizedCachePersistence.storage,
              getActiveScope: () => activePersistenceIdentity === undefined
                ? undefined
                : Object.freeze({
                    identity: activePersistenceIdentity,
                    generation: persistenceGeneration,
                  }),
              isActiveScope: (scope) =>
                persistenceScopeIsActive(scope.generation, scope.identity),
              isRecoveryReady: () =>
                lifecycleState.state === "ready" &&
                ownsRetainedSendRecovery() &&
                (realtimeSession === undefined ||
                  realtimeSession.state.state === "connected"),
              onPersistedIntent: (command, idempotencyKey) => {
                coordinator?.announcePersistedCommand(command, idempotencyKey);
              },
              onDiagnostic: (diagnostic) =>
                reportPersistenceDiagnostic(diagnostic.code, diagnostic.message),
            },
          }),
    });
  } catch {
    throw new ChatClientConfigurationError("drafts options are invalid");
  }
  resumeRetainedDraftRecoveryFromStorage = (announcement): void => {
    const identity = activePersistenceIdentity;
    const generation = persistenceGeneration;
    if (identity === undefined) return;
    const scope = Object.freeze({ identity, generation });
    void draftRuntime.reloadRetained(scope, announcement).then(() => {
      if (
        persistenceScopeIsActive(generation, identity) &&
        ownsRetainedSendRecovery()
      ) draftRuntime.resumeRetained();
    }).catch(() => undefined);
  };
  client = {
    endpoint,
    get state() {
      return lifecycleState;
    },
    get realtime() {
      return realtimeSession;
    },
    get coordination() {
      return coordinationStatus;
    },
    get cache() {
      return cache;
    },
    getSendMessageQueueState() {
      return sendMessageQueueState;
    },
    subscribeSendMessageQueue(listener) {
      if (typeof listener !== "function") {
        throw new TypeError("Send message queue listener must be a function");
      }
      sendMessageQueueListeners.add(listener);
      try {
        listener(sendMessageQueueState);
      } catch (error) {
        sendMessageQueueListeners.delete(listener);
        throw error;
      }
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        sendMessageQueueListeners.delete(listener);
      };
    },
    cancelQueuedMessage(clientMessageId) {
      if (
        typeof clientMessageId !== "string" ||
        clientMessageId.trim().length === 0 ||
        clientMessageId !== clientMessageId.trim()
      ) return Promise.resolve(false);
      const queue = activeSendMessageQueue;
      const identity = activePersistenceIdentity;
      const generation = persistenceGeneration;
      if (queue === undefined || identity === undefined) return Promise.resolve(false);
      return serializeSendMessageQueueMutation(queue, async () => {
        if (
          generation !== persistenceGeneration ||
          queue !== activeSendMessageQueue ||
          !storageIdentitiesEqual(identity, activePersistenceIdentity)
        ) return false;
        const intent = queue.getState().intents.find((candidate) =>
          candidate.clientMessageId === clientMessageId &&
          storageIdentitiesEqual(candidate.identity, identity));
        if (intent === undefined) return false;
        const cancelled = await queue.cancel(clientMessageId);
        if (cancelled) logicalSends.delete(clientMessageId);
        return cancelled;
      });
    },
    subscribeLifecycle(listener) {
      lifecycleListeners.add(listener);
      return () => {
        lifecycleListeners.delete(listener);
      };
    },
    start() {
      if (lifecycleState.state === "starting" && activeStart !== undefined) {
        return activeStart;
      }
      if (
        lifecycleState.state === "ready" ||
        lifecycleState.state === "refresh_required"
      ) {
        return Promise.resolve(lifecycleState);
      }

      const controller = new AbortController();
      const currentAttempt = ++attempt;
      const currentPersistenceGeneration = ++persistenceGeneration;
      const currentSendMessageQueue = replaceSendMessageQueue(
        currentPersistenceGeneration,
      );
      activePersistenceIdentity = undefined;
      persistenceCheckpointEnabled = false;
      lastCheckpointEncoded = undefined;
      activeController = controller;
      setLifecycleState(STARTING_STATE);

      const startup = Promise.all([
        fetchServerMetadata<Feature>(
          metadataUrl,
          config.getAccessToken,
          fetchImplementation,
          controller.signal,
        ),
        hydratePersistenceSnapshot(
          currentPersistenceGeneration,
          currentSendMessageQueue,
        ),
      ]).then(
        async ([metadata, hydratedPersistenceSnapshot]): Promise<ChatClientLifecycleState<Feature>> => {
          if (currentAttempt !== attempt || controller.signal.aborted) {
            return IDLE_STATE;
          }

          const handshake = decideRealtimeHandshake(
            {
              clientPackageVersion: CHAT_CLIENT_PACKAGE_VERSION,
              protocolVersion: CHAT_PROTOCOL_VERSION,
            },
            metadata,
          );
          if (handshake.state === "refresh_required") {
            setLifecycleState(Object.freeze({
              state: "refresh_required",
              reason: "unsupported_protocol",
              message: CHAT_REFRESH_REQUIRED_MESSAGE,
              requestedProtocolVersion: CHAT_PROTOCOL_VERSION,
              clientPackageVersion: CHAT_CLIENT_PACKAGE_VERSION,
              metadata,
            }));
            return lifecycleState;
          }

          await configureCoordination();
          if (currentAttempt !== attempt || controller.signal.aborted) {
            return IDLE_STATE;
          }

          setLifecycleState(Object.freeze({
            state: "ready",
            clientPackageVersion: CHAT_CLIENT_PACKAGE_VERSION,
            protocolVersion: CHAT_PROTOCOL_VERSION,
            metadata,
            enabledFeatures: negotiateFeatures(
              metadata.enabledFeatures,
              requestedFeatures,
            ),
          }));
          if (
            coordinator === undefined ||
            coordinationStatus?.role === "leader" ||
            coordinationStatus?.role === "fallback"
          ) realtimeSession?.start();
          const retainedScope = activePersistenceIdentity === undefined
            ? undefined
            : Object.freeze({
                identity: activePersistenceIdentity,
                generation: currentPersistenceGeneration,
              });
          if (retainedScope !== undefined) {
            await readStateRuntime.activateRetained(
              retainedScope,
              hydratedPersistenceSnapshot
                ? []
                : Object.values(cache.getState().currentUser.readStates),
            );
            await activateRetainedEditRecovery(
              retainedScope.generation,
              retainedScope.identity,
            );
            await activateRetainedDeleteRecovery(
              retainedScope.generation,
              retainedScope.identity,
            );
            await activateRetainedReactionRecovery(
              retainedScope.generation,
              retainedScope.identity,
            );
            await activateRetainedForwardRecovery(
              retainedScope.generation,
              retainedScope.identity,
            );
            await activateRetainedMembershipRecovery(
              retainedScope.generation,
              retainedScope.identity,
            );
            await activateRetainedConversationCreationRecovery(
              retainedScope.generation,
              retainedScope.identity,
            );
            await activateRetainedConversationPreferenceRecovery(
              retainedScope.generation,
              retainedScope.identity,
            );
            await activateRetainedConversationArchiveRecovery(
              retainedScope.generation,
              retainedScope.identity,
            );
            await activateRetainedThreadFollowRecovery(
              retainedScope.generation,
              retainedScope.identity,
            );
            await activateRetainedSavedMessageRecovery(
              retainedScope.generation,
              retainedScope.identity,
            );
            await activateRetainedMessageReminderRecovery(
              retainedScope.generation,
              retainedScope.identity,
            );
            await draftRuntime.activateRetained(retainedScope);
            await huddleRuntime.activateRetained(retainedScope);
          }
          if (currentAttempt !== attempt || controller.signal.aborted) {
            return IDLE_STATE;
          }
          requestRetainedSendRecovery();
          requestRetainedMessageMutationRecovery();
          requestRetainedMembershipRecovery();
          requestRetainedConversationCreationRecovery();
          requestRetainedConversationPreferenceRecovery();
          requestRetainedConversationArchiveRecovery();
          requestRetainedThreadFollowRecovery();
          requestRetainedSavedMessageRecovery();
          requestRetainedMessageReminderRecovery();
          if (ownsRetainedSendRecovery()) draftRuntime.resumeRetained();
          else draftRuntime.announceRetained();
          if (ownsRetainedSendRecovery()) huddleRuntime.resumeRetained();
          else huddleRuntime.announceRetained();
          return lifecycleState;
        },
        (error: unknown): ChatClientLifecycleState<Feature> => {
          if (
            error === ABORTED ||
            controller.signal.aborted ||
            currentAttempt !== attempt
          ) {
            return IDLE_STATE;
          }

          const diagnostic =
            error instanceof StartupFailure
              ? error.diagnostic
              : Object.freeze({
                  code: "metadata_request_failed" as const,
                  message: "Chat server metadata could not be requested.",
                });
          setLifecycleState(Object.freeze({ state: "error", diagnostic }));
          return lifecycleState;
        },
      ).finally(() => {
        if (currentAttempt === attempt) {
          activeController = undefined;
          activeStart = undefined;
        }
      });

      activeStart = startup;
      return startup;
    },
    dispatch(descriptor, input, options) {
      if (
        coordinator === undefined ||
        coordinationStatus?.role === "fallback" ||
        options?.idempotencyKey === undefined ||
        !isRecord(descriptor) ||
        typeof descriptor.name !== "string"
      ) return commandDispatcher.dispatch(descriptor, input, options);
      return coordinator.coordinateCommand({
        command: descriptor.name,
        idempotencyKey:
          options.coordinationKey ?? options.idempotencyKey,
        execute: () => commandDispatcher.dispatch(descriptor, input, options),
        parseResult: (value) => parseCoordinatedCommandResult(descriptor, value),
      });
    },
    async listConversations(input, options) {
      const result = await snapshotReader.listConversations<Feature>(input, options);
      if (result.status === "success") {
        readStateRuntime.markAuthoritative(
          result.value.items.map((conversation) => conversation.currentReadState),
        );
      }
      return result;
    },
    async getConversation(input, options) {
      const result = await snapshotReader.getConversation<Feature>(input, options);
      if (result.status === "success") {
        readStateRuntime.markAuthoritative([
          result.value.conversation.currentReadState,
        ]);
      }
      return result;
    },
    getMessageTimeline(input, options) {
      return snapshotReader.getMessageTimeline(input, options);
    },
    getConversationDraft(input, options) {
      return snapshotReader.getConversationDraft(input, options);
    },
    openConversationDraft(conversationId) {
      return draftRuntime.open(conversationId);
    },
    selectConversationDraft(conversationId) {
      return draftRuntime.select(conversationId);
    },
    subscribeConversationDraft(conversationId, listener) {
      return draftRuntime.subscribe(conversationId, listener);
    },
    replaceConversationDraft(input) {
      return draftRuntime.replace(input);
    },
    clearConversationDraft(conversationId) {
      return draftRuntime.clear(conversationId);
    },
    flushConversationDraft(conversationId) {
      return draftRuntime.flush(conversationId);
    },
    retryConversationDraft(conversationId) {
      return draftRuntime.retry(conversationId);
    },
    closeConversationDraft(conversationId, options) {
      return draftRuntime.closeConversation(conversationId, options);
    },
    listSavedMessages(input, options) {
      return snapshotReader.listSavedMessages(input, options);
    },
    listMessageReminders(input, options) {
      return snapshotReader.listMessageReminders(input, options);
    },
    hydrateDirectoryUsers(userIds, options) {
      return directoryRuntime.hydrateVisibleUsers(userIds, options);
    },
    selectDirectoryUser(userId) {
      return directoryRuntime.selectUser(userId);
    },
    searchDirectoryUsers(input, options) {
      return directoryRuntime.search(input, options);
    },
    getDirectorySearchState() {
      return directoryRuntime.getSearchState();
    },
    subscribeDirectorySearch(listener) {
      return directoryRuntime.subscribeSearch(listener);
    },
    cancelDirectorySearch() {
      directoryRuntime.cancelSearch();
    },
    searchMessages(input, options) {
      return messageSearchRuntime.search(input, options);
    },
    getMessageSearchState() {
      return messageSearchRuntime.getState();
    },
    subscribeMessageSearch(listener) {
      return messageSearchRuntime.subscribe(listener);
    },
    cancelMessageSearch() {
      messageSearchRuntime.cancel();
    },
    hydrateHuddle(conversationId) {
      return huddleRuntime.hydrate(conversationId);
    },
    getHuddleState(conversationId) {
      return huddleRuntime.getState(conversationId);
    },
    subscribeHuddle(conversationId, listener) {
      return huddleRuntime.subscribe(conversationId, listener);
    },
    startHuddle(conversationId) {
      return huddleRuntime.start(conversationId);
    },
    joinHuddle(conversationId) {
      return huddleRuntime.join(conversationId);
    },
    leaveHuddle(conversationId) {
      return huddleRuntime.leave(conversationId);
    },
    setHuddleScreenShare(conversationId) {
      return huddleRuntime.setScreenShare(conversationId, "set");
    },
    clearHuddleScreenShare(conversationId) {
      return huddleRuntime.setScreenShare(conversationId, "clear");
    },
    endHuddle(conversationId) {
      return huddleRuntime.end(conversationId);
    },
    retryHuddle(conversationId) {
      return huddleRuntime.retry(conversationId);
    },
    rejoinHuddle(conversationId) {
      return huddleRuntime.rejoin(conversationId);
    },
    getHuddleMediaJoinDescriptor(conversationId) {
      return huddleRuntime.getMediaJoinDescriptor(conversationId);
    },
    get replyStyle() { return replyStyleRuntime!.api; },
    get threadList() { return threadListRuntime!.api; },
    get threadLifecycle() { return threadLifecycleRuntime!.api; },
    get messageContext() { return messageContextRuntime!.api; },
    openThread(rootMessageId) {
      return beginThreadOpening(rootMessageId);
    },
    createThread(input) {
      return beginThreadOpening(input.rootMessageId, input.name);
    },
    openExistingThread(threadId) {
      return beginExistingThreadOpening(threadId);
    },
    getExistingThreadOpeningState(threadId) {
      return existingThreadOpeningStates.get(threadId) ?? idleExistingThreadOpeningState(threadId);
    },
    subscribeExistingThreadOpening(threadId, listener) {
      let listeners = existingThreadOpeningListeners.get(threadId);
      if (listeners === undefined) {
        listeners = new Set();
        existingThreadOpeningListeners.set(threadId, listeners);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) existingThreadOpeningListeners.delete(threadId);
      };
    },
    getThreadOpeningState(rootMessageId) {
      if (
        typeof rootMessageId !== "string" ||
        rootMessageId.trim().length === 0 ||
        rootMessageId !== rootMessageId.trim()
      ) throw new TypeError("Thread root message id is invalid");
      return threadOpeningStates.get(rootMessageId) ??
        idleThreadOpeningState(rootMessageId);
    },
    subscribeThreadOpening(rootMessageId, listener) {
      if (
        typeof rootMessageId !== "string" ||
        rootMessageId.trim().length === 0 ||
        rootMessageId !== rootMessageId.trim() ||
        typeof listener !== "function"
      ) throw new TypeError("Thread opening subscription is invalid");
      let listeners = threadOpeningListeners.get(rootMessageId);
      if (listeners === undefined) {
        listeners = new Set();
        threadOpeningListeners.set(rootMessageId, listeners);
      }
      listeners.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        listeners?.delete(listener);
        if (listeners?.size === 0) threadOpeningListeners.delete(rootMessageId);
      };
    },
    uploadAttachment(input) {
      return attachmentUploadManager.upload(input);
    },
    async sendMessage(input) {
      const conversationId = input.conversationId;
      // A completed send owns only the draft it started with. Newer edits (even
      // if later reverted) must survive a late response or conversation switch.
      let draftChanged = false;
      const draftIdentity = cache.getState().identity;
      const releaseDraft = draftRuntime.subscribe(conversationId, (next, previous) => {
        if (JSON.stringify(next.draft) !== JSON.stringify(previous.draft)) draftChanged = true;
      });
      let result;
      try {
        result = await beginLogicalSend(input);
      } finally {
        releaseDraft();
      }
      if (result.status === "success" && !draftChanged && cache.getState().identity === draftIdentity) {
        try {
          draftRuntime.clear(conversationId);
          void draftRuntime.flush(conversationId);
        } catch {
          // Message delivery remains successful; the draft state exposes a
          // safe retryable synchronization outcome independently.
        }
      }
      return result;
    },
    retryMessage(clientMessageId) {
      return retryLogicalSend(clientMessageId);
    },
    forwardMessage(input) {
      return beginForwardMessage(input);
    },
    editMessage(input) {
      return beginLogicalEdit(input);
    },
    deleteMessage(input) {
      return beginLogicalDelete(input);
    },
    setReaction(input) {
      return beginLogicalReaction(input);
    },
    createChannel(input) {
      return beginConversationCreation("channel", input) as Promise<ChatCreateChannelResult>;
    },
    createDirect(input) {
      return beginConversationCreation("direct", input) as Promise<ChatCreateDirectResult>;
    },
    createGroupDirect(input) {
      return beginConversationCreation("group_direct", input) as Promise<ChatCreateGroupDirectResult>;
    },
    archiveConversation(input) {
      return beginConversationArchive("archive", input) as Promise<ChatArchiveConversationResult>;
    },
    restoreConversation(input) {
      return beginConversationArchive("restore", input) as Promise<ChatRestoreConversationResult>;
    },
    joinConversation(input) {
      return beginConversationMembership("join", input) as Promise<ChatJoinConversationResult>;
    },
    leaveConversation(input) {
      return beginConversationMembership("leave", input) as Promise<ChatLeaveConversationResult>;
    },
    addConversationMember(input) {
      return beginConversationMembership("add_member", input) as Promise<ChatAddConversationMemberResult>;
    },
    removeConversationMember(input) {
      return beginConversationMembership("remove_member", input) as Promise<ChatRemoveConversationMemberResult>;
    },
    changeConversationMemberRole(input) {
      return beginConversationMembership("change_member_role", input) as Promise<ChatChangeConversationMemberRoleResult>;
    },
    updateConversationPreference(input) {
      return beginConversationPreferenceUpdate(input);
    },
    setThreadFollow(input) {
      return beginThreadFollow(input);
    },
    followThread(threadId) {
      return beginThreadFollow({ threadId, intent: "follow" });
    },
    unfollowThread(threadId) {
      return beginThreadFollow({ threadId, intent: "unfollow" });
    },
    saveMessage(input) {
      return beginSavedMessage("save", input);
    },
    unsaveMessage(input) {
      return beginSavedMessage("unsave", input);
    },
    retrySavedMessage(messageId) {
      return retrySavedMessageMutation(messageId);
    },
    setMessageReminder(input) {
      return beginMessageReminder("set", input);
    },
    cancelMessageReminder(input) {
      return beginMessageReminder("cancel", input);
    },
    retryMessageReminder(messageId) {
      return retryMessageReminderMutation(messageId);
    },
    markRead(input) {
      return readStateRuntime.markRead(input);
    },
    markUnread(input) {
      return readStateRuntime.markUnread(input);
    },
    startTyping(conversationId, visibility) {
      return realtimeSession?.startTyping(conversationId, visibility) ?? false;
    },
    stopTyping(conversationId) {
      realtimeSession?.stopTyping(conversationId);
    },
    setPresence(nextState) {
      realtimeSession?.setPresence(nextState);
    },
    notifyActivity() {
      realtimeSession?.notifyActivity();
    },
    close() {
      ++attempt;
      ++persistenceGeneration;
      activePersistenceIdentity = undefined;
      deactivateSendMessageQueue();
      pauseRetainedEditRecovery();
      retainedEditIntents = Object.freeze([]);
      for (const waiters of editResultWaiters.values()) {
        for (const resolve of waiters) resolve(PREFERENCE_CLOSED_RESULT);
      }
      editResultWaiters.clear();
      pauseRetainedDeleteRecovery();
      retainedDeleteIntents = Object.freeze([]);
      for (const waiters of deleteResultWaiters.values()) {
        for (const resolve of waiters) resolve(PREFERENCE_CLOSED_RESULT);
      }
      deleteResultWaiters.clear();
      pauseRetainedReactionRecovery();
      retainedReactionIntents = Object.freeze([]);
      projectedRetainedReactions.clear();
      for (const waiters of reactionResultWaiters.values()) {
        for (const resolve of waiters) resolve(PREFERENCE_CLOSED_RESULT);
      }
      reactionResultWaiters.clear();
      pauseRetainedForwardRecovery();
      retainedForwardIntents = Object.freeze([]);
      for (const waiters of forwardResultWaiters.values()) {
        for (const resolve of waiters) resolve(PREFERENCE_CLOSED_RESULT);
      }
      forwardResultWaiters.clear();
      pauseRetainedMembershipRecovery();
      for (const intent of retainedMembershipIntents) {
        cache.settleConversationOperation(
          conversationMembershipLogicalKey(intent.request),
        );
      }
      retainedMembershipIntents = Object.freeze([]);
      for (const waiters of membershipResultWaiters.values()) {
        for (const resolve of waiters) resolve(PREFERENCE_CLOSED_RESULT);
      }
      membershipResultWaiters.clear();
      pauseRetainedConversationCreationRecovery();
      for (const intent of retainedConversationCreationIntents) {
        cache.settleConversationOperation(
          conversationCreationLogicalKey(intent.request),
        );
      }
      retainedConversationCreationIntents = Object.freeze([]);
      for (const waiters of conversationCreationResultWaiters.values()) {
        for (const resolve of waiters) resolve(PREFERENCE_CLOSED_RESULT);
      }
      conversationCreationResultWaiters.clear();
      pauseRetainedConversationPreferenceRecovery();
      for (const intent of retainedConversationPreferenceIntents) {
        cache.rollbackOptimisticConversationPreference(
          intent.request.conversationId,
          intent.request.idempotencyKey,
        );
      }
      retainedConversationPreferenceIntents = Object.freeze([]);
      for (const waiters of conversationPreferenceResultWaiters.values()) {
        for (const resolve of waiters) resolve(PREFERENCE_CLOSED_RESULT);
      }
      conversationPreferenceResultWaiters.clear();
      pauseRetainedConversationArchiveRecovery();
      for (const intent of retainedConversationArchiveIntents) {
        cache.settleConversationOperation(
          conversationArchiveLogicalKey(intent.request),
        );
      }
      retainedConversationArchiveIntents = Object.freeze([]);
      for (const waiters of conversationArchiveResultWaiters.values()) {
        for (const resolve of waiters) resolve(PREFERENCE_CLOSED_RESULT);
      }
      conversationArchiveResultWaiters.clear();
      pauseRetainedThreadFollowRecovery();
      for (const intent of retainedThreadFollowIntents) {
        cache.rollbackOptimisticThreadFollow(
          intent.request.target.id,
          intent.request.idempotencyKey,
        );
      }
      retainedThreadFollowIntents = Object.freeze([]);
      for (const waiters of threadFollowResultWaiters.values()) {
        for (const resolve of waiters) resolve(THREAD_FOLLOW_CLOSED_RESULT);
      }
      threadFollowResultWaiters.clear();
      pauseRetainedSavedMessageRecovery();
      for (const intent of retainedSavedMessageIntents) {
        cache.rollbackOptimisticSavedMessage(
          intent.request.messageId,
          intent.request.idempotencyKey,
        );
      }
      retainedSavedMessageIntents = Object.freeze([]);
      for (const waiters of savedMessageResultWaiters.values()) {
        for (const resolve of waiters) resolve(PREFERENCE_CLOSED_RESULT);
      }
      savedMessageResultWaiters.clear();
      pauseRetainedMessageReminderRecovery();
      for (const intent of retainedMessageReminderIntents) {
        cache.rollbackOptimisticMessageReminder(
          intent.request.messageId,
          intent.request.idempotencyKey,
        );
      }
      retainedMessageReminderIntents = Object.freeze([]);
      for (const waiters of messageReminderResultWaiters.values()) {
        for (const resolve of waiters) resolve(PREFERENCE_CLOSED_RESULT);
      }
      messageReminderResultWaiters.clear();
      persistenceCheckpointEnabled = false;
      lastCheckpointFingerprint = undefined;
      lastCheckpointEncoded = undefined;
      logicalSends.clear();
      ++preferenceGeneration;
      ++threadFollowGeneration;
      ++savedMessageGeneration;
      ++messageReminderGeneration;
      ++threadOpeningGeneration;
      clearForwardState(false);
      for (const pending of Object.values(
        cache.getState().currentUser.pendingSavedMessageUpdates,
      )) {
        cache.rollbackOptimisticSavedMessage(
          pending.messageId,
          pending.idempotencyKey,
        );
      }
      savedMessageInputs.clear();
      savedMessageQueues.clear();
      for (const pending of Object.values(
        cache.getState().currentUser.pendingMessageReminderUpdates,
      )) {
        cache.rollbackOptimisticMessageReminder(
          pending.messageId,
          pending.idempotencyKey,
        );
      }
      messageReminderInputs.clear();
      messageReminderQueues.clear();
      activeController?.abort();
      for (const active of activeThreadOpenings.values()) {
        active.controller.abort();
      }
      activeThreadOpenings.clear();
      threadCreationInputs.clear();
      for (const active of activeExistingThreadOpenings.values()) active.controller.abort();
      activeExistingThreadOpenings.clear();
      for (const threadId of existingThreadOpeningStates.keys()) {
        setExistingThreadOpeningState(idleExistingThreadOpeningState(threadId));
      }
      attachmentUploadManager.closeActive();
      huddleRuntime.closeActive();
      draftRuntime.closeActive();
      readStateRuntime.closeActive();
      commandDispatcher.closeActive();
      snapshotReader.closeActive();
      unreadMentionRefresh.closeActive();
      replyStyleRuntime?.closeActive();
      threadListRuntime?.closeActive();
      threadLifecycleRuntime?.closeActive();
      messageContextRuntime?.closeActive();
      threadSnapshotReader.closeActive();
      draftSnapshotReader.closeActive();
      directoryRuntime.closeActive();
      messageSearchRuntime.closeActive();
      for (const release of retainedThreadSubscriptions.values()) release();
      retainedThreadSubscriptions.clear();
      threadRootSequences.clear();
      for (const rootMessageId of threadOpeningStates.keys()) {
        setThreadOpeningState(idleThreadOpeningState(rootMessageId));
      }
      coordinator?.close();
      coordinator = undefined;
      coordinationStatus = undefined;
      realtimeSession?.close();
      activeController = undefined;
      activeStart = undefined;
      setLifecycleState(IDLE_STATE);
    },
  };

  readStateRuntime = createChatReadStateRuntime({
    cache,
    dispatch: (descriptor, input, options) =>
      client.dispatch(descriptor, input, options),
    generateIdempotencyKey: generateReadStateIdempotencyKey,
    ...(config.readState?.schedule === undefined
      ? {}
      : { schedule: config.readState.schedule }),
    ...(normalizedCachePersistence === undefined
      ? {}
      : {
          persistence: {
            storage: normalizedCachePersistence.storage,
            getActiveScope: () => activePersistenceIdentity === undefined
              ? undefined
              : Object.freeze({
                  identity: activePersistenceIdentity,
                  generation: persistenceGeneration,
                }),
            isActiveScope: (scope) =>
              persistenceScopeIsActive(scope.generation, scope.identity),
            isRecoveryReady: () =>
              lifecycleState.state === "ready" &&
              ownsRetainedSendRecovery() &&
              (realtimeSession === undefined ||
                realtimeSession.state.state === "connected"),
            ...(retainedReadRecovery === undefined
              ? {}
              : { recovery: retainedReadRecovery }),
            onDiagnostic: (diagnostic) =>
              reportPersistenceDiagnostic(diagnostic.code, diagnostic.message),
            onPersistedIntent: (command, idempotencyKey) => {
              coordinator?.announcePersistedCommand(command, idempotencyKey);
            },
            ...(config.readState?.now === undefined
              ? {}
              : { now: config.readState.now }),
          },
        }),
  });

  resumeRetainedReadRecoveryFromStorage = (announcement): void => {
    const identity = activePersistenceIdentity;
    const generation = persistenceGeneration;
    if (identity === undefined) return;
    const scope = Object.freeze({ identity, generation });
    void readStateRuntime.reloadRetained(scope, announcement).then(() => {
      if (
        persistenceScopeIsActive(generation, identity) &&
        ownsRetainedSendRecovery()
      ) readStateRuntime.resumeRetained();
    }).catch(() => undefined);
  };

  try {
    huddleRuntime = createChatHuddleRuntime({
      endpoint,
      getAccessToken: config.getAccessToken,
      fetch: fetchImplementation,
      cache,
      dispatch: (descriptor, input, options) => {
        const dispatch = () => commandDispatcher.dispatch(descriptor, input, options);
        if (
          coordinator === undefined ||
          coordinationStatus?.role === "fallback" ||
          options?.idempotencyKey === undefined
        ) return dispatch();
        return coordinator.coordinateCommand({
          command: "huddle.command",
          // The correlation is the exact retained key. Huddle/session identity
          // and request/media values remain inside storage and this closure.
          idempotencyKey: options.idempotencyKey,
          execute: dispatch,
          parseResult: (value) => parseCoordinatedCommandResult(descriptor, value),
          projectResultForRelay: (result) => result.status === "success"
            ? HUDDLE_AUTHORITY_REFRESH_RESULT
            : result,
        });
      },
      generateDefaultIdempotencyKey: () => generateIdentity("huddle"),
      ...(config.huddles === undefined ? {} : { options: config.huddles }),
      ...(normalizedCachePersistence === undefined
        ? {}
        : {
            persistence: {
              storage: normalizedCachePersistence.storage,
              getActiveScope: () => activePersistenceIdentity === undefined
                ? undefined
                : Object.freeze({
                    identity: activePersistenceIdentity,
                    generation: persistenceGeneration,
                  }),
              isActiveScope: (scope) =>
                persistenceScopeIsActive(scope.generation, scope.identity),
              isRecoveryReady: () =>
                lifecycleState.state === "ready" &&
                ownsRetainedSendRecovery() &&
                (realtimeSession === undefined ||
                  realtimeSession.state.state === "connected"),
              ...(config.realtime?.network === undefined
                ? {}
                : { network: config.realtime.network }),
              onPersistedIntent: (command, idempotencyKey) => {
                coordinator?.announcePersistedCommand(command, idempotencyKey);
              },
              onDiagnostic: (diagnostic) =>
                reportPersistenceDiagnostic(diagnostic.code, diagnostic.message),
            },
          }),
    });
  } catch {
    throw new ChatClientConfigurationError("huddles options are invalid");
  }
  resumeRetainedHuddleRecoveryFromStorage = (announcement): void => {
    const identity = activePersistenceIdentity;
    const generation = persistenceGeneration;
    if (identity === undefined || !ownsRetainedSendRecovery()) return;
    const scope = Object.freeze({ identity, generation });
    void huddleRuntime.reloadRetained(scope, announcement).then(() => {
      if (
        persistenceScopeIsActive(generation, identity) &&
        ownsRetainedSendRecovery()
      ) huddleRuntime.resumeRetained();
    }).catch(() => undefined);
  };

  return Object.freeze(client);
}
