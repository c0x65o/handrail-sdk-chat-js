import type {
  ConversationDetailSnapshot,
  ConversationListSnapshot,
  ConversationSnapshotCursor,
  ConversationSnapshotMetadata,
  ConversationSnapshotScope,
  ConversationSnapshotSummary,
} from "../contracts/conversation-snapshot.js";
import type { Conversation } from "../contracts/conversation.js";
import {
  parseAttachmentLifecycleState,
  parseAttachmentMetadata,
  type AttachmentLifecycleState,
  type AttachmentMetadata,
} from "../contracts/attachment-transport.js";
import {
  parseConversationArchiveResult,
  type ConversationArchiveInput,
  type ConversationArchiveResult,
} from "../contracts/conversation-archive.js";
import {
  parseConversationCreationResult,
  type ConversationCreationInput,
  type ConversationCreationResult,
} from "../contracts/conversation-creation.js";
import {
  parseConversationMembershipMutationResult,
  type ConversationMembershipMutationInput,
  type ConversationMembershipMutationResult,
} from "../contracts/conversation-membership.js";
import {
  parseThreadCreationResult,
  type ThreadCreationInput,
  type ThreadCreationResult,
} from "../contracts/thread-creation.js";
import type {
  EphemeralSignalEvent,
  PresenceSignalEvent,
  TypingSignalEvent,
} from "../contracts/ephemeral-signals.js";
import type { HuddleSessionState } from "../contracts/huddle-session.js";
import type { CanonicalDraftState } from "../contracts/draft-mutation.js";
import type { MessageMention } from "../contracts/message.js";
import type {
  ConversationDraftSnapshot,
  MessageReminderListSnapshot,
  MessageReminderSnapshotEntry,
  SavedMessageListSnapshot,
  SavedMessageSnapshotEntry,
} from "../contracts/private-user-state-snapshot.js";
import {
  parseCancelMessageReminderInput,
  parseSetMessageReminderInput,
  type CanonicalMessageReminder,
  type MessageReminderInput,
  type MessageReminderResult,
} from "../contracts/generated/message-reminder.js";
import {
  parseSetThreadFollowInput,
  parseSetThreadFollowResult,
  type CanonicalThreadFollowState,
  type SetThreadFollowInput,
  type SetThreadFollowResult,
  type ThreadFollowMutationIntent,
} from "../contracts/thread-follow-mutation.js";
import {
  parseUpdateConversationPreferenceInput,
  parseUpdateConversationPreferenceResult,
  type ConversationPreferenceDesiredState,
  type UpdateConversationPreferenceInput,
  type UpdateConversationPreferenceResult,
} from "../contracts/conversation-preference-mutation.js";
import type {
  ConversationId,
  IsoTimestamp,
  MessageId,
  MessageSequence,
  SessionId,
  TenantId,
  UserId,
} from "../contracts/identifiers.js";
import type {
  ConversationMember,
  ConversationMemberPreference,
  ConversationReadState,
} from "../contracts/member-read-state.js";
import {
  parseReadCursorMutationResult,
  type ReadCursorMutationResult,
} from "../contracts/read-cursor-mutation.js";
import type {
  MessageAttachmentMetadata,
  MessageTimelineMessage,
  MessageTimelinePage,
  MessageTimelinePagination,
} from "../contracts/message-timeline.js";
import type {
  EditMessageInput,
  EditMessageResult,
  SendMessageResult,
  SoftDeleteMessageInput,
  SoftDeleteMessageResult,
} from "../contracts/message-mutations.js";
import type {
  ReactionMutationInput,
  ReactionMutationResult,
} from "../contracts/reaction-mutations.js";
import {
  parseSetSavedMessageInput,
  type CanonicalActorPrivateSavedMessageState,
  type SetSavedMessageInput,
  type SetSavedMessageResult,
} from "../contracts/saved-message-mutation.js";
import type { EventCursor } from "../contracts/realtime.js";
import type { ChatEvent } from "../contracts/realtime.js";
import {
  reconcileAuthoritativeMessageCreated,
  reconcileCurrentUserPreferenceMutation,
  reconcileCurrentUserThreadFollowMutation,
  reconcileThreadFollowCanonical,
  reduceDurableChatEvent,
  type DurableEventReduction,
} from "./durable-event-reducer.js";
import {
  EMPTY_EPHEMERAL_SIGNAL_STATE,
  expireEphemeralSignals,
  reduceEphemeralSignal,
  type EphemeralSignalState,
} from "./ephemeral-signals.js";
import { OptimisticReactionStateMachine } from "./optimistic-reaction-state.js";
import {
  beginOptimisticSavedMessage,
  failOptimisticSavedMessage,
  markSavedMessageConflict,
  reconcileCurrentUserSavedMessageMutation,
  reconcileSavedMessageAuthority,
  reconcileSavedMessageEvent,
  retryOptimisticSavedMessage,
  rollbackOptimisticSavedMessage,
  type PendingSavedMessageUpdate,
  type SavedMessageMutationFailure,
  type SavedMessageUnavailableReason,
} from "./saved-message-state.js";
import {
  beginOptimisticMessageReminder,
  failOptimisticMessageReminder,
  markMessageReminderConflict,
  reconcileCurrentUserMessageReminderMutation,
  reconcileMessageReminderCanonical,
  retryOptimisticMessageReminder,
  rollbackOptimisticMessageReminder,
  type MessageReminderMutationFailure,
  type PendingMessageReminderUpdate,
} from "./message-reminder-state.js";

export interface ChatCacheIdentity {
  readonly tenantId: TenantId;
  readonly userId: UserId;
  readonly sessionId: SessionId;
}

export interface ConversationCacheMetadata {
  readonly latestSequence: MessageSequence;
  readonly activityAt: IsoTimestamp;
}

export interface ConversationListCacheEntry {
  readonly conversationIds: readonly ConversationId[];
  readonly nextCursor?: ConversationSnapshotCursor;
  readonly snapshot: ConversationSnapshotMetadata<never>;
  /** Pages are linked only by exact opaque cursor equality; cursors are never ordered. */
  readonly pages: Readonly<Record<string, ConversationListCachePage>>;
}

export interface ConversationListCachePage {
  readonly conversationIds: readonly ConversationId[];
  readonly nextCursor?: ConversationSnapshotCursor;
  readonly snapshot: ConversationSnapshotMetadata<never>;
}

export interface ConversationListHydrationOptions {
  /** The exclusive cursor used to request this page; absent means the first page. */
  readonly requestCursor?: ConversationSnapshotCursor;
}

export interface ConversationTimelineCacheEntry {
  readonly messageIds: readonly MessageId[];
  readonly pagination: MessageTimelinePagination;
  readonly realtimeCursor: EventCursor;
}

export type OptimisticMessageFailure =
  | "validation"
  | "conflict"
  | "authentication"
  | "feature_disabled"
  | "unsupported"
  | "rejected"
  | "malformed_response"
  | "transport"
  | "aborted"
  | "closed";

export interface OptimisticMessageDelivery {
  readonly state: "sending" | "failed";
  readonly clientMessageId: string;
  readonly idempotencyKey: string;
  readonly retryable: boolean;
  readonly attempt: number;
  readonly failure?: OptimisticMessageFailure;
}

/** A renderer-compatible provisional row, replaced atomically by its canonical message. */
export type OptimisticMessageProjection = MessageTimelineMessage & {
  readonly delivery: OptimisticMessageDelivery;
};

export interface PendingMessageEditState {
  readonly state: "pending";
  readonly idempotencyKey: string;
  readonly expectedRevision: number;
  /** Canonical projection captured before applying the local edit. */
  readonly previous: MessageTimelineMessage;
}

export interface ConflictedMessageEditState {
  readonly state: "revision_conflict";
  readonly idempotencyKey: string;
  readonly expectedRevision: number;
  readonly canonicalRevision: number;
}

export type MessageEditState =
  | PendingMessageEditState
  | ConflictedMessageEditState;

/** A canonical row with either a pending optimistic edit or a stale-revision outcome. */
export type MessageEditProjection = MessageTimelineMessage & {
  readonly editState: MessageEditState;
};

export interface PendingMessageDeleteState {
  readonly state: "pending";
  readonly idempotencyKey: string;
  readonly expectedRevision: number;
  /** Canonical projection captured before redacting the local tombstone. */
  readonly previous: MessageTimelineMessage;
}

/** A renderer-compatible tombstone retained until HTTP or realtime settles it. */
export type PendingMessageDeleteProjection = MessageTimelineMessage & {
  readonly content: null;
  readonly deleteState: PendingMessageDeleteState;
};

export type ChatTimelineMessage =
  | MessageTimelineMessage
  | OptimisticMessageProjection
  | MessageEditProjection
  | PendingMessageDeleteProjection;

export type ClientAttachmentUploadStatus =
  | "preparing"
  | "pending"
  | "uploading"
  | "finalizing"
  | "finalized"
  | "rejected"
  | "abandoned"
  | "failed"
  | "cancelled";

export interface ClientAttachmentUploadProgress {
  readonly uploadedBytes: number;
  readonly totalBytes: number;
}

/** Canonical, serializable upload state. Provider descriptors and byte sources never enter it. */
export interface ClientAttachmentUploadState {
  readonly uploadId: string;
  readonly conversationId: ConversationId;
  readonly metadata: AttachmentMetadata;
  readonly status: ClientAttachmentUploadStatus;
  readonly progress: ClientAttachmentUploadProgress;
  readonly attachment?: AttachmentLifecycleState;
}

export interface ChatCacheEntities {
  readonly conversations: Readonly<Record<ConversationId, Conversation>>;
  readonly messages: Readonly<
    Record<MessageId, ChatTimelineMessage>
  >;
  readonly memberUserIdsByConversation: Readonly<
    Record<ConversationId, readonly UserId[]>
  >;
  readonly membersByConversation: Readonly<
    Record<ConversationId, Readonly<Record<UserId, ConversationMember>>>
  >;
  readonly attachments: Readonly<
    Record<string, MessageAttachmentMetadata>
  >;
}

/** State derived only for the identity currently bound to this cache. */
export interface CurrentUserChatCacheState {
  readonly memberships: Readonly<Record<ConversationId, ConversationMember>>;
  readonly readStates: Readonly<Record<ConversationId, ConversationReadState>>;
  readonly preferences: Readonly<
    Record<ConversationId, ConversationMemberPreference>
  >;
  /** Last authoritative server revision, kept separate from optimistic projection state. */
  readonly preferenceRevisions: Readonly<Record<ConversationId, number>>;
  readonly pendingPreferenceUpdates: Readonly<
    Record<ConversationId, PendingConversationPreferenceUpdate>
  >;
  /** Projected private follow state; canonical state is retained by pending entries. */
  readonly threadFollows: Readonly<
    Record<ConversationId, CanonicalThreadFollowState>
  >;
  readonly threadFollowRevisions: Readonly<Record<ConversationId, number>>;
  readonly pendingThreadFollowUpdates: Readonly<
    Record<ConversationId, PendingThreadFollowUpdate>
  >;
  /** Projected actor-private saved state; message content remains in the public entity cache. */
  readonly savedMessages: Readonly<
    Record<MessageId, CanonicalActorPrivateSavedMessageState>
  >;
  readonly savedMessageRevisions: Readonly<Record<MessageId, number>>;
  readonly pendingSavedMessageUpdates: Readonly<
    Record<MessageId, PendingSavedMessageUpdate>
  >;
  readonly savedMessageUnavailableReasons: Readonly<
    Record<MessageId, SavedMessageUnavailableReason>
  >;
  /** Projected actor-private reminder state keyed by message id. */
  readonly messageReminders: Readonly<Record<MessageId, CanonicalMessageReminder>>;
  readonly messageReminderConversationIds: Readonly<Record<MessageId, ConversationId>>;
  readonly messageReminderRevisions: Readonly<Record<MessageId, number>>;
  readonly pendingMessageReminderUpdates: Readonly<
    Record<MessageId, PendingMessageReminderUpdate>
  >;
  readonly drafts: Readonly<Record<ConversationId, CanonicalDraftState>>;
  /** Last authoritative draft revision observed for each conversation. */
  readonly draftRevisions: Readonly<Record<ConversationId, number>>;
}

export interface AvailableCurrentUserSavedMessageProjection {
  readonly availability: "available";
  readonly current: ChatTimelineMessage;
}

export interface UnavailableCurrentUserSavedMessageProjection {
  readonly availability: "unavailable";
  readonly reason: SavedMessageUnavailableReason;
}

export interface CurrentUserSavedMessageState {
  readonly savedMessage?: CanonicalActorPrivateSavedMessageState;
  readonly authoritativeSavedMessage?: CanonicalActorPrivateSavedMessageState;
  readonly authoritativeRevision: number;
  readonly pending?: PendingSavedMessageUpdate;
  readonly message?:
    | AvailableCurrentUserSavedMessageProjection
    | UnavailableCurrentUserSavedMessageProjection;
}

export interface CurrentUserSavedMessageListItem
  extends CurrentUserSavedMessageState {
  readonly messageId: MessageId;
}

export interface CurrentUserMessageReminderState {
  readonly conversationId?: ConversationId;
  readonly reminder?: CanonicalMessageReminder;
  readonly authoritativeReminder?: CanonicalMessageReminder;
  readonly authoritativeRevision: number;
  readonly pending?: PendingMessageReminderUpdate;
}

export interface CurrentUserMessageReminderListItem
  extends CurrentUserMessageReminderState {
  readonly conversationId: ConversationId;
  readonly messageId: MessageId;
}

/** Private, identity-bound correlation for the latest renderer-facing preference intent. */
export interface PendingConversationPreferenceUpdate {
  /** A conflict keeps the retained desired state inspectable without projecting it. */
  readonly state: "pending" | "conflict";
  readonly conversationId: ConversationId;
  readonly idempotencyKey: string;
  readonly expectedPreferenceRevision: number;
  readonly desiredPreference: ConversationPreferenceDesiredState;
  /** Latest canonical value observed while a newer local projection remains visible. */
  readonly authoritativePreference?: ConversationMemberPreference;
}

/** Focused custom-UI view of projected, canonical, and pending preference state. */
export interface CurrentUserConversationPreferenceState {
  readonly preference?: ConversationMemberPreference;
  readonly authoritativePreference?: ConversationMemberPreference;
  readonly authoritativeRevision: number;
  readonly pending?: PendingConversationPreferenceUpdate;
}

/** Private correlation for the newest explicit renderer intent on one thread. */
export interface PendingThreadFollowUpdate {
  /** A conflict retains the desired state for explicit resolution without replaying it. */
  readonly state: "pending" | "conflict";
  readonly threadId: ConversationId;
  readonly idempotencyKey: string;
  readonly expectedFollowRevision: number;
  readonly intent: ThreadFollowMutationIntent;
  /** Latest canonical value observed while a newer projection remains visible. */
  readonly authoritativeFollow?: CanonicalThreadFollowState;
}

/** Focused custom-UI view of projected, canonical, and pending follow state. */
export interface CurrentUserThreadFollowState {
  readonly follow?: CanonicalThreadFollowState;
  readonly authoritativeFollow?: CanonicalThreadFollowState;
  readonly authoritativeRevision: number;
  readonly pending?: PendingThreadFollowUpdate;
}

export interface DurableStreamCacheMetadata {
  readonly lastEventId: string;
  readonly lastOccurredAt: IsoTimestamp;
  readonly recentEventIds: readonly string[];
}

/** Safe correlation-only state; it never fabricates a canonical conversation row. */
export interface PendingConversationOperation {
  readonly logicalKey: string;
  readonly idempotencyKey: string;
  readonly family: "creation" | "archive" | "membership";
  readonly conversationId?: ConversationId;
  readonly clientRequestId?: string;
}

export interface ChatCacheMetadata {
  readonly conversations: Readonly<
    Record<ConversationId, ConversationCacheMetadata>
  >;
  readonly conversationLists: Readonly<
    Record<string, ConversationListCacheEntry>
  >;
  /** Bounded participant identities projected by accessible list summaries. */
  readonly conversationListParticipantUserIds: Readonly<
    Record<ConversationId, readonly UserId[]>
  >;
  /** List-only active-huddle state projected from canonical summaries. */
  readonly conversationListActiveHuddles: Readonly<
    Record<ConversationId, boolean>
  >;
  /** Actor-private counts projected from canonical list or detail summaries. */
  readonly conversationListUnreadMentionCounts: Readonly<
    Record<ConversationId, number>
  >;
  readonly conversationDetails: Readonly<
    Record<ConversationId, ConversationSnapshotMetadata<never>>
  >;
  readonly realtimeCursor?: EventCursor;
  readonly durableStreams: Readonly<Record<string, DurableStreamCacheMetadata>>;
  readonly pendingConversationOperations: Readonly<
    Record<string, PendingConversationOperation>
  >;
  readonly lifecycleRevisions: Readonly<Record<ConversationId, number>>;
  readonly memberListRevisions: Readonly<Record<ConversationId, number>>;
}

export interface NormalizedChatCacheState {
  readonly identity: ChatCacheIdentity | null;
  readonly entities: ChatCacheEntities;
  readonly attachmentUploads: Readonly<Record<string, ClientAttachmentUploadState>>;
  readonly timelines: Readonly<
    Record<ConversationId, ConversationTimelineCacheEntry>
  >;
  readonly currentUser: CurrentUserChatCacheState;
  readonly ephemeral: EphemeralSignalState;
  readonly huddles: Readonly<Record<ConversationId, HuddleSessionState>>;
  readonly metadata: ChatCacheMetadata;
}

export type NormalizedChatCacheAction =
  | { readonly type: "messages/hydrate-context-window"; readonly page: MessageTimelinePage }
  | { readonly type: "messages/forget-context"; readonly messageIds: readonly MessageId[] }
  | { readonly type: "identity/set"; readonly identity: ChatCacheIdentity | null }
  | { readonly type: "cache/reset" }
  | {
      readonly type: "attachments/set-upload";
      readonly upload: ClientAttachmentUploadState;
      readonly messageMetadata?: MessageAttachmentMetadata;
    }
  | {
      readonly type: "conversations/hydrate-list";
      readonly snapshot: ConversationListSnapshot;
      readonly requestCursor?: ConversationSnapshotCursor;
    }
  | {
      readonly type: "conversations/hydrate-detail";
      readonly snapshot: ConversationDetailSnapshot;
    }
  | {
      readonly type: "conversations/pending-begin";
      readonly operation: PendingConversationOperation;
    }
  | {
      readonly type: "conversations/pending-settle";
      readonly logicalKey: string;
    }
  | {
      readonly type: "conversations/reconcile-creation";
      readonly logicalKey: string;
      readonly input: ConversationCreationInput;
      readonly result: ConversationCreationResult;
    }
  | {
      /** Atomically publishes authorized history and freshly resolved root context. */
      readonly type: "threads/hydrate-existing";
      readonly snapshot: ConversationDetailSnapshot;
      readonly page: MessageTimelinePage;
      readonly rootPage?: MessageTimelinePage;
    }
  | {
      /** Removes cached history after an opening request loses authorization. */
      readonly type: "threads/discard-history";
      readonly threadId: ConversationId;
    }
  | {
      readonly type: "threads/reconcile-open";
      readonly input: ThreadCreationInput;
      readonly result: ThreadCreationResult;
      readonly page: MessageTimelinePage;
    }
  | {
      readonly type: "conversations/reconcile-archive";
      readonly logicalKey: string;
      readonly input: ConversationArchiveInput;
      readonly result: ConversationArchiveResult;
    }
  | {
      readonly type: "conversations/reconcile-membership";
      readonly logicalKey: string;
      readonly input: ConversationMembershipMutationInput;
      readonly result: ConversationMembershipMutationResult;
    }
  | {
      readonly type: "messages/hydrate-timeline";
      readonly page: MessageTimelinePage;
    }
  | {
      readonly type: "private-state/hydrate-draft";
      readonly snapshot: ConversationDraftSnapshot;
    }
  | {
      readonly type: "private-state/project-draft";
      readonly conversationId: ConversationId;
      readonly draft: CanonicalDraftState;
    }
  | {
      readonly type: "private-state/reconcile-draft";
      readonly conversationId: ConversationId;
      readonly canonicalRevision: number;
      readonly draft: CanonicalDraftState | undefined;
      readonly preserveProjection: boolean;
    }
  | {
      readonly type: "private-state/hydrate-saved-messages";
      readonly snapshot: SavedMessageListSnapshot;
    }
  | {
      readonly type: "private-state/hydrate-message-reminders";
      readonly snapshot: MessageReminderListSnapshot;
    }
  | {
      readonly type: "messages/optimistic-insert";
      readonly message: OptimisticMessageProjection;
    }
  | {
      readonly type: "messages/optimistic-failed";
      readonly clientMessageId: string;
      readonly failure: OptimisticMessageFailure;
      readonly retryable: boolean;
    }
  | {
      readonly type: "messages/optimistic-reconcile";
      readonly result: SendMessageResult;
    }
  | {
      readonly type: "messages/optimistic-edit";
      readonly input: EditMessageInput;
    }
  | {
      readonly type: "messages/optimistic-edit-reconcile";
      readonly idempotencyKey: string;
      readonly result: EditMessageResult;
    }
  | {
      readonly type: "messages/optimistic-edit-rollback";
      readonly messageId: MessageId;
      readonly idempotencyKey: string;
    }
  | {
      readonly type: "messages/optimistic-delete";
      readonly input: SoftDeleteMessageInput;
    }
  | {
      readonly type: "messages/optimistic-delete-reconcile";
      readonly idempotencyKey: string;
      readonly result: SoftDeleteMessageResult;
    }
  | {
      readonly type: "messages/optimistic-delete-rollback";
      readonly messageId: MessageId;
      readonly idempotencyKey: string;
    }
  | {
      readonly type: "read-state/reconcile-current-user";
      readonly result: ReadCursorMutationResult;
    }
  | {
      readonly type: "preferences/optimistic-begin";
      readonly input: UpdateConversationPreferenceInput;
      readonly projectedAt: IsoTimestamp;
    }
  | {
      readonly type: "preferences/reconcile-current-user";
      readonly input: UpdateConversationPreferenceInput;
      readonly result: UpdateConversationPreferenceResult;
    }
  | {
      readonly type: "preferences/mark-conflict";
      readonly input: UpdateConversationPreferenceInput;
    }
  | {
      readonly type: "preferences/optimistic-rollback";
      readonly conversationId: ConversationId;
      readonly idempotencyKey: string;
    }
  | {
      readonly type: "thread-follows/optimistic-begin";
      readonly input: SetThreadFollowInput;
      readonly projectedAt: IsoTimestamp;
    }
  | {
      readonly type: "thread-follows/reconcile-current-user";
      readonly input: SetThreadFollowInput;
      readonly result: SetThreadFollowResult;
    }
  | {
      readonly type: "thread-follows/mark-conflict";
      readonly input: SetThreadFollowInput;
    }
  | {
      readonly type: "thread-follows/optimistic-rollback";
      readonly threadId: ConversationId;
      readonly idempotencyKey: string;
    }
  | {
      readonly type: "saved-messages/optimistic-begin";
      readonly input: SetSavedMessageInput;
    }
  | {
      readonly type: "saved-messages/optimistic-retry";
      readonly messageId: MessageId;
      readonly idempotencyKey: string;
    }
  | {
      readonly type: "saved-messages/optimistic-failed";
      readonly messageId: MessageId;
      readonly idempotencyKey: string;
      readonly failure: SavedMessageMutationFailure;
    }
  | {
      readonly type: "saved-messages/reconcile-current-user";
      readonly input: SetSavedMessageInput;
      readonly result: SetSavedMessageResult;
    }
  | {
      readonly type: "saved-messages/reconcile-authority";
      readonly messageId: MessageId;
      readonly savedMessageRevision: number;
      readonly savedMessage: CanonicalActorPrivateSavedMessageState;
    }
  | {
      readonly type: "saved-messages/mark-conflict";
      readonly input: SetSavedMessageInput;
    }
  | {
      readonly type: "saved-messages/optimistic-rollback";
      readonly messageId: MessageId;
      readonly idempotencyKey: string;
    }
  | { readonly type: "message-reminders/optimistic-begin"; readonly input: MessageReminderInput }
  | { readonly type: "message-reminders/optimistic-retry"; readonly messageId: MessageId; readonly idempotencyKey: string }
  | { readonly type: "message-reminders/optimistic-failed"; readonly messageId: MessageId; readonly idempotencyKey: string; readonly failure: MessageReminderMutationFailure }
  | { readonly type: "message-reminders/reconcile-current-user"; readonly input: MessageReminderInput; readonly result: MessageReminderResult }
  | { readonly type: "message-reminders/reconcile-authority"; readonly conversationId: ConversationId; readonly messageId: MessageId; readonly reminderRevision: number; readonly reminder: CanonicalMessageReminder }
  | { readonly type: "message-reminders/mark-conflict"; readonly input: MessageReminderInput }
  | { readonly type: "message-reminders/optimistic-rollback"; readonly messageId: MessageId; readonly idempotencyKey: string }
  | {
      readonly type: "ephemeral/apply";
      readonly event: EphemeralSignalEvent;
      readonly now: number;
    }
  | { readonly type: "ephemeral/expire"; readonly now: number }
  | { readonly type: "ephemeral/clear" }
  | { readonly type: "huddles/set"; readonly state: HuddleSessionState }
  | {
      readonly type: "realtime/set-cursor";
      readonly cursor: EventCursor | undefined;
    }
  | { readonly type: "realtime/apply-durable"; readonly event: ChatEvent };

export type ChatCacheSelector<Selection> = (
  state: NormalizedChatCacheState,
) => Selection;

export type ChatCacheEquality<Selection> = (
  left: Selection,
  right: Selection,
) => boolean;

export type ChatCacheSubscriptionListener<Selection> = (
  selected: Selection,
  previous: Selection,
) => void;

export interface NormalizedChatCache {
  getState(): NormalizedChatCacheState;
  /**
   * Replaces state only after validating a structured-clone/JSON-safe canonical
   * cache envelope. Existing non-null identities must match exactly.
   */
  hydrateCanonicalState(value: unknown): boolean;
  dispatch(action: NormalizedChatCacheAction): NormalizedChatCacheState;
  setIdentity(identity: ChatCacheIdentity | null): NormalizedChatCacheState;
  reset(): NormalizedChatCacheState;
  setAttachmentUploadState(
    upload: ClientAttachmentUploadState,
    messageMetadata?: MessageAttachmentMetadata,
  ): NormalizedChatCacheState;
  hydrateConversationList<Feature extends string>(
    snapshot: ConversationListSnapshot<Feature>,
    options?: ConversationListHydrationOptions,
  ): NormalizedChatCacheState;
  hydrateConversationDetail<Feature extends string>(
    snapshot: ConversationDetailSnapshot<Feature>,
  ): NormalizedChatCacheState;
  beginConversationOperation(
    operation: PendingConversationOperation,
  ): NormalizedChatCacheState;
  settleConversationOperation(logicalKey: string): NormalizedChatCacheState;
  reconcileConversationCreation(
    logicalKey: string,
    input: ConversationCreationInput,
    result: ConversationCreationResult,
  ): NormalizedChatCacheState;
  /** Atomically commits a resolved thread, its root summary, and initial timeline. */
  reconcileThreadOpening(
    input: ThreadCreationInput,
    result: ThreadCreationResult,
    page: MessageTimelinePage,
  ): NormalizedChatCacheState;
  reconcileConversationArchive(
    logicalKey: string,
    input: ConversationArchiveInput,
    result: ConversationArchiveResult,
  ): NormalizedChatCacheState;
  reconcileConversationMembership(
    logicalKey: string,
    input: ConversationMembershipMutationInput,
    result: ConversationMembershipMutationResult,
  ): NormalizedChatCacheState;
  hydrateMessageTimeline(page: MessageTimelinePage): NormalizedChatCacheState;
  /** Hydrates only the trusted identity currently bound to this in-memory cache. */
  hydrateConversationDraft(
    snapshot: ConversationDraftSnapshot,
  ): NormalizedChatCacheState;
  /** Projects actor-private local composer state without advancing its server revision. */
  projectConversationDraft(
    conversationId: ConversationId,
    draft: CanonicalDraftState,
  ): NormalizedChatCacheState;
  /** Records an authoritative revision, optionally retaining a newer local projection. */
  reconcileConversationDraft(
    conversationId: ConversationId,
    canonicalRevision: number,
    draft: CanonicalDraftState | undefined,
    preserveProjection?: boolean,
  ): NormalizedChatCacheState;
  /** Reconciles one actor-private saved-message page by per-item revision. */
  hydrateSavedMessageList(
    snapshot: SavedMessageListSnapshot,
  ): NormalizedChatCacheState;
  hydrateMessageReminderList(snapshot: MessageReminderListSnapshot): NormalizedChatCacheState;
  insertOptimisticMessage(message: OptimisticMessageProjection): NormalizedChatCacheState;
  failOptimisticMessage(
    clientMessageId: string,
    failure: OptimisticMessageFailure,
    retryable: boolean,
  ): NormalizedChatCacheState;
  reconcileOptimisticMessage(result: SendMessageResult): NormalizedChatCacheState;
  /** Reconciles an HTTP-authoritative message through message.created semantics. */
  reconcileAuthoritativeMessageCreated(
    message: import("../contracts/message.js").Message,
    clientCorrelationId: string,
  ): NormalizedChatCacheState;
  beginOptimisticMessageEdit(input: EditMessageInput): NormalizedChatCacheState;
  reconcileOptimisticMessageEdit(
    idempotencyKey: string,
    result: EditMessageResult,
  ): NormalizedChatCacheState;
  rollbackOptimisticMessageEdit(
    messageId: MessageId,
    idempotencyKey: string,
  ): NormalizedChatCacheState;
  beginOptimisticMessageDelete(
    input: SoftDeleteMessageInput,
  ): NormalizedChatCacheState;
  reconcileOptimisticMessageDelete(
    idempotencyKey: string,
    result: SoftDeleteMessageResult,
  ): NormalizedChatCacheState;
  rollbackOptimisticMessageDelete(
    messageId: MessageId,
    idempotencyKey: string,
  ): NormalizedChatCacheState;
  beginOptimisticReaction(input: ReactionMutationInput): NormalizedChatCacheState;
  reconcileOptimisticReaction(
    idempotencyKey: string,
    result: ReactionMutationResult,
  ): NormalizedChatCacheState;
  rollbackOptimisticReaction(
    messageId: MessageId,
    reactionKey: string,
    idempotencyKey: string,
  ): NormalizedChatCacheState;
  /** Reconciles only the identity-bound actor's validated read-cursor result. */
  reconcileCurrentUserReadState(
    result: ReadCursorMutationResult,
  ): NormalizedChatCacheState;
  beginOptimisticConversationPreference(
    input: UpdateConversationPreferenceInput,
    projectedAt: IsoTimestamp,
  ): NormalizedChatCacheState;
  reconcileCurrentUserConversationPreference(
    input: UpdateConversationPreferenceInput,
    result: UpdateConversationPreferenceResult,
  ): NormalizedChatCacheState;
  markConversationPreferenceConflict(
    input: UpdateConversationPreferenceInput,
  ): NormalizedChatCacheState;
  rollbackOptimisticConversationPreference(
    conversationId: ConversationId,
    idempotencyKey: string,
  ): NormalizedChatCacheState;
  beginOptimisticThreadFollow(
    input: SetThreadFollowInput,
    projectedAt: IsoTimestamp,
  ): NormalizedChatCacheState;
  reconcileCurrentUserThreadFollow(
    input: SetThreadFollowInput,
    result: SetThreadFollowResult,
  ): NormalizedChatCacheState;
  markThreadFollowConflict(input: SetThreadFollowInput): NormalizedChatCacheState;
  rollbackOptimisticThreadFollow(
    threadId: ConversationId,
    idempotencyKey: string,
  ): NormalizedChatCacheState;
  beginOptimisticSavedMessage(
    input: SetSavedMessageInput,
  ): NormalizedChatCacheState;
  retryOptimisticSavedMessage(
    messageId: MessageId,
    idempotencyKey: string,
  ): NormalizedChatCacheState;
  failOptimisticSavedMessage(
    messageId: MessageId,
    idempotencyKey: string,
    failure: SavedMessageMutationFailure,
  ): NormalizedChatCacheState;
  reconcileCurrentUserSavedMessage(
    input: SetSavedMessageInput,
    result: SetSavedMessageResult,
  ): NormalizedChatCacheState;
  reconcileSavedMessageAuthority(
    messageId: MessageId,
    savedMessageRevision: number,
    savedMessage: CanonicalActorPrivateSavedMessageState,
  ): NormalizedChatCacheState;
  markSavedMessageConflict(input: SetSavedMessageInput): NormalizedChatCacheState;
  rollbackOptimisticSavedMessage(
    messageId: MessageId,
    idempotencyKey: string,
  ): NormalizedChatCacheState;
  beginOptimisticMessageReminder(input: MessageReminderInput): NormalizedChatCacheState;
  retryOptimisticMessageReminder(messageId: MessageId, idempotencyKey: string): NormalizedChatCacheState;
  failOptimisticMessageReminder(messageId: MessageId, idempotencyKey: string, failure: MessageReminderMutationFailure): NormalizedChatCacheState;
  reconcileCurrentUserMessageReminder(input: MessageReminderInput, result: MessageReminderResult): NormalizedChatCacheState;
  reconcileMessageReminderAuthority(conversationId: ConversationId, messageId: MessageId, reminderRevision: number, reminder: CanonicalMessageReminder): NormalizedChatCacheState;
  markMessageReminderConflict(input: MessageReminderInput): NormalizedChatCacheState;
  rollbackOptimisticMessageReminder(messageId: MessageId, idempotencyKey: string): NormalizedChatCacheState;
  applyEphemeralSignal(
    event: EphemeralSignalEvent,
    now: number,
  ): NormalizedChatCacheState;
  expireEphemeralSignals(now: number): NormalizedChatCacheState;
  clearEphemeralSignals(): NormalizedChatCacheState;
  setHuddleState(state: HuddleSessionState): NormalizedChatCacheState;
  setRealtimeCursor(cursor: EventCursor | undefined): NormalizedChatCacheState;
  applyDurableEvent(event: ChatEvent): DurableEventReduction;
  /** Fires when identity replacement or reset invalidates actor-private work. */
  subscribePrivateStateBoundary(listener: () => void): () => void;
  subscribe<Selection>(
    selector: ChatCacheSelector<Selection>,
    listener: ChatCacheSubscriptionListener<Selection>,
    equality?: ChatCacheEquality<Selection>,
  ): () => void;
}

export type ChatCacheErrorCode =
  | "identity_required"
  | "tenant_mismatch"
  | "current_user_mismatch"
  | "conversation_mismatch"
  | "message_conflict";

export class ChatCacheError extends Error {
  readonly code: ChatCacheErrorCode;

  constructor(code: ChatCacheErrorCode, message: string) {
    super(message);
    this.name = "ChatCacheError";
    this.code = code;
  }
}

const EMPTY_RECORD = Object.freeze({}) as Readonly<Record<string, never>>;
const EMPTY_MESSAGES = Object.freeze([]) as readonly ChatTimelineMessage[];

const freezeRecord = <Value>(
  value: Record<string, Value>,
): Readonly<Record<string, Value>> => Object.freeze(value);

const createEmptyState = (
  identity: ChatCacheIdentity | null,
): NormalizedChatCacheState =>
  Object.freeze({
    identity,
    entities: Object.freeze({
      conversations: EMPTY_RECORD,
      messages: EMPTY_RECORD,
      memberUserIdsByConversation: EMPTY_RECORD,
      membersByConversation: EMPTY_RECORD,
      attachments: EMPTY_RECORD,
    }),
    attachmentUploads: EMPTY_RECORD,
    timelines: EMPTY_RECORD,
    currentUser: Object.freeze({
      memberships: EMPTY_RECORD,
      readStates: EMPTY_RECORD,
      preferences: EMPTY_RECORD,
      preferenceRevisions: EMPTY_RECORD,
      pendingPreferenceUpdates: EMPTY_RECORD,
      threadFollows: EMPTY_RECORD,
      threadFollowRevisions: EMPTY_RECORD,
      pendingThreadFollowUpdates: EMPTY_RECORD,
      savedMessages: EMPTY_RECORD,
      savedMessageRevisions: EMPTY_RECORD,
      pendingSavedMessageUpdates: EMPTY_RECORD,
      savedMessageUnavailableReasons: EMPTY_RECORD,
      messageReminders: EMPTY_RECORD,
      messageReminderConversationIds: EMPTY_RECORD,
      messageReminderRevisions: EMPTY_RECORD,
      pendingMessageReminderUpdates: EMPTY_RECORD,
      drafts: EMPTY_RECORD,
      draftRevisions: EMPTY_RECORD,
    }),
    ephemeral: EMPTY_EPHEMERAL_SIGNAL_STATE,
    huddles: EMPTY_RECORD,
    metadata: Object.freeze({
      conversations: EMPTY_RECORD,
      conversationLists: EMPTY_RECORD,
      conversationListActiveHuddles: EMPTY_RECORD,
      conversationListParticipantUserIds: EMPTY_RECORD,
      conversationListUnreadMentionCounts: EMPTY_RECORD,
      conversationDetails: EMPTY_RECORD,
      durableStreams: EMPTY_RECORD,
      pendingConversationOperations: EMPTY_RECORD,
      lifecycleRevisions: EMPTY_RECORD,
      memberListRevisions: EMPTY_RECORD,
    }),
  });

export const EMPTY_NORMALIZED_CHAT_CACHE_STATE = createEmptyState(null);

export function createNormalizedChatCache(
  initialIdentity: ChatCacheIdentity | null = null,
): NormalizedChatCache {
  let state = createEmptyState(initialIdentity);
  const optimisticReactions = new OptimisticReactionStateMachine();
  const subscriptions = new Set<{
    readonly notify: (next: NormalizedChatCacheState) => void;
  }>();
  const privateStateBoundaryListeners = new Set<() => void>();

  const dispatch = (
    action: NormalizedChatCacheAction,
  ): NormalizedChatCacheState => {
    const privateStateBoundaryChanged =
      action.type === "cache/reset" ||
      (action.type === "identity/set" && !identitiesEqual(state.identity, action.identity));
    const next = reduceNormalizedChatCache(state, action);
    if (privateStateBoundaryChanged) {
      optimisticReactions.clear();
    }
    if (next !== state) {
      state = next;
      for (const subscription of [...subscriptions]) {
        subscription.notify(state);
      }
    }
    if (privateStateBoundaryChanged) {
      for (const listener of [...privateStateBoundaryListeners]) {
        try {
          listener();
        } catch {
          // Identity-bound observers cannot affect cache invalidation.
        }
      }
    }
    return state;
  };

  const replaceState = (next: NormalizedChatCacheState): NormalizedChatCacheState => {
    if (next === state) return state;
    state = next;
    for (const subscription of [...subscriptions]) subscription.notify(state);
    return state;
  };

  return {
    getState: () => state,
    hydrateCanonicalState: (value) => {
      const next = parseCanonicalCacheState(value, state.identity);
      if (next === undefined || valueEqual(state, next)) return next !== undefined;
      optimisticReactions.clear();
      state = next;
      for (const subscription of [...subscriptions]) subscription.notify(state);
      return true;
    },
    dispatch,
    setIdentity: (identity) => dispatch({ type: "identity/set", identity }),
    reset: () => dispatch({ type: "cache/reset" }),
    setAttachmentUploadState: (upload, messageMetadata) =>
      dispatch({
        type: "attachments/set-upload",
        upload,
        ...(messageMetadata === undefined ? {} : { messageMetadata }),
      }),
    hydrateConversationList: (snapshot, options) =>
      dispatch({
        type: "conversations/hydrate-list",
        snapshot: snapshot as ConversationListSnapshot,
        ...(options?.requestCursor === undefined
          ? {}
          : { requestCursor: options.requestCursor }),
      }),
    hydrateConversationDetail: (snapshot) =>
      dispatch({
        type: "conversations/hydrate-detail",
        snapshot: snapshot as ConversationDetailSnapshot,
      }),
    beginConversationOperation: (operation) =>
      dispatch({ type: "conversations/pending-begin", operation }),
    settleConversationOperation: (logicalKey) =>
      dispatch({ type: "conversations/pending-settle", logicalKey }),
    reconcileConversationCreation: (logicalKey, input, result) =>
      dispatch({
        type: "conversations/reconcile-creation",
        logicalKey,
        input,
        result,
      }),
    reconcileThreadOpening: (input, result, page) =>
      dispatch({ type: "threads/reconcile-open", input, result, page }),
    reconcileConversationArchive: (logicalKey, input, result) =>
      dispatch({
        type: "conversations/reconcile-archive",
        logicalKey,
        input,
        result,
      }),
    reconcileConversationMembership: (logicalKey, input, result) =>
      dispatch({
        type: "conversations/reconcile-membership",
        logicalKey,
        input,
        result,
      }),
    hydrateMessageTimeline: (page) =>
      dispatch({ type: "messages/hydrate-timeline", page }),
    hydrateConversationDraft: (snapshot) =>
      dispatch({ type: "private-state/hydrate-draft", snapshot }),
    projectConversationDraft: (conversationId, draft) =>
      dispatch({ type: "private-state/project-draft", conversationId, draft }),
    reconcileConversationDraft: (
      conversationId,
      canonicalRevision,
      draft,
      preserveProjection = false,
    ) => dispatch({
      type: "private-state/reconcile-draft",
      conversationId,
      canonicalRevision,
      draft,
      preserveProjection,
    }),
    hydrateSavedMessageList: (snapshot) =>
      dispatch({ type: "private-state/hydrate-saved-messages", snapshot }),
    hydrateMessageReminderList: (snapshot) =>
      dispatch({ type: "private-state/hydrate-message-reminders", snapshot }),
    insertOptimisticMessage: (message) =>
      dispatch({ type: "messages/optimistic-insert", message }),
    failOptimisticMessage: (clientMessageId, failure, retryable) =>
      dispatch({
        type: "messages/optimistic-failed",
        clientMessageId,
        failure,
        retryable,
      }),
    reconcileOptimisticMessage: (result) =>
      dispatch({ type: "messages/optimistic-reconcile", result }),
    reconcileAuthoritativeMessageCreated: (message, clientCorrelationId) =>
      replaceState(
        reconcileAuthoritativeMessageCreated(state, message, clientCorrelationId),
      ),
    beginOptimisticMessageEdit: (input) =>
      dispatch({ type: "messages/optimistic-edit", input }),
    reconcileOptimisticMessageEdit: (idempotencyKey, result) =>
      dispatch({
        type: "messages/optimistic-edit-reconcile",
        idempotencyKey,
        result,
      }),
    rollbackOptimisticMessageEdit: (messageId, idempotencyKey) =>
      dispatch({
        type: "messages/optimistic-edit-rollback",
        messageId,
        idempotencyKey,
      }),
    beginOptimisticMessageDelete: (input) =>
      dispatch({ type: "messages/optimistic-delete", input }),
    reconcileOptimisticMessageDelete: (idempotencyKey, result) =>
      dispatch({
        type: "messages/optimistic-delete-reconcile",
        idempotencyKey,
        result,
      }),
    rollbackOptimisticMessageDelete: (messageId, idempotencyKey) =>
      dispatch({
        type: "messages/optimistic-delete-rollback",
        messageId,
        idempotencyKey,
      }),
    beginOptimisticReaction: (input) =>
      replaceState(optimisticReactions.begin(state, input)),
    reconcileOptimisticReaction: (idempotencyKey, result) =>
      replaceState(optimisticReactions.reconcile(state, idempotencyKey, result)),
    rollbackOptimisticReaction: (messageId, reactionKey, idempotencyKey) =>
      replaceState(
        optimisticReactions.rollback(
          state,
          messageId,
          reactionKey,
          idempotencyKey,
        ),
      ),
    reconcileCurrentUserReadState: (result) =>
      dispatch({ type: "read-state/reconcile-current-user", result }),
    beginOptimisticConversationPreference: (input, projectedAt) =>
      dispatch({ type: "preferences/optimistic-begin", input, projectedAt }),
    reconcileCurrentUserConversationPreference: (input, result) =>
      dispatch({ type: "preferences/reconcile-current-user", input, result }),
    markConversationPreferenceConflict: (input) =>
      dispatch({ type: "preferences/mark-conflict", input }),
    rollbackOptimisticConversationPreference: (conversationId, idempotencyKey) =>
      dispatch({
        type: "preferences/optimistic-rollback",
        conversationId,
        idempotencyKey,
      }),
    beginOptimisticThreadFollow: (input, projectedAt) =>
      dispatch({ type: "thread-follows/optimistic-begin", input, projectedAt }),
    reconcileCurrentUserThreadFollow: (input, result) =>
      dispatch({ type: "thread-follows/reconcile-current-user", input, result }),
    markThreadFollowConflict: (input) =>
      dispatch({ type: "thread-follows/mark-conflict", input }),
    rollbackOptimisticThreadFollow: (threadId, idempotencyKey) =>
      dispatch({
        type: "thread-follows/optimistic-rollback",
        threadId,
        idempotencyKey,
      }),
    beginOptimisticSavedMessage: (input) =>
      dispatch({ type: "saved-messages/optimistic-begin", input }),
    retryOptimisticSavedMessage: (messageId, idempotencyKey) =>
      dispatch({
        type: "saved-messages/optimistic-retry",
        messageId,
        idempotencyKey,
      }),
    failOptimisticSavedMessage: (messageId, idempotencyKey, failure) =>
      dispatch({
        type: "saved-messages/optimistic-failed",
        messageId,
        idempotencyKey,
        failure,
      }),
    reconcileCurrentUserSavedMessage: (input, result) =>
      dispatch({ type: "saved-messages/reconcile-current-user", input, result }),
    reconcileSavedMessageAuthority: (
      messageId,
      savedMessageRevision,
      savedMessage,
    ) => dispatch({
      type: "saved-messages/reconcile-authority",
      messageId,
      savedMessageRevision,
      savedMessage,
    }),
    markSavedMessageConflict: (input) =>
      dispatch({ type: "saved-messages/mark-conflict", input }),
    rollbackOptimisticSavedMessage: (messageId, idempotencyKey) =>
      dispatch({
        type: "saved-messages/optimistic-rollback",
        messageId,
        idempotencyKey,
      }),
    beginOptimisticMessageReminder: (input) =>
      dispatch({ type: "message-reminders/optimistic-begin", input }),
    retryOptimisticMessageReminder: (messageId, idempotencyKey) =>
      dispatch({ type: "message-reminders/optimistic-retry", messageId, idempotencyKey }),
    failOptimisticMessageReminder: (messageId, idempotencyKey, failure) =>
      dispatch({ type: "message-reminders/optimistic-failed", messageId, idempotencyKey, failure }),
    reconcileCurrentUserMessageReminder: (input, result) =>
      dispatch({ type: "message-reminders/reconcile-current-user", input, result }),
    reconcileMessageReminderAuthority: (conversationId, messageId, reminderRevision, reminder) =>
      dispatch({ type: "message-reminders/reconcile-authority", conversationId, messageId, reminderRevision, reminder }),
    markMessageReminderConflict: (input) =>
      dispatch({ type: "message-reminders/mark-conflict", input }),
    rollbackOptimisticMessageReminder: (messageId, idempotencyKey) =>
      dispatch({ type: "message-reminders/optimistic-rollback", messageId, idempotencyKey }),
    applyEphemeralSignal: (event, now) =>
      dispatch({ type: "ephemeral/apply", event, now }),
    expireEphemeralSignals: (now) =>
      dispatch({ type: "ephemeral/expire", now }),
    clearEphemeralSignals: () => dispatch({ type: "ephemeral/clear" }),
    setHuddleState: (huddleState) =>
      dispatch({ type: "huddles/set", state: huddleState }),
    setRealtimeCursor: (cursor) =>
      dispatch({ type: "realtime/set-cursor", cursor }),
    applyDurableEvent: (event) => {
      const reduction = reduceDurableChatEvent(state, event);
      const next = reduction.status === "applied"
        ? optimisticReactions.applyDurableEvent(reduction.state, event)
        : reduction.state;
      replaceState(next);
      return next === reduction.state
        ? reduction
        : Object.freeze({ ...reduction, state: next });
    },
    subscribePrivateStateBoundary: (listener) => {
      if (typeof listener !== "function") {
        throw new TypeError("Private-state boundary listener must be a function");
      }
      privateStateBoundaryListeners.add(listener);
      return () => privateStateBoundaryListeners.delete(listener);
    },
    subscribe: (selector, listener, equality = Object.is) => {
      let selected = selector(state);
      const subscription = {
        notify: (next: NormalizedChatCacheState) => {
          const nextSelected = selector(next);
          if (equality(selected, nextSelected)) {
            return;
          }
          const previous = selected;
          selected = nextSelected;
          listener(nextSelected, previous);
        },
      };
      subscriptions.add(subscription);
      return () => subscriptions.delete(subscription);
    },
  };
}

const CANONICAL_STATE_KEYS = [
  "identity",
  "entities",
  "attachmentUploads",
  "timelines",
  "currentUser",
  "ephemeral",
  "huddles",
  "metadata",
] as const;

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const exactRecord = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  isPlainRecord(value) &&
  Object.keys(value).length === keys.length &&
  Object.keys(value).every((key) => keys.includes(key));

const CLIENT_ATTACHMENT_UPLOAD_STATUSES = new Set<ClientAttachmentUploadStatus>([
  "preparing",
  "pending",
  "uploading",
  "finalizing",
  "finalized",
  "rejected",
  "abandoned",
  "failed",
  "cancelled",
]);

export function parseClientAttachmentUploadState(
  value: unknown,
): ClientAttachmentUploadState {
  if (!isPlainRecord(value)) throw new TypeError("Invalid client attachment upload state");
  const hasAttachment = Object.hasOwn(value, "attachment");
  const keys = hasAttachment
    ? ["uploadId", "conversationId", "metadata", "status", "progress", "attachment"]
    : ["uploadId", "conversationId", "metadata", "status", "progress"];
  if (!exactRecord(value, keys)) throw new TypeError("Invalid client attachment upload state");
  if (
    typeof value.uploadId !== "string" ||
    value.uploadId.trim().length === 0 ||
    typeof value.conversationId !== "string" ||
    value.conversationId.trim().length === 0 ||
    typeof value.status !== "string" ||
    !CLIENT_ATTACHMENT_UPLOAD_STATUSES.has(value.status as ClientAttachmentUploadStatus) ||
    !exactRecord(value.progress, ["uploadedBytes", "totalBytes"]) ||
    !Number.isSafeInteger(value.progress.uploadedBytes) ||
    (value.progress.uploadedBytes as number) < 0 ||
    !Number.isSafeInteger(value.progress.totalBytes) ||
    (value.progress.totalBytes as number) < 1 ||
    (value.progress.uploadedBytes as number) > (value.progress.totalBytes as number)
  ) throw new TypeError("Invalid client attachment upload state");
  const metadata = parseAttachmentMetadata(value.metadata);
  if (metadata.sizeBytes !== value.progress.totalBytes) {
    throw new TypeError("Invalid client attachment upload state");
  }
  const attachment = hasAttachment
    ? parseAttachmentLifecycleState(value.attachment)
    : undefined;
  if (
    (value.status === "preparing" && attachment !== undefined) ||
    ((value.status === "pending" || value.status === "uploading" || value.status === "finalizing") &&
      attachment?.status !== "pending") ||
    (value.status === "finalized" && attachment?.status !== "finalized") ||
    (value.status === "rejected" && attachment?.status !== "rejected") ||
    (value.status === "abandoned" && attachment?.status !== "abandoned") ||
    (attachment !== undefined &&
      JSON.stringify(attachment.metadata) !== JSON.stringify(metadata))
  ) throw new TypeError("Invalid client attachment upload state");
  return Object.freeze({
    uploadId: value.uploadId,
    conversationId: value.conversationId as ConversationId,
    metadata: Object.freeze(metadata),
    status: value.status as ClientAttachmentUploadStatus,
    progress: Object.freeze({
      uploadedBytes: value.progress.uploadedBytes as number,
      totalBytes: value.progress.totalBytes as number,
    }),
    ...(attachment === undefined ? {} : { attachment: Object.freeze(attachment) }),
  });
}

const parseUploadMessageMetadata = (value: unknown): MessageAttachmentMetadata => {
  if (!isPlainRecord(value)) throw new TypeError("Invalid attachment message metadata");
  const required = ["attachmentId", "fileName", "contentType", "sizeBytes", "downloadUrl"];
  const optional = ["previewUrl", "width", "height", "altText"];
  const keys = Object.keys(value);
  if (
    !required.every((key) => keys.includes(key)) ||
    !keys.every((key) => required.includes(key) || optional.includes(key)) ||
    typeof value.attachmentId !== "string" || value.attachmentId.length === 0 ||
    typeof value.fileName !== "string" || typeof value.contentType !== "string" ||
    !Number.isSafeInteger(value.sizeBytes) || (value.sizeBytes as number) < 1 ||
    typeof value.downloadUrl !== "string"
  ) throw new TypeError("Invalid attachment message metadata");
  for (const key of ["previewUrl", "altText"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      throw new TypeError("Invalid attachment message metadata");
    }
  }
  for (const key of ["width", "height"] as const) {
    if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || (value[key] as number) < 1)) {
      throw new TypeError("Invalid attachment message metadata");
    }
  }
  return Object.freeze({ ...value }) as unknown as MessageAttachmentMetadata;
};

const isJsonSafe = (value: unknown, depth = 0): boolean => {
  if (depth > 64) return false;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((entry) => isJsonSafe(entry, depth + 1));
  if (!isPlainRecord(value)) return false;
  return Object.entries(value).every(
    ([key, entry]) => key !== "__proto__" && isJsonSafe(entry, depth + 1),
  );
};

const deepFreezeCanonical = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    for (const entry of value) deepFreezeCanonical(entry);
    return Object.freeze(value);
  }
  if (isPlainRecord(value)) {
    for (const entry of Object.values(value)) deepFreezeCanonical(entry);
    return Object.freeze(value);
  }
  return value;
};

const recordValuesAreRecords = (value: unknown): boolean =>
  isPlainRecord(value) && Object.values(value).every(isPlainRecord);

const recordValuesAreStringArrays = (value: unknown): boolean =>
  isPlainRecord(value) &&
  Object.values(value).every(
    (entry) => Array.isArray(entry) && entry.every((item) => typeof item === "string"),
  );

const nestedRecordValuesAreRecords = (value: unknown): boolean =>
  isPlainRecord(value) &&
  Object.values(value).every(
    (entry) => isPlainRecord(entry) && Object.values(entry).every(isPlainRecord),
  );

const recordValuesArePendingConversationOperations = (
  value: unknown,
): boolean =>
  isPlainRecord(value) &&
  Object.entries(value).every(([logicalKey, entry]) => {
    if (!isPlainRecord(entry)) return false;
    const family = entry.family;
    const expectedKeys = family === "creation"
      ? ["logicalKey", "idempotencyKey", "family", "clientRequestId"]
      : ["logicalKey", "idempotencyKey", "family", "conversationId"];
    return (
      (family === "creation" || family === "archive" || family === "membership") &&
      exactRecord(entry, expectedKeys) &&
      entry.logicalKey === logicalKey &&
      typeof entry.logicalKey === "string" &&
      entry.logicalKey.length > 0 &&
      typeof entry.idempotencyKey === "string" &&
      entry.idempotencyKey.length > 0 &&
      (family === "creation"
        ? typeof entry.clientRequestId === "string" && entry.clientRequestId.length > 0
        : typeof entry.conversationId === "string" && entry.conversationId.length > 0)
    );
  });

const recordValuesArePreferenceRevisions = (value: unknown): boolean =>
  isPlainRecord(value) &&
  Object.values(value).every(
    (revision) => Number.isSafeInteger(revision) && (revision as number) >= 0,
  );

const recordValuesArePendingPreferenceUpdates = (value: unknown): boolean =>
  isPlainRecord(value) &&
  Object.entries(value).every(([conversationId, entry]) => {
    if (!isPlainRecord(entry)) return false;
    const hasAuthoritative = Object.hasOwn(entry, "authoritativePreference");
    if (!exactRecord(entry, [
      "state",
      "conversationId",
      "idempotencyKey",
      "expectedPreferenceRevision",
      "desiredPreference",
      ...(hasAuthoritative ? ["authoritativePreference"] : []),
    ])) return false;
    return (
      (entry.state === "pending" || entry.state === "conflict") &&
      entry.conversationId === conversationId &&
      typeof entry.idempotencyKey === "string" &&
      entry.idempotencyKey.length > 0 &&
      Number.isSafeInteger(entry.expectedPreferenceRevision) &&
      (entry.expectedPreferenceRevision as number) >= 0 &&
      isPlainRecord(entry.desiredPreference) &&
      (!hasAuthoritative || isPlainRecord(entry.authoritativePreference)) &&
      (entry.state !== "conflict" || hasAuthoritative)
    );
  });

const isCanonicalThreadFollow = (
  value: unknown,
  expectedThreadId?: string,
): boolean => {
  if (!exactRecord(value, ["target", "isFollowing", "source", "updatedAt"])) {
    return false;
  }
  if (
    !exactRecord(value.target, ["type", "id"]) ||
    value.target.type !== "thread" ||
    typeof value.target.id !== "string" ||
    value.target.id.length === 0 ||
    (expectedThreadId !== undefined && value.target.id !== expectedThreadId) ||
    typeof value.isFollowing !== "boolean" ||
    (value.source !== "manual" && value.source !== "reply" && value.source !== "mention") ||
    (!value.isFollowing && value.source !== "manual") ||
    typeof value.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.updatedAt))
  ) return false;
  return true;
};

const recordValuesAreThreadFollows = (value: unknown): boolean =>
  isPlainRecord(value) &&
  Object.entries(value).every(([threadId, follow]) =>
    isCanonicalThreadFollow(follow, threadId));

const recordValuesArePendingThreadFollowUpdates = (value: unknown): boolean =>
  isPlainRecord(value) &&
  Object.entries(value).every(([threadId, entry]) => {
    if (!isPlainRecord(entry)) return false;
    const hasAuthoritative = Object.hasOwn(entry, "authoritativeFollow");
    if (!exactRecord(entry, [
      "state",
      "threadId",
      "idempotencyKey",
      "expectedFollowRevision",
      "intent",
      ...(hasAuthoritative ? ["authoritativeFollow"] : []),
    ])) return false;
    return (entry.state === "pending" || entry.state === "conflict") &&
      entry.threadId === threadId &&
      typeof entry.idempotencyKey === "string" &&
      entry.idempotencyKey.length > 0 &&
      Number.isSafeInteger(entry.expectedFollowRevision) &&
      (entry.expectedFollowRevision as number) >= 0 &&
      (entry.intent === "follow" || entry.intent === "unfollow") &&
      (!hasAuthoritative ||
        isCanonicalThreadFollow(entry.authoritativeFollow, threadId));
  });

const isCanonicalSavedMessage = (
  value: unknown,
  expectedMessageId: string,
): boolean => {
  if (!isPlainRecord(value)) return false;
  const hasPrivateNote = Object.hasOwn(value, "privateNote");
  if (!exactRecord(value, [
    "messageId",
    "isSaved",
    ...(hasPrivateNote ? ["privateNote"] : []),
  ])) return false;
  if (
    value.messageId !== expectedMessageId ||
    typeof value.isSaved !== "boolean" ||
    (!value.isSaved && hasPrivateNote)
  ) return false;
  try {
    parseSetSavedMessageInput({
      operation: "set_saved_message",
      intent: value.isSaved ? "save" : "unsave",
      messageId: value.messageId,
      expectedSavedMessageRevision: 0,
      idempotencyKey: "cache-saved-message-validation",
      ...(hasPrivateNote ? { privateNote: value.privateNote } : {}),
    });
    return true;
  } catch {
    return false;
  }
};

const recordValuesAreSavedMessages = (value: unknown): boolean =>
  isPlainRecord(value) &&
  Object.entries(value).every(([messageId, savedMessage]) =>
    isCanonicalSavedMessage(savedMessage, messageId));

const recordValuesArePendingSavedMessageUpdates = (value: unknown): boolean =>
  isPlainRecord(value) &&
  Object.entries(value).every(([messageId, entry]) => {
    if (!isPlainRecord(entry)) return false;
    const hasAuthoritative = Object.hasOwn(entry, "authoritativeSavedMessage");
    const hasFailure = Object.hasOwn(entry, "failure");
    if (!exactRecord(entry, [
      "state",
      "messageId",
      "idempotencyKey",
      "expectedSavedMessageRevision",
      "intent",
      "desiredSavedMessage",
      ...(hasAuthoritative ? ["authoritativeSavedMessage"] : []),
      "attempt",
      "retryable",
      ...(hasFailure ? ["failure"] : []),
    ])) return false;
    return (
      (entry.state === "pending" || entry.state === "failed" ||
        entry.state === "conflict") &&
      entry.messageId === messageId &&
      typeof entry.idempotencyKey === "string" &&
      entry.idempotencyKey.length > 0 &&
      Number.isSafeInteger(entry.expectedSavedMessageRevision) &&
      (entry.expectedSavedMessageRevision as number) >= 0 &&
      (entry.intent === "save" || entry.intent === "unsave") &&
      isCanonicalSavedMessage(entry.desiredSavedMessage, messageId) &&
      (!hasAuthoritative ||
        isCanonicalSavedMessage(entry.authoritativeSavedMessage, messageId)) &&
      Number.isSafeInteger(entry.attempt) &&
      (entry.attempt as number) >= 1 &&
      typeof entry.retryable === "boolean" &&
      (entry.state === "pending" || entry.state === "conflict"
        ? !entry.retryable && !hasFailure
        : entry.retryable && hasFailure &&
          (entry.failure === "transport" ||
            entry.failure === "malformed_response" ||
            entry.failure === "aborted"))
    );
  });

const recordValuesAreSavedMessageUnavailableReasons = (
  value: unknown,
): boolean => isPlainRecord(value) && Object.values(value).every(
  (reason) => reason === "deleted" || reason === "inaccessible",
);

const privateSavedMessageFieldsMatch = (
  currentUser: Record<string, unknown>,
  identity: Record<string, unknown> | null,
): boolean => {
  const savedMessages = currentUser.savedMessages ?? {};
  const revisions = currentUser.savedMessageRevisions ?? {};
  const pending = currentUser.pendingSavedMessageUpdates ?? {};
  const unavailable = currentUser.savedMessageUnavailableReasons ?? {};
  if (
    !recordValuesAreSavedMessages(savedMessages) ||
    !recordValuesArePreferenceRevisions(revisions) ||
    !recordValuesArePendingSavedMessageUpdates(pending) ||
    !recordValuesAreSavedMessageUnavailableReasons(unavailable)
  ) return false;
  if (identity !== null) return true;
  return Object.keys(savedMessages).length === 0 &&
    Object.keys(revisions).length === 0 &&
    Object.keys(pending).length === 0 &&
    Object.keys(unavailable).length === 0;
};

const isCanonicalMessageReminder = (value: unknown): boolean => {
  if (!isPlainRecord(value) || value.privacy !== "affected_authenticated_actor") return false;
  if (value.state === "cancelled") {
    if (!exactRecord(value, ["privacy", "state"])) return false;
    try {
      parseCancelMessageReminderInput({
        operation: "message_reminder.v1",
        intent: "cancel",
        conversationId: "cache-conversation",
        messageId: "cache-message",
        expectedReminderRevision: 0,
        idempotencyKey: "cache-message-reminder-validation",
      });
      return true;
    } catch {
      return false;
    }
  }
  if (value.state !== "scheduled" || !exactRecord(value, ["privacy", "state", "dueAt"])) {
    return false;
  }
  try {
    parseSetMessageReminderInput({
      operation: "message_reminder.v1",
      intent: "set",
      conversationId: "cache-conversation",
      messageId: "cache-message",
      expectedReminderRevision: 0,
      idempotencyKey: "cache-message-reminder-validation",
      dueAt: value.dueAt,
    }, { referenceTime: new Date(0) });
    return true;
  } catch {
    return false;
  }
};

const recordValuesAreMessageReminders = (value: unknown): boolean =>
  isPlainRecord(value) && Object.values(value).every(isCanonicalMessageReminder);

const recordValuesArePendingMessageReminderUpdates = (value: unknown): boolean =>
  isPlainRecord(value) && Object.entries(value).every(([messageId, entry]) => {
    if (!isPlainRecord(entry)) return false;
    const hasAuthoritative = Object.hasOwn(entry, "authoritativeReminder");
    const hasFailure = Object.hasOwn(entry, "failure");
    if (!exactRecord(entry, [
      "state", "conversationId", "messageId", "idempotencyKey",
      "expectedReminderRevision", "intent", "desiredReminder",
      ...(hasAuthoritative ? ["authoritativeReminder"] : []),
      "attempt", "retryable", ...(hasFailure ? ["failure"] : []),
    ])) return false;
    if (entry.messageId !== messageId || typeof entry.conversationId !== "string" ||
        typeof entry.idempotencyKey !== "string" || entry.idempotencyKey.length === 0 ||
        !Number.isSafeInteger(entry.expectedReminderRevision) ||
        (entry.expectedReminderRevision as number) < 0 ||
        (entry.intent !== "set" && entry.intent !== "cancel") ||
        !isCanonicalMessageReminder(entry.desiredReminder) ||
        (hasAuthoritative && !isCanonicalMessageReminder(entry.authoritativeReminder)) ||
        !Number.isSafeInteger(entry.attempt) || (entry.attempt as number) < 1 ||
        typeof entry.retryable !== "boolean") return false;
    return entry.state === "pending" || entry.state === "conflict"
      ? !entry.retryable && !hasFailure &&
        (entry.state !== "conflict" || hasAuthoritative)
      : entry.state === "failed" && entry.retryable && hasFailure &&
        (entry.failure === "transport" || entry.failure === "malformed_response" ||
          entry.failure === "aborted");
  });

const privateMessageReminderFieldsMatch = (
  currentUser: Record<string, unknown>,
  identity: Record<string, unknown> | null,
): boolean => {
  const reminders = currentUser.messageReminders ?? {};
  const conversations = currentUser.messageReminderConversationIds ?? {};
  const revisions = currentUser.messageReminderRevisions ?? {};
  const pending = currentUser.pendingMessageReminderUpdates ?? {};
  if (!recordValuesAreMessageReminders(reminders) ||
      !isPlainRecord(conversations) ||
      !Object.values(conversations).every((value) => typeof value === "string" && value.length > 0) ||
      !recordValuesArePreferenceRevisions(revisions) ||
      !recordValuesArePendingMessageReminderUpdates(pending)) return false;
  const keys = new Set([...Object.keys(reminders), ...Object.keys(revisions), ...Object.keys(pending)]);
  if (![...keys].every((key) => typeof conversations[key] === "string")) return false;
  return identity !== null || (keys.size === 0 && Object.keys(conversations).length === 0);
};

const privateDraftFieldsMatch = (
  currentUser: Record<string, unknown>,
  identity: Record<string, unknown> | null,
): boolean => {
  const drafts = currentUser.drafts;
  const revisions = (currentUser.draftRevisions ?? {}) as Record<string, unknown>;
  if (!isPlainRecord(drafts) || !recordValuesArePreferenceRevisions(revisions)) {
    return false;
  }
  const draftKeys = Object.keys(drafts).sort();
  const revisionKeys = Object.keys(revisions).sort();
  if (
    draftKeys.length !== revisionKeys.length ||
    !draftKeys.every((key, index) => key === revisionKeys[index]) ||
    !Object.entries(drafts).every(([conversationId, draft]) => {
      if (!isPlainRecord(draft)) return false;
      if (draft.kind === "clear_tombstone") {
        return exactRecord(draft, ["kind", "content"]) && draft.content === null;
      }
      if (
        draft.kind !== "replaced" ||
        !exactRecord(draft, ["kind", "content"]) ||
        !isPlainRecord(draft.content) ||
        !exactRecord(draft.content, ["format", "text", "attachments"]) ||
        (draft.content.format !== "plain" && draft.content.format !== "markdown") ||
        typeof draft.content.text !== "string" ||
        !Array.isArray(draft.content.attachments)
      ) return false;
      return draft.content.attachments.every(
        (attachment) =>
          exactRecord(attachment, ["attachmentId"]) &&
          typeof attachment.attachmentId === "string" &&
          attachment.attachmentId.length > 0,
      ) && Number.isSafeInteger(revisions[conversationId]) &&
        (revisions[conversationId] as number) >= 1;
    })
  ) return false;
  return identity !== null || draftKeys.length === 0;
};

const tenantFieldsMatch = (value: unknown, tenantId: string): boolean => {
  if (Array.isArray(value)) return value.every((entry) => tenantFieldsMatch(entry, tenantId));
  if (!isPlainRecord(value)) return true;
  if (Object.hasOwn(value, "tenantId") && value.tenantId !== tenantId) return false;
  return Object.values(value).every((entry) => tenantFieldsMatch(entry, tenantId));
};

const privatePreferenceFieldsMatch = (
  currentUser: Record<string, unknown>,
  identity: Record<string, unknown> | null,
): boolean => {
  const preferences = currentUser.preferences;
  const revisions = currentUser.preferenceRevisions ?? {};
  const pending = currentUser.pendingPreferenceUpdates ?? {};
  if (!isPlainRecord(preferences) || !isPlainRecord(revisions) || !isPlainRecord(pending)) {
    return false;
  }
  if (identity === null) {
    return Object.keys(preferences).length === 0 &&
      Object.keys(revisions).length === 0 &&
      Object.keys(pending).length === 0;
  }
  return Object.entries(preferences).every(
    ([conversationId, preference]) =>
      isPlainRecord(preference) &&
      preference.conversationId === conversationId &&
      preference.userId === identity.userId,
  ) && Object.entries(pending).every(([conversationId, update]) => {
    if (!isPlainRecord(update) || update.conversationId !== conversationId) return false;
    const authoritative = update.authoritativePreference;
    return authoritative === undefined ||
      (isPlainRecord(authoritative) &&
        authoritative.conversationId === conversationId &&
        authoritative.userId === identity.userId);
  });
};

const privateThreadFollowFieldsMatch = (
  currentUser: Record<string, unknown>,
  conversationsValue: unknown,
  messagesValue: unknown,
  identity: Record<string, unknown> | null,
): boolean => {
  if (!isPlainRecord(conversationsValue) || !isPlainRecord(messagesValue)) {
    return false;
  }
  const conversations = conversationsValue;
  const messages = messagesValue;
  const follows = currentUser.threadFollows ?? {};
  const revisions = currentUser.threadFollowRevisions ?? {};
  const pending = currentUser.pendingThreadFollowUpdates ?? {};
  if (
    !recordValuesAreThreadFollows(follows) ||
    !recordValuesArePreferenceRevisions(revisions) ||
    !recordValuesArePendingThreadFollowUpdates(pending)
  ) return false;
  if (identity === null) {
    return Object.keys(follows).length === 0 &&
      Object.keys(revisions).length === 0 &&
      Object.keys(pending).length === 0;
  }
  const threadIds = new Set([
    ...Object.keys(follows),
    ...Object.keys(revisions),
    ...Object.keys(pending),
  ]);
  return [...threadIds].every((threadId) => {
    const thread = conversations[threadId];
    if (
      !isPlainRecord(thread) ||
      thread.type !== "thread" ||
      typeof thread.parentConversationId !== "string" ||
      typeof thread.rootMessageId !== "string"
    ) return false;
    const parent = conversations[thread.parentConversationId];
    const root = messages[thread.rootMessageId];
    return isPlainRecord(parent) &&
      parent.type !== "thread" &&
      isPlainRecord(root) &&
      root.conversationId === thread.parentConversationId;
  });
};

const parseCanonicalCacheState = (
  value: unknown,
  currentIdentity: ChatCacheIdentity | null,
): NormalizedChatCacheState | undefined => {
  try {
    const legacyKeys = CANONICAL_STATE_KEYS.filter((key) => key !== "attachmentUploads");
    if (
      (!exactRecord(value, CANONICAL_STATE_KEYS) && !exactRecord(value, legacyKeys)) ||
      !isJsonSafe(value)
    ) return undefined;
    const identity = value.identity;
    if (
      identity !== null &&
      (!exactRecord(identity, ["tenantId", "userId", "sessionId"]) ||
        typeof identity.tenantId !== "string" || identity.tenantId.length === 0 ||
        typeof identity.userId !== "string" || identity.userId.length === 0 ||
        typeof identity.sessionId !== "string" || identity.sessionId.length === 0)
    ) return undefined;
    if (
      currentIdentity !== null &&
      (identity === null ||
        identity.tenantId !== currentIdentity.tenantId ||
        identity.userId !== currentIdentity.userId ||
        identity.sessionId !== currentIdentity.sessionId)
    ) return undefined;
    if (
      !exactRecord(value.entities, [
        "conversations",
        "messages",
        "memberUserIdsByConversation",
        "membersByConversation",
        "attachments",
      ]) ||
      (!exactRecord(value.currentUser, [
        "memberships",
        "readStates",
        "preferences",
        "drafts",
      ]) && !exactRecord(value.currentUser, [
        "memberships",
        "readStates",
        "preferences",
        "preferenceRevisions",
        "pendingPreferenceUpdates",
        "drafts",
      ]) && !exactRecord(value.currentUser, [
        "memberships",
        "readStates",
        "preferences",
        "preferenceRevisions",
        "pendingPreferenceUpdates",
        "threadFollows",
        "threadFollowRevisions",
        "pendingThreadFollowUpdates",
        "drafts",
      ]) && !exactRecord(value.currentUser, [
        "memberships",
        "readStates",
        "preferences",
        "preferenceRevisions",
        "pendingPreferenceUpdates",
        "threadFollows",
        "threadFollowRevisions",
        "pendingThreadFollowUpdates",
        "savedMessages",
        "savedMessageRevisions",
        "pendingSavedMessageUpdates",
        "savedMessageUnavailableReasons",
        "drafts",
      ]) && !exactRecord(value.currentUser, [
        "memberships",
        "readStates",
        "preferences",
        "preferenceRevisions",
        "pendingPreferenceUpdates",
        "threadFollows",
        "threadFollowRevisions",
        "pendingThreadFollowUpdates",
        "savedMessages",
        "savedMessageRevisions",
        "pendingSavedMessageUpdates",
        "savedMessageUnavailableReasons",
        "drafts",
        "draftRevisions",
      ]) && !exactRecord(value.currentUser, [
        "memberships",
        "readStates",
        "preferences",
        "preferenceRevisions",
        "pendingPreferenceUpdates",
        "threadFollows",
        "threadFollowRevisions",
        "pendingThreadFollowUpdates",
        "savedMessages",
        "savedMessageRevisions",
        "pendingSavedMessageUpdates",
        "savedMessageUnavailableReasons",
        "messageReminders",
        "messageReminderConversationIds",
        "messageReminderRevisions",
        "pendingMessageReminderUpdates",
        "drafts",
        "draftRevisions",
      ])) ||
      !exactRecord(value.ephemeral, ["typing", "presence"]) ||
      !isPlainRecord(value.timelines) ||
      !isPlainRecord(value.huddles) ||
      !isPlainRecord(value.metadata)
    ) return undefined;
    const metadataKeys = Object.keys(value.metadata);
    if (
      ![
        "conversations",
        "conversationLists",
        "conversationDetails",
        "durableStreams",
        "pendingConversationOperations",
        "lifecycleRevisions",
        "memberListRevisions",
      ].every((key) => metadataKeys.includes(key)) ||
      !metadataKeys.every((key) => [
        "conversations",
        "conversationLists",
        "conversationListActiveHuddles",
        "conversationListParticipantUserIds",
        "conversationListUnreadMentionCounts",
        "conversationDetails",
        "durableStreams",
        "pendingConversationOperations",
        "lifecycleRevisions",
        "memberListRevisions",
        "realtimeCursor",
      ].includes(key)) ||
      ![7, 8, 9, 10, 11].includes(metadataKeys.length) ||
      !recordValuesAreRecords(value.entities.conversations) ||
      !recordValuesAreRecords(value.entities.messages) ||
      !recordValuesAreStringArrays(value.entities.memberUserIdsByConversation) ||
      !nestedRecordValuesAreRecords(value.entities.membersByConversation) ||
      !recordValuesAreRecords(value.entities.attachments) ||
      (value.attachmentUploads !== undefined && !isPlainRecord(value.attachmentUploads)) ||
      !recordValuesAreRecords(value.timelines) ||
      !recordValuesAreRecords(value.currentUser.memberships) ||
      !recordValuesAreRecords(value.currentUser.readStates) ||
      !recordValuesAreRecords(value.currentUser.preferences) ||
      !recordValuesAreRecords(value.currentUser.drafts) ||
      (value.currentUser.draftRevisions !== undefined &&
        !recordValuesArePreferenceRevisions(value.currentUser.draftRevisions)) ||
      (value.currentUser.preferenceRevisions !== undefined &&
        !recordValuesArePreferenceRevisions(value.currentUser.preferenceRevisions)) ||
      (value.currentUser.pendingPreferenceUpdates !== undefined &&
        !recordValuesArePendingPreferenceUpdates(
          value.currentUser.pendingPreferenceUpdates,
        )) ||
      (value.currentUser.threadFollows !== undefined &&
        !recordValuesAreThreadFollows(value.currentUser.threadFollows)) ||
      (value.currentUser.threadFollowRevisions !== undefined &&
        !recordValuesArePreferenceRevisions(
          value.currentUser.threadFollowRevisions,
        )) ||
      (value.currentUser.pendingThreadFollowUpdates !== undefined &&
        !recordValuesArePendingThreadFollowUpdates(
          value.currentUser.pendingThreadFollowUpdates,
        )) ||
      (value.currentUser.savedMessages !== undefined &&
        !recordValuesAreSavedMessages(value.currentUser.savedMessages)) ||
      (value.currentUser.savedMessageRevisions !== undefined &&
        !recordValuesArePreferenceRevisions(
          value.currentUser.savedMessageRevisions,
        )) ||
      (value.currentUser.pendingSavedMessageUpdates !== undefined &&
        !recordValuesArePendingSavedMessageUpdates(
          value.currentUser.pendingSavedMessageUpdates,
        )) ||
      (value.currentUser.savedMessageUnavailableReasons !== undefined &&
        !recordValuesAreSavedMessageUnavailableReasons(
          value.currentUser.savedMessageUnavailableReasons,
        )) ||
      (value.currentUser.messageReminders !== undefined &&
        !recordValuesAreMessageReminders(value.currentUser.messageReminders)) ||
      (value.currentUser.messageReminderConversationIds !== undefined &&
        (!isPlainRecord(value.currentUser.messageReminderConversationIds) ||
          !Object.values(value.currentUser.messageReminderConversationIds).every(
            (entry) => typeof entry === "string" && entry.length > 0,
          ))) ||
      (value.currentUser.messageReminderRevisions !== undefined &&
        !recordValuesArePreferenceRevisions(value.currentUser.messageReminderRevisions)) ||
      (value.currentUser.pendingMessageReminderUpdates !== undefined &&
        !recordValuesArePendingMessageReminderUpdates(
          value.currentUser.pendingMessageReminderUpdates,
        )) ||
      !Object.values(value.ephemeral).every(recordValuesAreRecords) ||
      !recordValuesAreRecords(value.huddles) ||
      !recordValuesAreRecords(value.metadata.conversations) ||
      !recordValuesAreRecords(value.metadata.conversationLists) ||
      (value.metadata.conversationListActiveHuddles !== undefined &&
        (!isPlainRecord(value.metadata.conversationListActiveHuddles) ||
          !Object.values(value.metadata.conversationListActiveHuddles).every(
            (entry) => typeof entry === "boolean",
          ) ||
          !Object.keys(value.metadata.conversationListActiveHuddles).every(
            (conversationId) =>
              isPlainRecord(value.entities) &&
              isPlainRecord(value.entities.conversations) &&
              Object.hasOwn(value.entities.conversations, conversationId),
          ))) ||
      (value.metadata.conversationListParticipantUserIds !== undefined &&
        (!isPlainRecord(value.metadata.conversationListParticipantUserIds) ||
          !recordValuesAreStringArrays(
            value.metadata.conversationListParticipantUserIds,
          ) ||
          !Object.keys(value.metadata.conversationListParticipantUserIds).every(
            (conversationId) =>
              isPlainRecord(value.entities) &&
              isPlainRecord(value.entities.conversations) &&
              Object.hasOwn(value.entities.conversations, conversationId),
          ))) ||
      (value.metadata.conversationListUnreadMentionCounts !== undefined &&
        (!isPlainRecord(value.metadata.conversationListUnreadMentionCounts) ||
          !recordValuesArePreferenceRevisions(
            value.metadata.conversationListUnreadMentionCounts,
          ) ||
          !Object.keys(value.metadata.conversationListUnreadMentionCounts).every(
            (conversationId) =>
              isPlainRecord(value.entities) &&
              isPlainRecord(value.entities.conversations) &&
              Object.hasOwn(value.entities.conversations, conversationId),
          ))) ||
      !recordValuesAreRecords(value.metadata.conversationDetails) ||
      !recordValuesAreRecords(value.metadata.durableStreams) ||
      !recordValuesArePendingConversationOperations(
        value.metadata.pendingConversationOperations,
      ) ||
      !isPlainRecord(value.metadata.lifecycleRevisions) ||
      !Object.values(value.metadata.lifecycleRevisions).every(
        (revision) => Number.isSafeInteger(revision) && (revision as number) >= 1,
      ) ||
      !isPlainRecord(value.metadata.memberListRevisions) ||
      !Object.values(value.metadata.memberListRevisions).every(
        (revision) => Number.isSafeInteger(revision) && (revision as number) >= 1,
      ) ||
      (value.metadata.realtimeCursor !== undefined &&
        (!exactRecord(value.metadata.realtimeCursor, ["eventId"]) ||
          typeof value.metadata.realtimeCursor.eventId !== "string" ||
          value.metadata.realtimeCursor.eventId.length === 0)) ||
      !privatePreferenceFieldsMatch(value.currentUser, identity) ||
      !privateThreadFollowFieldsMatch(
        value.currentUser,
        value.entities.conversations,
        value.entities.messages,
        identity,
      ) ||
      !privateSavedMessageFieldsMatch(value.currentUser, identity) ||
      !privateMessageReminderFieldsMatch(value.currentUser, identity) ||
      !privateDraftFieldsMatch(value.currentUser, identity) ||
      (identity !== null && !tenantFieldsMatch(value, identity.tenantId as string))
    ) return undefined;
    const uploads = value.attachmentUploads === undefined
      ? EMPTY_RECORD
      : Object.freeze(Object.fromEntries(
          Object.entries(value.attachmentUploads).map(([uploadId, upload]) => {
            const parsed = parseClientAttachmentUploadState(upload);
            if (parsed.uploadId !== uploadId) throw new TypeError("Invalid client attachment upload state");
            return [uploadId, parsed];
          }),
        ));
    const cloned = JSON.parse(JSON.stringify({
      ...value,
      attachmentUploads: uploads,
      currentUser: {
        ...value.currentUser,
        preferenceRevisions: value.currentUser.preferenceRevisions ?? {},
        pendingPreferenceUpdates: value.currentUser.pendingPreferenceUpdates ?? {},
        threadFollows: value.currentUser.threadFollows ?? {},
        threadFollowRevisions: value.currentUser.threadFollowRevisions ?? {},
        pendingThreadFollowUpdates:
          value.currentUser.pendingThreadFollowUpdates ?? {},
        savedMessages: value.currentUser.savedMessages ?? {},
        savedMessageRevisions: value.currentUser.savedMessageRevisions ?? {},
        pendingSavedMessageUpdates:
          value.currentUser.pendingSavedMessageUpdates ?? {},
        savedMessageUnavailableReasons:
          value.currentUser.savedMessageUnavailableReasons ?? {},
        messageReminders: value.currentUser.messageReminders ?? {},
        messageReminderConversationIds:
          value.currentUser.messageReminderConversationIds ?? {},
        messageReminderRevisions: value.currentUser.messageReminderRevisions ?? {},
        pendingMessageReminderUpdates:
          value.currentUser.pendingMessageReminderUpdates ?? {},
        draftRevisions: value.currentUser.draftRevisions ?? {},
      },
      metadata: {
        ...value.metadata,
        conversationListActiveHuddles:
          value.metadata.conversationListActiveHuddles ?? {},
        conversationListParticipantUserIds:
          value.metadata.conversationListParticipantUserIds ?? {},
        conversationListUnreadMentionCounts:
          value.metadata.conversationListUnreadMentionCounts ?? {},
      },
    })) as NormalizedChatCacheState;
    return deepFreezeCanonical(cloned) as NormalizedChatCacheState;
  } catch {
    return undefined;
  }
};

export function reduceNormalizedChatCache(
  state: NormalizedChatCacheState,
  action: NormalizedChatCacheAction,
): NormalizedChatCacheState {
  switch (action.type) {
    case "identity/set":
      return identitiesEqual(state.identity, action.identity)
        ? state
        : createEmptyState(action.identity);
    case "cache/reset":
      return isEmptyState(state) ? state : createEmptyState(state.identity);
    case "attachments/set-upload": {
      const upload = parseClientAttachmentUploadState(action.upload);
      const existing = state.attachmentUploads[upload.uploadId];
      let entities = state.entities;
      if (action.messageMetadata !== undefined) {
        const metadata = parseUploadMessageMetadata(action.messageMetadata);
        if (
          upload.status !== "finalized" ||
          upload.attachment?.attachmentId !== metadata.attachmentId
        ) throw new TypeError("Finalized attachment metadata does not match upload state");
        entities = Object.freeze({
          ...state.entities,
          attachments: freezeRecord({
            ...state.entities.attachments,
            [metadata.attachmentId]: metadata,
          }),
        });
      }
      if (valueEqual(existing, upload) && entities === state.entities) return state;
      return freezeState({
        ...state,
        entities,
        attachmentUploads: freezeRecord({
          ...state.attachmentUploads,
          [upload.uploadId]: upload,
        }),
      });
    }
    case "conversations/hydrate-list":
      return hydrateConversationList(state, action.snapshot, action.requestCursor);
    case "conversations/hydrate-detail":
      return hydrateConversationDetail(state, action.snapshot);
    case "conversations/pending-begin":
      return beginConversationOperation(state, action.operation);
    case "conversations/pending-settle":
      return settleConversationOperation(state, action.logicalKey);
    case "conversations/reconcile-creation":
      return reconcileConversationCreation(
        state,
        action.logicalKey,
        action.input,
        action.result,
      );
    case "threads/hydrate-existing": {
      const thread = action.snapshot.conversation;
      if (thread.type !== "thread" || action.page.conversationId !== thread.id ||
          (action.rootPage !== undefined && action.rootPage.conversationId !== thread.parentConversationId)) {
        throw new ChatCacheError("conversation_mismatch", "Existing thread snapshot identity does not match");
      }
      const root = action.rootPage?.messages.find((message) => message.id === thread.rootMessageId);
      let next = root === undefined ? forgetCachedMessages(state, new Set([thread.rootMessageId])) : state;
      if (root !== undefined && action.rootPage !== undefined) {
        // Hydrate only the root, preserving newer canonical revisions from realtime.
        next = hydrateMessageTimeline(next, { ...action.rootPage, messages: [root] });
      }
      return hydrateMessageTimeline(hydrateConversationDetail(next, action.snapshot), action.page);
    }
    case "threads/discard-history": {
      const ids = new Set(Object.values(state.entities.messages)
        .filter((message) => message.conversationId === action.threadId).map((message) => message.id));
      const next = forgetCachedMessages(state, ids);
      const conversations = { ...next.entities.conversations };
      const timelines = { ...next.timelines };
      const conversationDetails = { ...next.metadata.conversationDetails };
      delete conversations[action.threadId];
      delete timelines[action.threadId];
      delete conversationDetails[action.threadId];
      return freezeState({
        ...next,
        entities: Object.freeze({ ...next.entities, conversations: freezeRecord(conversations) }),
        timelines: freezeRecord(timelines),
        metadata: Object.freeze({ ...next.metadata, conversationDetails: freezeRecord(conversationDetails) }),
      });
    }
    case "threads/reconcile-open":
      return reconcileThreadOpening(
        state,
        action.input,
        action.result,
        action.page,
      );
    case "conversations/reconcile-archive":
      return reconcileConversationArchive(
        state,
        action.logicalKey,
        action.input,
        action.result,
      );
    case "conversations/reconcile-membership":
      return reconcileConversationMembership(
        state,
        action.logicalKey,
        action.input,
        action.result,
      );
    case "messages/forget-context":
      return forgetCachedMessages(state, new Set(action.messageIds.filter(id => {
        const message = state.entities.messages[id];
        return message !== undefined && !("delivery" in message);
      })));
    case "messages/hydrate-context-window": {
      const next = hydrateMessageTimeline(state, action.page);
      const timeline = next.timelines[action.page.conversationId]!;
      // A disjoint jump selects a new contiguous window. Merging extrema would
      // hide the unloaded gap. Keep pending sends visible and their destinations intact.
      const pendingIds = timeline.messageIds.filter(id => isOptimisticMessage(next.entities.messages[id]));
      const messageIds = sortAndValidateTimelineIds(mergeIds(action.page.messages.map(message => message.id), pendingIds),
        next.entities.messages, action.page.conversationId);
      return freezeState({ ...next, timelines: freezeRecord({ ...next.timelines,
        [action.page.conversationId]: Object.freeze({ ...timeline, messageIds, pagination: action.page.pagination }),
      }) });
    }
    case "messages/hydrate-timeline":
      return hydrateMessageTimeline(state, action.page);
    case "private-state/hydrate-draft":
      return hydrateConversationDraftSnapshot(state, action.snapshot);
    case "private-state/project-draft":
      return projectConversationDraft(
        state,
        action.conversationId,
        action.draft,
      );
    case "private-state/reconcile-draft":
      return reconcileConversationDraft(
        state,
        action.conversationId,
        action.canonicalRevision,
        action.draft,
        action.preserveProjection,
      );
    case "private-state/hydrate-saved-messages":
      return hydrateSavedMessageListSnapshot(state, action.snapshot);
    case "private-state/hydrate-message-reminders":
      return hydrateMessageReminderListSnapshot(state, action.snapshot);
    case "messages/optimistic-insert":
      return insertOptimisticMessage(state, action.message);
    case "messages/optimistic-failed":
      return failOptimisticMessage(
        state,
        action.clientMessageId,
        action.failure,
        action.retryable,
      );
    case "messages/optimistic-reconcile":
      return reconcileOptimisticMessage(state, action.result);
    case "messages/optimistic-edit":
      return beginOptimisticMessageEdit(state, action.input);
    case "messages/optimistic-edit-reconcile":
      return reconcileOptimisticMessageEdit(
        state,
        action.idempotencyKey,
        action.result,
      );
    case "messages/optimistic-edit-rollback":
      return rollbackOptimisticMessageEdit(
        state,
        action.messageId,
        action.idempotencyKey,
      );
    case "messages/optimistic-delete":
      return beginOptimisticMessageDelete(state, action.input);
    case "messages/optimistic-delete-reconcile":
      return reconcileOptimisticMessageDelete(
        state,
        action.idempotencyKey,
        action.result,
      );
    case "messages/optimistic-delete-rollback":
      return rollbackOptimisticMessageDelete(
        state,
        action.messageId,
        action.idempotencyKey,
      );
    case "read-state/reconcile-current-user":
      return reconcileCurrentUserReadState(state, action.result);
    case "preferences/optimistic-begin":
      return beginOptimisticConversationPreference(
        state,
        action.input,
        action.projectedAt,
      );
    case "preferences/reconcile-current-user":
      return reconcileCurrentUserConversationPreference(
        state,
        action.input,
        action.result,
      );
    case "preferences/mark-conflict":
      return markConversationPreferenceConflict(state, action.input);
    case "preferences/optimistic-rollback":
      return rollbackOptimisticConversationPreference(
        state,
        action.conversationId,
        action.idempotencyKey,
      );
    case "thread-follows/optimistic-begin":
      return beginOptimisticThreadFollow(state, action.input, action.projectedAt);
    case "thread-follows/reconcile-current-user":
      return reconcileCurrentUserThreadFollow(
        state,
        action.input,
        action.result,
      );
    case "thread-follows/mark-conflict":
      return markThreadFollowConflict(state, action.input);
    case "thread-follows/optimistic-rollback":
      return rollbackOptimisticThreadFollow(
        state,
        action.threadId,
        action.idempotencyKey,
      );
    case "saved-messages/optimistic-begin":
      return beginOptimisticSavedMessage(state, action.input);
    case "saved-messages/optimistic-retry":
      return retryOptimisticSavedMessage(
        state,
        action.messageId,
        action.idempotencyKey,
      );
    case "saved-messages/optimistic-failed":
      return failOptimisticSavedMessage(
        state,
        action.messageId,
        action.idempotencyKey,
        action.failure,
      );
    case "saved-messages/reconcile-current-user":
      return reconcileCurrentUserSavedMessageMutation(
        state,
        action.input,
        action.result,
      );
    case "saved-messages/reconcile-authority":
      return reconcileSavedMessageAuthority(
        state,
        action.messageId,
        action.savedMessageRevision,
        action.savedMessage,
      );
    case "saved-messages/mark-conflict":
      return markSavedMessageConflict(state, action.input);
    case "saved-messages/optimistic-rollback":
      return rollbackOptimisticSavedMessage(
        state,
        action.messageId,
        action.idempotencyKey,
      );
    case "message-reminders/optimistic-begin":
      return beginOptimisticMessageReminder(state, action.input);
    case "message-reminders/optimistic-retry":
      return retryOptimisticMessageReminder(state, action.messageId, action.idempotencyKey);
    case "message-reminders/optimistic-failed":
      return failOptimisticMessageReminder(
        state,
        action.messageId,
        action.idempotencyKey,
        action.failure,
      );
    case "message-reminders/reconcile-current-user":
      return reconcileCurrentUserMessageReminderMutation(state, action.input, action.result);
    case "message-reminders/reconcile-authority":
      return reconcileMessageReminderCanonical(
        state,
        action.conversationId,
        action.messageId,
        action.reminderRevision,
        action.reminder,
      );
    case "message-reminders/mark-conflict":
      return markMessageReminderConflict(state, action.input);
    case "message-reminders/optimistic-rollback":
      return rollbackOptimisticMessageReminder(state, action.messageId, action.idempotencyKey);
    case "ephemeral/apply":
      return applyEphemeral(state, action.event, action.now);
    case "ephemeral/expire": {
      const ephemeral = expireEphemeralSignals(state.ephemeral, action.now);
      return ephemeral === state.ephemeral
        ? state
        : freezeState({ ...state, ephemeral });
    }
    case "ephemeral/clear":
      return state.ephemeral === EMPTY_EPHEMERAL_SIGNAL_STATE
        ? state
        : freezeState({ ...state, ephemeral: EMPTY_EPHEMERAL_SIGNAL_STATE });
    case "huddles/set":
      return setHuddle(state, action.state);
    case "realtime/set-cursor":
      return setRealtimeCursor(state, action.cursor);
    case "realtime/apply-durable":
      return reduceDurableChatEvent(state, action.event).state;
  }
}

export const selectChatCacheIdentity = (
  state: NormalizedChatCacheState,
): ChatCacheIdentity | null => state.identity;

export const selectConversation = (
  state: NormalizedChatCacheState,
  conversationId: ConversationId,
): Conversation | undefined => state.entities.conversations[conversationId];

export const selectMessage = (
  state: NormalizedChatCacheState,
  messageId: MessageId,
): ChatTimelineMessage | undefined => state.entities.messages[messageId];

export const selectAttachmentUpload = (
  state: NormalizedChatCacheState,
  uploadId: string,
): ClientAttachmentUploadState | undefined => state.attachmentUploads[uploadId];

export const selectAttachmentUploadByAttachmentId = (
  state: NormalizedChatCacheState,
  attachmentId: string,
): ClientAttachmentUploadState | undefined =>
  Object.values(state.attachmentUploads).find(
    (upload) => upload.attachment?.attachmentId === attachmentId,
  );

export const selectConversationTimeline = (
  state: NormalizedChatCacheState,
  conversationId: ConversationId,
): ConversationTimelineCacheEntry | undefined => state.timelines[conversationId];

export const selectCurrentUserReadState = (
  state: NormalizedChatCacheState,
  conversationId: ConversationId,
): ConversationReadState | undefined => state.currentUser.readStates[conversationId];

export const selectConversationUnreadMentionCount = (
  state: NormalizedChatCacheState,
  conversationId: ConversationId,
): number | undefined => {
  const count = state.metadata.conversationListUnreadMentionCounts[conversationId];
  if (count === undefined) return undefined;
  const readState = state.currentUser.readStates[conversationId];
  const latestSequence = state.metadata.conversations[conversationId]?.latestSequence;
  return readState !== undefined &&
      latestSequence !== undefined &&
      readState.lastReadSequence >= latestSequence
    ? 0
    : count;
};

export const selectCurrentUserMembership = (
  state: NormalizedChatCacheState,
  conversationId: ConversationId,
): ConversationMember | undefined => state.currentUser.memberships[conversationId];

export const selectCurrentUserPreference = (
  state: NormalizedChatCacheState,
  conversationId: ConversationId,
): ConversationMemberPreference | undefined =>
  state.currentUser.preferences[conversationId];

export const selectCurrentUserPreferenceState = (
  state: NormalizedChatCacheState,
  conversationId: ConversationId,
): CurrentUserConversationPreferenceState => {
  const pending = state.currentUser.pendingPreferenceUpdates[conversationId];
  const preference = state.currentUser.preferences[conversationId];
  return Object.freeze({
    ...(preference === undefined ? {} : { preference }),
    ...((pending?.authoritativePreference ?? preference) === undefined
      ? {}
      : { authoritativePreference: pending?.authoritativePreference ?? preference }),
    authoritativeRevision:
      state.currentUser.preferenceRevisions[conversationId] ?? 0,
    ...(pending === undefined ? {} : { pending }),
  });
};

/** Returns the renderer-facing projection, including the newest explicit intent. */
export const selectCurrentUserThreadFollow = (
  state: NormalizedChatCacheState,
  threadId: ConversationId,
): CanonicalThreadFollowState | undefined =>
  state.currentUser.threadFollows[threadId];

export const selectCurrentUserThreadFollowState = (
  state: NormalizedChatCacheState,
  threadId: ConversationId,
): CurrentUserThreadFollowState => {
  const pending = state.currentUser.pendingThreadFollowUpdates[threadId];
  const follow = state.currentUser.threadFollows[threadId];
  return Object.freeze({
    ...(follow === undefined ? {} : { follow }),
    ...((pending?.authoritativeFollow ?? follow) === undefined
      ? {}
      : { authoritativeFollow: pending?.authoritativeFollow ?? follow }),
    authoritativeRevision:
      state.currentUser.threadFollowRevisions[threadId] ?? 0,
    ...(pending === undefined ? {} : { pending }),
  });
};

/** Undefined means no private canonical or optimistic state has been observed. */
export const selectIsCurrentUserFollowingThread = (
  state: NormalizedChatCacheState,
  threadId: ConversationId,
): boolean | undefined =>
  state.currentUser.threadFollows[threadId]?.isFollowing;

/** Returns the renderer-facing actor-private saved state for one message. */
export const selectCurrentUserSavedMessage = (
  state: NormalizedChatCacheState,
  messageId: MessageId,
): CanonicalActorPrivateSavedMessageState | undefined =>
  state.currentUser.savedMessages[messageId];

export const selectCurrentUserMessageReminder = (
  state: NormalizedChatCacheState,
  messageId: MessageId,
): CanonicalMessageReminder | undefined =>
  state.currentUser.messageReminders[messageId];

export const selectCurrentUserMessageReminderState = (
  state: NormalizedChatCacheState,
  messageId: MessageId,
): CurrentUserMessageReminderState => {
  const pending = state.currentUser.pendingMessageReminderUpdates[messageId];
  const reminder = state.currentUser.messageReminders[messageId];
  const conversationId = state.currentUser.messageReminderConversationIds[messageId];
  return Object.freeze({
    ...(conversationId === undefined ? {} : { conversationId }),
    ...(reminder === undefined ? {} : { reminder }),
    ...((pending?.authoritativeReminder ?? reminder) === undefined
      ? {}
      : { authoritativeReminder: pending?.authoritativeReminder ?? reminder }),
    authoritativeRevision: state.currentUser.messageReminderRevisions[messageId] ?? 0,
    ...(pending === undefined ? {} : { pending }),
  });
};

export const selectCurrentUserMessageReminders = (
  state: NormalizedChatCacheState,
): readonly CurrentUserMessageReminderListItem[] => Object.freeze(
  Object.entries(state.currentUser.messageReminders)
    .filter(([, reminder]) => reminder.state === "scheduled")
    .map(([messageId]) => Object.freeze({
      messageId: messageId as MessageId,
      conversationId: state.currentUser.messageReminderConversationIds[messageId as MessageId] as ConversationId,
      ...selectCurrentUserMessageReminderState(state, messageId as MessageId),
    }))
    .filter((item) => item.conversationId !== undefined)
    .sort((left, right) => {
      const leftDue = left.reminder?.state === "scheduled" ? left.reminder.dueAt : "";
      const rightDue = right.reminder?.state === "scheduled" ? right.reminder.dueAt : "";
      return leftDue.localeCompare(rightDue) || left.messageId.localeCompare(right.messageId);
    }) as CurrentUserMessageReminderListItem[],
);

/** Undefined means this identity has not observed saved state for the message. */
export const selectIsCurrentUserMessageSaved = (
  state: NormalizedChatCacheState,
  messageId: MessageId,
): boolean | undefined => state.currentUser.savedMessages[messageId]?.isSaved;

const selectSavedMessageContentProjection = (
  state: NormalizedChatCacheState,
  messageId: MessageId,
): AvailableCurrentUserSavedMessageProjection |
  UnavailableCurrentUserSavedMessageProjection => {
  const explicitReason =
    state.currentUser.savedMessageUnavailableReasons[messageId];
  if (explicitReason !== undefined) {
    return Object.freeze({ availability: "unavailable", reason: explicitReason });
  }
  const message = state.entities.messages[messageId];
  if (message === undefined) {
    return Object.freeze({ availability: "unavailable", reason: "inaccessible" });
  }
  if (message.content === null) {
    return Object.freeze({ availability: "unavailable", reason: "deleted" });
  }
  const conversation = state.entities.conversations[message.conversationId];
  if (
    conversation === undefined ||
    conversation.archivedAt !== undefined ||
    (conversation.visibility === "private" &&
      state.currentUser.memberships[conversation.id]?.state !== "active")
  ) {
    return Object.freeze({ availability: "unavailable", reason: "inaccessible" });
  }
  return Object.freeze({ availability: "available", current: message });
};

export const selectCurrentUserSavedMessageState = (
  state: NormalizedChatCacheState,
  messageId: MessageId,
): CurrentUserSavedMessageState => {
  const pending = state.currentUser.pendingSavedMessageUpdates[messageId];
  const savedMessage = state.currentUser.savedMessages[messageId];
  const authoritativeSavedMessage =
    pending?.authoritativeSavedMessage ?? savedMessage;
  return Object.freeze({
    ...(savedMessage === undefined ? {} : { savedMessage }),
    ...(authoritativeSavedMessage === undefined
      ? {}
      : { authoritativeSavedMessage }),
    authoritativeRevision:
      state.currentUser.savedMessageRevisions[messageId] ?? 0,
    ...(pending === undefined ? {} : { pending }),
    ...(savedMessage?.isSaved === true
      ? { message: selectSavedMessageContentProjection(state, messageId) }
      : {}),
  });
};

/** Lists projected saved items without fabricating content for absent/inaccessible rows. */
export const selectCurrentUserSavedMessages = (
  state: NormalizedChatCacheState,
): readonly CurrentUserSavedMessageListItem[] => Object.freeze(
  Object.values(state.currentUser.savedMessages)
    .filter((savedMessage) => savedMessage.isSaved)
    .map((savedMessage) => Object.freeze({
      messageId: savedMessage.messageId,
      ...selectCurrentUserSavedMessageState(state, savedMessage.messageId),
    })),
);

export const selectHuddleState = (
  state: NormalizedChatCacheState,
  conversationId: ConversationId,
): HuddleSessionState | undefined => state.huddles[conversationId];

export interface ConversationTypingState {
  readonly conversationId: ConversationId;
  readonly userId: UserId;
  readonly sentAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
}

export interface CurrentUserPresenceState {
  readonly userId: UserId;
  readonly state: "online" | "away" | "offline";
  readonly sentAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
}

/**
 * Returns canonical typing state only for a conversation the current cache
 * identity is an active member of. Tenant-wide and unrelated signal maps are
 * intentionally not part of the public selector contract.
 */
export const selectTypingSignals = (
  state: NormalizedChatCacheState,
  conversationId: ConversationId,
): readonly ConversationTypingState[] => {
  const identity = state.identity;
  const conversation = state.entities.conversations[conversationId];
  const membership = state.currentUser.memberships[conversationId];
  if (
    identity === null ||
    conversation === undefined ||
    conversation.tenantId !== identity.tenantId ||
    membership?.state !== "active" ||
    membership.userId !== identity.userId
  ) {
    return Object.freeze([]);
  }

  // The cache expires signals and retains the latest contribution per session.
  // A stopped session must not suppress another session's live start.
  const latestByUser = new Map<UserId, TypingSignalEvent>();
  for (const event of Object.values(state.ephemeral.typing)) {
    if (
      event.tenantId !== identity.tenantId ||
      event.payload.scope.conversationId !== conversationId ||
      event.payload.scope.visibility !== conversation.visibility ||
      event.payload.state !== "start"
    ) {
      continue;
    }
    const previous = latestByUser.get(event.payload.actorUserId);
    if (
      previous === undefined ||
      Date.parse(event.payload.sentAt) >= Date.parse(previous.payload.sentAt)
    ) {
      latestByUser.set(event.payload.actorUserId, event);
    }
  }

  return Object.freeze(
    [...latestByUser.values()]
      .sort((left, right) =>
        left.payload.actorUserId.localeCompare(right.payload.actorUserId),
      )
      .map((event) =>
        Object.freeze({
          conversationId,
          userId: event.payload.actorUserId,
          sentAt: event.payload.sentAt,
          expiresAt: event.payload.expiresAt,
        }),
      ),
  );
};

/** Presence delivered on the current user's private stream, aggregated by actor. */
export const selectPresenceSignals = (
  state: NormalizedChatCacheState,
): readonly CurrentUserPresenceState[] => {
  const identity = state.identity;
  if (identity === null) return Object.freeze([]);
  const latestByUser = new Map<UserId, PresenceSignalEvent>();
  for (const event of Object.values(state.ephemeral.presence)) {
    if (
      event.tenantId !== identity.tenantId ||
      event.payload.scope.userId !== identity.userId
    ) {
      continue;
    }
    const previous = latestByUser.get(event.payload.actorUserId);
    if (
      previous === undefined ||
      Date.parse(event.payload.sentAt) >= Date.parse(previous.payload.sentAt)
    ) {
      latestByUser.set(event.payload.actorUserId, event);
    }
  }
  return Object.freeze(
    [...latestByUser.values()]
      .sort((left, right) =>
        left.payload.actorUserId.localeCompare(right.payload.actorUserId),
      )
      .map((event) =>
        Object.freeze({
          userId: event.payload.actorUserId,
          state: event.payload.state,
          sentAt: event.payload.sentAt,
          expiresAt: event.payload.expiresAt,
        }),
      ),
  );
};

/** A memoized selector suitable for subscriptions and external-store adapters. */
export function createConversationMessagesSelector(
  conversationId: ConversationId,
): ChatCacheSelector<readonly ChatTimelineMessage[]> {
  let previousIds: readonly MessageId[] | undefined;
  let previousMessages: readonly ChatTimelineMessage[] = EMPTY_MESSAGES;

  return (state) => {
    const ids = state.timelines[conversationId]?.messageIds;
    if (ids === undefined || ids.length === 0) {
      previousIds = ids;
      previousMessages = EMPTY_MESSAGES;
      return EMPTY_MESSAGES;
    }

    if (
      ids === previousIds &&
      previousMessages.every(
        (message, index) => state.entities.messages[ids[index] as MessageId] === message,
      )
    ) {
      return previousMessages;
    }

    const messages = ids.flatMap((id) => {
      const message = state.entities.messages[id];
      return message === undefined ? [] : [message];
    });
    if (
      messages.length === previousMessages.length &&
      messages.every((message, index) => message === previousMessages[index])
    ) {
      previousIds = ids;
      return previousMessages;
    }

    previousIds = ids;
    previousMessages = Object.freeze(messages);
    return previousMessages;
  };
}

export function conversationSnapshotScopeKey(
  scope: ConversationSnapshotScope,
): string {
  return scope.type === "organization"
    ? "organization"
    : JSON.stringify(["entity", scope.entity.type, scope.entity.id]);
}

function beginConversationOperation(
  state: NormalizedChatCacheState,
  operation: PendingConversationOperation,
): NormalizedChatCacheState {
  if (
    operation.logicalKey.trim().length === 0 ||
    operation.idempotencyKey.trim().length === 0 ||
    (operation.conversationId !== undefined &&
      operation.conversationId.trim().length === 0) ||
    (operation.clientRequestId !== undefined &&
      operation.clientRequestId.trim().length === 0)
  ) {
    throw new ChatCacheError(
      "conversation_mismatch",
      "pending conversation operation correlation is invalid",
    );
  }
  const existing = state.metadata.pendingConversationOperations[operation.logicalKey];
  if (existing !== undefined) {
    if (!valueEqual(existing, operation)) {
      throw new ChatCacheError(
        "conversation_mismatch",
        "a logical conversation operation already has different correlation",
      );
    }
    return state;
  }
  return freezeState({
    ...state,
    metadata: Object.freeze({
      ...state.metadata,
      pendingConversationOperations: freezeRecord({
        ...state.metadata.pendingConversationOperations,
        [operation.logicalKey]: Object.freeze({ ...operation }),
      }),
    }),
  });
}

function settleConversationOperation(
  state: NormalizedChatCacheState,
  logicalKey: string,
): NormalizedChatCacheState {
  if (state.metadata.pendingConversationOperations[logicalKey] === undefined) {
    return state;
  }
  const pendingConversationOperations = {
    ...state.metadata.pendingConversationOperations,
  };
  delete pendingConversationOperations[logicalKey];
  return freezeState({
    ...state,
    metadata: Object.freeze({
      ...state.metadata,
      pendingConversationOperations: freezeRecord(pendingConversationOperations),
    }),
  });
}

function reconcileConversationCreation(
  state: NormalizedChatCacheState,
  logicalKey: string,
  input: ConversationCreationInput,
  value: ConversationCreationResult,
): NormalizedChatCacheState {
  const result = parseConversationCreationResult(value, input);
  const hydrated = hydrateConversationDetail(
    state,
    result.conversation as ConversationDetailSnapshot,
  );
  return settleConversationOperation(hydrated, logicalKey);
}

/** Forget source/history content without touching drafts or participation authority. */
function forgetCachedMessages(
  state: NormalizedChatCacheState,
  ids: ReadonlySet<MessageId>,
): NormalizedChatCacheState {
  const messages = { ...state.entities.messages };
  const timelines = { ...state.timelines };
  for (const id of ids) delete messages[id];
  for (const [id, timeline] of Object.entries(timelines)) {
    if (timeline.messageIds.some((messageId) => ids.has(messageId))) {
      timelines[id as ConversationId] = Object.freeze({
        ...timeline, messageIds: Object.freeze(timeline.messageIds.filter((messageId) => !ids.has(messageId))),
      });
    }
  }
  return freezeState({
    ...state,
    entities: Object.freeze({ ...state.entities, messages: freezeRecord(messages) }),
    timelines: freezeRecord(timelines),
  });
}

function reconcileThreadOpening(
  state: NormalizedChatCacheState,
  input: ThreadCreationInput,
  value: ThreadCreationResult,
  page: MessageTimelinePage,
): NormalizedChatCacheState {
  const result = parseThreadCreationResult(value, input);
  const root = state.entities.messages[result.rootMessageId];
  const threadId = result.conversation.conversation.id;
  if (
    root === undefined ||
    root.conversationId !== result.parentConversationId ||
    result.rootThreadSummary.threadId !== threadId ||
    page.conversationId !== threadId
  ) {
    throw new ChatCacheError(
      "conversation_mismatch",
      "canonical thread opening does not match the root message and timeline",
    );
  }

  const withDetail = hydrateConversationDetail(
    state,
    result.conversation as ConversationDetailSnapshot,
  );
  const withTimeline = hydrateMessageTimeline(withDetail, page);
  const currentRoot = withTimeline.entities.messages[result.rootMessageId];
  if (currentRoot === undefined) {
    throw new ChatCacheError(
      "conversation_mismatch",
      "canonical thread root is unavailable",
    );
  }
  const reconciledRoot: MessageTimelineMessage = Object.freeze({
    ...currentRoot,
    isThreadRoot: true as const,
    threadSummary: result.rootThreadSummary,
  });
  if (valueEqual(currentRoot, reconciledRoot)) return withTimeline;
  return freezeState({
    ...withTimeline,
    entities: Object.freeze({
      ...withTimeline.entities,
      messages: freezeRecord({
        ...withTimeline.entities.messages,
        [result.rootMessageId]: reconciledRoot,
      } as Record<MessageId, ChatTimelineMessage>),
    }),
  });
}

function reconcileConversationArchive(
  state: NormalizedChatCacheState,
  logicalKey: string,
  input: ConversationArchiveInput,
  value: ConversationArchiveResult,
): NormalizedChatCacheState {
  const result = parseConversationArchiveResult(value, input);
  const currentRevision = state.metadata.lifecycleRevisions[result.conversationId];
  let next = state;
  if (currentRevision === undefined || result.lifecycleRevision >= currentRevision) {
    const lifecycleRevisions: ChatCacheMetadata["lifecycleRevisions"] = freezeRecord({
      ...state.metadata.lifecycleRevisions,
      [result.conversationId]: result.lifecycleRevision,
    } as Record<ConversationId, number>);
    const existing = state.entities.conversations[result.conversationId];
    if (
      result.reconciliationStatus !== "lifecycle_conflict" &&
      existing === undefined
    ) {
      throw new ChatCacheError(
        "conversation_mismatch",
        "canonical archive state requires a known conversation",
      );
    }
    let conversations = state.entities.conversations;
    if (
      result.reconciliationStatus !== "lifecycle_conflict" &&
      existing !== undefined
    ) {
      if (result.archiveState.status === "archived") {
        conversations = freezeRecord({
          ...conversations,
          [result.conversationId]: Object.freeze({
            ...existing,
            archivedAt: result.archiveState.archivedAt,
            archivedByUserId: result.archiveState.archivedByUserId,
            updatedAt:
              compareIsoTimestamp(result.archiveState.archivedAt, existing.updatedAt) > 0
                ? result.archiveState.archivedAt
                : existing.updatedAt,
          }) as Conversation,
        });
      } else {
        const {
          archivedAt: _archivedAt,
          archivedByUserId: _archivedByUserId,
          ...active
        } = existing;
        conversations = freezeRecord({
          ...conversations,
          [result.conversationId]: Object.freeze(active) as Conversation,
        });
      }
    }
    next = freezeState({
      ...state,
      entities:
        conversations === state.entities.conversations
          ? state.entities
          : Object.freeze({ ...state.entities, conversations }),
      metadata: Object.freeze({ ...state.metadata, lifecycleRevisions }),
    });
  }
  return settleConversationOperation(next, logicalKey);
}

function reconcileConversationMembership(
  state: NormalizedChatCacheState,
  logicalKey: string,
  input: ConversationMembershipMutationInput,
  value: ConversationMembershipMutationResult,
): NormalizedChatCacheState {
  const result = parseConversationMembershipMutationResult(value, input);
  if (
    result.reconciliationStatus === "member_list_conflict" ||
    result.reconciliationStatus === "safety_rejected"
  ) {
    return settleConversationOperation(state, logicalKey);
  }
  const identity = requireIdentity(state);
  if (state.entities.conversations[result.conversationId] === undefined) {
    throw new ChatCacheError(
      "conversation_mismatch",
      "canonical membership requires a known conversation",
    );
  }
  const knownRevision =
    state.metadata.memberListRevisions[result.conversationId];
  if (
    knownRevision !== undefined &&
    result.memberListRevision < knownRevision
  ) {
    return settleConversationOperation(state, logicalKey);
  }
  const members = freezeRecord(Object.fromEntries(result.members.map((member) => [
    member.userId,
    Object.freeze({
      ...member,
      tenantId: identity.tenantId,
      conversationId: result.conversationId,
    }),
  ])) as Record<UserId, ConversationMember>);
  const activeIds: readonly UserId[] = Object.freeze(
    result.members
      .filter((member) => member.state === "active")
      .map((member) => member.userId),
  );
  const existingMembers =
    state.entities.membersByConversation[result.conversationId];
  if (
    knownRevision === result.memberListRevision &&
    existingMembers !== undefined &&
    !valueEqual(existingMembers, members)
  ) {
    throw new ChatCacheError(
      "conversation_mismatch",
      "the same member-list revision cannot carry different canonical members",
    );
  }
  const memberships = { ...state.currentUser.memberships };
  const current = members[identity.userId];
  if (current === undefined) delete memberships[result.conversationId];
  else memberships[result.conversationId] = current;
  const next = freezeState({
    ...state,
    entities: Object.freeze({
      ...state.entities,
      memberUserIdsByConversation: freezeRecord({
        ...state.entities.memberUserIdsByConversation,
        [result.conversationId]: activeIds,
      } as Record<ConversationId, readonly UserId[]>),
      membersByConversation: freezeRecord({
        ...state.entities.membersByConversation,
        [result.conversationId]: members,
      } as Record<ConversationId, Readonly<Record<UserId, ConversationMember>>>),
    }),
    currentUser: Object.freeze({
      ...state.currentUser,
      memberships: freezeRecord(memberships),
    }),
    metadata: Object.freeze({
      ...state.metadata,
      memberListRevisions: freezeRecord({
        ...state.metadata.memberListRevisions,
        [result.conversationId]: result.memberListRevision,
      } as Record<ConversationId, number>),
    }),
  });
  return settleConversationOperation(next, logicalKey);
}

function hydrateConversationList(
  state: NormalizedChatCacheState,
  snapshot: ConversationListSnapshot,
  requestCursor: ConversationSnapshotCursor | undefined,
): NormalizedChatCacheState {
  const identity = requireIdentity(state);
  const normalized = normalizeConversationSummaries(state, snapshot.items, identity);
  const scopeKey = conversationSnapshotScopeKey(snapshot.scope);
  const existingList = state.metadata.conversationLists[scopeKey];
  const page: ConversationListCachePage = Object.freeze({
    conversationIds: Object.freeze(snapshot.items.map((item) => item.id)),
    ...(snapshot.page.nextCursor === undefined
      ? {}
      : { nextCursor: snapshot.page.nextCursor }),
    snapshot: snapshot._meta,
  });
  const pageKey = conversationListPageKey(requestCursor);
  const pages = freezeRecord({
    ...(existingList?.pages ?? {}),
    [pageKey]: page,
  });
  const linked = linkConversationListPages(pages);
  const list: ConversationListCacheEntry = Object.freeze({
    conversationIds: linked.conversationIds,
    ...(linked.nextCursor === undefined ? {} : { nextCursor: linked.nextCursor }),
    snapshot: snapshot._meta,
    pages,
  });

  const conversationLists = valueEqual(existingList, list)
    ? state.metadata.conversationLists
    : freezeRecord({ ...state.metadata.conversationLists, [scopeKey]: list });
  let conversationListParticipantUserIds =
    state.metadata.conversationListParticipantUserIds;
  let conversationListActiveHuddles =
    state.metadata.conversationListActiveHuddles;
  let conversationListUnreadMentionCounts =
    state.metadata.conversationListUnreadMentionCounts;
  let nextConversationListParticipantUserIds:
    | Record<ConversationId, readonly UserId[]>
    | undefined;
  let nextConversationListActiveHuddles:
    | Record<ConversationId, boolean>
    | undefined;
  let nextConversationListUnreadMentionCounts:
    | Record<ConversationId, number>
    | undefined;
  for (const item of snapshot.items) {
    const existingConversation = state.entities.conversations[item.id];
    if (conversationListActiveHuddles[item.id] !== item.hasActiveHuddle) {
      nextConversationListActiveHuddles ??= {
        ...conversationListActiveHuddles,
      };
      nextConversationListActiveHuddles[item.id] = item.hasActiveHuddle;
    }
    const existingParticipantUserIds = conversationListParticipantUserIds[item.id];
    if (
      !valueEqual(existingParticipantUserIds, item.activeMemberUserIds) &&
      (existingConversation === undefined ||
        compareIsoTimestamp(item.updatedAt, existingConversation.updatedAt) >= 0)
    ) {
      nextConversationListParticipantUserIds ??= {
        ...conversationListParticipantUserIds,
      };
      nextConversationListParticipantUserIds[item.id] = Object.freeze([
        ...item.activeMemberUserIds,
      ]);
    }
    const existingMetadata = state.metadata.conversations[item.id];
    const currentMetadata = normalized.metadata[item.id];
    const currentReadState = normalized.readStates[item.id];
    const existingMentionCount = conversationListUnreadMentionCounts[item.id];
    const unreadMentionCount = currentReadState !== undefined &&
        currentMetadata !== undefined &&
        currentReadState.lastReadSequence >= currentMetadata.latestSequence
      ? 0
      : existingMetadata !== undefined &&
          item.latestSequence < existingMetadata.latestSequence &&
          existingMentionCount !== undefined
        ? existingMentionCount
        : item.unreadMentionCount;
    if (existingMentionCount !== unreadMentionCount) {
      nextConversationListUnreadMentionCounts ??= {
        ...conversationListUnreadMentionCounts,
      };
      nextConversationListUnreadMentionCounts[item.id] = unreadMentionCount;
    }
  }
  if (nextConversationListActiveHuddles !== undefined) {
    conversationListActiveHuddles = freezeRecord(
      nextConversationListActiveHuddles,
    );
  }
  if (nextConversationListParticipantUserIds !== undefined) {
    conversationListParticipantUserIds = freezeRecord(
      nextConversationListParticipantUserIds,
    );
  }
  if (nextConversationListUnreadMentionCounts !== undefined) {
    conversationListUnreadMentionCounts = freezeRecord(
      nextConversationListUnreadMentionCounts,
    );
  }

  if (
    normalized.conversations === state.entities.conversations &&
    normalized.metadata === state.metadata.conversations &&
    normalized.memberships === state.currentUser.memberships &&
    normalized.readStates === state.currentUser.readStates &&
    normalized.preferences === state.currentUser.preferences &&
    normalized.preferenceRevisions === state.currentUser.preferenceRevisions &&
    normalized.pendingPreferenceUpdates ===
      state.currentUser.pendingPreferenceUpdates &&
    conversationLists === state.metadata.conversationLists &&
    conversationListActiveHuddles ===
      state.metadata.conversationListActiveHuddles &&
    conversationListParticipantUserIds ===
      state.metadata.conversationListParticipantUserIds &&
    conversationListUnreadMentionCounts ===
      state.metadata.conversationListUnreadMentionCounts
  ) {
    return state;
  }

  return freezeState({
    ...state,
    entities: Object.freeze({
      ...state.entities,
      conversations: normalized.conversations,
    }),
    currentUser: Object.freeze({
      ...state.currentUser,
      memberships: normalized.memberships,
      readStates: normalized.readStates,
      preferences: normalized.preferences,
      preferenceRevisions: normalized.preferenceRevisions,
      pendingPreferenceUpdates: normalized.pendingPreferenceUpdates,
    }),
    metadata: Object.freeze({
      ...state.metadata,
      conversations: normalized.metadata,
      conversationLists,
      conversationListActiveHuddles,
      conversationListParticipantUserIds,
      conversationListUnreadMentionCounts,
    }),
  });
}

function hydrateConversationDetail(
  state: NormalizedChatCacheState,
  snapshot: ConversationDetailSnapshot,
): NormalizedChatCacheState {
  const hydrated = hydrateConversationDetailBase(state, snapshot);
  const authority = snapshot.conversation.currentThreadFollow;
  if (authority === undefined) return hydrated;
  const threadId = snapshot.conversation.id;
  if (authority.follow !== null) {
    return reconcileThreadFollowCanonical(hydrated, threadId, authority.followRevision, authority.follow);
  }
  if (hydrated.currentUser.threadFollowRevisions[threadId] !== undefined) return hydrated;
  return freezeState({
    ...hydrated,
    currentUser: Object.freeze({
      ...hydrated.currentUser,
      threadFollowRevisions: freezeRecord<number>({ ...hydrated.currentUser.threadFollowRevisions, [threadId]: 0 }),
    }),
  });
}

function hydrateConversationDetailBase(
  state: NormalizedChatCacheState,
  snapshot: ConversationDetailSnapshot,
): NormalizedChatCacheState {
  const identity = requireIdentity(state);
  const item = snapshot.conversation;
  const previousConversation = state.entities.conversations[item.id];
  const previousMetadata = state.metadata.conversations[item.id];
  const snapshotIsNewer =
    previousConversation === undefined ||
    previousMetadata === undefined ||
    item.latestSequence > previousMetadata.latestSequence ||
    (item.latestSequence === previousMetadata.latestSequence &&
      compareIsoTimestamp(item.updatedAt, previousConversation.updatedAt) > 0);
  const normalized = normalizeConversationSummaries(state, [item], identity);

  const existingMentionCount = state.metadata.conversationListUnreadMentionCounts[item.id];
  const read = normalized.readStates[item.id];
  const latest = normalized.metadata[item.id]?.latestSequence;
  const mentionCount = read !== undefined && latest !== undefined &&
      read.lastReadSequence >= latest
    ? 0
    : previousMetadata !== undefined && item.latestSequence < previousMetadata.latestSequence
      ? existingMentionCount
      : item.unreadMentionCount;
  const conversationListUnreadMentionCounts = mentionCount === undefined ||
      mentionCount === existingMentionCount
    ? state.metadata.conversationListUnreadMentionCounts
    : freezeRecord<number>({ ...state.metadata.conversationListUnreadMentionCounts, [item.id]: mentionCount });

  const existingMembers = state.entities.memberUserIdsByConversation[item.id];
  const memberIds: readonly UserId[] =
    existingMembers !== undefined &&
    (!snapshotIsNewer || valueEqual(existingMembers, item.memberUserIds))
    ? existingMembers
    : Object.freeze([...item.memberUserIds]);
  const memberUserIdsByConversation: ChatCacheEntities["memberUserIdsByConversation"] =
    memberIds === existingMembers
      ? state.entities.memberUserIdsByConversation
      : freezeRecord({
          ...state.entities.memberUserIdsByConversation,
          [item.id]: memberIds,
        });
  const existingMemberListRevision = state.metadata.memberListRevisions[item.id];
  const memberListRevisions: ChatCacheMetadata["memberListRevisions"] =
    item.memberListRevision === undefined ||
      (existingMemberListRevision !== undefined &&
        existingMemberListRevision >= item.memberListRevision)
      ? state.metadata.memberListRevisions
      : freezeRecord({
          ...state.metadata.memberListRevisions,
          [item.id]: item.memberListRevision,
        });
  const existingDetail = state.metadata.conversationDetails[item.id];
  const conversationDetails: ChatCacheMetadata["conversationDetails"] =
    existingDetail !== undefined &&
    (!snapshotIsNewer || valueEqual(existingDetail, snapshot._meta))
    ? state.metadata.conversationDetails
    : freezeRecord({
        ...state.metadata.conversationDetails,
        [item.id]: snapshot._meta,
      });

  if (
    normalized.conversations === state.entities.conversations &&
    normalized.metadata === state.metadata.conversations &&
    normalized.memberships === state.currentUser.memberships &&
    normalized.readStates === state.currentUser.readStates &&
    memberUserIdsByConversation === state.entities.memberUserIdsByConversation &&
    normalized.preferences === state.currentUser.preferences &&
    normalized.preferenceRevisions === state.currentUser.preferenceRevisions &&
    normalized.pendingPreferenceUpdates ===
      state.currentUser.pendingPreferenceUpdates &&
    conversationDetails === state.metadata.conversationDetails &&
    conversationListUnreadMentionCounts === state.metadata.conversationListUnreadMentionCounts &&
    memberListRevisions === state.metadata.memberListRevisions
  ) {
    return state;
  }

  return freezeState({
    ...state,
    entities: Object.freeze({
      ...state.entities,
      conversations: normalized.conversations,
      memberUserIdsByConversation,
    }),
    currentUser: Object.freeze({
      ...state.currentUser,
      memberships: normalized.memberships,
      readStates: normalized.readStates,
      preferences: normalized.preferences,
      preferenceRevisions: normalized.preferenceRevisions,
      pendingPreferenceUpdates: normalized.pendingPreferenceUpdates,
    }),
    metadata: Object.freeze({
      ...state.metadata,
      conversations: normalized.metadata,
      conversationDetails,
      conversationListUnreadMentionCounts,
      memberListRevisions,
    }),
  });
}

function hydrateConversationDraftSnapshot(
  state: NormalizedChatCacheState,
  snapshot: ConversationDraftSnapshot,
): NormalizedChatCacheState {
  requireIdentity(state);
  const conversationId = snapshot.conversationId;
  const knownRevision = state.currentUser.draftRevisions[conversationId] ?? 0;
  if (snapshot.canonicalRevision < knownRevision) return state;

  const incoming: CanonicalDraftState | undefined = snapshot.state === "present"
    ? freezeDraftState({
        kind: "replaced",
        content: snapshot.content.value,
      })
    : snapshot.canonicalRevision === 0
      ? undefined
      : Object.freeze({ kind: "clear_tombstone" as const, content: null });
  const existing = state.currentUser.drafts[conversationId];
  if (
    snapshot.canonicalRevision === knownRevision &&
    !valueEqual(existing, incoming)
  ) {
    throw new ChatCacheError(
      "message_conflict",
      "one draft revision carried conflicting canonical state",
    );
  }
  if (
    snapshot.canonicalRevision === knownRevision &&
    valueEqual(existing, incoming)
  ) return state;

  const drafts = { ...state.currentUser.drafts };
  if (incoming === undefined) delete drafts[conversationId];
  else drafts[conversationId] = incoming;
  const draftRevisions = { ...state.currentUser.draftRevisions };
  if (snapshot.canonicalRevision === 0) delete draftRevisions[conversationId];
  else draftRevisions[conversationId] = snapshot.canonicalRevision;
  return freezeState({
    ...state,
    currentUser: Object.freeze({
      ...state.currentUser,
      drafts: freezeRecord(drafts),
      draftRevisions: freezeRecord(draftRevisions),
    }),
  });
}

function projectConversationDraft(
  state: NormalizedChatCacheState,
  conversationId: ConversationId,
  draft: CanonicalDraftState,
): NormalizedChatCacheState {
  requireIdentity(state);
  const projected = freezeDraftState(draft);
  if (valueEqual(state.currentUser.drafts[conversationId], projected)) return state;
  return freezeState({
    ...state,
    currentUser: Object.freeze({
      ...state.currentUser,
      drafts: freezeRecord<CanonicalDraftState>({
        ...state.currentUser.drafts,
        [conversationId]: projected,
      }),
      draftRevisions: freezeRecord<number>({
        ...state.currentUser.draftRevisions,
        [conversationId]: state.currentUser.draftRevisions[conversationId] ?? 0,
      }),
    }),
  });
}

function reconcileConversationDraft(
  state: NormalizedChatCacheState,
  conversationId: ConversationId,
  canonicalRevision: number,
  draft: CanonicalDraftState | undefined,
  preserveProjection: boolean,
): NormalizedChatCacheState {
  requireIdentity(state);
  if (!Number.isSafeInteger(canonicalRevision) || canonicalRevision < 0) {
    throw new ChatCacheError("message_conflict", "draft revision is invalid");
  }
  const knownRevision = state.currentUser.draftRevisions[conversationId] ?? 0;
  if (canonicalRevision < knownRevision) return state;
  const canonical = draft === undefined ? undefined : freezeDraftState(draft);
  const drafts = { ...state.currentUser.drafts };
  if (!preserveProjection) {
    if (canonical === undefined) delete drafts[conversationId];
    else drafts[conversationId] = canonical;
  }
  const draftRevisions = { ...state.currentUser.draftRevisions };
  if (canonicalRevision === 0 && !preserveProjection) {
    delete draftRevisions[conversationId];
  } else {
    draftRevisions[conversationId] = canonicalRevision;
  }
  if (
    valueEqual(state.currentUser.drafts, drafts) &&
    valueEqual(state.currentUser.draftRevisions, draftRevisions)
  ) return state;
  return freezeState({
    ...state,
    currentUser: Object.freeze({
      ...state.currentUser,
      drafts: freezeRecord(drafts),
      draftRevisions: freezeRecord(draftRevisions),
    }),
  });
}

function freezeDraftState(draft: CanonicalDraftState): CanonicalDraftState {
  if (draft.kind === "clear_tombstone" && draft.content === null) {
    return Object.freeze({ kind: "clear_tombstone", content: null });
  }
  if (
    draft.kind !== "replaced" ||
    draft.content === null ||
    (draft.content.format !== "plain" && draft.content.format !== "markdown") ||
    typeof draft.content.text !== "string" ||
    !Array.isArray(draft.content.attachments)
  ) {
    throw new ChatCacheError("message_conflict", "draft projection is invalid");
  }
  return Object.freeze({
    kind: "replaced",
    content: Object.freeze({
      format: draft.content.format,
      text: draft.content.text,
      ...(draft.content.replyTo === undefined
        ? {}
        : { replyTo: Object.freeze({ ...draft.content.replyTo }) }),
      ...(draft.content.mentions === undefined
        ? {}
        : {
            mentions: Object.freeze(
              draft.content.mentions.map(freezeDraftMention),
            ),
          }),
      attachments: Object.freeze(
        draft.content.attachments.map((attachment) =>
          Object.freeze({ attachmentId: attachment.attachmentId })),
      ),
    }),
  });
}

function freezeDraftMention(mention: MessageMention): MessageMention {
  switch (mention.type) {
    case "user":
      return Object.freeze({ type: "user", userId: mention.userId });
    case "conversation":
      return Object.freeze({
        type: "conversation",
        conversationId: mention.conversationId,
      });
    case "entity":
      return Object.freeze({
        type: "entity",
        entity: Object.freeze({
          type: mention.entity.type,
          id: mention.entity.id,
        }),
      });
  }
}

function hydrateSavedMessageListSnapshot(
  state: NormalizedChatCacheState,
  snapshot: SavedMessageListSnapshot,
): NormalizedChatCacheState {
  requireIdentity(state);
  let next = state;
  for (const entry of snapshot.items) {
    next = hydrateSavedMessageSnapshotEntry(next, entry);
  }
  return next;
}

function hydrateMessageReminderListSnapshot(
  state: NormalizedChatCacheState,
  snapshot: MessageReminderListSnapshot,
): NormalizedChatCacheState {
  requireIdentity(state);
  let next = state;
  for (const entry of snapshot.items) {
    next = hydrateMessageReminderSnapshotEntry(next, entry);
  }
  return next;
}

function hydrateMessageReminderSnapshotEntry(
  state: NormalizedChatCacheState,
  entry: MessageReminderSnapshotEntry,
): NormalizedChatCacheState {
  const knownRevision = state.currentUser.messageReminderRevisions[entry.messageId] ?? 0;
  if (entry.reminderRevision < knownRevision) return state;
  return reconcileMessageReminderCanonical(
    state,
    entry.conversationId,
    entry.messageId,
    entry.reminderRevision,
    entry.reminder,
  );
}

function hydrateSavedMessageSnapshotEntry(
  state: NormalizedChatCacheState,
  entry: SavedMessageSnapshotEntry,
): NormalizedChatCacheState {
  const identity = requireIdentity(state);
  const knownRevision = state.currentUser.savedMessageRevisions[entry.messageId] ?? 0;
  if (entry.savedMessageRevision < knownRevision) return state;

  let next = state;
  if (entry.message.availability === "available") {
    if (next.currentUser.savedMessageUnavailableReasons[entry.messageId] !== undefined) {
      const unavailableReasons = {
        ...next.currentUser.savedMessageUnavailableReasons,
      };
      delete unavailableReasons[entry.messageId];
      next = freezeState({
        ...next,
        currentUser: Object.freeze({
          ...next.currentUser,
          savedMessageUnavailableReasons: freezeRecord(unavailableReasons),
        }),
      });
    }
  }

  next = reconcileSavedMessageEvent(next, {
    operation: "set_saved_message",
    messageId: entry.messageId,
    savedMessageRevision: entry.savedMessageRevision,
    savedMessage: {
      messageId: entry.messageId,
      isSaved: true,
      ...(entry.message.availability === "available" && entry.privateNote !== undefined
        ? { privateNote: entry.privateNote.text }
        : {}),
    },
  });

  if (entry.message.availability === "unavailable") {
    const messages: Record<MessageId, ChatTimelineMessage> = {
      ...next.entities.messages,
    };
    delete messages[entry.messageId];
    const savedMessages = { ...next.currentUser.savedMessages };
    const pending = next.currentUser.pendingSavedMessageUpdates[entry.messageId];
    if (pending === undefined) {
      savedMessages[entry.messageId] = Object.freeze({
        messageId: entry.messageId,
        isSaved: true,
      });
    }
    return freezeState({
      ...next,
      entities: Object.freeze({
        ...next.entities,
        messages: freezeRecord(messages),
      }),
      currentUser: Object.freeze({
        ...next.currentUser,
        savedMessages: freezeRecord(savedMessages),
        savedMessageUnavailableReasons: freezeRecord<SavedMessageUnavailableReason>({
          ...next.currentUser.savedMessageUnavailableReasons,
          [entry.messageId]: entry.message.reason,
        }),
      }),
    });
  }

  const current = entry.message.current;
  const existing = next.entities.messages[entry.messageId];
  if (
    existing !== undefined &&
    (existing.tenantId !== identity.tenantId ||
      existing.conversationId !== current.conversationId ||
      existing.sequence !== current.sequence)
  ) {
    throw new ChatCacheError(
      "message_conflict",
      "saved-message identity, tenant, conversation, and sequence are immutable",
    );
  }
  if (existing !== undefined && existing.revision.revision >= current.revision.revision) {
    return next;
  }

  const hydrated: ChatTimelineMessage = Object.freeze({
    ...current,
    tenantId: identity.tenantId,
    reactions: existing?.reactions ?? Object.freeze([]),
    attachmentMetadata: Object.freeze([...current.attachmentMetadata]),
    ...(existing?.isThreadRoot === true
      ? { isThreadRoot: true as const, threadSummary: existing.threadSummary }
      : { isThreadRoot: false as const }),
  });
  const attachments = { ...next.entities.attachments };
  for (const metadata of current.attachmentMetadata) {
    attachments[metadata.attachmentId] = metadata;
  }
  return freezeState({
    ...next,
    entities: Object.freeze({
      ...next.entities,
      messages: freezeRecord<ChatTimelineMessage>({
        ...next.entities.messages,
        [entry.messageId]: hydrated,
      }),
      attachments: freezeRecord(attachments),
    }),
  });
}

function hydrateMessageTimeline(
  state: NormalizedChatCacheState,
  page: MessageTimelinePage,
): NormalizedChatCacheState {
  const identity = requireIdentity(state);
  let messages = state.entities.messages;
  let changedMessages: Record<string, MessageTimelineMessage> | undefined;

  for (const incoming of page.messages) {
    if (incoming.tenantId !== identity.tenantId) {
      throw new ChatCacheError("tenant_mismatch", "message tenant does not match cache identity");
    }
    if (incoming.conversationId !== page.conversationId) {
      throw new ChatCacheError(
        "conversation_mismatch",
        "message does not belong to the hydrated timeline",
      );
    }
    const existing = messages[incoming.id];
    if (
      existing !== undefined &&
      (existing.tenantId !== incoming.tenantId ||
        existing.conversationId !== incoming.conversationId ||
        existing.sequence !== incoming.sequence)
    ) {
      throw new ChatCacheError(
        "message_conflict",
        "message identity, tenant, conversation, and sequence are immutable",
      );
    }
    if (existing !== undefined && existing.revision.revision >= incoming.revision.revision) {
      continue;
    }
    if (valueEqual(existing, incoming)) {
      continue;
    }
    changedMessages ??= { ...messages };
    changedMessages[incoming.id] = incoming;
  }
  if (changedMessages !== undefined) {
    messages = freezeRecord(changedMessages);
  }

  const existingTimeline = state.timelines[page.conversationId];
  const incomingIds = page.messages.map((message) => message.id);
  const messageIds = sortAndValidateTimelineIds(
    mergeIds(existingTimeline?.messageIds ?? [], incomingIds),
    messages,
    page.conversationId,
  );
  const pagination = mergePagination(existingTimeline, page, messages);
  const timeline: ConversationTimelineCacheEntry = Object.freeze({
    messageIds,
    pagination,
    realtimeCursor:
      state.metadata.realtimeCursor ??
      page.replay.resumeFrom,
  });
  const timelines: NormalizedChatCacheState["timelines"] =
    existingTimeline !== undefined && valueEqual(existingTimeline, timeline)
    ? state.timelines
    : freezeRecord({ ...state.timelines, [page.conversationId]: timeline });

  let conversationMetadata = state.metadata.conversations;
  const known = conversationMetadata[page.conversationId];
  const latestFromPage = page.messages.reduce(
    (latest, message) => Math.max(latest, message.sequence),
    known?.latestSequence ?? 0,
  );
  if (known !== undefined && latestFromPage !== known.latestSequence) {
    conversationMetadata = freezeRecord({
      ...conversationMetadata,
      [page.conversationId]: Object.freeze({
        ...known,
        latestSequence: latestFromPage,
      }),
    });
  }

  if (
    messages === state.entities.messages &&
    timelines === state.timelines &&
    conversationMetadata === state.metadata.conversations
  ) {
    return state;
  }
  return freezeState({
    ...state,
    entities: Object.freeze({ ...state.entities, messages }),
    timelines,
    metadata: Object.freeze({
      ...state.metadata,
      conversations: conversationMetadata,
    }),
  });
}

function isOptimisticMessage(
  message: ChatTimelineMessage | undefined,
): message is OptimisticMessageProjection {
  return message !== undefined && "delivery" in message;
}

function isMessageEditProjection(
  message: ChatTimelineMessage | undefined,
): message is MessageEditProjection {
  return message !== undefined && "editState" in message;
}

function isPendingMessageEdit(
  message: ChatTimelineMessage | undefined,
): message is MessageEditProjection & { readonly editState: PendingMessageEditState } {
  return isMessageEditProjection(message) && message.editState.state === "pending";
}

function isPendingMessageDelete(
  message: ChatTimelineMessage | undefined,
): message is PendingMessageDeleteProjection {
  return message !== undefined && "deleteState" in message;
}

function insertOptimisticMessage(
  state: NormalizedChatCacheState,
  message: OptimisticMessageProjection,
): NormalizedChatCacheState {
  const identity = requireIdentity(state);
  if (message.tenantId !== identity.tenantId) {
    throw new ChatCacheError("tenant_mismatch", "optimistic message tenant does not match cache identity");
  }
  if (
    message.author.userId !== identity.userId ||
    message.delivery.clientMessageId.length === 0 ||
    message.delivery.idempotencyKey.length === 0
  ) {
    throw new ChatCacheError("current_user_mismatch", "optimistic message identity is invalid");
  }
  const duplicate = Object.values(state.entities.messages).find(
    (candidate) =>
      isOptimisticMessage(candidate) &&
      candidate.delivery.clientMessageId === message.delivery.clientMessageId,
  );
  if (duplicate !== undefined && duplicate.id !== message.id) {
    throw new ChatCacheError("message_conflict", "clientMessageId already identifies another optimistic message");
  }

  const existing = state.entities.messages[message.id];
  if (existing !== undefined && !isOptimisticMessage(existing)) return state;
  const messages: ChatCacheEntities["messages"] = freezeRecord({
    ...state.entities.messages,
    [message.id]: message,
  });
  const timeline = state.timelines[message.conversationId];
  const messageIds = timeline?.messageIds.includes(message.id) === true
    ? timeline.messageIds
    : Object.freeze([...(timeline?.messageIds ?? []), message.id]);
  const nextTimeline: ConversationTimelineCacheEntry = Object.freeze({
    messageIds,
    pagination: timeline?.pagination ?? Object.freeze({
      older: Object.freeze({ available: false as const }),
      newer: Object.freeze({ available: false as const }),
    }),
    realtimeCursor: timeline?.realtimeCursor ?? state.metadata.realtimeCursor ?? Object.freeze({ eventId: `optimistic:${message.delivery.clientMessageId}` }),
  });
  return freezeState({
    ...state,
    entities: Object.freeze({ ...state.entities, messages }),
    timelines: freezeRecord({ ...state.timelines, [message.conversationId]: nextTimeline }),
  });
}

function failOptimisticMessage(
  state: NormalizedChatCacheState,
  clientMessageId: string,
  failure: OptimisticMessageFailure,
  retryable: boolean,
): NormalizedChatCacheState {
  const projection = Object.values(state.entities.messages).find(
    (message): message is OptimisticMessageProjection =>
      isOptimisticMessage(message) &&
      message.delivery.clientMessageId === clientMessageId,
  );
  if (projection === undefined) return state;
  const failed: OptimisticMessageProjection = Object.freeze({
    ...projection,
    delivery: Object.freeze({
      ...projection.delivery,
      state: "failed" as const,
      retryable,
      failure,
    }),
  });
  const messages: ChatCacheEntities["messages"] = freezeRecord({
    ...state.entities.messages,
    [projection.id]: failed,
  });
  return freezeState({
    ...state,
    entities: Object.freeze({
      ...state.entities,
      messages,
    }),
  });
}

function reconcileOptimisticMessage(
  state: NormalizedChatCacheState,
  result: SendMessageResult,
): NormalizedChatCacheState {
  const identity = requireIdentity(state);
  const canonical = result.message;
  if (canonical.tenantId !== identity.tenantId) {
    throw new ChatCacheError("tenant_mismatch", "canonical message tenant does not match cache identity");
  }
  const projection = Object.values(state.entities.messages).find(
    (message): message is OptimisticMessageProjection =>
      isOptimisticMessage(message) &&
      message.delivery.clientMessageId === result.clientMessageId,
  );
  const existingCanonical = state.entities.messages[canonical.id];
  if (projection === undefined && existingCanonical !== undefined) return state;

  const references = canonical.content?.attachments ?? [];
  const attachmentMetadata = references.map(
    ({ attachmentId }) => state.entities.attachments[attachmentId],
  );
  if (attachmentMetadata.some((attachment) => attachment === undefined)) {
    throw new ChatCacheError("message_conflict", "canonical attachment metadata is unavailable");
  }
  const { threadSummary, ...withoutSummary } = canonical;
  const base = {
    ...withoutSummary,
    reactions: projection?.reactions ?? Object.freeze([]),
    attachmentMetadata: Object.freeze(attachmentMetadata as MessageAttachmentMetadata[]),
  };
  const message: MessageTimelineMessage = threadSummary === undefined
    ? Object.freeze({ ...base, isThreadRoot: false as const })
    : Object.freeze({ ...base, isThreadRoot: true as const, threadSummary });

  const mutableMessages: Record<string, ChatTimelineMessage> = { ...state.entities.messages };
  if (projection !== undefined) delete mutableMessages[projection.id];
  if (existingCanonical === undefined || isOptimisticMessage(existingCanonical)) {
    mutableMessages[message.id] = message;
  }
  const conversation = state.entities.conversations[canonical.conversationId];
  if (conversation?.type === "thread") {
    const root = mutableMessages[conversation.rootMessageId];
    if (
      root !== undefined &&
      root.isThreadRoot &&
      root.threadSummary.threadId === conversation.id
    ) {
      const participantIds = root.threadSummary.participantIds.includes(
        message.author.userId,
      )
        ? root.threadSummary.participantIds
        : Object.freeze([
            ...root.threadSummary.participantIds,
            message.author.userId,
          ]);
      mutableMessages[root.id] = Object.freeze({
        ...root,
        threadSummary: Object.freeze({
          ...root.threadSummary,
          replyCount: root.threadSummary.replyCount + 1,
          participantIds,
          lastReplyAt: message.createdAt,
          unreadCount:
            root.threadSummary.unreadCount +
            (message.author.userId === identity.userId ? 0 : 1),
        }),
      });
    }
  }
  const messages = freezeRecord(mutableMessages);
  const timeline = state.timelines[canonical.conversationId];
  const replacedIds = (timeline?.messageIds ?? [])
    .filter((id) => id !== projection?.id && id !== canonical.id)
    .concat(canonical.id);
  const messageIds = sortAndValidateTimelineIds(
    Object.freeze(replacedIds),
    messages,
    canonical.conversationId,
  );
  const nextTimeline = Object.freeze({
    messageIds,
    pagination: timeline?.pagination ?? Object.freeze({
      older: Object.freeze({ available: false as const }),
      newer: Object.freeze({ available: false as const }),
    }),
    realtimeCursor: timeline?.realtimeCursor ?? state.metadata.realtimeCursor ?? Object.freeze({ eventId: `optimistic:${result.clientMessageId}` }),
  });
  const known = state.metadata.conversations[canonical.conversationId];
  const conversations: ChatCacheMetadata["conversations"] = known === undefined
    ? state.metadata.conversations
    : freezeRecord({
        ...state.metadata.conversations,
        [canonical.conversationId]: Object.freeze({
          latestSequence: Math.max(known.latestSequence, canonical.sequence) as MessageSequence,
          activityAt: compareIsoTimestamp(known.activityAt, canonical.updatedAt) > 0
            ? known.activityAt
            : canonical.updatedAt,
        }),
      });
  return freezeState({
    ...state,
    entities: Object.freeze({ ...state.entities, messages }),
    timelines: freezeRecord({ ...state.timelines, [canonical.conversationId]: nextTimeline }),
    metadata: Object.freeze({ ...state.metadata, conversations }),
  });
}

function beginOptimisticMessageEdit(
  state: NormalizedChatCacheState,
  input: EditMessageInput,
): NormalizedChatCacheState {
  const identity = requireIdentity(state);
  const current = state.entities.messages[input.messageId];
  if (current === undefined || isOptimisticMessage(current)) {
    throw new ChatCacheError(
      "message_conflict",
      "a canonical message is required before it can be edited",
    );
  }
  if (isPendingMessageEdit(current) || isPendingMessageDelete(current)) {
    throw new ChatCacheError(
      "message_conflict",
      "the message already has a pending edit",
    );
  }
  if (current.tenantId !== identity.tenantId) {
    throw new ChatCacheError(
      "tenant_mismatch",
      "message tenant does not match cache identity",
    );
  }

  const previous = stripMessageEditState(current);
  if (
    input.expectedRevision !== previous.revision.revision ||
    previous.content === null
  ) {
    throw new ChatCacheError(
      "message_conflict",
      "the expected revision does not match the canonical message",
    );
  }

  const attachmentMetadata = input.content.attachments?.map(
    ({ attachmentId }) => state.entities.attachments[attachmentId],
  ) ?? [];
  if (attachmentMetadata.some((attachment) => attachment === undefined)) {
    throw new ChatCacheError(
      "message_conflict",
      "optimistic edit attachment metadata is unavailable",
    );
  }

  const message: MessageEditProjection = Object.freeze({
    ...previous,
    content: input.content,
    attachmentMetadata: Object.freeze(
      attachmentMetadata as MessageAttachmentMetadata[],
    ),
    editState: Object.freeze({
      state: "pending" as const,
      idempotencyKey: input.idempotencyKey,
      expectedRevision: input.expectedRevision,
      previous,
    }),
  });
  return replaceTimelineMessage(state, message);
}

function reconcileOptimisticMessageEdit(
  state: NormalizedChatCacheState,
  idempotencyKey: string,
  result: EditMessageResult,
): NormalizedChatCacheState {
  const current = state.entities.messages[result.message.id];
  if (
    !isPendingMessageEdit(current) ||
    current.editState.idempotencyKey !== idempotencyKey
  ) {
    return state;
  }
  if (
    current.editState.expectedRevision !== result.expectedRevision ||
    result.message.tenantId !== state.identity?.tenantId
  ) {
    throw new ChatCacheError(
      "message_conflict",
      "the edit result does not match the pending edit",
    );
  }

  assertSameMessageIdentity(current.editState.previous, result.message);
  const canonical = projectCanonicalEditMessage(state, result.message, current);
  if (result.reconciliationStatus !== "revision_conflict") {
    return replaceTimelineMessage(state, canonical);
  }

  const conflicted: MessageEditProjection = Object.freeze({
    ...canonical,
    editState: Object.freeze({
      state: "revision_conflict" as const,
      idempotencyKey,
      expectedRevision: result.expectedRevision,
      canonicalRevision: result.canonicalRevision,
    }),
  });
  return replaceTimelineMessage(state, conflicted);
}

function rollbackOptimisticMessageEdit(
  state: NormalizedChatCacheState,
  messageId: MessageId,
  idempotencyKey: string,
): NormalizedChatCacheState {
  const current = state.entities.messages[messageId];
  if (
    !isPendingMessageEdit(current) ||
    current.editState.idempotencyKey !== idempotencyKey
  ) {
    return state;
  }
  return replaceTimelineMessage(state, current.editState.previous);
}

function beginOptimisticMessageDelete(
  state: NormalizedChatCacheState,
  input: SoftDeleteMessageInput,
): NormalizedChatCacheState {
  const identity = requireIdentity(state);
  const current = state.entities.messages[input.messageId];
  if (
    current === undefined ||
    isOptimisticMessage(current) ||
    isPendingMessageEdit(current) ||
    isPendingMessageDelete(current)
  ) {
    throw new ChatCacheError(
      "message_conflict",
      "a canonical message without a pending mutation is required before it can be deleted",
    );
  }
  if (current.tenantId !== identity.tenantId) {
    throw new ChatCacheError(
      "tenant_mismatch",
      "message tenant does not match cache identity",
    );
  }

  const previous = stripMessageEditState(current);
  if (
    input.expectedRevision !== previous.revision.revision ||
    previous.content === null
  ) {
    throw new ChatCacheError(
      "message_conflict",
      "the expected revision does not match the canonical message",
    );
  }

  const message: PendingMessageDeleteProjection = Object.freeze({
    ...previous,
    content: null,
    deletedAt: previous.updatedAt,
    deletedByUserId: identity.userId,
    deleteState: Object.freeze({
      state: "pending" as const,
      idempotencyKey: input.idempotencyKey,
      expectedRevision: input.expectedRevision,
      previous,
    }),
  });
  return replaceTimelineMessage(state, message);
}

function reconcileOptimisticMessageDelete(
  state: NormalizedChatCacheState,
  idempotencyKey: string,
  result: SoftDeleteMessageResult,
): NormalizedChatCacheState {
  const current = state.entities.messages[result.message.id];
  if (
    !isPendingMessageDelete(current) ||
    current.deleteState.idempotencyKey !== idempotencyKey
  ) {
    return state;
  }
  if (
    current.deleteState.expectedRevision !== result.expectedRevision ||
    result.message.tenantId !== state.identity?.tenantId
  ) {
    throw new ChatCacheError(
      "message_conflict",
      "the delete result does not match the pending deletion",
    );
  }

  assertSameMessageIdentity(current.deleteState.previous, result.message);
  return replaceTimelineMessage(
    state,
    projectCanonicalMutationMessage(state, result.message, current),
  );
}

function rollbackOptimisticMessageDelete(
  state: NormalizedChatCacheState,
  messageId: MessageId,
  idempotencyKey: string,
): NormalizedChatCacheState {
  const current = state.entities.messages[messageId];
  if (
    !isPendingMessageDelete(current) ||
    current.deleteState.idempotencyKey !== idempotencyKey
  ) {
    return state;
  }
  return replaceTimelineMessage(state, current.deleteState.previous);
}

function stripMessageEditState(
  message: MessageTimelineMessage | MessageEditProjection,
): MessageTimelineMessage {
  if (!isMessageEditProjection(message)) return message;
  const { editState: _editState, ...canonical } = message;
  return Object.freeze(canonical) as MessageTimelineMessage;
}

function projectCanonicalEditMessage(
  state: NormalizedChatCacheState,
  canonical: EditMessageResult["message"],
  existing: MessageTimelineMessage,
): MessageTimelineMessage {
  return projectCanonicalMutationMessage(state, canonical, existing);
}

function projectCanonicalMutationMessage(
  state: NormalizedChatCacheState,
  canonical: EditMessageResult["message"] | SoftDeleteMessageResult["message"],
  existing: MessageTimelineMessage,
): MessageTimelineMessage {
  const references = canonical.content?.attachments ?? [];
  const attachmentMetadata = references.map(
    ({ attachmentId }) => state.entities.attachments[attachmentId],
  );
  if (attachmentMetadata.some((attachment) => attachment === undefined)) {
    throw new ChatCacheError(
      "message_conflict",
      "canonical edit attachment metadata is unavailable",
    );
  }
  const { threadSummary, ...withoutSummary } = canonical;
  const base = {
    ...withoutSummary,
    reactions: existing.reactions,
    attachmentMetadata: Object.freeze(
      attachmentMetadata as MessageAttachmentMetadata[],
    ),
  };
  return threadSummary === undefined
    ? Object.freeze({ ...base, isThreadRoot: false as const })
    : Object.freeze({ ...base, isThreadRoot: true as const, threadSummary });
}

function assertSameMessageIdentity(
  previous: MessageTimelineMessage,
  canonical: EditMessageResult["message"],
): void {
  if (
    previous.id !== canonical.id ||
    previous.tenantId !== canonical.tenantId ||
    previous.conversationId !== canonical.conversationId ||
    previous.author.userId !== canonical.author.userId ||
    previous.sequence !== canonical.sequence ||
    previous.createdAt !== canonical.createdAt
  ) {
    throw new ChatCacheError(
      "message_conflict",
      "canonical edit changed immutable message identity",
    );
  }
}

function replaceTimelineMessage(
  state: NormalizedChatCacheState,
  message: ChatTimelineMessage,
): NormalizedChatCacheState {
  const messages: ChatCacheEntities["messages"] = freezeRecord({
    ...state.entities.messages,
    [message.id]: message,
  } as Record<MessageId, ChatTimelineMessage>);
  return freezeState({
    ...state,
    entities: Object.freeze({
      ...state.entities,
      messages,
    }),
  });
}

function applyEphemeral(
  state: NormalizedChatCacheState,
  event: EphemeralSignalEvent,
  now: number,
): NormalizedChatCacheState {
  const identity = requireIdentity(state);
  if (event.tenantId !== identity.tenantId) {
    throw new ChatCacheError("tenant_mismatch", "signal tenant does not match cache identity");
  }
  if (
    event.type === "presence.signal" &&
    event.payload.scope.userId !== identity.userId
  ) {
    throw new ChatCacheError(
      "current_user_mismatch",
      "presence signal is not scoped to the current user",
    );
  }
  const ephemeral = reduceEphemeralSignal(state.ephemeral, event, now);
  return ephemeral === state.ephemeral
    ? state
    : freezeState({ ...state, ephemeral });
}

function setHuddle(
  state: NormalizedChatCacheState,
  huddle: HuddleSessionState,
): NormalizedChatCacheState {
  requireIdentity(state);
  const existing = state.huddles[huddle.conversationId];
  if (valueEqual(existing, huddle)) {
    return state;
  }
  return freezeState({
    ...state,
    huddles: freezeRecord({
      ...state.huddles,
      [huddle.conversationId]: huddle,
    }),
  });
}

function reconcileCurrentUserReadState(
  state: NormalizedChatCacheState,
  value: ReadCursorMutationResult,
): NormalizedChatCacheState {
  const identity = requireIdentity(state);
  const result = parseReadCursorMutationResult(value);
  const readState = result.readState;
  const metadata = state.metadata.conversations[result.conversationId];
  if (metadata === undefined) {
    throw new ChatCacheError(
      "conversation_mismatch",
      "read state conversation is not present in the cache",
    );
  }
  assertPrivateUser(identity, readState.userId, "read state");

  const existingReadState = state.currentUser.readStates[result.conversationId];
  const nextLatestSequence = Math.max(
    metadata.latestSequence,
    result.latestSequence,
  ) as MessageSequence;
  const existingMentionCount =
    state.metadata.conversationListUnreadMentionCounts[result.conversationId];
  const clearsUnreadMentions = existingMentionCount !== undefined &&
    existingMentionCount > 0 &&
    readState.lastReadSequence >= nextLatestSequence;
  if (
    valueEqual(existingReadState, readState) &&
    nextLatestSequence === metadata.latestSequence &&
    !clearsUnreadMentions
  ) {
    return state;
  }
  return freezeState({
    ...state,
    currentUser: Object.freeze({
      ...state.currentUser,
      readStates: freezeRecord<ConversationReadState>({
        ...state.currentUser.readStates,
        [readState.conversationId]: Object.freeze(readState),
      }),
    }),
    metadata:
      nextLatestSequence === metadata.latestSequence && !clearsUnreadMentions
        ? state.metadata
        : Object.freeze({
            ...state.metadata,
            ...(nextLatestSequence === metadata.latestSequence
              ? {}
              : {
                  conversations: freezeRecord<ConversationCacheMetadata>({
                    ...state.metadata.conversations,
                    [result.conversationId]: Object.freeze({
                      ...metadata,
                      latestSequence: nextLatestSequence,
                    }),
                  }),
                }),
            ...(clearsUnreadMentions
              ? {
                  conversationListUnreadMentionCounts: freezeRecord<number>({
                    ...state.metadata.conversationListUnreadMentionCounts,
                    [result.conversationId]: 0,
                  }),
                }
              : {}),
          }),
  });
}

function beginOptimisticConversationPreference(
  state: NormalizedChatCacheState,
  value: UpdateConversationPreferenceInput,
  projectedAt: IsoTimestamp,
): NormalizedChatCacheState {
  const identity = requireIdentity(state);
  const input = parseUpdateConversationPreferenceInput(value);
  if (
    state.entities.conversations[input.conversationId] === undefined ||
    !Number.isFinite(Date.parse(projectedAt))
  ) {
    throw new ChatCacheError(
      "conversation_mismatch",
      "optimistic preference update requires a known conversation and timestamp",
    );
  }
  const knownRevision =
    state.currentUser.preferenceRevisions[input.conversationId] ?? 0;
  if (input.expectedPreferenceRevision !== knownRevision) {
    throw new ChatCacheError(
      "conversation_mismatch",
      "optimistic preference update does not use the authoritative revision",
    );
  }
  const existingPending =
    state.currentUser.pendingPreferenceUpdates[input.conversationId];
  const authoritativePreference =
    existingPending?.authoritativePreference ??
    state.currentUser.preferences[input.conversationId];
  const pending = Object.freeze({
    state: "pending" as const,
    conversationId: input.conversationId,
    idempotencyKey: input.idempotencyKey,
    expectedPreferenceRevision: input.expectedPreferenceRevision,
    desiredPreference: Object.freeze({
      notificationPreference: input.notificationPreference,
      isStarred: input.isStarred,
      mute: Object.freeze({ ...input.mute }),
    }),
    ...(authoritativePreference === undefined
      ? {}
      : { authoritativePreference }),
  });
  const projection: ConversationMemberPreference = Object.freeze({
    conversationId: input.conversationId,
    userId: identity.userId,
    isStarred: input.isStarred,
    notificationPreference: input.notificationPreference,
    mute: Object.freeze({ ...input.mute }),
    updatedAt: projectedAt,
  });
  if (
    valueEqual(existingPending, pending) &&
    valueEqual(state.currentUser.preferences[input.conversationId], projection)
  ) return state;
  return freezeState({
    ...state,
    currentUser: Object.freeze({
      ...state.currentUser,
      preferences: freezeRecord<ConversationMemberPreference>({
        ...state.currentUser.preferences,
        [input.conversationId]: projection,
      }),
      pendingPreferenceUpdates: freezeRecord<PendingConversationPreferenceUpdate>({
        ...state.currentUser.pendingPreferenceUpdates,
        [input.conversationId]: pending,
      }),
    }),
  });
}

function reconcileCurrentUserConversationPreference(
  state: NormalizedChatCacheState,
  input: UpdateConversationPreferenceInput,
  result: UpdateConversationPreferenceResult,
): NormalizedChatCacheState {
  return reconcileCurrentUserPreferenceMutation(state, input, result);
}

function markConversationPreferenceConflict(
  state: NormalizedChatCacheState,
  value: UpdateConversationPreferenceInput,
): NormalizedChatCacheState {
  requireIdentity(state);
  const input = parseUpdateConversationPreferenceInput(value);
  const knownRevision =
    state.currentUser.preferenceRevisions[input.conversationId] ?? 0;
  const existing =
    state.currentUser.pendingPreferenceUpdates[input.conversationId];
  const authoritativePreference =
    existing?.authoritativePreference ??
    state.currentUser.preferences[input.conversationId];
  if (
    state.entities.conversations[input.conversationId] === undefined ||
    knownRevision <= input.expectedPreferenceRevision ||
    authoritativePreference === undefined
  ) {
    throw new ChatCacheError(
      "conversation_mismatch",
      "preference conflict requires a newer authoritative preference",
    );
  }
  const conflict: PendingConversationPreferenceUpdate = Object.freeze({
    state: "conflict",
    conversationId: input.conversationId,
    idempotencyKey: input.idempotencyKey,
    expectedPreferenceRevision: input.expectedPreferenceRevision,
    desiredPreference: Object.freeze({
      notificationPreference: input.notificationPreference,
      isStarred: input.isStarred,
      mute: Object.freeze({ ...input.mute }),
    }),
    authoritativePreference,
  });
  if (
    valueEqual(existing, conflict) &&
    valueEqual(
      state.currentUser.preferences[input.conversationId],
      authoritativePreference,
    )
  ) return state;
  return freezeState({
    ...state,
    currentUser: Object.freeze({
      ...state.currentUser,
      preferences: freezeRecord<ConversationMemberPreference>({
        ...state.currentUser.preferences,
        [input.conversationId]: authoritativePreference,
      }),
      pendingPreferenceUpdates: freezeRecord<PendingConversationPreferenceUpdate>({
        ...state.currentUser.pendingPreferenceUpdates,
        [input.conversationId]: conflict,
      }),
    }),
  });
}

function rollbackOptimisticConversationPreference(
  state: NormalizedChatCacheState,
  conversationId: ConversationId,
  idempotencyKey: string,
): NormalizedChatCacheState {
  requireIdentity(state);
  const pending = state.currentUser.pendingPreferenceUpdates[conversationId];
  if (pending?.idempotencyKey !== idempotencyKey) return state;
  const pendingPreferenceUpdates = {
    ...state.currentUser.pendingPreferenceUpdates,
  };
  delete pendingPreferenceUpdates[conversationId];
  const preferences = { ...state.currentUser.preferences };
  if (pending.authoritativePreference === undefined) delete preferences[conversationId];
  else preferences[conversationId] = pending.authoritativePreference;
  return freezeState({
    ...state,
    currentUser: Object.freeze({
      ...state.currentUser,
      preferences: freezeRecord(preferences),
      pendingPreferenceUpdates: freezeRecord(pendingPreferenceUpdates),
    }),
  });
}

function requireKnownThreadFollowTarget(
  state: NormalizedChatCacheState,
  threadId: ConversationId,
): void {
  const thread = state.entities.conversations[threadId];
  if (thread?.type !== "thread") {
    throw new ChatCacheError(
      "conversation_mismatch",
      "thread follow requires a known thread conversation",
    );
  }
  const parent = state.entities.conversations[thread.parentConversationId];
  const root = state.entities.messages[thread.rootMessageId];
  if (
    parent === undefined ||
    parent.type === "thread" ||
    root === undefined ||
    root.conversationId !== parent.id
  ) {
    throw new ChatCacheError(
      "conversation_mismatch",
      "thread follow requires a valid known parent and root message relationship",
    );
  }
}

function beginOptimisticThreadFollow(
  state: NormalizedChatCacheState,
  value: SetThreadFollowInput,
  projectedAt: IsoTimestamp,
): NormalizedChatCacheState {
  requireIdentity(state);
  const input = parseSetThreadFollowInput(value);
  requireKnownThreadFollowTarget(state, input.target.id);
  if (!Number.isFinite(Date.parse(projectedAt))) {
    throw new ChatCacheError(
      "conversation_mismatch",
      "optimistic thread follow requires a valid timestamp",
    );
  }
  const knownRevision =
    state.currentUser.threadFollowRevisions[input.target.id] ?? 0;
  if (input.expectedFollowRevision !== knownRevision) {
    throw new ChatCacheError(
      "conversation_mismatch",
      "optimistic thread follow does not use the authoritative revision",
    );
  }
  const existingPending =
    state.currentUser.pendingThreadFollowUpdates[input.target.id];
  // Absence is authoritative too; re-projecting a pending first follow must
  // not adopt its optimistic value as the rollback state.
  const authoritativeFollow =
    existingPending === undefined
      ? state.currentUser.threadFollows[input.target.id]
      : existingPending.authoritativeFollow;
  const pending: PendingThreadFollowUpdate = Object.freeze({
    state: "pending",
    threadId: input.target.id,
    idempotencyKey: input.idempotencyKey,
    expectedFollowRevision: input.expectedFollowRevision,
    intent: input.intent,
    ...(authoritativeFollow === undefined ? {} : { authoritativeFollow }),
  });
  const projection: CanonicalThreadFollowState = Object.freeze({
    target: Object.freeze({ ...input.target }),
    isFollowing: input.intent === "follow",
    source: "manual",
    updatedAt: projectedAt,
  });
  if (
    valueEqual(existingPending, pending) &&
    valueEqual(state.currentUser.threadFollows[input.target.id], projection)
  ) return state;
  return freezeState({
    ...state,
    currentUser: Object.freeze({
      ...state.currentUser,
      threadFollows: freezeRecord<CanonicalThreadFollowState>({
        ...state.currentUser.threadFollows,
        [input.target.id]: projection,
      }),
      pendingThreadFollowUpdates: freezeRecord<PendingThreadFollowUpdate>({
        ...state.currentUser.pendingThreadFollowUpdates,
        [input.target.id]: pending,
      }),
    }),
  });
}

function reconcileCurrentUserThreadFollow(
  state: NormalizedChatCacheState,
  input: SetThreadFollowInput,
  result: SetThreadFollowResult,
): NormalizedChatCacheState {
  parseSetThreadFollowResult(result, input);
  requireKnownThreadFollowTarget(state, input.target.id);
  return reconcileCurrentUserThreadFollowMutation(state, input, result);
}

function markThreadFollowConflict(
  state: NormalizedChatCacheState,
  value: SetThreadFollowInput,
): NormalizedChatCacheState {
  requireIdentity(state);
  const input = parseSetThreadFollowInput(value);
  requireKnownThreadFollowTarget(state, input.target.id);
  const knownRevision =
    state.currentUser.threadFollowRevisions[input.target.id] ?? 0;
  const existing = state.currentUser.pendingThreadFollowUpdates[input.target.id];
  const authoritativeFollow = existing?.authoritativeFollow ??
    state.currentUser.threadFollows[input.target.id];
  if (
    knownRevision <= input.expectedFollowRevision ||
    authoritativeFollow === undefined
  ) {
    throw new ChatCacheError(
      "conversation_mismatch",
      "thread-follow conflict requires a newer authoritative state",
    );
  }
  const conflict: PendingThreadFollowUpdate = Object.freeze({
    state: "conflict",
    threadId: input.target.id,
    idempotencyKey: input.idempotencyKey,
    expectedFollowRevision: input.expectedFollowRevision,
    intent: input.intent,
    authoritativeFollow,
  });
  if (
    valueEqual(existing, conflict) &&
    valueEqual(state.currentUser.threadFollows[input.target.id], authoritativeFollow)
  ) return state;
  return freezeState({
    ...state,
    currentUser: Object.freeze({
      ...state.currentUser,
      threadFollows: freezeRecord<CanonicalThreadFollowState>({
        ...state.currentUser.threadFollows,
        [input.target.id]: authoritativeFollow,
      }),
      pendingThreadFollowUpdates: freezeRecord<PendingThreadFollowUpdate>({
        ...state.currentUser.pendingThreadFollowUpdates,
        [input.target.id]: conflict,
      }),
    }),
  });
}

function rollbackOptimisticThreadFollow(
  state: NormalizedChatCacheState,
  threadId: ConversationId,
  idempotencyKey: string,
): NormalizedChatCacheState {
  requireIdentity(state);
  const pending = state.currentUser.pendingThreadFollowUpdates[threadId];
  if (pending?.idempotencyKey !== idempotencyKey) return state;
  const pendingThreadFollowUpdates = {
    ...state.currentUser.pendingThreadFollowUpdates,
  };
  delete pendingThreadFollowUpdates[threadId];
  const threadFollows = { ...state.currentUser.threadFollows };
  if (pending.authoritativeFollow === undefined) delete threadFollows[threadId];
  else threadFollows[threadId] = pending.authoritativeFollow;
  return freezeState({
    ...state,
    currentUser: Object.freeze({
      ...state.currentUser,
      threadFollows: freezeRecord(threadFollows),
      pendingThreadFollowUpdates: freezeRecord(pendingThreadFollowUpdates),
    }),
  });
}

function setRealtimeCursor(
  state: NormalizedChatCacheState,
  cursor: EventCursor | undefined,
): NormalizedChatCacheState {
  requireIdentity(state);
  if (valueEqual(state.metadata.realtimeCursor, cursor)) {
    return state;
  }
  const { realtimeCursor: _previous, ...metadata } = state.metadata;
  return freezeState({
    ...state,
    metadata: Object.freeze({
      ...metadata,
      ...(cursor === undefined ? {} : { realtimeCursor: cursor }),
    }),
  });
}

function normalizeConversationSummaries(
  state: NormalizedChatCacheState,
  items: readonly ConversationSnapshotSummary[],
  identity: ChatCacheIdentity,
): {
  readonly conversations: ChatCacheEntities["conversations"];
  readonly metadata: ChatCacheMetadata["conversations"];
  readonly memberships: CurrentUserChatCacheState["memberships"];
  readonly readStates: CurrentUserChatCacheState["readStates"];
  readonly preferences: CurrentUserChatCacheState["preferences"];
  readonly preferenceRevisions: CurrentUserChatCacheState["preferenceRevisions"];
  readonly pendingPreferenceUpdates: CurrentUserChatCacheState["pendingPreferenceUpdates"];
} {
  let conversations = state.entities.conversations;
  let metadata = state.metadata.conversations;
  let memberships = state.currentUser.memberships;
  let readStates = state.currentUser.readStates;
  let preferences = state.currentUser.preferences;
  let preferenceRevisions = state.currentUser.preferenceRevisions;
  let pendingPreferenceUpdates = state.currentUser.pendingPreferenceUpdates;
  let nextConversations: Record<string, Conversation> | undefined;
  let nextMetadata: Record<string, ConversationCacheMetadata> | undefined;
  let nextMemberships: Record<string, ConversationMember> | undefined;
  let nextReadStates: Record<string, ConversationReadState> | undefined;
  let nextPreferences: Record<string, ConversationMemberPreference> | undefined;
  let nextPreferenceRevisions: Record<string, number> | undefined;
  let nextPendingPreferenceUpdates:
    | Record<string, PendingConversationPreferenceUpdate>
    | undefined;

  for (const item of items) {
    assertConversationIdentity(item, identity);
    const conversation = toConversation(item);
    const existingConversationMetadata = metadata[item.id];
    const conversationMetadata: ConversationCacheMetadata = Object.freeze({
      latestSequence: Math.max(
        existingConversationMetadata?.latestSequence ?? 0,
        item.latestSequence,
      ),
      activityAt:
        existingConversationMetadata !== undefined &&
        compareIsoTimestamp(existingConversationMetadata.activityAt, item.activityAt) > 0
          ? existingConversationMetadata.activityAt
          : item.activityAt,
    });

    const existingConversation = conversations[item.id];
    if (
      !valueEqual(existingConversation, conversation) &&
      (existingConversation === undefined ||
        compareIsoTimestamp(conversation.updatedAt, existingConversation.updatedAt) > 0)
    ) {
      nextConversations ??= { ...conversations };
      nextConversations[item.id] = conversation;
    }
    if (!valueEqual(metadata[item.id], conversationMetadata)) {
      nextMetadata ??= { ...metadata };
      nextMetadata[item.id] = conversationMetadata;
    }
    const existingMembership = memberships[item.id];
    if (
      !valueEqual(existingMembership, item.currentMember) &&
      (existingMembership === undefined ||
        compareIsoTimestamp(
          item.currentMember.updatedAt,
          existingMembership.updatedAt,
        ) > 0)
    ) {
      nextMemberships ??= { ...memberships };
      nextMemberships[item.id] = item.currentMember;
    }
    const existingReadState = readStates[item.id];
    if (
      !valueEqual(existingReadState, item.currentReadState) &&
      (existingReadState === undefined ||
        (item.currentReadState.lastReadSequence >= existingReadState.lastReadSequence &&
          compareIsoTimestamp(
            item.currentReadState.updatedAt,
            existingReadState.updatedAt,
          ) > 0))
    ) {
      nextReadStates ??= { ...readStates };
      nextReadStates[item.id] = item.currentReadState;
    }
    const pendingPreference =
      (nextPendingPreferenceUpdates ?? pendingPreferenceUpdates)[item.id];
    const projectedPreference = (nextPreferences ?? preferences)[item.id];
    const existingPreference =
      pendingPreference?.authoritativePreference ?? projectedPreference;
    const incomingRevision = item.currentPreference.preferenceRevision;
    const knownRevision = (nextPreferenceRevisions ?? preferenceRevisions)[item.id] ?? 0;
    // Revisions order canonical snapshots even when timestamps tie or arrive late.
    // Legacy snapshots retain their existing timestamp-based reconciliation.
    let canonicalPreference = existingPreference;
    if (incomingRevision !== undefined) {
      if (incomingRevision >= knownRevision) {
        canonicalPreference = item.currentPreference;
        if ((nextPreferenceRevisions ?? preferenceRevisions)[item.id] !== incomingRevision) {
          nextPreferenceRevisions ??= { ...preferenceRevisions };
          nextPreferenceRevisions[item.id] = incomingRevision;
        }
      }
    } else if (existingPreference === undefined || compareIsoTimestamp(
      item.currentPreference.updatedAt, existingPreference.updatedAt,
    ) > 0) {
      canonicalPreference = item.currentPreference;
    }
    canonicalPreference ??= item.currentPreference;
    if (
      pendingPreference === undefined &&
      !valueEqual(projectedPreference, canonicalPreference)
    ) {
      nextPreferences ??= { ...preferences };
      nextPreferences[item.id] = canonicalPreference;
    }
    if (
      pendingPreference !== undefined &&
      !valueEqual(pendingPreference.authoritativePreference, canonicalPreference)
    ) {
      nextPendingPreferenceUpdates ??= { ...pendingPreferenceUpdates };
      nextPendingPreferenceUpdates[item.id] = Object.freeze({
        ...pendingPreference,
        authoritativePreference: canonicalPreference,
      });
    }
  }

  if (nextConversations !== undefined) conversations = freezeRecord(nextConversations);
  if (nextMetadata !== undefined) metadata = freezeRecord(nextMetadata);
  if (nextMemberships !== undefined) memberships = freezeRecord(nextMemberships);
  if (nextReadStates !== undefined) readStates = freezeRecord(nextReadStates);
  if (nextPreferences !== undefined) preferences = freezeRecord(nextPreferences);
  if (nextPreferenceRevisions !== undefined) preferenceRevisions = freezeRecord(nextPreferenceRevisions);
  if (nextPendingPreferenceUpdates !== undefined) {
    pendingPreferenceUpdates = freezeRecord(nextPendingPreferenceUpdates);
  }
  return {
    conversations,
    metadata,
    memberships,
    readStates,
    preferences,
    preferenceRevisions,
    pendingPreferenceUpdates,
  };
}

function toConversation(item: ConversationSnapshotSummary): Conversation {
  const {
    latestSequence: _latestSequence,
    activityAt: _activityAt,
    unreadMentionCount: _unreadMentionCount,
    currentMember: _currentMember,
    currentReadState: _currentReadState,
    ...conversationWithDetail
  } = item;
  const {
    hasActiveHuddle: _hasActiveHuddle,
    memberUserIds: _memberUserIds,
    currentPreference: _currentPreference,
    ...conversation
  } = conversationWithDetail as typeof conversationWithDetail & {
    readonly hasActiveHuddle?: boolean;
    readonly memberUserIds?: readonly UserId[];
    readonly currentPreference?: ConversationMemberPreference;
  };
  return Object.freeze(conversation) as Conversation;
}

function assertConversationIdentity(
  item: ConversationSnapshotSummary,
  identity: ChatCacheIdentity,
): void {
  if (item.tenantId !== identity.tenantId || item.currentMember.tenantId !== identity.tenantId) {
    throw new ChatCacheError("tenant_mismatch", "conversation tenant does not match cache identity");
  }
  if (
    item.currentMember.conversationId !== item.id ||
    item.currentReadState.conversationId !== item.id ||
    item.currentPreference.conversationId !== item.id
  ) {
    throw new ChatCacheError(
      "conversation_mismatch",
      "private conversation state does not match its snapshot conversation",
    );
  }
  assertPrivateUser(identity, item.currentMember.userId, "membership");
  assertPrivateUser(identity, item.currentReadState.userId, "read state");
  assertPrivateUser(identity, item.currentPreference.userId, "preference");
}

function assertPrivateUser(
  identity: ChatCacheIdentity,
  userId: UserId,
  label: string,
): void {
  if (userId !== identity.userId) {
    throw new ChatCacheError(
      "current_user_mismatch",
      `${label} does not belong to the current cache user`,
    );
  }
}

function requireIdentity(state: NormalizedChatCacheState): ChatCacheIdentity {
  if (state.identity === null) {
    throw new ChatCacheError(
      "identity_required",
      "set a tenant, user, and session identity before hydrating the cache",
    );
  }
  return state.identity;
}

function identitiesEqual(
  left: ChatCacheIdentity | null,
  right: ChatCacheIdentity | null,
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.tenantId === right.tenantId &&
      left.userId === right.userId &&
      left.sessionId === right.sessionId)
  );
}

const conversationListPageKey = (
  cursor: ConversationSnapshotCursor | undefined,
): string =>
  cursor === undefined
    ? JSON.stringify(["initial"])
    : JSON.stringify(["cursor", cursor]);

function linkConversationListPages(
  pages: Readonly<Record<string, ConversationListCachePage>>,
): {
  readonly conversationIds: readonly ConversationId[];
  readonly nextCursor?: ConversationSnapshotCursor;
} {
  let page = pages[conversationListPageKey(undefined)];
  if (page === undefined) {
    return { conversationIds: Object.freeze([]) };
  }

  let conversationIds: readonly ConversationId[] = Object.freeze([]);
  const visited = new Set<string>();
  while (page !== undefined) {
    conversationIds = mergeIds(conversationIds, page.conversationIds);
    const nextCursor = page.nextCursor;
    if (nextCursor === undefined) return { conversationIds };

    const nextKey = conversationListPageKey(nextCursor);
    if (visited.has(nextKey)) return { conversationIds, nextCursor };
    visited.add(nextKey);
    const nextPage = pages[nextKey];
    if (nextPage === undefined) return { conversationIds, nextCursor };
    page = nextPage;
  }
  return { conversationIds };
}

function mergeIds<Id extends string>(
  existing: readonly Id[],
  incoming: readonly Id[],
): readonly Id[] {
  const seen = new Set(existing);
  const merged = [...existing];
  for (const id of incoming) {
    if (!seen.has(id)) {
      seen.add(id);
      merged.push(id);
    }
  }
  return merged.length === existing.length ? existing : Object.freeze(merged);
}

function sortAndValidateTimelineIds(
  ids: readonly MessageId[],
  messages: ChatCacheEntities["messages"],
  conversationId: ConversationId,
): readonly MessageId[] {
  const sorted = [...ids].sort((leftId, rightId) => {
    const left = messages[leftId];
    const right = messages[rightId];
    return (left?.sequence ?? 0) - (right?.sequence ?? 0) || leftId.localeCompare(rightId);
  });
  let previous: MessageTimelineMessage | undefined;
  for (const id of sorted) {
    const message = messages[id];
    if (message === undefined || message.conversationId !== conversationId) {
      throw new ChatCacheError(
        "conversation_mismatch",
        "timeline references a missing or different-conversation message",
      );
    }
    if (previous !== undefined && previous.sequence === message.sequence && previous.id !== message.id) {
      throw new ChatCacheError(
        "message_conflict",
        "a conversation timeline cannot contain two messages at one sequence",
      );
    }
    previous = message;
  }
  return ids.length === sorted.length && ids.every((id, index) => id === sorted[index])
    ? ids
    : Object.freeze(sorted);
}

function mergePagination(
  existing: ConversationTimelineCacheEntry | undefined,
  page: MessageTimelinePage,
  messages: ChatCacheEntities["messages"],
): MessageTimelinePagination {
  if (existing === undefined || existing.messageIds.length === 0 || page.messages.length === 0) {
    return page.pagination;
  }
  const existingFirst = messages[existing.messageIds[0] as MessageId];
  const existingLast = messages[existing.messageIds[existing.messageIds.length - 1] as MessageId];
  const incomingFirst = page.messages.reduce((first, message) =>
    message.sequence < first.sequence ? message : first,
  );
  const incomingLast = page.messages.reduce((last, message) =>
    message.sequence > last.sequence ? message : last,
  );
  if (existingFirst === undefined || existingLast === undefined) {
    return page.pagination;
  }
  const pagination: MessageTimelinePagination = Object.freeze({
    older:
      incomingFirst.sequence <= existingFirst.sequence
        ? page.pagination.older
        : existing.pagination.older,
    newer:
      incomingLast.sequence >= existingLast.sequence
        ? page.pagination.newer
        : existing.pagination.newer,
  });
  return valueEqual(existing.pagination, pagination)
    ? existing.pagination
    : pagination;
}

function valueEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => valueEqual(value, right[index]))
    );
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.hasOwn(rightRecord, key) &&
        valueEqual(leftRecord[key], rightRecord[key]),
    )
  );
}

function compareIsoTimestamp(left: IsoTimestamp, right: IsoTimestamp): number {
  return Date.parse(left) - Date.parse(right);
}

function freezeState(state: NormalizedChatCacheState): NormalizedChatCacheState {
  return Object.freeze(state);
}

function isEmptyState(state: NormalizedChatCacheState): boolean {
  return (
    Object.keys(state.entities.conversations).length === 0 &&
    Object.keys(state.entities.messages).length === 0 &&
    Object.keys(state.entities.memberUserIdsByConversation).length === 0 &&
    Object.keys(state.entities.membersByConversation).length === 0 &&
    Object.keys(state.entities.attachments).length === 0 &&
    Object.keys(state.attachmentUploads).length === 0 &&
    Object.keys(state.timelines).length === 0 &&
    Object.keys(state.currentUser.memberships).length === 0 &&
    Object.keys(state.currentUser.readStates).length === 0 &&
    Object.keys(state.currentUser.preferences).length === 0 &&
    Object.keys(state.currentUser.preferenceRevisions).length === 0 &&
    Object.keys(state.currentUser.pendingPreferenceUpdates).length === 0 &&
    Object.keys(state.currentUser.threadFollows).length === 0 &&
    Object.keys(state.currentUser.threadFollowRevisions).length === 0 &&
    Object.keys(state.currentUser.pendingThreadFollowUpdates).length === 0 &&
    Object.keys(state.currentUser.savedMessages).length === 0 &&
    Object.keys(state.currentUser.savedMessageRevisions).length === 0 &&
    Object.keys(state.currentUser.pendingSavedMessageUpdates).length === 0 &&
    Object.keys(state.currentUser.savedMessageUnavailableReasons).length === 0 &&
    Object.keys(state.currentUser.messageReminders).length === 0 &&
    Object.keys(state.currentUser.messageReminderConversationIds).length === 0 &&
    Object.keys(state.currentUser.messageReminderRevisions).length === 0 &&
    Object.keys(state.currentUser.pendingMessageReminderUpdates).length === 0 &&
    Object.keys(state.currentUser.drafts).length === 0 &&
    Object.keys(state.currentUser.draftRevisions).length === 0 &&
    Object.keys(state.ephemeral.typing).length === 0 &&
    Object.keys(state.ephemeral.presence).length === 0 &&
    Object.keys(state.huddles).length === 0 &&
    Object.keys(state.metadata.conversations).length === 0 &&
    Object.keys(state.metadata.conversationLists).length === 0 &&
    Object.keys(state.metadata.conversationListActiveHuddles).length === 0 &&
    Object.keys(state.metadata.conversationListParticipantUserIds).length === 0 &&
    Object.keys(state.metadata.conversationListUnreadMentionCounts).length === 0 &&
    Object.keys(state.metadata.conversationDetails).length === 0 &&
    Object.keys(state.metadata.durableStreams).length === 0 &&
    Object.keys(state.metadata.pendingConversationOperations).length === 0 &&
    Object.keys(state.metadata.lifecycleRevisions).length === 0 &&
    Object.keys(state.metadata.memberListRevisions).length === 0 &&
    state.metadata.realtimeCursor === undefined
  );
}
