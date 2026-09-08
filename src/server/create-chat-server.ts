import { CHAT_REPLY_THREAD_FEATURES as REPLY_THREAD_FEATURES, type ChatReplyThreadFeature } from "../contracts/generated/realtime-handshake.js";
import { replyThreadStorageReady } from "./reply-thread-readiness.js";
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";

import { Pool } from "pg";

import {
  createThreadListHandlerOptions,
  type ChatThreadInactivityPolicyResolver,
  type ChatThreadListHandlerOptions,
} from "./thread-list-handler-options.js";

import {
  AttachmentTransportError,
  MAX_ATTACHMENT_IDENTIFIER_UTF8_BYTES,
  MAX_ATTACHMENT_IDEMPOTENCY_KEY_UTF8_BYTES,
  parseAbortAttachmentResult,
  parseAttachmentMutationInput,
  parseFinalizeAttachmentResult,
  parseGetAttachmentDownloadInput,
  parsePrepareAttachmentInput,
  parsePrepareAttachmentResult,
  type AbortAttachmentInput,
  type AbortAttachmentResult,
  type FinalizeAttachmentInput,
  type FinalizeAttachmentResult,
  type GetAttachmentDownloadInput,
  type GetAttachmentDownloadResult,
  type PrepareAttachmentInput,
  type PrepareAttachmentResult,
} from "../contracts/attachment-transport.js";
import {
  ConversationArchiveParseError,
  parseConversationArchiveInput,
  parseConversationArchiveResult,
  type ConversationArchiveInput,
  type ConversationArchiveResult,
} from "../contracts/conversation-archive.js";
import {
  ConversationCreationParseError,
  parseConversationCreationInput,
  parseConversationCreationResult,
  type ConversationCreationInput,
  type ConversationCreationResult,
} from "../contracts/conversation-creation.js";
import {
  ConversationMembershipParseError,
  parseConversationMembershipMutationInput,
  parseConversationMembershipMutationResult,
  type ConversationMembershipMutationInput,
  type ConversationMembershipMutationResult,
} from "../contracts/conversation-membership.js";
import {
  ConversationPreferenceMutationParseError,
  MAX_CONVERSATION_PREFERENCE_IDEMPOTENCY_KEY_UTF8_BYTES,
  parseUpdateConversationPreferenceInput,
  parseUpdateConversationPreferenceResult,
  type UpdateConversationPreferenceInput,
  type UpdateConversationPreferenceResult,
} from "../contracts/conversation-preference-mutation.js";
import {
  DEVICE_PUSH_TOKEN_PATH,
  DevicePushTokenContractError,
  MAX_DEVICE_PUSH_TOKEN_IDEMPOTENCY_KEY_UTF8_BYTES,
  parseDevicePushTokenInput,
  parseDevicePushTokenResult,
  type DevicePushTokenInput,
  type DevicePushTokenResult,
} from "../contracts/device-push-token.js";
import {
  DraftMutationParseError,
  MAX_DRAFT_IDEMPOTENCY_KEY_UTF8_BYTES,
  parseSynchronizeDraftInput,
  parseSynchronizeDraftResult,
  type SynchronizeDraftInput,
  type SynchronizeDraftResult,
} from "../contracts/draft-mutation.js";
import {
  HuddleContractError,
  MAX_HUDDLE_IDEMPOTENCY_KEY_UTF8_BYTES,
  parseEndHuddleInput,
  parseHuddleCommandResult,
  parseHuddleSessionState,
  parseJoinHuddleInput,
  parseLeaveHuddleInput,
  parseSetHuddleScreenShareInput,
  parseStartHuddleInput,
  type EndHuddleInput,
  type EndHuddleResult,
  type HuddleFeatureDisabledResult,
  type HuddleSessionState,
  type JoinHuddleInput,
  type JoinHuddleResult,
  type LeaveHuddleInput,
  type LeaveHuddleResult,
  type SetHuddleScreenShareInput,
  type SetHuddleScreenShareResult,
  type StartHuddleInput,
  type StartHuddleResult,
} from "../contracts/huddle-session.js";
import {
  ThreadCreationParseError,
  parseThreadCreationInput,
  parseThreadCreationResult,
  type ThreadCreationInput,
  type ThreadCreationResult,
} from "../contracts/thread-creation.js";
import {
  ThreadLifecycleParseError,
  parseThreadLifecycleHttpInput,
  parseThreadLifecycleResult,
  type ThreadLifecycleInput,
} from "../contracts/thread-lifecycle.js";
import {
  MESSAGE_CONTEXT_PATH,
  parseMessageContextRequest,
  parseMessageContextResult,
} from "../contracts/message-context.js";
import { queryMessageContext } from "./message-context-query.js";
import {
  THREAD_LIST_PATH,
  parseThreadListHttpRequest,
} from "../contracts/thread-list.js";
import {
  MAX_THREAD_FOLLOW_IDENTIFIER_UTF8_BYTES,
  MAX_THREAD_FOLLOW_IDEMPOTENCY_KEY_UTF8_BYTES,
  ThreadFollowMutationParseError,
  parseSetThreadFollowInput,
  parseSetThreadFollowResult,
  type SetThreadFollowInput,
  type SetThreadFollowResult,
} from "../contracts/thread-follow-mutation.js";
import {
  ConversationSnapshotParseError,
  createConversationSnapshotMetadata,
  parseConversationDetailSnapshot,
  parseConversationDetailSnapshotInput,
  parseConversationListSnapshot,
  parseConversationListSnapshotInput,
  type ConversationDetailSnapshot,
  type ConversationDetailSnapshotConversation,
  type ConversationListSnapshot,
  type ConversationListSnapshotSummary,
  type ConversationSnapshotSummary,
} from "../contracts/conversation-snapshot.js";
import {
  PrivateUserStateSnapshotParseError,
  parseMessageReminderListSnapshot,
  parseMessageReminderListSnapshotInput,
  parseConversationDraftSnapshot,
  parseConversationDraftSnapshotInput,
  parseSavedMessageListSnapshot,
  parseSavedMessageListSnapshotInput,
  type ConversationDraftSnapshot,
  type ConversationDraftSnapshotInput,
  type MessageReminderListSnapshot,
  type SavedMessageListSnapshot,
} from "../contracts/private-user-state-snapshot.js";
import {
  CHAT_PROTOCOL_VERSION,
  createServerHandshakeMetadata,
  type ServerHandshakeMetadata,
} from "../contracts/realtime.js";
import {
  HostDirectorySnapshotParseError,
  MAX_HOST_DIRECTORY_SEARCH_LIMIT,
  createHostDirectorySnapshotMetadata,
  decodeHostDirectorySearchCursor,
  encodeHostDirectorySearchCursor,
  parseHostDirectoryBatchLookupInput,
  parseHostDirectoryBatchLookupResult,
  parseHostDirectorySearchInput,
  parseHostDirectorySearchResult,
  type HostDirectoryAvatar,
  type HostDirectoryBatchLookupResult,
  type HostDirectorySearchResult,
  type HostDirectoryUserStatus,
  type HostDirectoryUserSummary,
} from "../contracts/host-directory-snapshot.js";
import type { UserId } from "../contracts/identifiers.js";
import type { EphemeralSignalFeature } from "../contracts/ephemeral-signals.js";
import {
  MessageTimelineContractError,
  type MessageTimelinePage,
} from "../contracts/message-timeline.js";
import {
  ForwardMessageParseError,
  parseForwardMessageInput,
  parseForwardMessageResult,
  type ForwardMessageInput,
  type ForwardMessageResult,
} from "../contracts/generated/forward-message.js";
import {
  MAX_MESSAGE_REMINDER_IDEMPOTENCY_KEY_UTF8_BYTES,
  MAX_MESSAGE_REMINDER_IDENTIFIER_UTF8_BYTES,
  MessageReminderParseError,
  parseMessageReminderInput,
  parseMessageReminderResult,
  type MessageReminderInput,
  type MessageReminderResult,
} from "../contracts/generated/message-reminder.js";
import {
  MessageSearchParseError,
  parseMessageSearchRequest,
  parseMessageSearchResponse,
  type MessageSearchRequest,
  type MessageSearchResponse,
} from "../contracts/message-search.js";
import {
  MessageMutationParseError,
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
  MAX_READ_CURSOR_IDEMPOTENCY_KEY_UTF8_BYTES,
  ReadCursorMutationError,
  parseReadCursorMutationInput,
  parseReadCursorMutationResult,
  type ReadCursorMutationInput,
  type ReadCursorMutationResult,
} from "../contracts/read-cursor-mutation.js";
import {
  MAX_SAVED_MESSAGE_IDENTIFIER_UTF8_BYTES,
  MAX_SAVED_MESSAGE_IDEMPOTENCY_KEY_UTF8_BYTES,
  SavedMessageMutationParseError,
  parseSetSavedMessageInput,
  parseSetSavedMessageResult,
  type SetSavedMessageInput,
  type SetSavedMessageResult,
} from "../contracts/saved-message-mutation.js";
import {
  MAX_REACTION_IDEMPOTENCY_KEY_UTF8_BYTES,
  MAX_REACTION_KEY_UTF8_BYTES,
  ReactionMutationParseError,
  parseReactionMutationInput,
  parseReactionMutationResult,
  type ReactionMutationInput,
  type ReactionMutationResult,
} from "../contracts/reaction-mutations.js";

import type {
  ChatAuditAdapter,
  ChatAuthAdapter,
  ChatDirectoryAdapter,
  ChatDirectoryPolicyAction,
  ChatHttpObservabilityOptions,
  ChatHttpRequestOutcome,
  ChatHttpRequestOutcomeObserver,
  ChatHttpRequestIdProvider,
  ChatMediaAdapter,
  ChatNotificationAdapter,
  ChatPermissionAdapter,
  ChatPushTokenProtector,
  ChatRequestAdmissionAdapter,
  ChatRequestAdmissionMethod,
  ChatRequestAdmissionRouteTemplate,
  ChatRealtimeAdapter,
  ChatRealtimeDelivery,
  ChatRealtimeSubscriber,
  ChatStorageAdapter,
  TrustedChatActorContext,
} from "./contracts.js";
import {
  ADMITTED_CHAT_REQUEST,
  CHAT_REQUEST_ADMISSION_DENIED_CODE,
  CHAT_REQUEST_ADMISSION_DENIED_MESSAGE,
  failedClosedChatRequestAdmission,
  normalizeChatRequestAdmissionOutcome,
} from "./request-admission.js";
export {
  DEFAULT_CHAT_REQUEST_ADMISSION_RETRY_AFTER_SECONDS,
  MAX_CHAT_REQUEST_ADMISSION_RETRY_AFTER_SECONDS,
  MIN_CHAT_REQUEST_ADMISSION_RETRY_AFTER_SECONDS,
} from "./request-admission.js";
import {
  ACTIVE_HUDDLE_ENTITY_POLICY_ACTION,
  queryActiveHuddleSnapshot,
} from "./active-huddle-snapshot-query.js";
import {
  ARCHIVE_CONVERSATION_ENTITY_POLICY_ACTION,
  ArchiveConversationCommandError,
  archiveConversation,
} from "./archive-conversation-command.js";
import {
  CONVERSATION_DETAIL_ENTITY_POLICY_ACTION,
  queryConversationDetail,
} from "./conversation-detail-query.js";
import {
  CONVERSATION_DRAFT_SNAPSHOT_ENTITY_POLICY_ACTION,
  queryConversationDraftSnapshot,
} from "./conversation-draft-snapshot-query.js";
import {
  CONVERSATION_LIST_ENTITY_POLICY_ACTION,
  DEFAULT_CONVERSATION_LIST_LIMIT,
  queryConversationList,
} from "./conversation-list-query.js";
import {
  THREAD_LIST_ENTITY_POLICY_ACTION,
  queryThreadList,
} from "./thread-list-query.js";
import {
  CREATE_CONVERSATION_ENTITY_POLICY_ACTION,
  CreateConversationCommandError,
  createConversation,
} from "./create-conversation-command.js";
import {
  CONVERSATION_MEMBERSHIP_ENTITY_POLICY_ACTION,
  ConversationMembershipCommandError,
  mutateConversationMembership,
} from "./conversation-membership-command.js";
import {
  CREATE_THREAD_ENTITY_POLICY_ACTION,
  CreateThreadCommandError,
  createThread,
} from "./create-thread-command.js";
import {
  MESSAGE_TIMELINE_ENTITY_POLICY_ACTION,
  queryMessageTimeline,
} from "./message-timeline-query.js";
import {
  MESSAGE_SEARCH_ENTITY_POLICY_ACTION,
  MessageSearchQueryError,
  queryMessageSearch,
} from "./message-search-query.js";
import {
  EditMessageCommandError,
  editMessage,
} from "./edit-message-command.js";
import {
  FORWARD_MESSAGE_DESTINATION_ENTITY_POLICY_ACTION,
  FORWARD_MESSAGE_SOURCE_ENTITY_POLICY_ACTION,
  ForwardMessageCommandError,
  forwardMessage,
} from "./forward-message-command.js";
import {
  SEND_MESSAGE_ENTITY_POLICY_ACTION,
  SendMessageCommandError,
  sendMessage,
} from "./send-message-command.js";
import {
  START_HUDDLE_ENTITY_POLICY_ACTION,
  StartHuddleCommandError,
  startHuddle,
} from "./start-huddle-command.js";
import {
  JOIN_HUDDLE_ENTITY_POLICY_ACTION,
  JoinHuddleCommandError,
  joinHuddle,
} from "./join-huddle-command.js";
import {
  LEAVE_HUDDLE_ENTITY_POLICY_ACTION,
  LeaveHuddleCommandError,
  leaveHuddle,
} from "./leave-huddle-command.js";
import {
  HUDDLE_SCREEN_SHARE_ENTITY_POLICY_ACTION,
  SetHuddleScreenShareCommandError,
  setHuddleScreenShare,
} from "./set-huddle-screen-share-command.js";
import {
  END_HUDDLE_ENTITY_POLICY_ACTION,
  EndHuddleCommandError,
  endHuddle,
} from "./end-huddle-command.js";
import {
  SoftDeleteMessageCommandError,
  softDeleteMessage,
} from "./soft-delete-message-command.js";
import {
  SET_REACTION_ENTITY_POLICY_ACTION,
  SetReactionCommandError,
  setReaction,
} from "./set-reaction-command.js";
import {
  SET_SAVED_MESSAGE_ENTITY_POLICY_ACTION,
  SetSavedMessageCommandError,
  setSavedMessage,
} from "./set-saved-message-command.js";
import {
  SAVED_MESSAGE_LIST_ENTITY_POLICY_ACTION,
  querySavedMessageList,
} from "./saved-message-list-query.js";
import {
  MESSAGE_REMINDER_LIST_ENTITY_POLICY_ACTION,
  queryMessageReminderList,
} from "./message-reminder-list-query.js";
import {
  SET_MESSAGE_REMINDER_ENTITY_POLICY_ACTION,
  SetMessageReminderCommandError,
  setMessageReminder,
} from "./set-message-reminder-command.js";
import {
  SET_THREAD_FOLLOW_ENTITY_POLICY_ACTION,
  SetThreadFollowCommandError,
  setThreadFollow,
} from "./set-thread-follow-command.js";
import {
  UpdateThreadLifecycleCommandError,
  updateThreadLifecycle,
} from "./update-thread-lifecycle-command.js";
import {
  UpdateReadCursorCommandError,
  updateReadCursor,
} from "./update-read-cursor-command.js";
import {
  UpdateConversationPreferenceCommandError,
  updateConversationPreference,
} from "./update-conversation-preference-command.js";
import {
  DevicePushTokenCommandError,
  updateDevicePushToken,
} from "./device-push-token-command.js";
import {
  SynchronizeDraftCommandError,
  synchronizeDraft,
} from "./synchronize-draft-command.js";
import {
  createChatAuditDispatcher,
  normalizeChatAuditDispatcherOptions,
  type ChatAuditDispatcher,
  type ChatAuditDispatcherOptions,
  type NormalizedChatAuditDispatcherOptions,
} from "./audit-dispatcher.js";
import {
  createChatAttachmentCleanupDispatcher,
  normalizeChatAttachmentCleanupDispatcherOptions,
  type ChatAttachmentCleanupBatchResult,
  type ChatAttachmentCleanupDispatcher,
  type ChatAttachmentCleanupDispatcherOptions,
  type NormalizedChatAttachmentCleanupDispatcherOptions,
} from "./attachment-cleanup-dispatcher.js";
import {
  createChatNotificationDispatcher,
  normalizeChatNotificationDispatcherOptions,
  type ChatNotificationDispatcher,
  type ChatNotificationDispatcherOptions,
  type NormalizedChatNotificationDispatcherOptions,
} from "./notification-dispatcher.js";
import {
  createPostgresMigrationRunner,
  DEFAULT_POSTGRES_SCHEMA,
  validatePostgresSchema,
  type PostgresMigrationDatabase,
} from "./postgres-migrations.js";
import {
  createExpiredIdempotencyKeyMaintenanceJob,
  createExpiredOutboxEventMaintenanceJob,
  createExpiredPendingAttachmentMaintenanceJob,
  createPostgresMaintenance,
  normalizeChatPostgresMaintenanceOptions,
  type ChatPostgresMaintenanceOptions,
  type NormalizedChatPostgresMaintenanceOptions,
  type PostgresMaintenance,
} from "./postgres-maintenance.js";
import {
  PREPARE_ATTACHMENT_ENTITY_POLICY_ACTION,
  PrepareAttachmentCommandError,
  prepareAttachment,
} from "./prepare-attachment-command.js";
import {
  AbortAttachmentCommandError,
  abortAttachment,
} from "./abort-attachment-command.js";
import {
  ATTACHMENT_DOWNLOAD_ENTITY_POLICY_ACTION,
  AttachmentDownloadQueryError,
  queryAttachmentDownload,
} from "./attachment-download-query.js";
import {
  FinalizeAttachmentCommandError,
  finalizeAttachment,
} from "./finalize-attachment-command.js";
import { readBoundedJsonBody } from "./bounded-json-body.js";
import {
  createChatOutboxPublisher,
  createLocalChatRealtimeHub,
  normalizeChatOutboxOptions,
  type ChatLocalRealtimeHub,
  type ChatOutboxOptions,
  type ChatOutboxPublisher,
  type NormalizedChatOutboxOptions,
} from "./outbox-publisher.js";
import {
  chatUserReplyStylePreferencesMigration,
  handrailChatPostgresMigrations,
} from "./postgres-schema-migrations.js";
import {
  REPLY_STYLE_PREFERENCE_FEATURE,
  parseGetReplyStylePreferenceInput,
  parseUpdateReplyStylePreferenceInput,
} from "../contracts/reply-style-preference.js";
import { queryReplyStylePreference } from "./reply-style-preference-query.js";
import {
  UpdateReplyStylePreferenceCommandError,
  updateReplyStylePreference,
} from "./update-reply-style-preference-command.js";
import {
  ChatAuthenticationError,
  ChatAuthorizationError,
  resolveChatRequestContext,
} from "./request-context.js";
import {
  DEFAULT_CHAT_WEBSOCKET_HANDSHAKE_TIMEOUT_MS,
  DEFAULT_CHAT_WEBSOCKET_SESSION_REVALIDATION_INTERVAL_MS,
  DEFAULT_CHAT_WEBSOCKET_MAX_CONNECTIONS,
  DEFAULT_CHAT_WEBSOCKET_MAX_CONNECTIONS_PER_TENANT,
  DEFAULT_CHAT_WEBSOCKET_MAX_PENDING_EVENTS,
  DEFAULT_CHAT_WEBSOCKET_PATH,
  MAX_CHAT_WEBSOCKET_SESSION_REVALIDATION_INTERVAL_MS,
  MIN_CHAT_WEBSOCKET_SESSION_REVALIDATION_INTERVAL_MS,
  createChatWebSocketController,
  type ChatWebSocketOptions,
  type ChatWebSocketServer,
  type NormalizedChatWebSocketOptions,
} from "./websocket-upgrade.js";
import { DEFAULT_CHAT_WEBSOCKET_MAX_REPLAY_EVENTS } from "./websocket-replay.js";
import type { ChatWebSocketSubscriptionRevalidationScope } from "./websocket-subscriptions.js";
import {
  createChatEphemeralSignalController,
  normalizeChatEphemeralSignalOptions,
  type ChatEphemeralSignalOptions,
  type NormalizedChatEphemeralSignalOptions,
} from "./websocket-ephemeral-signals.js";

const packageManifest = createRequire(import.meta.url)("../../package.json") as {
  readonly version: string;
};

const PACKAGE_VERSION = packageManifest.version;

export const HOST_DIRECTORY_BATCH_ROUTE = "/directory/users:batch" as const;
export const HOST_DIRECTORY_SEARCH_ROUTE = "/directory/users/search" as const;
export const CONVERSATION_LIST_ROUTE = "/conversations" as const;
const REPLY_STYLE_PREFERENCE_ROUTE = "/preferences/reply-style" as const;
export const CONVERSATION_DETAIL_ROUTE_PREFIX = "/conversations/" as const;
export const CONVERSATION_ARCHIVE_ROUTE_SUFFIX = "/lifecycle" as const;
export const CONVERSATION_MEMBERSHIP_ROUTE_SUFFIX = "/membership" as const;
export const CONVERSATION_PREFERENCE_ROUTE_SUFFIX = "/preference" as const;
export const DEVICE_PUSH_TOKEN_ROUTE =
  DEVICE_PUSH_TOKEN_PATH;
export const THREAD_FOLLOW_ROUTE_SUFFIX = "/follow" as const;
export const READ_CURSOR_ROUTE_SUFFIX = "/read-cursor" as const;
export const DRAFT_SYNCHRONIZATION_ROUTE_SUFFIX = "/draft" as const;
export const CONVERSATION_DRAFT_SNAPSHOT_ROUTE =
  "/conversations/:conversationId/draft" as const;
export const MESSAGE_TIMELINE_ROUTE_SUFFIX = "/messages" as const;
export const MESSAGE_SEARCH_ROUTE = "/messages/search" as const;
export const FORWARD_MESSAGE_ROUTE = "/messages/forward" as const;
export const MESSAGE_EDIT_ROUTE_PREFIX = "/messages/" as const;
export const MESSAGE_DELETE_ROUTE_PREFIX = "/messages/" as const;
export const MESSAGE_REACTION_ROUTE_PREFIX = "/messages/" as const;
export const MESSAGE_REACTION_ROUTE_SEGMENT = "/reactions/" as const;
export const SAVED_MESSAGE_ROUTE = "/messages/:messageId/saved" as const;
export const SAVED_MESSAGE_LIST_ROUTE = "/saved-messages" as const;
export const MESSAGE_REMINDER_ROUTE =
  "/conversations/:conversationId/messages/:messageId/reminder" as const;
export const MESSAGE_REMINDER_LIST_ROUTE = "/message-reminders" as const;
export const THREAD_CREATION_ROUTE_PREFIX = "/messages/" as const;
export const THREAD_CREATION_ROUTE_SUFFIX = "/thread" as const;
export const PREPARE_ATTACHMENT_ROUTE =
  "/conversations/:conversationId/attachments" as const;
export const ACTIVE_HUDDLE_SNAPSHOT_ROUTE =
  "/conversations/:conversationId/huddle" as const;
export const START_HUDDLE_ROUTE =
  "/conversations/:conversationId/huddles" as const;
export const JOIN_HUDDLE_ROUTE =
  "/huddles/:huddleSessionId/join" as const;
export const LEAVE_HUDDLE_ROUTE =
  "/huddles/:huddleSessionId/leave" as const;
export const HUDDLE_SCREEN_SHARE_ROUTE =
  "/huddles/:huddleSessionId/screen-share" as const;
export const END_HUDDLE_ROUTE =
  "/huddles/:huddleSessionId/end" as const;
export const ATTACHMENT_LIFECYCLE_ROUTE =
  "/attachments/:attachmentId/lifecycle" as const;
export const ATTACHMENT_DOWNLOAD_ROUTE =
  "/attachments/:attachmentId/download" as const;
export const CONVERSATION_SNAPSHOT_LIMIT_HEADER =
  "x-handrail-page-limit" as const;
export const CONVERSATION_SNAPSHOT_NEXT_CURSOR_HEADER =
  "x-handrail-next-cursor" as const;
export const MESSAGE_TIMELINE_LIMIT_HEADER =
  "x-handrail-page-limit" as const;
export const HOST_DIRECTORY_LOOKUP_POLICY_ACTION =
  "directory.lookup" as const;
export const HOST_DIRECTORY_SEARCH_POLICY_ACTION =
  "directory.search" as const;
export const HOST_DIRECTORY_RATE_LIMIT_REQUESTS = 30 as const;
export const HOST_DIRECTORY_RATE_LIMIT_WINDOW_MS = 60_000 as const;
export {
  CHAT_REQUEST_ADMISSION_DENIED_CODE,
  CHAT_REQUEST_ADMISSION_DENIED_MESSAGE,
};
export const CHAT_HTTP_REQUEST_ID_HEADER = "x-handrail-request-id" as const;
export const MAX_CHAT_HTTP_REQUEST_ID_UTF8_BYTES = 128 as const;
export const CHAT_HTTP_CLIENT_DISCONNECTED_CODE =
  "chat_client_disconnected" as const;
export const CHAT_HTTP_RESPONSE_ERROR_CODE = "chat_response_error" as const;
export const CHAT_HTTP_INTERNAL_ERROR_CODE = "chat_internal_error" as const;
export const DEFAULT_HOST_DIRECTORY_SEARCH_LIMIT = 25 as const;
export const DEFAULT_MESSAGE_TIMELINE_LIMIT = 50 as const;
export const MAX_HOST_DIRECTORY_REQUEST_BYTES = 64 * 1_024;
export const MAX_HOST_DIRECTORY_RESPONSE_BYTES = 256 * 1_024;
export const MAX_CONVERSATION_CREATION_REQUEST_BYTES = 64 * 1_024;
export const MAX_CONVERSATION_CREATION_RESPONSE_BYTES = 1_024 * 1_024;
export const MAX_CONVERSATION_ARCHIVE_REQUEST_BYTES = 64 * 1_024;
export const MAX_CONVERSATION_ARCHIVE_RESPONSE_BYTES = 64 * 1_024;
export const MAX_CONVERSATION_MEMBERSHIP_REQUEST_BYTES = 64 * 1_024;
export const MAX_CONVERSATION_MEMBERSHIP_RESPONSE_BYTES = 1_024 * 1_024;
export const MAX_CONVERSATION_PREFERENCE_REQUEST_BYTES = 64 * 1_024;
export const MAX_CONVERSATION_PREFERENCE_RESPONSE_BYTES = 64 * 1_024;
export const MAX_DEVICE_PUSH_TOKEN_REQUEST_BYTES = 64 * 1_024;
export const MAX_DEVICE_PUSH_TOKEN_RESPONSE_BYTES = 64 * 1_024;
export const MAX_THREAD_FOLLOW_REQUEST_BYTES = 64 * 1_024;
export const MAX_THREAD_FOLLOW_RESPONSE_BYTES = 64 * 1_024;
export const MAX_READ_CURSOR_REQUEST_BYTES = 64 * 1_024;
export const MAX_READ_CURSOR_RESPONSE_BYTES = 64 * 1_024;
export const MAX_DRAFT_SYNCHRONIZATION_REQUEST_BYTES = 96 * 1_024;
export const MAX_DRAFT_SYNCHRONIZATION_RESPONSE_BYTES = 96 * 1_024;
export const MAX_CONVERSATION_DRAFT_SNAPSHOT_RESPONSE_BYTES = 96 * 1_024;
export const MAX_THREAD_CREATION_REQUEST_BYTES = 64 * 1_024;
export const MAX_THREAD_CREATION_RESPONSE_BYTES = 1_024 * 1_024;
export const MAX_SEND_MESSAGE_REQUEST_BYTES = 64 * 1_024;
export const MAX_SEND_MESSAGE_RESPONSE_BYTES = 1_024 * 1_024;
export const MAX_FORWARD_MESSAGE_REQUEST_BYTES = 64 * 1_024;
export const MAX_FORWARD_MESSAGE_RESPONSE_BYTES = 1_024 * 1_024;
export const MAX_PREPARE_ATTACHMENT_REQUEST_BYTES = 64 * 1_024;
export const MAX_PREPARE_ATTACHMENT_RESPONSE_BYTES = 64 * 1_024;
export const MAX_START_HUDDLE_REQUEST_BYTES = 64 * 1_024;
export const MAX_START_HUDDLE_RESPONSE_BYTES = 64 * 1_024;
export const MAX_JOIN_HUDDLE_REQUEST_BYTES = 64 * 1_024;
export const MAX_JOIN_HUDDLE_RESPONSE_BYTES = 16 * 1_024;
export const MAX_LEAVE_HUDDLE_REQUEST_BYTES = 64 * 1_024;
export const MAX_LEAVE_HUDDLE_RESPONSE_BYTES = 64 * 1_024;
export const MAX_HUDDLE_SCREEN_SHARE_REQUEST_BYTES = 64 * 1_024;
export const MAX_HUDDLE_SCREEN_SHARE_RESPONSE_BYTES = 64 * 1_024;
export const MAX_END_HUDDLE_REQUEST_BYTES = 64 * 1_024;
export const MAX_END_HUDDLE_RESPONSE_BYTES = 64 * 1_024;
export const MAX_ATTACHMENT_LIFECYCLE_REQUEST_BYTES = 64 * 1_024;
export const MAX_ATTACHMENT_LIFECYCLE_RESPONSE_BYTES = 64 * 1_024;
export const MAX_ATTACHMENT_DOWNLOAD_RESPONSE_BYTES = 64 * 1_024;
export const MAX_EDIT_MESSAGE_REQUEST_BYTES = 64 * 1_024;
export const MAX_EDIT_MESSAGE_RESPONSE_BYTES = 1_024 * 1_024;
export const MAX_DELETE_MESSAGE_REQUEST_BYTES = 64 * 1_024;
export const MAX_DELETE_MESSAGE_RESPONSE_BYTES = 1_024 * 1_024;
export const MAX_REACTION_MUTATION_REQUEST_BYTES = 64 * 1_024;
export const MAX_REACTION_MUTATION_RESPONSE_BYTES = 64 * 1_024;
export const MAX_SAVED_MESSAGE_REQUEST_BYTES = 64 * 1_024;
export const MAX_SAVED_MESSAGE_RESPONSE_BYTES = 64 * 1_024;
export const MAX_SAVED_MESSAGE_LIST_RESPONSE_BYTES = 1_024 * 1_024;
export const MAX_MESSAGE_REMINDER_REQUEST_BYTES = 64 * 1_024;
export const MAX_MESSAGE_REMINDER_RESPONSE_BYTES = 64 * 1_024;
export const MAX_MESSAGE_REMINDER_LIST_RESPONSE_BYTES = 1_024 * 1_024;
export const MAX_CONVERSATION_SNAPSHOT_RESPONSE_BYTES = 1_024 * 1_024;
export const MAX_MESSAGE_TIMELINE_RESPONSE_BYTES = 1_024 * 1_024;
export const MAX_MESSAGE_SEARCH_REQUEST_BYTES = 64 * 1_024;
export const MAX_MESSAGE_SEARCH_RESPONSE_BYTES = 2 * 1_024 * 1_024;
export const MAX_ACTIVE_HUDDLE_SNAPSHOT_RESPONSE_BYTES = 1_024 * 1_024;

export const CHAT_DIRECTORY_INVALID_REQUEST_CODE =
  "CHAT_DIRECTORY_INVALID_REQUEST" as const;
export const CHAT_DIRECTORY_RATE_LIMITED_CODE =
  "CHAT_DIRECTORY_RATE_LIMITED" as const;
export const CHAT_DIRECTORY_UNAVAILABLE_CODE =
  "CHAT_DIRECTORY_UNAVAILABLE" as const;
export const CHAT_CONVERSATION_SNAPSHOT_INVALID_REQUEST_CODE =
  "CHAT_CONVERSATION_SNAPSHOT_INVALID_REQUEST" as const;
export const CHAT_CONVERSATION_SNAPSHOT_UNAVAILABLE_CODE =
  "CHAT_CONVERSATION_SNAPSHOT_UNAVAILABLE" as const;
export const CHAT_CONVERSATION_CREATION_INVALID_REQUEST_CODE =
  "CHAT_CONVERSATION_CREATION_INVALID_REQUEST" as const;
export const CHAT_CONVERSATION_CREATION_CONFLICT_CODE =
  "CHAT_CONVERSATION_CREATION_CONFLICT" as const;
export const CHAT_CONVERSATION_CREATION_MEMBER_UNAVAILABLE_CODE =
  "CHAT_CONVERSATION_CREATION_MEMBER_UNAVAILABLE" as const;
export const CHAT_CONVERSATION_CREATION_UNAVAILABLE_CODE =
  "CHAT_CONVERSATION_CREATION_UNAVAILABLE" as const;
export const CHAT_CONVERSATION_ARCHIVE_INVALID_REQUEST_CODE =
  "CHAT_CONVERSATION_ARCHIVE_INVALID_REQUEST" as const;
export const CHAT_CONVERSATION_ARCHIVE_CONFLICT_CODE =
  "CHAT_CONVERSATION_ARCHIVE_CONFLICT" as const;
export const CHAT_CONVERSATION_ARCHIVE_UNAVAILABLE_CODE =
  "CHAT_CONVERSATION_ARCHIVE_UNAVAILABLE" as const;
export const CHAT_CONVERSATION_MEMBERSHIP_INVALID_REQUEST_CODE =
  "CHAT_CONVERSATION_MEMBERSHIP_INVALID_REQUEST" as const;
export const CHAT_CONVERSATION_MEMBERSHIP_CONFLICT_CODE =
  "CHAT_CONVERSATION_MEMBERSHIP_CONFLICT" as const;
export const CHAT_CONVERSATION_MEMBERSHIP_INVARIANT_CODE =
  "CHAT_CONVERSATION_MEMBERSHIP_INVARIANT" as const;
export const CHAT_CONVERSATION_MEMBERSHIP_MEMBER_UNAVAILABLE_CODE =
  "CHAT_CONVERSATION_MEMBERSHIP_MEMBER_UNAVAILABLE" as const;
export const CHAT_CONVERSATION_MEMBERSHIP_UNAVAILABLE_CODE =
  "CHAT_CONVERSATION_MEMBERSHIP_UNAVAILABLE" as const;
export const CHAT_CONVERSATION_PREFERENCE_INVALID_REQUEST_CODE =
  "CHAT_CONVERSATION_PREFERENCE_INVALID_REQUEST" as const;
export const CHAT_CONVERSATION_PREFERENCE_CONFLICT_CODE =
  "CHAT_CONVERSATION_PREFERENCE_CONFLICT" as const;
export const CHAT_CONVERSATION_PREFERENCE_UNAVAILABLE_CODE =
  "CHAT_CONVERSATION_PREFERENCE_UNAVAILABLE" as const;
export const CHAT_DEVICE_PUSH_TOKEN_INVALID_REQUEST_CODE =
  "CHAT_DEVICE_PUSH_TOKEN_INVALID_REQUEST" as const;
export const CHAT_DEVICE_PUSH_TOKEN_CONFLICT_CODE =
  "CHAT_DEVICE_PUSH_TOKEN_CONFLICT" as const;
export const CHAT_DEVICE_PUSH_TOKEN_UNAVAILABLE_CODE =
  "CHAT_DEVICE_PUSH_TOKEN_UNAVAILABLE" as const;
export const CHAT_THREAD_FOLLOW_INVALID_REQUEST_CODE =
  "CHAT_THREAD_FOLLOW_INVALID_REQUEST" as const;
export const CHAT_THREAD_FOLLOW_CONFLICT_CODE =
  "CHAT_THREAD_FOLLOW_CONFLICT" as const;
export const CHAT_THREAD_FOLLOW_UNAVAILABLE_CODE =
  "CHAT_THREAD_FOLLOW_UNAVAILABLE" as const;
export const CHAT_READ_CURSOR_INVALID_REQUEST_CODE =
  "CHAT_READ_CURSOR_INVALID_REQUEST" as const;
export const CHAT_READ_CURSOR_SEQUENCE_CONFLICT_CODE =
  "CHAT_READ_CURSOR_SEQUENCE_CONFLICT" as const;
export const CHAT_READ_CURSOR_CONFLICT_CODE =
  "CHAT_READ_CURSOR_CONFLICT" as const;
export const CHAT_READ_CURSOR_UNAVAILABLE_CODE =
  "CHAT_READ_CURSOR_UNAVAILABLE" as const;
export const CHAT_DRAFT_SYNCHRONIZATION_INVALID_REQUEST_CODE =
  "CHAT_DRAFT_SYNCHRONIZATION_INVALID_REQUEST" as const;
export const CHAT_DRAFT_SYNCHRONIZATION_CONFLICT_CODE =
  "CHAT_DRAFT_SYNCHRONIZATION_CONFLICT" as const;
export const CHAT_DRAFT_SYNCHRONIZATION_UNAVAILABLE_CODE =
  "CHAT_DRAFT_SYNCHRONIZATION_UNAVAILABLE" as const;
export const CHAT_THREAD_CREATION_INVALID_REQUEST_CODE =
  "CHAT_THREAD_CREATION_INVALID_REQUEST" as const;
export const CHAT_THREAD_CREATION_CONFLICT_CODE =
  "CHAT_THREAD_CREATION_CONFLICT" as const;
export const CHAT_THREAD_CREATION_UNAVAILABLE_CODE =
  "CHAT_THREAD_CREATION_UNAVAILABLE" as const;
export const CHAT_MESSAGE_SEND_INVALID_REQUEST_CODE =
  "CHAT_MESSAGE_SEND_INVALID_REQUEST" as const;
export const CHAT_MESSAGE_SEND_CONFLICT_CODE =
  "CHAT_MESSAGE_SEND_CONFLICT" as const;
export const CHAT_MESSAGE_SEND_MENTION_UNAVAILABLE_CODE =
  "CHAT_MESSAGE_SEND_MENTION_UNAVAILABLE" as const;
export const CHAT_MESSAGE_SEND_ATTACHMENT_UNAVAILABLE_CODE =
  "CHAT_MESSAGE_SEND_ATTACHMENT_UNAVAILABLE" as const;
export const CHAT_MESSAGE_SEND_UNAVAILABLE_CODE =
  "CHAT_MESSAGE_SEND_UNAVAILABLE" as const;
export const CHAT_MESSAGE_FORWARD_INVALID_REQUEST_CODE =
  "CHAT_MESSAGE_FORWARD_INVALID_REQUEST" as const;
export const CHAT_MESSAGE_FORWARD_CONFLICT_CODE =
  "CHAT_MESSAGE_FORWARD_CONFLICT" as const;
export const CHAT_MESSAGE_FORWARD_SOURCE_UNAVAILABLE_CODE =
  "CHAT_MESSAGE_FORWARD_SOURCE_UNAVAILABLE" as const;
export const CHAT_MESSAGE_FORWARD_DESTINATION_UNAVAILABLE_CODE =
  "CHAT_MESSAGE_FORWARD_DESTINATION_UNAVAILABLE" as const;
export const CHAT_MESSAGE_FORWARD_ATTACHMENTS_UNSUPPORTED_CODE =
  "CHAT_MESSAGE_FORWARD_ATTACHMENTS_UNSUPPORTED" as const;
export const CHAT_MESSAGE_FORWARD_CONTENT_UNSUPPORTED_CODE =
  "CHAT_MESSAGE_FORWARD_CONTENT_UNSUPPORTED" as const;
export const CHAT_MESSAGE_FORWARD_UNAVAILABLE_CODE =
  "CHAT_MESSAGE_FORWARD_UNAVAILABLE" as const;
export const CHAT_ATTACHMENT_PREPARATION_INVALID_REQUEST_CODE =
  "CHAT_ATTACHMENT_PREPARATION_INVALID_REQUEST" as const;
export const CHAT_ATTACHMENT_PREPARATION_CONFLICT_CODE =
  "CHAT_ATTACHMENT_PREPARATION_CONFLICT" as const;
export const CHAT_ATTACHMENT_PREPARATION_UNAVAILABLE_CODE =
  "CHAT_ATTACHMENT_PREPARATION_UNAVAILABLE" as const;
export const CHAT_HUDDLE_START_INVALID_REQUEST_CODE =
  "CHAT_HUDDLE_START_INVALID_REQUEST" as const;
export const CHAT_HUDDLE_START_CONFLICT_CODE =
  "CHAT_HUDDLE_START_CONFLICT" as const;
export const CHAT_HUDDLE_START_UNAVAILABLE_CODE =
  "CHAT_HUDDLE_START_UNAVAILABLE" as const;
export const CHAT_HUDDLE_JOIN_INVALID_REQUEST_CODE =
  "CHAT_HUDDLE_JOIN_INVALID_REQUEST" as const;
export const CHAT_HUDDLE_JOIN_NOT_LIVE_CODE =
  "CHAT_HUDDLE_JOIN_NOT_LIVE" as const;
export const CHAT_HUDDLE_JOIN_CONFLICT_CODE =
  "CHAT_HUDDLE_JOIN_CONFLICT" as const;
export const CHAT_HUDDLE_JOIN_UNAVAILABLE_CODE =
  "CHAT_HUDDLE_JOIN_UNAVAILABLE" as const;
export const CHAT_HUDDLE_LEAVE_INVALID_REQUEST_CODE =
  "CHAT_HUDDLE_LEAVE_INVALID_REQUEST" as const;
export const CHAT_HUDDLE_LEAVE_CONFLICT_CODE =
  "CHAT_HUDDLE_LEAVE_CONFLICT" as const;
export const CHAT_HUDDLE_LEAVE_UNAVAILABLE_CODE =
  "CHAT_HUDDLE_LEAVE_UNAVAILABLE" as const;
export const CHAT_HUDDLE_SCREEN_SHARE_INVALID_REQUEST_CODE =
  "CHAT_HUDDLE_SCREEN_SHARE_INVALID_REQUEST" as const;
export const CHAT_HUDDLE_SCREEN_SHARE_CONFLICT_CODE =
  "CHAT_HUDDLE_SCREEN_SHARE_CONFLICT" as const;
export const CHAT_HUDDLE_SCREEN_SHARE_DISABLED_CODE =
  "CHAT_HUDDLE_SCREEN_SHARE_DISABLED" as const;
export const CHAT_HUDDLE_SCREEN_SHARE_UNAVAILABLE_CODE =
  "CHAT_HUDDLE_SCREEN_SHARE_UNAVAILABLE" as const;
export const CHAT_HUDDLE_END_INVALID_REQUEST_CODE =
  "CHAT_HUDDLE_END_INVALID_REQUEST" as const;
export const CHAT_HUDDLE_END_CONFLICT_CODE =
  "CHAT_HUDDLE_END_CONFLICT" as const;
export const CHAT_HUDDLE_END_UNAVAILABLE_CODE =
  "CHAT_HUDDLE_END_UNAVAILABLE" as const;
export const CHAT_ATTACHMENT_LIFECYCLE_INVALID_REQUEST_CODE =
  "CHAT_ATTACHMENT_LIFECYCLE_INVALID_REQUEST" as const;
export const CHAT_ATTACHMENT_LIFECYCLE_ATTACHMENT_UNAVAILABLE_CODE =
  "CHAT_ATTACHMENT_LIFECYCLE_ATTACHMENT_UNAVAILABLE" as const;
export const CHAT_ATTACHMENT_LIFECYCLE_CONFLICT_CODE =
  "CHAT_ATTACHMENT_LIFECYCLE_CONFLICT" as const;
export const CHAT_ATTACHMENT_LIFECYCLE_UNAVAILABLE_CODE =
  "CHAT_ATTACHMENT_LIFECYCLE_UNAVAILABLE" as const;
export const CHAT_ATTACHMENT_DOWNLOAD_INVALID_REQUEST_CODE =
  "CHAT_ATTACHMENT_DOWNLOAD_INVALID_REQUEST" as const;
export const CHAT_ATTACHMENT_DOWNLOAD_ATTACHMENT_UNAVAILABLE_CODE =
  "CHAT_ATTACHMENT_DOWNLOAD_ATTACHMENT_UNAVAILABLE" as const;
export const CHAT_ATTACHMENT_DOWNLOAD_UNAVAILABLE_CODE =
  "CHAT_ATTACHMENT_DOWNLOAD_UNAVAILABLE" as const;
export const CHAT_MESSAGE_EDIT_INVALID_REQUEST_CODE =
  "CHAT_MESSAGE_EDIT_INVALID_REQUEST" as const;
export const CHAT_MESSAGE_EDIT_CONFLICT_CODE =
  "CHAT_MESSAGE_EDIT_CONFLICT" as const;
export const CHAT_MESSAGE_EDIT_UNAVAILABLE_CODE =
  "CHAT_MESSAGE_EDIT_UNAVAILABLE" as const;
export const CHAT_MESSAGE_DELETE_INVALID_REQUEST_CODE =
  "CHAT_MESSAGE_DELETE_INVALID_REQUEST" as const;
export const CHAT_MESSAGE_DELETE_CONFLICT_CODE =
  "CHAT_MESSAGE_DELETE_CONFLICT" as const;
export const CHAT_MESSAGE_DELETE_UNAVAILABLE_CODE =
  "CHAT_MESSAGE_DELETE_UNAVAILABLE" as const;
export const CHAT_MESSAGE_REACTION_INVALID_REQUEST_CODE =
  "CHAT_MESSAGE_REACTION_INVALID_REQUEST" as const;
export const CHAT_MESSAGE_REACTION_CONFLICT_CODE =
  "CHAT_MESSAGE_REACTION_CONFLICT" as const;
export const CHAT_MESSAGE_REACTION_UNAVAILABLE_CODE =
  "CHAT_MESSAGE_REACTION_UNAVAILABLE" as const;
export const CHAT_SAVED_MESSAGE_INVALID_REQUEST_CODE =
  "CHAT_SAVED_MESSAGE_INVALID_REQUEST" as const;
export const CHAT_SAVED_MESSAGE_CONFLICT_CODE =
  "CHAT_SAVED_MESSAGE_CONFLICT" as const;
export const CHAT_SAVED_MESSAGE_UNAVAILABLE_CODE =
  "CHAT_SAVED_MESSAGE_UNAVAILABLE" as const;
export const CHAT_SAVED_MESSAGE_LIST_INVALID_REQUEST_CODE =
  "CHAT_SAVED_MESSAGE_LIST_INVALID_REQUEST" as const;
export const CHAT_SAVED_MESSAGE_LIST_UNAVAILABLE_CODE =
  "CHAT_SAVED_MESSAGE_LIST_UNAVAILABLE" as const;
export const CHAT_MESSAGE_REMINDER_INVALID_REQUEST_CODE =
  "CHAT_MESSAGE_REMINDER_INVALID_REQUEST" as const;
export const CHAT_MESSAGE_REMINDER_CONFLICT_CODE =
  "CHAT_MESSAGE_REMINDER_CONFLICT" as const;
export const CHAT_MESSAGE_REMINDER_UNAVAILABLE_CODE =
  "CHAT_MESSAGE_REMINDER_UNAVAILABLE" as const;
export const CHAT_MESSAGE_REMINDER_LIST_INVALID_REQUEST_CODE =
  "CHAT_MESSAGE_REMINDER_LIST_INVALID_REQUEST" as const;
export const CHAT_MESSAGE_REMINDER_LIST_UNAVAILABLE_CODE =
  "CHAT_MESSAGE_REMINDER_LIST_UNAVAILABLE" as const;
export const CHAT_MESSAGE_TIMELINE_INVALID_REQUEST_CODE =
  "CHAT_MESSAGE_TIMELINE_INVALID_REQUEST" as const;
export const CHAT_MESSAGE_TIMELINE_UNAVAILABLE_CODE =
  "CHAT_MESSAGE_TIMELINE_UNAVAILABLE" as const;
export const CHAT_MESSAGE_SEARCH_INVALID_REQUEST_CODE =
  "CHAT_MESSAGE_SEARCH_INVALID_REQUEST" as const;
export const CHAT_MESSAGE_SEARCH_UNAVAILABLE_CODE =
  "CHAT_MESSAGE_SEARCH_UNAVAILABLE" as const;
export const CHAT_ACTIVE_HUDDLE_SNAPSHOT_INVALID_REQUEST_CODE =
  "CHAT_ACTIVE_HUDDLE_SNAPSHOT_INVALID_REQUEST" as const;
export const CHAT_ACTIVE_HUDDLE_SNAPSHOT_UNAVAILABLE_CODE =
  "CHAT_ACTIVE_HUDDLE_SNAPSHOT_UNAVAILABLE" as const;
export const CHAT_CONVERSATION_DRAFT_SNAPSHOT_INVALID_REQUEST_CODE =
  "CHAT_CONVERSATION_DRAFT_SNAPSHOT_INVALID_REQUEST" as const;
export const CHAT_CONVERSATION_DRAFT_SNAPSHOT_UNAVAILABLE_CODE =
  "CHAT_CONVERSATION_DRAFT_SNAPSHOT_UNAVAILABLE" as const;

class ChatDirectoryRouteError extends Error {
  public constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ChatDirectoryRouteError";
  }
}

class ChatConversationSnapshotRouteError extends Error {
  public constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ChatConversationSnapshotRouteError";
  }
}

class ChatConversationCreationRouteError extends Error {
  public constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ChatConversationCreationRouteError";
  }
}

class ChatThreadLifecycleRouteError extends Error {
  public constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ChatThreadLifecycleRouteError";
  }
}

class ChatConversationArchiveRouteError extends Error {
  public constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ChatConversationArchiveRouteError";
  }
}

class ChatConversationMembershipRouteError extends Error {
  public constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ChatConversationMembershipRouteError";
  }
}

class ChatConversationPreferenceRouteError extends Error {
  public constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ChatConversationPreferenceRouteError";
  }
}

class ChatDevicePushTokenRouteError extends Error {
  public constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ChatDevicePushTokenRouteError";
  }
}

class ChatThreadFollowRouteError extends Error {
  public constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ChatThreadFollowRouteError";
  }
}

class ChatReadCursorRouteError extends Error {
  public constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ChatReadCursorRouteError";
  }
}

class ChatDraftSynchronizationRouteError extends Error {
  public constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ChatDraftSynchronizationRouteError";
  }
}

class ChatThreadCreationRouteError extends Error {
  public constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ChatThreadCreationRouteError";
  }
}

class ChatMessageSendRouteError extends Error {
  public constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ChatMessageSendRouteError";
  }
}

class ChatMessageForwardRouteError extends Error {
  public constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ChatMessageForwardRouteError";
  }
}

class ChatAttachmentPreparationRouteError extends Error {
  public constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ChatAttachmentPreparationRouteError";
  }
}

class ChatHuddleStartRouteError extends Error {
  public constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ChatHuddleStartRouteError";
  }
}

class ChatHuddleJoinRouteError extends Error {
  public constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ChatHuddleJoinRouteError";
  }
}

class ChatHuddleLeaveRouteError extends Error {
  public constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ChatHuddleLeaveRouteError";
  }
}

class ChatHuddleScreenShareRouteError extends Error {
  public constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ChatHuddleScreenShareRouteError";
  }
}

class ChatHuddleEndRouteError extends Error {
  public constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ChatHuddleEndRouteError";
  }
}

class ChatAttachmentLifecycleRouteError extends Error {
  public constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ChatAttachmentLifecycleRouteError";
  }
}

class ChatAttachmentDownloadRouteError extends Error {
  public constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ChatAttachmentDownloadRouteError";
  }
}

class ChatMessageEditRouteError extends Error {
  public constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ChatMessageEditRouteError";
  }
}

class ChatMessageDeleteRouteError extends Error {
  public constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ChatMessageDeleteRouteError";
  }
}

class ChatMessageReactionRouteError extends Error {
  public constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ChatMessageReactionRouteError";
  }
}

class ChatSavedMessageRouteError extends Error {
  public constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ChatSavedMessageRouteError";
  }
}

class ChatSavedMessageListRouteError extends Error {
  public constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ChatSavedMessageListRouteError";
  }
}

class ChatMessageReminderRouteError extends Error {
  public constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ChatMessageReminderRouteError";
  }
}

class ChatMessageReminderListRouteError extends Error {
  public constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ChatMessageReminderListRouteError";
  }
}

class ChatMessageTimelineRouteError extends Error {
  public constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ChatMessageTimelineRouteError";
  }
}

class ChatMessageContextRouteError extends Error {
  public constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ChatMessageContextRouteError";
  }
}

const invalidMessageContextRequest = (): ChatMessageContextRouteError =>
  new ChatMessageContextRouteError(
    "chat_message_context_invalid_request",
    400,
    "Invalid message context request",
  );
const messageContextUnavailable = (): ChatMessageContextRouteError =>
  new ChatMessageContextRouteError(
    "chat_message_context_unavailable",
    503,
    "Message context temporarily unavailable",
  );

class ChatReplyStylePreferenceRouteError extends Error {
  public constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ChatReplyStylePreferenceRouteError";
  }
}

const invalidReplyStylePreferenceRequest = (): ChatReplyStylePreferenceRouteError =>
  new ChatReplyStylePreferenceRouteError(
    "chat_reply_style_preference_invalid_request",
    400,
    "Invalid reply-style preference request",
  );

const replyStylePreferenceUnavailable = (): ChatReplyStylePreferenceRouteError =>
  new ChatReplyStylePreferenceRouteError(
    "chat_reply_style_preference_unavailable",
    503,
    "Reply-style preference temporarily unavailable",
  );

class ChatThreadListRouteError extends Error {
  public constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ChatThreadListRouteError";
  }
}

const invalidThreadListRequest = (): ChatThreadListRouteError =>
  new ChatThreadListRouteError(
    "chat_thread_list_invalid_request",
    400,
    "Invalid thread list request",
  );
const threadListUnavailable = (): ChatThreadListRouteError =>
  new ChatThreadListRouteError(
    "chat_thread_list_unavailable",
    503,
    "Thread list temporarily unavailable",
  );

class ChatMessageSearchRouteError extends Error {
  public constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ChatMessageSearchRouteError";
  }
}

class ChatActiveHuddleSnapshotRouteError extends Error {
  public constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ChatActiveHuddleSnapshotRouteError";
  }
}

class ChatConversationDraftSnapshotRouteError extends Error {
  public constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ChatConversationDraftSnapshotRouteError";
  }
}

const invalidDirectoryRequest = (): ChatDirectoryRouteError =>
  new ChatDirectoryRouteError(
    CHAT_DIRECTORY_INVALID_REQUEST_CODE,
    400,
    "Invalid directory request",
  );

const directoryRateLimited = (): ChatDirectoryRouteError =>
  new ChatDirectoryRouteError(
    CHAT_DIRECTORY_RATE_LIMITED_CODE,
    429,
    "Directory request rate limit exceeded",
  );

const directoryUnavailable = (): ChatDirectoryRouteError =>
  new ChatDirectoryRouteError(
    CHAT_DIRECTORY_UNAVAILABLE_CODE,
    503,
    "Host directory temporarily unavailable",
  );

const invalidConversationSnapshotRequest =
  (): ChatConversationSnapshotRouteError =>
    new ChatConversationSnapshotRouteError(
      CHAT_CONVERSATION_SNAPSHOT_INVALID_REQUEST_CODE,
      400,
      "Invalid conversation snapshot request",
    );

const conversationSnapshotUnavailable =
  (): ChatConversationSnapshotRouteError =>
    new ChatConversationSnapshotRouteError(
      CHAT_CONVERSATION_SNAPSHOT_UNAVAILABLE_CODE,
      503,
      "Conversation snapshot temporarily unavailable",
    );

const invalidSavedMessageListRequest =
  (): ChatSavedMessageListRouteError =>
    new ChatSavedMessageListRouteError(
      CHAT_SAVED_MESSAGE_LIST_INVALID_REQUEST_CODE,
      400,
      "Invalid saved-message list request",
    );

const savedMessageListUnavailable =
  (): ChatSavedMessageListRouteError =>
    new ChatSavedMessageListRouteError(
      CHAT_SAVED_MESSAGE_LIST_UNAVAILABLE_CODE,
      503,
      "Saved-message list temporarily unavailable",
    );

const invalidActiveHuddleSnapshotRequest =
  (): ChatActiveHuddleSnapshotRouteError =>
    new ChatActiveHuddleSnapshotRouteError(
      CHAT_ACTIVE_HUDDLE_SNAPSHOT_INVALID_REQUEST_CODE,
      400,
      "Invalid active huddle snapshot request",
    );

const activeHuddleSnapshotUnavailable =
  (): ChatActiveHuddleSnapshotRouteError =>
    new ChatActiveHuddleSnapshotRouteError(
      CHAT_ACTIVE_HUDDLE_SNAPSHOT_UNAVAILABLE_CODE,
      503,
      "Active huddle snapshot temporarily unavailable",
    );

const invalidConversationDraftSnapshotRequest =
  (): ChatConversationDraftSnapshotRouteError =>
    new ChatConversationDraftSnapshotRouteError(
      CHAT_CONVERSATION_DRAFT_SNAPSHOT_INVALID_REQUEST_CODE,
      400,
      "Invalid conversation draft snapshot request",
    );

const conversationDraftSnapshotUnavailable =
  (): ChatConversationDraftSnapshotRouteError =>
    new ChatConversationDraftSnapshotRouteError(
      CHAT_CONVERSATION_DRAFT_SNAPSHOT_UNAVAILABLE_CODE,
      503,
      "Conversation draft snapshot temporarily unavailable",
    );

const invalidConversationCreationRequest =
  (): ChatConversationCreationRouteError =>
    new ChatConversationCreationRouteError(
      CHAT_CONVERSATION_CREATION_INVALID_REQUEST_CODE,
      400,
      "Invalid conversation creation request",
    );

const conversationCreationConflict =
  (): ChatConversationCreationRouteError =>
    new ChatConversationCreationRouteError(
      CHAT_CONVERSATION_CREATION_CONFLICT_CODE,
      409,
      "Conversation creation conflicts with current server state",
    );

const conversationCreationMemberUnavailable =
  (): ChatConversationCreationRouteError =>
    new ChatConversationCreationRouteError(
      CHAT_CONVERSATION_CREATION_MEMBER_UNAVAILABLE_CODE,
      422,
      "One or more intended conversation members are unavailable",
    );

const conversationCreationUnavailable =
  (): ChatConversationCreationRouteError =>
    new ChatConversationCreationRouteError(
      CHAT_CONVERSATION_CREATION_UNAVAILABLE_CODE,
      503,
      "Conversation creation temporarily unavailable",
    );

const invalidThreadLifecycleRequest = (): ChatThreadLifecycleRouteError =>
  new ChatThreadLifecycleRouteError(
    "chat_thread_lifecycle_invalid_request",
    400,
    "Invalid thread lifecycle request",
  );

const threadLifecycleConflict = (): ChatThreadLifecycleRouteError =>
  new ChatThreadLifecycleRouteError(
    "chat_thread_lifecycle_conflict",
    409,
    "Thread lifecycle conflicts with current server state",
  );

const threadLifecycleUnavailable = (): ChatThreadLifecycleRouteError =>
  new ChatThreadLifecycleRouteError(
    "chat_thread_lifecycle_unavailable",
    503,
    "Thread lifecycle temporarily unavailable",
  );

const invalidConversationArchiveRequest =
  (): ChatConversationArchiveRouteError =>
    new ChatConversationArchiveRouteError(
      CHAT_CONVERSATION_ARCHIVE_INVALID_REQUEST_CODE,
      400,
      "Invalid conversation archive request",
    );

const conversationArchiveConflict = (): ChatConversationArchiveRouteError =>
  new ChatConversationArchiveRouteError(
    CHAT_CONVERSATION_ARCHIVE_CONFLICT_CODE,
    409,
    "Conversation archive conflicts with current server state",
  );

const conversationArchiveUnavailable =
  (): ChatConversationArchiveRouteError =>
    new ChatConversationArchiveRouteError(
      CHAT_CONVERSATION_ARCHIVE_UNAVAILABLE_CODE,
      503,
      "Conversation archive temporarily unavailable",
    );

const invalidConversationMembershipRequest =
  (): ChatConversationMembershipRouteError =>
    new ChatConversationMembershipRouteError(
      CHAT_CONVERSATION_MEMBERSHIP_INVALID_REQUEST_CODE,
      400,
      "Invalid conversation membership request",
    );

const conversationMembershipConflict =
  (): ChatConversationMembershipRouteError =>
    new ChatConversationMembershipRouteError(
      CHAT_CONVERSATION_MEMBERSHIP_CONFLICT_CODE,
      409,
      "Conversation membership conflicts with current server state",
    );

const conversationMembershipInvariant =
  (): ChatConversationMembershipRouteError =>
    new ChatConversationMembershipRouteError(
      CHAT_CONVERSATION_MEMBERSHIP_INVARIANT_CODE,
      409,
      "Conversation membership invariants prevent this request",
    );

const conversationMembershipMemberUnavailable =
  (): ChatConversationMembershipRouteError =>
    new ChatConversationMembershipRouteError(
      CHAT_CONVERSATION_MEMBERSHIP_MEMBER_UNAVAILABLE_CODE,
      422,
      "The requested conversation member is unavailable",
    );

const conversationMembershipUnavailable =
  (): ChatConversationMembershipRouteError =>
    new ChatConversationMembershipRouteError(
      CHAT_CONVERSATION_MEMBERSHIP_UNAVAILABLE_CODE,
      503,
      "Conversation membership temporarily unavailable",
    );

const invalidConversationPreferenceRequest =
  (): ChatConversationPreferenceRouteError =>
    new ChatConversationPreferenceRouteError(
      CHAT_CONVERSATION_PREFERENCE_INVALID_REQUEST_CODE,
      400,
      "Invalid conversation-preference request",
    );

const conversationPreferenceConflict =
  (): ChatConversationPreferenceRouteError =>
    new ChatConversationPreferenceRouteError(
      CHAT_CONVERSATION_PREFERENCE_CONFLICT_CODE,
      409,
      "Conversation-preference request conflicts with current server state",
    );

const conversationPreferenceUnavailable =
  (): ChatConversationPreferenceRouteError =>
    new ChatConversationPreferenceRouteError(
      CHAT_CONVERSATION_PREFERENCE_UNAVAILABLE_CODE,
      503,
      "Conversation preference temporarily unavailable",
    );

const invalidDevicePushTokenRequest = (): ChatDevicePushTokenRouteError =>
  new ChatDevicePushTokenRouteError(
    CHAT_DEVICE_PUSH_TOKEN_INVALID_REQUEST_CODE,
    400,
    "Invalid device push-token request",
  );

const devicePushTokenConflict = (): ChatDevicePushTokenRouteError =>
  new ChatDevicePushTokenRouteError(
    CHAT_DEVICE_PUSH_TOKEN_CONFLICT_CODE,
    409,
    "Device push-token request conflicts with current server state",
  );

const devicePushTokenUnavailable = (): ChatDevicePushTokenRouteError =>
  new ChatDevicePushTokenRouteError(
    CHAT_DEVICE_PUSH_TOKEN_UNAVAILABLE_CODE,
    503,
    "Device push token temporarily unavailable",
  );

const invalidThreadFollowRequest = (): ChatThreadFollowRouteError =>
  new ChatThreadFollowRouteError(
    CHAT_THREAD_FOLLOW_INVALID_REQUEST_CODE,
    400,
    "Invalid thread-follow request",
  );

const threadFollowConflict = (): ChatThreadFollowRouteError =>
  new ChatThreadFollowRouteError(
    CHAT_THREAD_FOLLOW_CONFLICT_CODE,
    409,
    "Thread-follow request conflicts with current server state",
  );

const threadFollowUnavailable = (): ChatThreadFollowRouteError =>
  new ChatThreadFollowRouteError(
    CHAT_THREAD_FOLLOW_UNAVAILABLE_CODE,
    503,
    "Thread follow temporarily unavailable",
  );

const invalidReadCursorRequest = (): ChatReadCursorRouteError =>
  new ChatReadCursorRouteError(
    CHAT_READ_CURSOR_INVALID_REQUEST_CODE,
    400,
    "Invalid read-cursor request",
  );

const readCursorSequenceConflict = (): ChatReadCursorRouteError =>
  new ChatReadCursorRouteError(
    CHAT_READ_CURSOR_SEQUENCE_CONFLICT_CODE,
    409,
    "Read cursor conflicts with current conversation state",
  );

const readCursorConflict = (): ChatReadCursorRouteError =>
  new ChatReadCursorRouteError(
    CHAT_READ_CURSOR_CONFLICT_CODE,
    409,
    "Read-cursor request conflicts with current server state",
  );

const readCursorUnavailable = (): ChatReadCursorRouteError =>
  new ChatReadCursorRouteError(
    CHAT_READ_CURSOR_UNAVAILABLE_CODE,
    503,
    "Read cursor temporarily unavailable",
  );

const invalidDraftSynchronizationRequest =
  (): ChatDraftSynchronizationRouteError =>
    new ChatDraftSynchronizationRouteError(
      CHAT_DRAFT_SYNCHRONIZATION_INVALID_REQUEST_CODE,
      400,
      "Invalid draft synchronization request",
    );

const draftSynchronizationConflict =
  (): ChatDraftSynchronizationRouteError =>
    new ChatDraftSynchronizationRouteError(
      CHAT_DRAFT_SYNCHRONIZATION_CONFLICT_CODE,
      409,
      "Draft synchronization conflicts with current server state",
    );

const draftSynchronizationUnavailable =
  (): ChatDraftSynchronizationRouteError =>
    new ChatDraftSynchronizationRouteError(
      CHAT_DRAFT_SYNCHRONIZATION_UNAVAILABLE_CODE,
      503,
      "Draft synchronization temporarily unavailable",
    );

const invalidThreadCreationRequest = (): ChatThreadCreationRouteError =>
  new ChatThreadCreationRouteError(
    CHAT_THREAD_CREATION_INVALID_REQUEST_CODE,
    400,
    "Invalid thread creation request",
  );

const threadCreationConflict = (): ChatThreadCreationRouteError =>
  new ChatThreadCreationRouteError(
    CHAT_THREAD_CREATION_CONFLICT_CODE,
    409,
    "Thread creation conflicts with current server state",
  );

const threadCreationUnavailable = (): ChatThreadCreationRouteError =>
  new ChatThreadCreationRouteError(
    CHAT_THREAD_CREATION_UNAVAILABLE_CODE,
    503,
    "Thread creation temporarily unavailable",
  );

const invalidMessageSendRequest = (): ChatMessageSendRouteError =>
  new ChatMessageSendRouteError(
    CHAT_MESSAGE_SEND_INVALID_REQUEST_CODE,
    400,
    "Invalid message send request",
  );

const messageSendConflict = (): ChatMessageSendRouteError =>
  new ChatMessageSendRouteError(
    CHAT_MESSAGE_SEND_CONFLICT_CODE,
    409,
    "Message send conflicts with current server state",
  );

const messageSendMentionUnavailable = (): ChatMessageSendRouteError =>
  new ChatMessageSendRouteError(
    CHAT_MESSAGE_SEND_MENTION_UNAVAILABLE_CODE,
    422,
    "One or more mentioned users are unavailable",
  );

const messageSendAttachmentUnavailable = (): ChatMessageSendRouteError =>
  new ChatMessageSendRouteError(
    CHAT_MESSAGE_SEND_ATTACHMENT_UNAVAILABLE_CODE,
    422,
    "One or more attachments are unavailable",
  );

const messageSendUnavailable = (): ChatMessageSendRouteError =>
  new ChatMessageSendRouteError(
    CHAT_MESSAGE_SEND_UNAVAILABLE_CODE,
    503,
    "Message send temporarily unavailable",
  );

const invalidMessageForwardRequest = (): ChatMessageForwardRouteError =>
  new ChatMessageForwardRouteError(
    CHAT_MESSAGE_FORWARD_INVALID_REQUEST_CODE,
    400,
    "Invalid message forward request",
  );

const messageForwardConflict = (): ChatMessageForwardRouteError =>
  new ChatMessageForwardRouteError(
    CHAT_MESSAGE_FORWARD_CONFLICT_CODE,
    409,
    "Message forward conflicts with current server state",
  );

const messageForwardSourceUnavailable = (): ChatMessageForwardRouteError =>
  new ChatMessageForwardRouteError(
    CHAT_MESSAGE_FORWARD_SOURCE_UNAVAILABLE_CODE,
    404,
    "Source message is unavailable",
  );

const messageForwardDestinationUnavailable =
  (): ChatMessageForwardRouteError =>
    new ChatMessageForwardRouteError(
      CHAT_MESSAGE_FORWARD_DESTINATION_UNAVAILABLE_CODE,
      404,
      "Destination conversation is unavailable",
    );

const messageForwardAttachmentsUnsupported =
  (): ChatMessageForwardRouteError =>
    new ChatMessageForwardRouteError(
      CHAT_MESSAGE_FORWARD_ATTACHMENTS_UNSUPPORTED_CODE,
      422,
      "Source message attachments cannot be forwarded",
    );

const messageForwardContentUnsupported =
  (): ChatMessageForwardRouteError =>
    new ChatMessageForwardRouteError(
      CHAT_MESSAGE_FORWARD_CONTENT_UNSUPPORTED_CODE,
      422,
      "Source message content cannot be forwarded",
    );

const messageForwardUnavailable = (): ChatMessageForwardRouteError =>
  new ChatMessageForwardRouteError(
    CHAT_MESSAGE_FORWARD_UNAVAILABLE_CODE,
    503,
    "Message forward temporarily unavailable",
  );

const invalidAttachmentPreparationRequest =
  (): ChatAttachmentPreparationRouteError =>
    new ChatAttachmentPreparationRouteError(
      CHAT_ATTACHMENT_PREPARATION_INVALID_REQUEST_CODE,
      400,
      "Invalid attachment preparation request",
    );

const attachmentPreparationConflict =
  (): ChatAttachmentPreparationRouteError =>
    new ChatAttachmentPreparationRouteError(
      CHAT_ATTACHMENT_PREPARATION_CONFLICT_CODE,
      409,
      "Attachment preparation conflicts with current server state",
    );

const attachmentPreparationUnavailable =
  (): ChatAttachmentPreparationRouteError =>
    new ChatAttachmentPreparationRouteError(
      CHAT_ATTACHMENT_PREPARATION_UNAVAILABLE_CODE,
      503,
      "Attachment preparation temporarily unavailable",
    );

const invalidHuddleStartRequest = (): ChatHuddleStartRouteError =>
  new ChatHuddleStartRouteError(
    CHAT_HUDDLE_START_INVALID_REQUEST_CODE,
    400,
    "Invalid huddle start request",
  );

const huddleStartConflict = (): ChatHuddleStartRouteError =>
  new ChatHuddleStartRouteError(
    CHAT_HUDDLE_START_CONFLICT_CODE,
    409,
    "Huddle start conflicts with current server state",
  );

const huddleStartUnavailable = (): ChatHuddleStartRouteError =>
  new ChatHuddleStartRouteError(
    CHAT_HUDDLE_START_UNAVAILABLE_CODE,
    503,
    "Huddle start temporarily unavailable",
  );

const invalidHuddleJoinRequest = (): ChatHuddleJoinRouteError =>
  new ChatHuddleJoinRouteError(
    CHAT_HUDDLE_JOIN_INVALID_REQUEST_CODE,
    400,
    "Invalid huddle join request",
  );

const huddleJoinNotLive = (): ChatHuddleJoinRouteError =>
  new ChatHuddleJoinRouteError(
    CHAT_HUDDLE_JOIN_NOT_LIVE_CODE,
    409,
    "Huddle is not available to join",
  );

const huddleJoinConflict = (): ChatHuddleJoinRouteError =>
  new ChatHuddleJoinRouteError(
    CHAT_HUDDLE_JOIN_CONFLICT_CODE,
    409,
    "Huddle join conflicts with current server state",
  );

const huddleJoinUnavailable = (): ChatHuddleJoinRouteError =>
  new ChatHuddleJoinRouteError(
    CHAT_HUDDLE_JOIN_UNAVAILABLE_CODE,
    503,
    "Huddle join temporarily unavailable",
  );

const invalidHuddleLeaveRequest = (): ChatHuddleLeaveRouteError =>
  new ChatHuddleLeaveRouteError(
    CHAT_HUDDLE_LEAVE_INVALID_REQUEST_CODE,
    400,
    "Invalid huddle leave request",
  );

const huddleLeaveConflict = (): ChatHuddleLeaveRouteError =>
  new ChatHuddleLeaveRouteError(
    CHAT_HUDDLE_LEAVE_CONFLICT_CODE,
    409,
    "Huddle leave conflicts with current server state",
  );

const huddleLeaveUnavailable = (): ChatHuddleLeaveRouteError =>
  new ChatHuddleLeaveRouteError(
    CHAT_HUDDLE_LEAVE_UNAVAILABLE_CODE,
    503,
    "Huddle leave temporarily unavailable",
  );

const invalidHuddleScreenShareRequest =
  (): ChatHuddleScreenShareRouteError =>
    new ChatHuddleScreenShareRouteError(
      CHAT_HUDDLE_SCREEN_SHARE_INVALID_REQUEST_CODE,
      400,
      "Invalid huddle screen-share request",
    );

const huddleScreenShareConflict = (): ChatHuddleScreenShareRouteError =>
  new ChatHuddleScreenShareRouteError(
    CHAT_HUDDLE_SCREEN_SHARE_CONFLICT_CODE,
    409,
    "Huddle screen-share request conflicts with current server state",
  );

const huddleScreenShareDisabled = (): ChatHuddleScreenShareRouteError =>
  new ChatHuddleScreenShareRouteError(
    CHAT_HUDDLE_SCREEN_SHARE_DISABLED_CODE,
    403,
    "Huddle screen sharing is disabled",
  );

const huddleScreenShareUnavailable = (): ChatHuddleScreenShareRouteError =>
  new ChatHuddleScreenShareRouteError(
    CHAT_HUDDLE_SCREEN_SHARE_UNAVAILABLE_CODE,
    503,
    "Huddle screen sharing temporarily unavailable",
  );

const invalidHuddleEndRequest = (): ChatHuddleEndRouteError =>
  new ChatHuddleEndRouteError(
    CHAT_HUDDLE_END_INVALID_REQUEST_CODE,
    400,
    "Invalid huddle end request",
  );

const huddleEndConflict = (): ChatHuddleEndRouteError =>
  new ChatHuddleEndRouteError(
    CHAT_HUDDLE_END_CONFLICT_CODE,
    409,
    "Huddle end conflicts with current server state",
  );

const huddleEndUnavailable = (): ChatHuddleEndRouteError =>
  new ChatHuddleEndRouteError(
    CHAT_HUDDLE_END_UNAVAILABLE_CODE,
    503,
    "Huddle end temporarily unavailable",
  );

const invalidAttachmentLifecycleRequest =
  (): ChatAttachmentLifecycleRouteError =>
    new ChatAttachmentLifecycleRouteError(
      CHAT_ATTACHMENT_LIFECYCLE_INVALID_REQUEST_CODE,
      400,
      "Invalid attachment lifecycle request",
    );

const attachmentLifecycleAttachmentUnavailable =
  (): ChatAttachmentLifecycleRouteError =>
    new ChatAttachmentLifecycleRouteError(
      CHAT_ATTACHMENT_LIFECYCLE_ATTACHMENT_UNAVAILABLE_CODE,
      404,
      "Attachment is unavailable",
    );

const attachmentLifecycleConflict =
  (): ChatAttachmentLifecycleRouteError =>
    new ChatAttachmentLifecycleRouteError(
      CHAT_ATTACHMENT_LIFECYCLE_CONFLICT_CODE,
      409,
      "Attachment lifecycle request conflicts with current server state",
    );

const attachmentLifecycleUnavailable =
  (): ChatAttachmentLifecycleRouteError =>
    new ChatAttachmentLifecycleRouteError(
      CHAT_ATTACHMENT_LIFECYCLE_UNAVAILABLE_CODE,
      503,
      "Attachment lifecycle temporarily unavailable",
    );

const invalidAttachmentDownloadRequest =
  (): ChatAttachmentDownloadRouteError =>
    new ChatAttachmentDownloadRouteError(
      CHAT_ATTACHMENT_DOWNLOAD_INVALID_REQUEST_CODE,
      400,
      "Invalid attachment download request",
    );

const attachmentDownloadAttachmentUnavailable =
  (): ChatAttachmentDownloadRouteError =>
    new ChatAttachmentDownloadRouteError(
      CHAT_ATTACHMENT_DOWNLOAD_ATTACHMENT_UNAVAILABLE_CODE,
      404,
      "Attachment is unavailable",
    );

const attachmentDownloadUnavailable =
  (): ChatAttachmentDownloadRouteError =>
    new ChatAttachmentDownloadRouteError(
      CHAT_ATTACHMENT_DOWNLOAD_UNAVAILABLE_CODE,
      503,
      "Attachment download temporarily unavailable",
    );

const invalidMessageEditRequest = (): ChatMessageEditRouteError =>
  new ChatMessageEditRouteError(
    CHAT_MESSAGE_EDIT_INVALID_REQUEST_CODE,
    400,
    "Invalid message edit request",
  );

const messageEditConflict = (): ChatMessageEditRouteError =>
  new ChatMessageEditRouteError(
    CHAT_MESSAGE_EDIT_CONFLICT_CODE,
    409,
    "Message edit conflicts with current server state",
  );

const messageEditUnavailable = (): ChatMessageEditRouteError =>
  new ChatMessageEditRouteError(
    CHAT_MESSAGE_EDIT_UNAVAILABLE_CODE,
    503,
    "Message edit temporarily unavailable",
  );

const invalidMessageDeleteRequest = (): ChatMessageDeleteRouteError =>
  new ChatMessageDeleteRouteError(
    CHAT_MESSAGE_DELETE_INVALID_REQUEST_CODE,
    400,
    "Invalid message delete request",
  );

const messageDeleteConflict = (): ChatMessageDeleteRouteError =>
  new ChatMessageDeleteRouteError(
    CHAT_MESSAGE_DELETE_CONFLICT_CODE,
    409,
    "Message delete conflicts with current server state",
  );

const messageDeleteUnavailable = (): ChatMessageDeleteRouteError =>
  new ChatMessageDeleteRouteError(
    CHAT_MESSAGE_DELETE_UNAVAILABLE_CODE,
    503,
    "Message delete temporarily unavailable",
  );

const invalidMessageReactionRequest = (): ChatMessageReactionRouteError =>
  new ChatMessageReactionRouteError(
    CHAT_MESSAGE_REACTION_INVALID_REQUEST_CODE,
    400,
    "Invalid message reaction request",
  );

const messageReactionConflict = (): ChatMessageReactionRouteError =>
  new ChatMessageReactionRouteError(
    CHAT_MESSAGE_REACTION_CONFLICT_CODE,
    409,
    "Message reaction conflicts with current server state",
  );

const messageReactionUnavailable = (): ChatMessageReactionRouteError =>
  new ChatMessageReactionRouteError(
    CHAT_MESSAGE_REACTION_UNAVAILABLE_CODE,
    503,
    "Message reaction temporarily unavailable",
  );

const invalidSavedMessageRequest = (): ChatSavedMessageRouteError =>
  new ChatSavedMessageRouteError(
    CHAT_SAVED_MESSAGE_INVALID_REQUEST_CODE,
    400,
    "Invalid saved-message request",
  );

const savedMessageConflict = (): ChatSavedMessageRouteError =>
  new ChatSavedMessageRouteError(
    CHAT_SAVED_MESSAGE_CONFLICT_CODE,
    409,
    "Saved-message request conflicts with current server state",
  );

const savedMessageUnavailable = (): ChatSavedMessageRouteError =>
  new ChatSavedMessageRouteError(
    CHAT_SAVED_MESSAGE_UNAVAILABLE_CODE,
    503,
    "Saved message temporarily unavailable",
  );

const invalidMessageReminderRequest = (): ChatMessageReminderRouteError =>
  new ChatMessageReminderRouteError(
    CHAT_MESSAGE_REMINDER_INVALID_REQUEST_CODE,
    400,
    "Invalid message-reminder request",
  );

const messageReminderConflict = (): ChatMessageReminderRouteError =>
  new ChatMessageReminderRouteError(
    CHAT_MESSAGE_REMINDER_CONFLICT_CODE,
    409,
    "Message-reminder request conflicts with current server state",
  );

const messageReminderUnavailable = (): ChatMessageReminderRouteError =>
  new ChatMessageReminderRouteError(
    CHAT_MESSAGE_REMINDER_UNAVAILABLE_CODE,
    503,
    "Message reminder temporarily unavailable",
  );

const invalidMessageReminderListRequest =
  (): ChatMessageReminderListRouteError =>
    new ChatMessageReminderListRouteError(
      CHAT_MESSAGE_REMINDER_LIST_INVALID_REQUEST_CODE,
      400,
      "Invalid message-reminder list request",
    );

const messageReminderListUnavailable =
  (): ChatMessageReminderListRouteError =>
    new ChatMessageReminderListRouteError(
      CHAT_MESSAGE_REMINDER_LIST_UNAVAILABLE_CODE,
      503,
      "Message-reminder list temporarily unavailable",
    );

const invalidMessageTimelineRequest = (): ChatMessageTimelineRouteError =>
  new ChatMessageTimelineRouteError(
    CHAT_MESSAGE_TIMELINE_INVALID_REQUEST_CODE,
    400,
    "Invalid message timeline request",
  );

const messageTimelineUnavailable = (): ChatMessageTimelineRouteError =>
  new ChatMessageTimelineRouteError(
    CHAT_MESSAGE_TIMELINE_UNAVAILABLE_CODE,
    503,
    "Message timeline temporarily unavailable",
  );

const invalidMessageSearchRequest = (): ChatMessageSearchRouteError =>
  new ChatMessageSearchRouteError(
    CHAT_MESSAGE_SEARCH_INVALID_REQUEST_CODE,
    400,
    "Invalid message search request",
  );

const messageSearchUnavailable = (): ChatMessageSearchRouteError =>
  new ChatMessageSearchRouteError(
    CHAT_MESSAGE_SEARCH_UNAVAILABLE_CODE,
    503,
    "Message search temporarily unavailable",
  );

export interface ChatServerFeatures extends Partial<Record<ChatReplyThreadFeature, boolean>> {
  /** Opt-in saved preference API; advertisement also requires persistence readiness. */
  readonly reply_style_preference_v1?: boolean;
  /** Opt-in channel discovery. Does not enable thread lifecycle management. */
  readonly threadDiscovery?: boolean;
  readonly attachments?: boolean;
  readonly notifications?: boolean;
  readonly audit?: boolean;
  readonly realtime?: boolean;
  readonly media?: boolean;
  readonly typing?: boolean;
  readonly presence?: boolean;
}

export type NormalizedChatServerFeatures = Readonly<
  Required<ChatServerFeatures>
>;

export type ChatServerMetadata = ServerHandshakeMetadata<FeatureName>;

export interface ChatServerOwnedDatabase extends PostgresMigrationDatabase {
  end(): Promise<void>;
}

export interface ChatServerPoolFactoryOptions {
  readonly connectionString: string;
}

export type ChatServerPoolFactory = (
  options: ChatServerPoolFactoryOptions,
) => ChatServerOwnedDatabase;

export interface ChatServerOwnedDatabaseConfig {
  readonly connectionString: string;
  readonly schema?: string;
  /** Primarily useful for hosts that wrap pg Pool construction. */
  readonly createPool?: ChatServerPoolFactory;
  readonly pool?: never;
}

export interface ChatServerBorrowedDatabaseConfig {
  readonly pool: PostgresMigrationDatabase;
  readonly schema?: string;
  readonly connectionString?: never;
  readonly createPool?: never;
}

export type ChatServerDatabaseConfig =
  | ChatServerOwnedDatabaseConfig
  | ChatServerBorrowedDatabaseConfig;

export interface CreateChatServerConfig<
  Request = unknown,
  Capability extends string = string,
  EntityAction extends string = string,
> {
  readonly database: ChatServerDatabaseConfig;
  readonly httpObservability?: ChatHttpObservabilityOptions<Request>;
  readonly admission?: ChatRequestAdmissionAdapter<Request>;
  readonly auth: ChatAuthAdapter<Request>;
  readonly directory: ChatDirectoryAdapter;
  readonly permissions: ChatPermissionAdapter<Capability, EntityAction>;
  readonly storage?: ChatStorageAdapter;
  readonly notifications?: ChatNotificationAdapter;
  readonly pushTokenProtector?: ChatPushTokenProtector;
  readonly audit?: ChatAuditAdapter;
  readonly realtime?: ChatRealtimeAdapter;
  readonly media?: ChatMediaAdapter;
  readonly features?: ChatServerFeatures;
  /** Shared per-parent discovery policy; absent/false or invalid results disable hiding. */
  readonly threadInactivityPolicy?: false | ChatThreadInactivityPolicyResolver;
  /** Defaults to single_process; clustered requires realtime publish/subscribe. */
  readonly realtimeDelivery?: ChatRealtimeDelivery;
  readonly outbox?: ChatOutboxOptions;
  readonly postgresMaintenance?: ChatPostgresMaintenanceOptions;
  readonly attachmentCleanup?: ChatAttachmentCleanupDispatcherOptions;
  readonly auditDelivery?: ChatAuditDispatcherOptions;
  readonly notificationDelivery?: ChatNotificationDispatcherOptions;
  readonly ephemeralSignals?: ChatEphemeralSignalOptions;
  readonly webSocket?: ChatWebSocketOptions<Capability, FeatureName>;
}

export interface NormalizedChatHttpObservabilityOptions<Request = unknown> {
  readonly createRequestId: ChatHttpRequestIdProvider<Request> | undefined;
  readonly onOutcome: ChatHttpRequestOutcomeObserver | undefined;
  readonly now: () => number;
}

export interface NormalizedChatServerAdapters<
  Request = unknown,
  Capability extends string = string,
  EntityAction extends string = string,
> {
  readonly admission: ChatRequestAdmissionAdapter<Request> | undefined;
  readonly auth: ChatAuthAdapter<Request>;
  readonly directory: ChatDirectoryAdapter;
  readonly permissions: ChatPermissionAdapter<Capability, EntityAction>;
  readonly storage: ChatStorageAdapter | undefined;
  readonly notifications: ChatNotificationAdapter | undefined;
  readonly pushTokenProtector: ChatPushTokenProtector | undefined;
  readonly audit: ChatAuditAdapter | undefined;
  readonly realtime: ChatRealtimeAdapter | undefined;
  readonly media: ChatMediaAdapter | undefined;
}

export interface NormalizedChatServerConfig<
  Request = unknown,
  Capability extends string = string,
  EntityAction extends string = string,
> {
  readonly database: Readonly<{
    schema: string;
    owned: boolean;
  }>;
  readonly httpObservability: NormalizedChatHttpObservabilityOptions<Request>;
  readonly adapters: NormalizedChatServerAdapters<
    Request,
    Capability,
    EntityAction
  >;
  readonly features: NormalizedChatServerFeatures;
  readonly realtimeDelivery: ChatRealtimeDelivery;
  readonly outbox: NormalizedChatOutboxOptions;
  readonly postgresMaintenance: NormalizedChatPostgresMaintenanceOptions;
  readonly attachmentCleanup: NormalizedChatAttachmentCleanupDispatcherOptions;
  readonly auditDelivery: NormalizedChatAuditDispatcherOptions;
  readonly notificationDelivery: NormalizedChatNotificationDispatcherOptions;
  readonly ephemeralSignals: NormalizedChatEphemeralSignalOptions;
  readonly webSocket: NormalizedChatWebSocketOptions<Capability, FeatureName>;
}

export type ChatRouterNext = (error?: unknown) => void;

/** A Node request listener that can also be mounted as connect-style middleware. */
export type ChatRouter = (
  request: IncomingMessage,
  response: ServerResponse,
  next?: ChatRouterNext,
) => void;

export interface ChatServerRuntime<
  Request = unknown,
  Capability extends string = string,
  EntityAction extends string = string,
> {
  readonly router: ChatRouter;
  readonly database: PostgresMigrationDatabase;
  readonly config: NormalizedChatServerConfig<Request, Capability, EntityAction>;
  /** Server-only policy boundary reserved for authorized thread-list handling. */
  readonly threadListHandlerOptions: ChatThreadListHandlerOptions;
  readonly outboxPublisher: ChatOutboxPublisher;
  readonly postgresMaintenance: PostgresMaintenance;
  /** Undefined when attachment support is disabled. */
  readonly attachmentCleanupDispatcher:
    | ChatAttachmentCleanupDispatcher
    | undefined;
  /** Undefined when audit support is disabled. */
  readonly auditDispatcher: ChatAuditDispatcher | undefined;
  /** Undefined when notification support or its host adapter is absent. */
  readonly notificationDispatcher: ChatNotificationDispatcher | undefined;
  /** In-process fanout used when no external realtime adapter is configured. */
  readonly realtimeHub: ChatLocalRealtimeHub;
  readonly closed: boolean;
  readonly webSocketSessionCount: number;
  readonly webSocketSubscriptionCount: number;
  /** Installs the authenticated upgrade boundary; repeat attachment is idempotent. */
  attachWebSocket(server: ChatWebSocketServer): void;
  /** Removes the upgrade listener and terminates runtime-owned socket resources. */
  detachWebSocket(): void;
  /** Revalidates subscriptions affected by an observed access-state change. */
  revalidateWebSocketSubscriptions(
    scope?: ChatWebSocketSubscriptionRevalidationScope,
  ): Promise<number>;
  /** Runs or joins one attachment cleanup batch without creating another loop. */
  dispatchAttachmentCleanupOnce(): Promise<ChatAttachmentCleanupBatchResult>;
  /** Idempotently releases only resources created by this runtime. */
  close(): Promise<void>;
}

export class ChatServerConfigurationError extends TypeError {
  public constructor(message: string) {
    super(`Invalid chat server configuration: ${message}`);
    this.name = "ChatServerConfigurationError";
  }
}

const FEATURE_NAMES = [
  ...Object.values(REPLY_THREAD_FEATURES),
  "attachments",
  "notifications",
  "audit",
  "realtime",
  "media",
  "typing",
  "presence",
] as const;

type FeatureName = (typeof FEATURE_NAMES)[number];

const FEATURE_ADAPTERS = {
  attachments: "storage",
  notifications: "notifications",
  audit: "audit",
  realtime: "realtime",
  media: "media",
} as const satisfies Partial<
  Record<FeatureName, keyof NormalizedChatServerAdapters>
>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const requireObject = (
  value: unknown,
  path: string,
): Record<string, unknown> => {
  if (!isObject(value)) {
    throw new ChatServerConfigurationError(`${path} must be an object`);
  }
  return value;
};

const requireFunction = (value: unknown, path: string): void => {
  if (typeof value !== "function") {
    throw new ChatServerConfigurationError(`${path} must be a function`);
  }
};

const defaultChatHttpClock = (): number => performance.now();

const normalizeChatHttpObservability = <Request>(
  value: unknown,
): NormalizedChatHttpObservabilityOptions<Request> => {
  if (value === undefined) {
    return Object.freeze({
      createRequestId: undefined,
      onOutcome: undefined,
      now: defaultChatHttpClock,
    });
  }
  const options = requireObject(value, "httpObservability");
  for (const key of Object.keys(options)) {
    if (!["createRequestId", "onOutcome", "now"].includes(key)) {
      throw new ChatServerConfigurationError(
        `httpObservability.${key} is not supported`,
      );
    }
  }
  for (const key of ["createRequestId", "onOutcome", "now"] as const) {
    if (options[key] !== undefined) {
      requireFunction(options[key], `httpObservability.${key}`);
    }
  }
  return Object.freeze({
    createRequestId: options.createRequestId as
      | ChatHttpRequestIdProvider<Request>
      | undefined,
    onOutcome: options.onOutcome as ChatHttpRequestOutcomeObserver | undefined,
    now: (options.now ?? defaultChatHttpClock) as () => number,
  });
};

const validateAdapter = (
  value: unknown,
  path: string,
  methods: readonly string[],
): void => {
  const adapter = requireObject(value, path);
  for (const method of methods) {
    requireFunction(adapter[method], `${path}.${method}`);
  }
};

const normalizeFeatures = (value: unknown): NormalizedChatServerFeatures => {
  const features = value === undefined ? {} : requireObject(value, "features");
  for (const key of Object.keys(features)) {
    if (!(FEATURE_NAMES as readonly string[]).includes(key)) {
      throw new ChatServerConfigurationError(`features.${key} is not supported`);
    }
  }

  const normalized = Object.fromEntries(
    FEATURE_NAMES.map((name) => {
      const configured = features[name];
      if (configured !== undefined && typeof configured !== "boolean") {
        throw new ChatServerConfigurationError(
          `features.${name} must be a boolean`,
        );
      }
      return [name, configured ?? false];
    }),
  ) as unknown as Required<ChatServerFeatures>;

  return Object.freeze(normalized);
};

const normalizeRealtimeDelivery = (value: unknown): ChatRealtimeDelivery => {
  if (value === undefined) return "single_process";
  if (value !== "single_process" && value !== "clustered") {
    throw new ChatServerConfigurationError(
      'realtimeDelivery must be "single_process" or "clustered"',
    );
  }
  return value;
};

const defaultChatWebSocketClock = (): number => performance.now();

const normalizeWebSocketOptions = <Capability extends string>(
  value: unknown,
): NormalizedChatWebSocketOptions<Capability, FeatureName> => {
  const options = value === undefined ? {} : requireObject(value, "webSocket");
  const allowedFields = new Set([
    "path",
    "maxConnections",
    "maxConnectionsPerTenant",
    "handshakeTimeoutMs",
    "sessionRevalidationIntervalMs",
    "maxPendingEvents",
    "maxReplayEvents",
    "onSession",
    "onUpgradeOutcome",
    "now",
  ]);
  for (const field of Object.keys(options)) {
    if (!allowedFields.has(field)) {
      throw new ChatServerConfigurationError(
        `webSocket.${field} is not supported`,
      );
    }
  }

  const path = options.path ?? DEFAULT_CHAT_WEBSOCKET_PATH;
  if (
    typeof path !== "string" ||
    !path.startsWith("/") ||
    path.includes("?") ||
    path.includes("#")
  ) {
    throw new ChatServerConfigurationError(
      "webSocket.path must be an absolute URL path without a query or fragment",
    );
  }

  const readPositiveInteger = (
    field:
      | "maxConnections"
      | "maxConnectionsPerTenant"
      | "handshakeTimeoutMs"
      | "maxPendingEvents"
      | "maxReplayEvents",
    defaultValue: number,
  ): number => {
    const candidate = options[field] ?? defaultValue;
    if (!Number.isSafeInteger(candidate) || (candidate as number) < 1) {
      throw new ChatServerConfigurationError(
        `webSocket.${field} must be a positive safe integer`,
      );
    }
    return candidate as number;
  };

  if (options.onSession !== undefined) {
    requireFunction(options.onSession, "webSocket.onSession");
  }
  if (options.onUpgradeOutcome !== undefined) {
    requireFunction(options.onUpgradeOutcome, "webSocket.onUpgradeOutcome");
  }
  if (options.now !== undefined) {
    requireFunction(options.now, "webSocket.now");
  }

  const sessionRevalidationIntervalMs =
    options.sessionRevalidationIntervalMs === undefined
      ? DEFAULT_CHAT_WEBSOCKET_SESSION_REVALIDATION_INTERVAL_MS
      : options.sessionRevalidationIntervalMs;
  if (
    !Number.isSafeInteger(sessionRevalidationIntervalMs) ||
    (sessionRevalidationIntervalMs as number) <
      MIN_CHAT_WEBSOCKET_SESSION_REVALIDATION_INTERVAL_MS ||
    (sessionRevalidationIntervalMs as number) >
      MAX_CHAT_WEBSOCKET_SESSION_REVALIDATION_INTERVAL_MS
  ) {
    throw new ChatServerConfigurationError(
      `webSocket.sessionRevalidationIntervalMs must be a safe integer between ${MIN_CHAT_WEBSOCKET_SESSION_REVALIDATION_INTERVAL_MS} and ${MAX_CHAT_WEBSOCKET_SESSION_REVALIDATION_INTERVAL_MS}`,
    );
  }

  return Object.freeze({
    path,
    maxConnections: readPositiveInteger(
      "maxConnections",
      DEFAULT_CHAT_WEBSOCKET_MAX_CONNECTIONS,
    ),
    maxConnectionsPerTenant: readPositiveInteger(
      "maxConnectionsPerTenant",
      DEFAULT_CHAT_WEBSOCKET_MAX_CONNECTIONS_PER_TENANT,
    ),
    handshakeTimeoutMs: readPositiveInteger(
      "handshakeTimeoutMs",
      DEFAULT_CHAT_WEBSOCKET_HANDSHAKE_TIMEOUT_MS,
    ),
    sessionRevalidationIntervalMs:
      sessionRevalidationIntervalMs as number,
    maxPendingEvents: readPositiveInteger(
      "maxPendingEvents",
      DEFAULT_CHAT_WEBSOCKET_MAX_PENDING_EVENTS,
    ),
    maxReplayEvents: readPositiveInteger(
      "maxReplayEvents",
      DEFAULT_CHAT_WEBSOCKET_MAX_REPLAY_EVENTS,
    ),
    onSession: options.onSession as
      | NormalizedChatWebSocketOptions<Capability, FeatureName>["onSession"]
      | undefined,
    onUpgradeOutcome: options.onUpgradeOutcome as
      | NormalizedChatWebSocketOptions<
          Capability,
          FeatureName
        >["onUpgradeOutcome"]
      | undefined,
    now: (options.now ?? defaultChatWebSocketClock) as () => number,
  });
};

const normalizeOutboxOptions = (value: unknown): NormalizedChatOutboxOptions => {
  const options = value === undefined ? {} : requireObject(value, "outbox");
  const allowedFields = new Set([
    "batchSize",
    "pollIntervalMs",
    "leaseDurationMs",
    "initialRetryDelayMs",
    "maxRetryDelayMs",
    "onError",
    "onBatch",
  ]);
  for (const field of Object.keys(options)) {
    if (!allowedFields.has(field)) {
      throw new ChatServerConfigurationError(
        `outbox.${field} is not supported`,
      );
    }
  }
  try {
    return normalizeChatOutboxOptions(options);
  } catch (error) {
    throw new ChatServerConfigurationError(
      error instanceof Error ? error.message : "outbox is invalid",
    );
  }
};

const normalizePostgresMaintenanceOptions = (
  value: unknown,
): NormalizedChatPostgresMaintenanceOptions => {
  try {
    return normalizeChatPostgresMaintenanceOptions(
      (value === undefined ? {} : value) as ChatPostgresMaintenanceOptions,
    );
  } catch (error) {
    throw new ChatServerConfigurationError(
      error instanceof Error ? error.message : "postgresMaintenance is invalid",
    );
  }
};

const normalizeAttachmentCleanupOptions = (
  value: unknown,
): NormalizedChatAttachmentCleanupDispatcherOptions => {
  if (Array.isArray(value)) {
    throw new ChatServerConfigurationError(
      "attachmentCleanup must be an object",
    );
  }
  const options =
    value === undefined ? {} : requireObject(value, "attachmentCleanup");
  const allowedFields = new Set([
    "batchSize",
    "pollIntervalMs",
    "leaseDurationMs",
    "maxAttempts",
    "initialRetryDelayMs",
    "maxRetryDelayMs",
    "onError",
    "onBatch",
    "monotonicNow",
  ]);
  for (const field of Object.keys(options)) {
    if (!allowedFields.has(field)) {
      throw new ChatServerConfigurationError(
        `attachmentCleanup.${field} is not supported`,
      );
    }
  }
  try {
    return normalizeChatAttachmentCleanupDispatcherOptions(options);
  } catch (error) {
    throw new ChatServerConfigurationError(
      error instanceof Error ? error.message : "attachmentCleanup is invalid",
    );
  }
};

const normalizeNotificationDeliveryOptions = (
  value: unknown,
): NormalizedChatNotificationDispatcherOptions => {
  const options =
    value === undefined ? {} : requireObject(value, "notificationDelivery");
  const allowedFields = new Set([
    "batchSize",
    "pollIntervalMs",
    "leaseDurationMs",
    "maxAttempts",
    "initialRetryDelayMs",
    "maxRetryDelayMs",
    "isRecipientActive",
    "onError",
    "onBatch",
  ]);
  for (const field of Object.keys(options)) {
    if (!allowedFields.has(field)) {
      throw new ChatServerConfigurationError(
        `notificationDelivery.${field} is not supported`,
      );
    }
  }
  try {
    return normalizeChatNotificationDispatcherOptions(options);
  } catch (error) {
    throw new ChatServerConfigurationError(
      error instanceof Error ? error.message : "notificationDelivery is invalid",
    );
  }
};

const normalizeAuditDeliveryOptions = (
  value: unknown,
): NormalizedChatAuditDispatcherOptions => {
  if (Array.isArray(value)) {
    throw new ChatServerConfigurationError("auditDelivery must be an object");
  }
  const options =
    value === undefined ? {} : requireObject(value, "auditDelivery");
  const allowedFields = new Set([
    "batchSize",
    "pollIntervalMs",
    "leaseDurationMs",
    "initialRetryDelayMs",
    "maxRetryDelayMs",
    "onError",
    "onBatch",
    "monotonicNow",
  ]);
  for (const field of Object.keys(options)) {
    if (!allowedFields.has(field)) {
      throw new ChatServerConfigurationError(
        `auditDelivery.${field} is not supported`,
      );
    }
  }
  try {
    return normalizeChatAuditDispatcherOptions(options);
  } catch (error) {
    throw new ChatServerConfigurationError(
      error instanceof Error ? error.message : "auditDelivery is invalid",
    );
  }
};

const validateDatabase = (value: unknown): {
  readonly source: Record<string, unknown>;
  readonly schema: string;
  readonly owned: boolean;
} => {
  const database = requireObject(value, "database");
  const hasConnectionString = database.connectionString !== undefined;
  const hasPool = database.pool !== undefined;

  if (hasConnectionString === hasPool) {
    throw new ChatServerConfigurationError(
      "database must provide exactly one of connectionString or pool",
    );
  }

  const rawSchema = database.schema ?? DEFAULT_POSTGRES_SCHEMA;
  if (typeof rawSchema !== "string") {
    throw new ChatServerConfigurationError("database.schema must be a string");
  }

  let schema: string;
  try {
    schema = validatePostgresSchema(rawSchema);
  } catch (error) {
    throw new ChatServerConfigurationError(
      error instanceof Error ? `database.${error.message}` : "database.schema is invalid",
    );
  }

  if (hasConnectionString) {
    if (
      typeof database.connectionString !== "string" ||
      database.connectionString.trim().length === 0
    ) {
      throw new ChatServerConfigurationError(
        "database.connectionString must be a non-empty string",
      );
    }
    if (database.createPool !== undefined) {
      requireFunction(database.createPool, "database.createPool");
    }
  } else {
    if (database.createPool !== undefined) {
      throw new ChatServerConfigurationError(
        "database.createPool cannot be used with a borrowed pool",
      );
    }
    validateAdapter(database.pool, "database.pool", ["query", "connect"]);
  }

  return { source: database, schema, owned: hasConnectionString };
};

const createDefaultPool: ChatServerPoolFactory = ({ connectionString }) =>
  new Pool({ connectionString });

const cleanupInvalidOwnedDatabase = (value: unknown): void => {
  if (!isObject(value) || typeof value.end !== "function") {
    return;
  }

  try {
    const result = value.end.call(value) as unknown;
    if (isObject(result) && typeof result.catch === "function") {
      void result.catch(() => undefined);
    }
  } catch {
    // Preserve the configuration error; cleanup was best-effort and already attempted.
  }
};

const readDirectoryJsonBody = async (
  request: IncomingMessage,
): Promise<unknown> =>
  readBoundedJsonBody(
    request,
    MAX_HOST_DIRECTORY_REQUEST_BYTES,
    invalidDirectoryRequest,
  );

const CONVERSATION_CREATION_IDEMPOTENCY_KEY_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const CONVERSATION_CREATION_JSON_CONTENT_TYPE_PATTERN =
  /^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i;

const readConversationCreationIdempotencyKey = (
  request: IncomingMessage,
): string => {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === "idempotency-key") {
      values.push(request.rawHeaders[index + 1] ?? "");
    }
  }
  const value = values[0];
  if (
    values.length !== 1 ||
    value === undefined ||
    !CONVERSATION_CREATION_IDEMPOTENCY_KEY_PATTERN.test(value)
  ) {
    throw invalidConversationCreationRequest();
  }
  return value;
};

const readConversationCreationInput = async (
  request: IncomingMessage,
): Promise<ConversationCreationInput> => {
  let url: URL;
  try {
    url = new URL(request.url ?? "", "http://handrail.invalid");
  } catch {
    throw invalidConversationCreationRequest();
  }
  if (
    url.pathname !== CONVERSATION_LIST_ROUTE ||
    [...url.searchParams].length !== 0
  ) {
    throw invalidConversationCreationRequest();
  }

  const contentType = request.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !CONVERSATION_CREATION_JSON_CONTENT_TYPE_PATTERN.test(contentType)
  ) {
    throw invalidConversationCreationRequest();
  }
  const headerIdempotencyKey =
    readConversationCreationIdempotencyKey(request);

  const decoded = await readBoundedJsonBody(
    request,
    MAX_CONVERSATION_CREATION_REQUEST_BYTES,
    invalidConversationCreationRequest,
  );

  let input: ConversationCreationInput;
  try {
    input = parseConversationCreationInput(decoded);
  } catch (error) {
    if (error instanceof ConversationCreationParseError) {
      throw invalidConversationCreationRequest();
    }
    throw error;
  }
  if (
    !CONVERSATION_CREATION_IDEMPOTENCY_KEY_PATTERN.test(
      input.idempotencyKey,
    ) ||
    input.idempotencyKey !== headerIdempotencyKey
  ) {
    throw invalidConversationCreationRequest();
  }
  return input;
};

// Archive and thread lifecycle have the same public URL shape. Dispatch only
// after reading the bounded body, while retaining the existing admission label.
const CONVERSATION_ARCHIVE_PATH_PATTERN =
  /^\/conversations\/([^/]+)\/lifecycle$/u;

const readConversationArchiveIdempotencyKey = (
  request: IncomingMessage,
): string => {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === "idempotency-key") {
      values.push(request.rawHeaders[index + 1] ?? "");
    }
  }
  const value = values[0];
  if (
    values.length !== 1 ||
    value === undefined ||
    !CONVERSATION_CREATION_IDEMPOTENCY_KEY_PATTERN.test(value)
  ) {
    throw invalidConversationArchiveRequest();
  }
  return value;
};

const readConversationLifecycleInput = async (
  request: IncomingMessage,
): Promise<ConversationArchiveInput | ThreadLifecycleInput> => {
  let url: URL;
  try {
    url = new URL(request.url ?? "", "http://handrail.invalid");
  } catch {
    throw invalidConversationArchiveRequest();
  }
  const match = CONVERSATION_ARCHIVE_PATH_PATTERN.exec(url.pathname);
  const encodedConversationId = match?.[1];
  if (
    encodedConversationId === undefined ||
    [...url.searchParams].length !== 0
  ) {
    throw invalidConversationArchiveRequest();
  }

  let conversationId: string;
  try {
    conversationId = decodeURIComponent(encodedConversationId);
  } catch {
    throw invalidConversationArchiveRequest();
  }
  if (
    conversationId.trim().length === 0 ||
    conversationId.includes("/") ||
    conversationId.includes("\\") ||
    conversationId.includes("\0")
  ) {
    throw invalidConversationArchiveRequest();
  }

  const contentType = request.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !CONVERSATION_CREATION_JSON_CONTENT_TYPE_PATTERN.test(contentType)
  ) {
    throw invalidConversationArchiveRequest();
  }
  const decoded = await readBoundedJsonBody(
    request,
    MAX_CONVERSATION_ARCHIVE_REQUEST_BYTES,
    invalidConversationArchiveRequest,
  );

  if (
    typeof decoded === "object" && decoded !== null &&
    "operation" in decoded && decoded.operation === "update_thread_lifecycle"
  ) {
    try {
      return parseThreadLifecycleHttpInput(conversationId, decoded);
    } catch (error) {
      if (error instanceof ThreadLifecycleParseError) {
        throw invalidThreadLifecycleRequest();
      }
      throw error;
    }
  }

  // The legacy archive contract requires a matching Idempotency-Key header;
  // the lifecycle contract carries its key in the body only.
  const headerIdempotencyKey = readConversationArchiveIdempotencyKey(request);
  let input: ConversationArchiveInput;
  try {
    input = parseConversationArchiveInput(decoded);
  } catch (error) {
    if (error instanceof ConversationArchiveParseError) {
      throw invalidConversationArchiveRequest();
    }
    throw error;
  }
  if (
    input.conversationId !== conversationId ||
    !CONVERSATION_CREATION_IDEMPOTENCY_KEY_PATTERN.test(
      input.idempotencyKey,
    ) ||
    input.idempotencyKey !== headerIdempotencyKey
  ) {
    throw invalidConversationArchiveRequest();
  }
  return input;
};

const CONVERSATION_MEMBERSHIP_PATH_PATTERN =
  /^\/conversations\/([^/]+)\/membership$/u;

const readConversationMembershipIdempotencyKey = (
  request: IncomingMessage,
): string => {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === "idempotency-key") {
      values.push(request.rawHeaders[index + 1] ?? "");
    }
  }
  const value = values[0];
  if (
    values.length !== 1 ||
    value === undefined ||
    !CONVERSATION_CREATION_IDEMPOTENCY_KEY_PATTERN.test(value)
  ) {
    throw invalidConversationMembershipRequest();
  }
  return value;
};

const readConversationMembershipInput = async (
  request: IncomingMessage,
): Promise<ConversationMembershipMutationInput> => {
  let url: URL;
  try {
    url = new URL(request.url ?? "", "http://handrail.invalid");
  } catch {
    throw invalidConversationMembershipRequest();
  }
  const match = CONVERSATION_MEMBERSHIP_PATH_PATTERN.exec(url.pathname);
  const encodedConversationId = match?.[1];
  if (
    encodedConversationId === undefined ||
    [...url.searchParams].length !== 0
  ) {
    throw invalidConversationMembershipRequest();
  }

  let conversationId: string;
  try {
    conversationId = decodeURIComponent(encodedConversationId);
  } catch {
    throw invalidConversationMembershipRequest();
  }
  if (
    conversationId.trim().length === 0 ||
    conversationId.includes("/") ||
    conversationId.includes("\\") ||
    conversationId.includes("\0")
  ) {
    throw invalidConversationMembershipRequest();
  }

  const contentType = request.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !CONVERSATION_CREATION_JSON_CONTENT_TYPE_PATTERN.test(contentType)
  ) {
    throw invalidConversationMembershipRequest();
  }
  const headerIdempotencyKey =
    readConversationMembershipIdempotencyKey(request);

  const decoded = await readBoundedJsonBody(
    request,
    MAX_CONVERSATION_MEMBERSHIP_REQUEST_BYTES,
    invalidConversationMembershipRequest,
  );

  let input: ConversationMembershipMutationInput;
  try {
    input = parseConversationMembershipMutationInput(decoded);
  } catch (error) {
    if (error instanceof ConversationMembershipParseError) {
      throw invalidConversationMembershipRequest();
    }
    throw error;
  }
  if (
    input.conversationId !== conversationId ||
    !CONVERSATION_CREATION_IDEMPOTENCY_KEY_PATTERN.test(
      input.idempotencyKey,
    ) ||
    input.idempotencyKey !== headerIdempotencyKey
  ) {
    throw invalidConversationMembershipRequest();
  }
  return input;
};

const CONVERSATION_PREFERENCE_PATH_PATTERN =
  /^\/conversations\/([^/]+)\/preference$/u;
const CONVERSATION_PREFERENCE_IDEMPOTENCY_KEY_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

const readConversationPreferenceIdempotencyKey = (
  request: IncomingMessage,
): string => {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === "idempotency-key") {
      values.push(request.rawHeaders[index + 1] ?? "");
    }
  }
  const value = values[0];
  if (
    values.length !== 1 ||
    value === undefined ||
    !CONVERSATION_PREFERENCE_IDEMPOTENCY_KEY_PATTERN.test(value) ||
    Buffer.byteLength(value, "utf8") >
      MAX_CONVERSATION_PREFERENCE_IDEMPOTENCY_KEY_UTF8_BYTES
  ) {
    throw invalidConversationPreferenceRequest();
  }
  return value;
};

const readConversationPreferenceInput = async (
  request: IncomingMessage,
): Promise<UpdateConversationPreferenceInput> => {
  let url: URL;
  try {
    url = new URL(request.url ?? "", "http://handrail.invalid");
  } catch {
    throw invalidConversationPreferenceRequest();
  }
  const match = CONVERSATION_PREFERENCE_PATH_PATTERN.exec(url.pathname);
  const encodedConversationId = match?.[1];
  if (
    encodedConversationId === undefined ||
    [...url.searchParams].length !== 0
  ) {
    throw invalidConversationPreferenceRequest();
  }

  let conversationId: string;
  try {
    conversationId = decodeURIComponent(encodedConversationId);
  } catch {
    throw invalidConversationPreferenceRequest();
  }
  if (
    conversationId.trim().length === 0 ||
    conversationId.includes("/") ||
    conversationId.includes("\\") ||
    conversationId.includes("\0")
  ) {
    throw invalidConversationPreferenceRequest();
  }

  const contentType = request.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !CONVERSATION_CREATION_JSON_CONTENT_TYPE_PATTERN.test(contentType)
  ) {
    throw invalidConversationPreferenceRequest();
  }
  const headerIdempotencyKey =
    readConversationPreferenceIdempotencyKey(request);

  const decoded = await readBoundedJsonBody(
    request,
    MAX_CONVERSATION_PREFERENCE_REQUEST_BYTES,
    invalidConversationPreferenceRequest,
  );

  let input: UpdateConversationPreferenceInput;
  try {
    input = parseUpdateConversationPreferenceInput(decoded);
  } catch (error) {
    if (error instanceof ConversationPreferenceMutationParseError) {
      throw invalidConversationPreferenceRequest();
    }
    throw error;
  }
  if (
    input.conversationId !== conversationId ||
    !CONVERSATION_PREFERENCE_IDEMPOTENCY_KEY_PATTERN.test(
      input.idempotencyKey,
    ) ||
    input.idempotencyKey !== headerIdempotencyKey
  ) {
    throw invalidConversationPreferenceRequest();
  }
  return input;
};

const DEVICE_PUSH_TOKEN_PATH_PATTERN =
  /^\/devices\/([^/]+)\/push-token$/u;
const DEVICE_PUSH_TOKEN_IDEMPOTENCY_KEY_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

const readDevicePushTokenIdempotencyKey = (
  request: IncomingMessage,
): string => {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === "idempotency-key") {
      values.push(request.rawHeaders[index + 1] ?? "");
    }
  }
  const value = values[0];
  if (
    values.length !== 1 ||
    value === undefined ||
    !DEVICE_PUSH_TOKEN_IDEMPOTENCY_KEY_PATTERN.test(value) ||
    Buffer.byteLength(value, "utf8") >
      MAX_DEVICE_PUSH_TOKEN_IDEMPOTENCY_KEY_UTF8_BYTES
  ) {
    throw invalidDevicePushTokenRequest();
  }
  return value;
};

const readDevicePushTokenInput = async (
  request: IncomingMessage,
): Promise<DevicePushTokenInput> => {
  let url: URL;
  try {
    url = new URL(request.url ?? "", "http://handrail.invalid");
  } catch {
    throw invalidDevicePushTokenRequest();
  }
  const match = DEVICE_PUSH_TOKEN_PATH_PATTERN.exec(url.pathname);
  const encodedDeviceId = match?.[1];
  if (encodedDeviceId === undefined || [...url.searchParams].length !== 0) {
    throw invalidDevicePushTokenRequest();
  }

  let deviceId: string;
  try {
    deviceId = decodeURIComponent(encodedDeviceId);
  } catch {
    throw invalidDevicePushTokenRequest();
  }
  if (
    deviceId.trim().length === 0 ||
    Buffer.byteLength(deviceId, "utf8") > 255 ||
    deviceId.includes("/") ||
    deviceId.includes("\\") ||
    deviceId.includes("\0")
  ) {
    throw invalidDevicePushTokenRequest();
  }

  const contentType = request.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !CONVERSATION_CREATION_JSON_CONTENT_TYPE_PATTERN.test(contentType)
  ) {
    throw invalidDevicePushTokenRequest();
  }
  const headerIdempotencyKey = readDevicePushTokenIdempotencyKey(request);

  const decoded = await readBoundedJsonBody(
    request,
    MAX_DEVICE_PUSH_TOKEN_REQUEST_BYTES,
    invalidDevicePushTokenRequest,
  );

  let input: DevicePushTokenInput;
  try {
    input = parseDevicePushTokenInput(decoded);
  } catch (error) {
    if (error instanceof DevicePushTokenContractError) {
      throw invalidDevicePushTokenRequest();
    }
    throw error;
  }
  if (
    input.deviceId !== deviceId ||
    !DEVICE_PUSH_TOKEN_IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey) ||
    input.idempotencyKey !== headerIdempotencyKey
  ) {
    throw invalidDevicePushTokenRequest();
  }
  return input;
};

const THREAD_FOLLOW_PATH_PATTERN =
  /^\/conversations\/([^/]+)\/follow$/u;

const readThreadFollowIdempotencyKey = (
  request: IncomingMessage,
): string => {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === "idempotency-key") {
      values.push(request.rawHeaders[index + 1] ?? "");
    }
  }
  const value = values[0];
  if (
    values.length !== 1 ||
    value === undefined ||
    Buffer.byteLength(value, "utf8") >
      MAX_THREAD_FOLLOW_IDEMPOTENCY_KEY_UTF8_BYTES
  ) {
    throw invalidThreadFollowRequest();
  }
  return value;
};

const readThreadFollowInput = async (
  request: IncomingMessage,
): Promise<SetThreadFollowInput> => {
  let url: URL;
  try {
    url = new URL(request.url ?? "", "http://handrail.invalid");
  } catch {
    throw invalidThreadFollowRequest();
  }
  const match = THREAD_FOLLOW_PATH_PATTERN.exec(url.pathname);
  const encodedThreadId = match?.[1];
  if (encodedThreadId === undefined || [...url.searchParams].length !== 0) {
    throw invalidThreadFollowRequest();
  }

  let threadId: string;
  try {
    threadId = decodeURIComponent(encodedThreadId);
  } catch {
    throw invalidThreadFollowRequest();
  }
  if (
    threadId.trim().length === 0 ||
    threadId.includes("/") ||
    threadId.includes("\\") ||
    threadId.includes("\0") ||
    Buffer.byteLength(threadId, "utf8") >
      MAX_THREAD_FOLLOW_IDENTIFIER_UTF8_BYTES
  ) {
    throw invalidThreadFollowRequest();
  }

  const contentType = request.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !CONVERSATION_CREATION_JSON_CONTENT_TYPE_PATTERN.test(contentType)
  ) {
    throw invalidThreadFollowRequest();
  }
  const headerIdempotencyKey = readThreadFollowIdempotencyKey(request);

  const decoded = await readBoundedJsonBody(
    request,
    MAX_THREAD_FOLLOW_REQUEST_BYTES,
    invalidThreadFollowRequest,
  );

  let input: SetThreadFollowInput;
  try {
    input = parseSetThreadFollowInput(decoded);
  } catch (error) {
    if (error instanceof ThreadFollowMutationParseError) {
      throw invalidThreadFollowRequest();
    }
    throw error;
  }
  if (
    input.target.id !== threadId ||
    input.idempotencyKey !== headerIdempotencyKey
  ) {
    throw invalidThreadFollowRequest();
  }
  return input;
};

const READ_CURSOR_PATH_PATTERN =
  /^\/conversations\/([^/]+)\/read-cursor$/u;
const READ_CURSOR_IDEMPOTENCY_KEY_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

const readReadCursorIdempotencyKey = (request: IncomingMessage): string => {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === "idempotency-key") {
      values.push(request.rawHeaders[index + 1] ?? "");
    }
  }
  const value = values[0];
  if (
    values.length !== 1 ||
    value === undefined ||
    !READ_CURSOR_IDEMPOTENCY_KEY_PATTERN.test(value) ||
    Buffer.byteLength(value, "utf8") >
      MAX_READ_CURSOR_IDEMPOTENCY_KEY_UTF8_BYTES
  ) {
    throw invalidReadCursorRequest();
  }
  return value;
};

const readReadCursorInput = async (
  request: IncomingMessage,
): Promise<ReadCursorMutationInput> => {
  let url: URL;
  try {
    url = new URL(request.url ?? "", "http://handrail.invalid");
  } catch {
    throw invalidReadCursorRequest();
  }
  const match = READ_CURSOR_PATH_PATTERN.exec(url.pathname);
  const encodedConversationId = match?.[1];
  if (
    encodedConversationId === undefined ||
    [...url.searchParams].length !== 0
  ) {
    throw invalidReadCursorRequest();
  }

  let conversationId: string;
  try {
    conversationId = decodeURIComponent(encodedConversationId);
  } catch {
    throw invalidReadCursorRequest();
  }
  if (
    conversationId.trim().length === 0 ||
    conversationId.includes("/") ||
    conversationId.includes("\\") ||
    conversationId.includes("\0")
  ) {
    throw invalidReadCursorRequest();
  }

  const contentType = request.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !CONVERSATION_CREATION_JSON_CONTENT_TYPE_PATTERN.test(contentType)
  ) {
    throw invalidReadCursorRequest();
  }
  const headerIdempotencyKey = readReadCursorIdempotencyKey(request);

  const decoded = await readBoundedJsonBody(
    request,
    MAX_READ_CURSOR_REQUEST_BYTES,
    invalidReadCursorRequest,
  );

  let input: ReadCursorMutationInput;
  try {
    input = parseReadCursorMutationInput(decoded);
  } catch (error) {
    if (error instanceof ReadCursorMutationError) {
      throw invalidReadCursorRequest();
    }
    throw error;
  }
  if (
    input.conversationId !== conversationId ||
    !READ_CURSOR_IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey) ||
    input.idempotencyKey !== headerIdempotencyKey
  ) {
    throw invalidReadCursorRequest();
  }
  return input;
};

const DRAFT_SYNCHRONIZATION_PATH_PATTERN =
  /^\/conversations\/([^/]+)\/draft$/u;
const DRAFT_SYNCHRONIZATION_IDEMPOTENCY_KEY_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

const readDraftSynchronizationIdempotencyKey = (
  request: IncomingMessage,
): string => {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === "idempotency-key") {
      values.push(request.rawHeaders[index + 1] ?? "");
    }
  }
  const value = values[0];
  if (
    values.length !== 1 ||
    value === undefined ||
    !DRAFT_SYNCHRONIZATION_IDEMPOTENCY_KEY_PATTERN.test(value) ||
    Buffer.byteLength(value, "utf8") >
      MAX_DRAFT_IDEMPOTENCY_KEY_UTF8_BYTES
  ) {
    throw invalidDraftSynchronizationRequest();
  }
  return value;
};

const readDraftSynchronizationInput = async (
  request: IncomingMessage,
): Promise<SynchronizeDraftInput> => {
  let url: URL;
  try {
    url = new URL(request.url ?? "", "http://handrail.invalid");
  } catch {
    throw invalidDraftSynchronizationRequest();
  }
  const match = DRAFT_SYNCHRONIZATION_PATH_PATTERN.exec(url.pathname);
  const encodedConversationId = match?.[1];
  if (
    encodedConversationId === undefined ||
    [...url.searchParams].length !== 0
  ) {
    throw invalidDraftSynchronizationRequest();
  }

  let conversationId: string;
  try {
    conversationId = decodeURIComponent(encodedConversationId);
  } catch {
    throw invalidDraftSynchronizationRequest();
  }
  if (
    conversationId.trim().length === 0 ||
    conversationId.includes("/") ||
    conversationId.includes("\\") ||
    conversationId.includes("\0")
  ) {
    throw invalidDraftSynchronizationRequest();
  }

  const contentType = request.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !CONVERSATION_CREATION_JSON_CONTENT_TYPE_PATTERN.test(contentType)
  ) {
    throw invalidDraftSynchronizationRequest();
  }
  const headerIdempotencyKey =
    readDraftSynchronizationIdempotencyKey(request);

  const decoded = await readBoundedJsonBody(
    request,
    MAX_DRAFT_SYNCHRONIZATION_REQUEST_BYTES,
    invalidDraftSynchronizationRequest,
  );

  let input: SynchronizeDraftInput;
  try {
    input = parseSynchronizeDraftInput(decoded);
  } catch (error) {
    if (error instanceof DraftMutationParseError) {
      throw invalidDraftSynchronizationRequest();
    }
    throw error;
  }
  if (
    input.conversationId !== conversationId ||
    !DRAFT_SYNCHRONIZATION_IDEMPOTENCY_KEY_PATTERN.test(
      input.idempotencyKey,
    ) ||
    input.idempotencyKey !== headerIdempotencyKey
  ) {
    throw invalidDraftSynchronizationRequest();
  }
  return input;
};

const THREAD_CREATION_PATH_PATTERN = /^\/messages\/([^/]+)\/thread$/u;

const readThreadCreationIdempotencyKey = (
  request: IncomingMessage,
): string => {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === "idempotency-key") {
      values.push(request.rawHeaders[index + 1] ?? "");
    }
  }
  const value = values[0];
  if (
    values.length !== 1 ||
    value === undefined ||
    !CONVERSATION_CREATION_IDEMPOTENCY_KEY_PATTERN.test(value)
  ) {
    throw invalidThreadCreationRequest();
  }
  return value;
};

const readThreadCreationInput = async (
  request: IncomingMessage,
): Promise<ThreadCreationInput> => {
  let url: URL;
  try {
    url = new URL(request.url ?? "", "http://handrail.invalid");
  } catch {
    throw invalidThreadCreationRequest();
  }
  const match = THREAD_CREATION_PATH_PATTERN.exec(url.pathname);
  const encodedRootMessageId = match?.[1];
  if (
    encodedRootMessageId === undefined ||
    [...url.searchParams].length !== 0
  ) {
    throw invalidThreadCreationRequest();
  }

  let rootMessageId: string;
  try {
    rootMessageId = decodeURIComponent(encodedRootMessageId);
  } catch {
    throw invalidThreadCreationRequest();
  }
  if (
    rootMessageId.trim().length === 0 ||
    rootMessageId.includes("/") ||
    rootMessageId.includes("\\") ||
    rootMessageId.includes("\0")
  ) {
    throw invalidThreadCreationRequest();
  }

  const contentType = request.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !CONVERSATION_CREATION_JSON_CONTENT_TYPE_PATTERN.test(contentType)
  ) {
    throw invalidThreadCreationRequest();
  }
  const headerIdempotencyKey = readThreadCreationIdempotencyKey(request);
  const decoded = await readBoundedJsonBody(
    request,
    MAX_THREAD_CREATION_REQUEST_BYTES,
    invalidThreadCreationRequest,
  );

  let input: ThreadCreationInput;
  try {
    input = parseThreadCreationInput(decoded);
  } catch (error) {
    if (error instanceof ThreadCreationParseError) {
      throw invalidThreadCreationRequest();
    }
    throw error;
  }
  if (
    input.rootMessageId !== rootMessageId ||
    !CONVERSATION_CREATION_IDEMPOTENCY_KEY_PATTERN.test(
      input.idempotencyKey,
    ) ||
    input.idempotencyKey !== headerIdempotencyKey
  ) {
    throw invalidThreadCreationRequest();
  }
  return input;
};

const MESSAGE_SEND_PATH_PATTERN = /^\/conversations\/([^/]+)\/messages$/u;

const readMessageSendIdempotencyKey = (request: IncomingMessage): string => {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === "idempotency-key") {
      values.push(request.rawHeaders[index + 1] ?? "");
    }
  }
  const value = values[0];
  if (
    values.length !== 1 ||
    value === undefined ||
    !CONVERSATION_CREATION_IDEMPOTENCY_KEY_PATTERN.test(value)
  ) {
    throw invalidMessageSendRequest();
  }
  return value;
};

const readMessageSendInput = async (
  request: IncomingMessage,
): Promise<SendMessageInput> => {
  let url: URL;
  try {
    url = new URL(request.url ?? "", "http://handrail.invalid");
  } catch {
    throw invalidMessageSendRequest();
  }
  const match = MESSAGE_SEND_PATH_PATTERN.exec(url.pathname);
  const encodedConversationId = match?.[1];
  if (
    encodedConversationId === undefined ||
    [...url.searchParams].length !== 0
  ) {
    throw invalidMessageSendRequest();
  }

  let conversationId: string;
  try {
    conversationId = decodeURIComponent(encodedConversationId);
  } catch {
    throw invalidMessageSendRequest();
  }
  if (
    conversationId.trim().length === 0 ||
    conversationId.includes("/") ||
    conversationId.includes("\\") ||
    conversationId.includes("\0")
  ) {
    throw invalidMessageSendRequest();
  }

  const contentType = request.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !CONVERSATION_CREATION_JSON_CONTENT_TYPE_PATTERN.test(contentType)
  ) {
    throw invalidMessageSendRequest();
  }
  const headerIdempotencyKey = readMessageSendIdempotencyKey(request);
  const decoded = await readBoundedJsonBody(
    request,
    MAX_SEND_MESSAGE_REQUEST_BYTES,
    invalidMessageSendRequest,
  );

  let input: SendMessageInput;
  try {
    input = parseSendMessageInput(decoded);
  } catch (error) {
    if (error instanceof MessageMutationParseError) {
      throw invalidMessageSendRequest();
    }
    throw error;
  }
  if (
    input.conversationId !== conversationId ||
    !CONVERSATION_CREATION_IDEMPOTENCY_KEY_PATTERN.test(
      input.idempotencyKey,
    ) ||
    input.idempotencyKey !== headerIdempotencyKey
  ) {
    throw invalidMessageSendRequest();
  }
  return input;
};

const readMessageForwardIdempotencyKey = (
  request: IncomingMessage,
): string => {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === "idempotency-key") {
      values.push(request.rawHeaders[index + 1] ?? "");
    }
  }
  const value = values[0];
  if (
    values.length !== 1 ||
    value === undefined ||
    !CONVERSATION_CREATION_IDEMPOTENCY_KEY_PATTERN.test(value)
  ) {
    throw invalidMessageForwardRequest();
  }
  return value;
};

const readMessageForwardInput = async (
  request: IncomingMessage,
): Promise<ForwardMessageInput> => {
  let url: URL;
  try {
    url = new URL(request.url ?? "", "http://handrail.invalid");
  } catch {
    throw invalidMessageForwardRequest();
  }
  if (
    url.pathname !== FORWARD_MESSAGE_ROUTE ||
    [...url.searchParams].length !== 0
  ) {
    throw invalidMessageForwardRequest();
  }
  const contentType = request.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !CONVERSATION_CREATION_JSON_CONTENT_TYPE_PATTERN.test(contentType)
  ) {
    throw invalidMessageForwardRequest();
  }
  const headerIdempotencyKey = readMessageForwardIdempotencyKey(request);
  const decoded = await readBoundedJsonBody(
    request,
    MAX_FORWARD_MESSAGE_REQUEST_BYTES,
    invalidMessageForwardRequest,
  );

  let input: ForwardMessageInput;
  try {
    input = parseForwardMessageInput(decoded);
  } catch (error) {
    if (error instanceof ForwardMessageParseError) {
      throw invalidMessageForwardRequest();
    }
    throw error;
  }
  if (
    !CONVERSATION_CREATION_IDEMPOTENCY_KEY_PATTERN.test(
      input.idempotencyKey,
    ) ||
    input.idempotencyKey !== headerIdempotencyKey
  ) {
    throw invalidMessageForwardRequest();
  }
  return input;
};

const PREPARE_ATTACHMENT_PATH_PATTERN =
  /^\/conversations\/([^/]+)\/attachments$/u;
const PREPARE_ATTACHMENT_IDEMPOTENCY_KEY_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u;

const readPrepareAttachmentIdempotencyKey = (
  request: IncomingMessage,
): string => {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === "idempotency-key") {
      values.push(request.rawHeaders[index + 1] ?? "");
    }
  }
  const value = values[0];
  if (
    values.length !== 1 ||
    value === undefined ||
    Buffer.byteLength(value, "utf8") >
      MAX_ATTACHMENT_IDEMPOTENCY_KEY_UTF8_BYTES ||
    !PREPARE_ATTACHMENT_IDEMPOTENCY_KEY_PATTERN.test(value)
  ) {
    throw invalidAttachmentPreparationRequest();
  }
  return value;
};

const readPrepareAttachmentInput = async (
  request: IncomingMessage,
): Promise<
  Readonly<{
    conversationId: string;
    input: PrepareAttachmentInput;
  }>
> => {
  let url: URL;
  try {
    url = new URL(request.url ?? "", "http://handrail.invalid");
  } catch {
    throw invalidAttachmentPreparationRequest();
  }
  const match = PREPARE_ATTACHMENT_PATH_PATTERN.exec(url.pathname);
  const encodedConversationId = match?.[1];
  if (
    encodedConversationId === undefined ||
    [...url.searchParams].length !== 0
  ) {
    throw invalidAttachmentPreparationRequest();
  }

  let conversationId: string;
  try {
    conversationId = decodeURIComponent(encodedConversationId);
  } catch {
    throw invalidAttachmentPreparationRequest();
  }
  if (
    conversationId.trim().length === 0 ||
    Buffer.byteLength(conversationId, "utf8") > 255 ||
    conversationId.includes("/") ||
    conversationId.includes("\\") ||
    /\p{Cc}/u.test(conversationId)
  ) {
    throw invalidAttachmentPreparationRequest();
  }

  const contentType = request.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !CONVERSATION_CREATION_JSON_CONTENT_TYPE_PATTERN.test(contentType)
  ) {
    throw invalidAttachmentPreparationRequest();
  }
  const headerIdempotencyKey =
    readPrepareAttachmentIdempotencyKey(request);
  const decoded = await readBoundedJsonBody(
    request,
    MAX_PREPARE_ATTACHMENT_REQUEST_BYTES,
    invalidAttachmentPreparationRequest,
  );

  let input: PrepareAttachmentInput;
  try {
    input = parsePrepareAttachmentInput(decoded);
  } catch (error) {
    if (error instanceof AttachmentTransportError) {
      throw invalidAttachmentPreparationRequest();
    }
    throw error;
  }
  if (
    !PREPARE_ATTACHMENT_IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey) ||
    input.idempotencyKey !== headerIdempotencyKey
  ) {
    throw invalidAttachmentPreparationRequest();
  }
  return Object.freeze({ conversationId, input });
};

const START_HUDDLE_PATH_PATTERN =
  /^\/conversations\/([^/]+)\/huddles$/u;

const readStartHuddleIdempotencyKey = (
  request: IncomingMessage,
): string => {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === "idempotency-key") {
      values.push(request.rawHeaders[index + 1] ?? "");
    }
  }
  const value = values[0];
  if (
    values.length !== 1 ||
    value === undefined ||
    value.trim().length === 0 ||
    Buffer.byteLength(value, "utf8") >
      MAX_HUDDLE_IDEMPOTENCY_KEY_UTF8_BYTES
  ) {
    throw invalidHuddleStartRequest();
  }
  return value;
};

const readStartHuddleInput = async (
  request: IncomingMessage,
): Promise<StartHuddleInput> => {
  let url: URL;
  try {
    url = new URL(request.url ?? "", "http://handrail.invalid");
  } catch {
    throw invalidHuddleStartRequest();
  }
  const match = START_HUDDLE_PATH_PATTERN.exec(url.pathname);
  const encodedConversationId = match?.[1];
  if (
    encodedConversationId === undefined ||
    [...url.searchParams].length !== 0
  ) {
    throw invalidHuddleStartRequest();
  }

  let conversationId: string;
  try {
    conversationId = decodeURIComponent(encodedConversationId);
  } catch {
    throw invalidHuddleStartRequest();
  }
  if (
    conversationId.trim().length === 0 ||
    Buffer.byteLength(conversationId, "utf8") > 255 ||
    conversationId.includes("/") ||
    conversationId.includes("\\") ||
    /\p{Cc}/u.test(conversationId)
  ) {
    throw invalidHuddleStartRequest();
  }

  const contentType = request.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !CONVERSATION_CREATION_JSON_CONTENT_TYPE_PATTERN.test(contentType)
  ) {
    throw invalidHuddleStartRequest();
  }
  const headerIdempotencyKey = readStartHuddleIdempotencyKey(request);

  const decoded = await readBoundedJsonBody(
    request,
    MAX_START_HUDDLE_REQUEST_BYTES,
    invalidHuddleStartRequest,
  );

  let input: StartHuddleInput;
  try {
    input = parseStartHuddleInput(decoded);
  } catch (error) {
    if (error instanceof HuddleContractError) {
      throw invalidHuddleStartRequest();
    }
    throw error;
  }
  if (
    input.conversationId !== conversationId ||
    input.idempotencyKey !== headerIdempotencyKey
  ) {
    throw invalidHuddleStartRequest();
  }
  return input;
};

const JOIN_HUDDLE_PATH_PATTERN = /^\/huddles\/([^/]+)\/join$/u;

const readJoinHuddleIdempotencyKey = (
  request: IncomingMessage,
): string => {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === "idempotency-key") {
      values.push(request.rawHeaders[index + 1] ?? "");
    }
  }
  const value = values[0];
  if (
    values.length !== 1 ||
    value === undefined ||
    value.trim().length === 0 ||
    Buffer.byteLength(value, "utf8") >
      MAX_HUDDLE_IDEMPOTENCY_KEY_UTF8_BYTES
  ) {
    throw invalidHuddleJoinRequest();
  }
  return value;
};

const readJoinHuddleInput = async (
  request: IncomingMessage,
): Promise<JoinHuddleInput> => {
  let url: URL;
  try {
    url = new URL(request.url ?? "", "http://handrail.invalid");
  } catch {
    throw invalidHuddleJoinRequest();
  }
  const match = JOIN_HUDDLE_PATH_PATTERN.exec(url.pathname);
  const encodedHuddleSessionId = match?.[1];
  if (
    encodedHuddleSessionId === undefined ||
    [...url.searchParams].length !== 0
  ) {
    throw invalidHuddleJoinRequest();
  }

  let huddleSessionId: string;
  try {
    huddleSessionId = decodeURIComponent(encodedHuddleSessionId);
  } catch {
    throw invalidHuddleJoinRequest();
  }
  if (
    huddleSessionId.trim().length === 0 ||
    Buffer.byteLength(huddleSessionId, "utf8") > 255 ||
    huddleSessionId.includes("/") ||
    huddleSessionId.includes("\\") ||
    /\p{Cc}/u.test(huddleSessionId)
  ) {
    throw invalidHuddleJoinRequest();
  }

  const contentType = request.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !CONVERSATION_CREATION_JSON_CONTENT_TYPE_PATTERN.test(contentType)
  ) {
    throw invalidHuddleJoinRequest();
  }
  const headerIdempotencyKey = readJoinHuddleIdempotencyKey(request);

  const decoded = await readBoundedJsonBody(
    request,
    MAX_JOIN_HUDDLE_REQUEST_BYTES,
    invalidHuddleJoinRequest,
  );

  let input: JoinHuddleInput;
  try {
    input = parseJoinHuddleInput(decoded);
  } catch (error) {
    if (error instanceof HuddleContractError) {
      throw invalidHuddleJoinRequest();
    }
    throw error;
  }
  if (
    input.huddleSessionId !== huddleSessionId ||
    input.idempotencyKey !== headerIdempotencyKey
  ) {
    throw invalidHuddleJoinRequest();
  }
  return input;
};

const LEAVE_HUDDLE_PATH_PATTERN = /^\/huddles\/([^/]+)\/leave$/u;

const readLeaveHuddleIdempotencyKey = (
  request: IncomingMessage,
): string => {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === "idempotency-key") {
      values.push(request.rawHeaders[index + 1] ?? "");
    }
  }
  const value = values[0];
  if (
    values.length !== 1 ||
    value === undefined ||
    value.trim().length === 0 ||
    Buffer.byteLength(value, "utf8") >
      MAX_HUDDLE_IDEMPOTENCY_KEY_UTF8_BYTES
  ) {
    throw invalidHuddleLeaveRequest();
  }
  return value;
};

const readLeaveHuddleInput = async (
  request: IncomingMessage,
): Promise<LeaveHuddleInput> => {
  let url: URL;
  try {
    url = new URL(request.url ?? "", "http://handrail.invalid");
  } catch {
    throw invalidHuddleLeaveRequest();
  }
  const match = LEAVE_HUDDLE_PATH_PATTERN.exec(url.pathname);
  const encodedHuddleSessionId = match?.[1];
  if (
    encodedHuddleSessionId === undefined ||
    [...url.searchParams].length !== 0
  ) {
    throw invalidHuddleLeaveRequest();
  }

  let huddleSessionId: string;
  try {
    huddleSessionId = decodeURIComponent(encodedHuddleSessionId);
  } catch {
    throw invalidHuddleLeaveRequest();
  }
  if (
    huddleSessionId.trim().length === 0 ||
    Buffer.byteLength(huddleSessionId, "utf8") > 255 ||
    huddleSessionId.includes("/") ||
    huddleSessionId.includes("\\") ||
    /\p{Cc}/u.test(huddleSessionId)
  ) {
    throw invalidHuddleLeaveRequest();
  }

  const contentType = request.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !CONVERSATION_CREATION_JSON_CONTENT_TYPE_PATTERN.test(contentType)
  ) {
    throw invalidHuddleLeaveRequest();
  }
  const headerIdempotencyKey = readLeaveHuddleIdempotencyKey(request);

  const decoded = await readBoundedJsonBody(
    request,
    MAX_LEAVE_HUDDLE_REQUEST_BYTES,
    invalidHuddleLeaveRequest,
  );

  let input: LeaveHuddleInput;
  try {
    input = parseLeaveHuddleInput(decoded);
  } catch (error) {
    if (error instanceof HuddleContractError) {
      throw invalidHuddleLeaveRequest();
    }
    throw error;
  }
  if (
    input.huddleSessionId !== huddleSessionId ||
    input.idempotencyKey !== headerIdempotencyKey
  ) {
    throw invalidHuddleLeaveRequest();
  }
  return input;
};

const HUDDLE_SCREEN_SHARE_PATH_PATTERN =
  /^\/huddles\/([^/]+)\/screen-share$/u;

const readHuddleScreenShareIdempotencyKey = (
  request: IncomingMessage,
): string => {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === "idempotency-key") {
      values.push(request.rawHeaders[index + 1] ?? "");
    }
  }
  const value = values[0];
  if (
    values.length !== 1 ||
    value === undefined ||
    value.trim().length === 0 ||
    Buffer.byteLength(value, "utf8") >
      MAX_HUDDLE_IDEMPOTENCY_KEY_UTF8_BYTES
  ) {
    throw invalidHuddleScreenShareRequest();
  }
  return value;
};

const readHuddleScreenShareInput = async (
  request: IncomingMessage,
): Promise<SetHuddleScreenShareInput> => {
  let url: URL;
  try {
    url = new URL(request.url ?? "", "http://handrail.invalid");
  } catch {
    throw invalidHuddleScreenShareRequest();
  }
  const match = HUDDLE_SCREEN_SHARE_PATH_PATTERN.exec(url.pathname);
  const encodedHuddleSessionId = match?.[1];
  if (
    encodedHuddleSessionId === undefined ||
    [...url.searchParams].length !== 0
  ) {
    throw invalidHuddleScreenShareRequest();
  }

  let huddleSessionId: string;
  try {
    huddleSessionId = decodeURIComponent(encodedHuddleSessionId);
  } catch {
    throw invalidHuddleScreenShareRequest();
  }
  if (
    huddleSessionId.trim().length === 0 ||
    Buffer.byteLength(huddleSessionId, "utf8") > 255 ||
    huddleSessionId.includes("/") ||
    huddleSessionId.includes("\\") ||
    /\p{Cc}/u.test(huddleSessionId)
  ) {
    throw invalidHuddleScreenShareRequest();
  }

  const contentType = request.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !CONVERSATION_CREATION_JSON_CONTENT_TYPE_PATTERN.test(contentType)
  ) {
    throw invalidHuddleScreenShareRequest();
  }
  const headerIdempotencyKey =
    readHuddleScreenShareIdempotencyKey(request);

  const decoded = await readBoundedJsonBody(
    request,
    MAX_HUDDLE_SCREEN_SHARE_REQUEST_BYTES,
    invalidHuddleScreenShareRequest,
  );

  let input: SetHuddleScreenShareInput;
  try {
    input = parseSetHuddleScreenShareInput(decoded);
  } catch (error) {
    if (error instanceof HuddleContractError) {
      throw invalidHuddleScreenShareRequest();
    }
    throw error;
  }
  if (
    input.huddleSessionId !== huddleSessionId ||
    input.idempotencyKey !== headerIdempotencyKey
  ) {
    throw invalidHuddleScreenShareRequest();
  }
  return input;
};

const END_HUDDLE_PATH_PATTERN = /^\/huddles\/([^/]+)\/end$/u;

const readEndHuddleIdempotencyKey = (request: IncomingMessage): string => {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === "idempotency-key") {
      values.push(request.rawHeaders[index + 1] ?? "");
    }
  }
  const value = values[0];
  if (
    values.length !== 1 ||
    value === undefined ||
    value.trim().length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_HUDDLE_IDEMPOTENCY_KEY_UTF8_BYTES
  ) {
    throw invalidHuddleEndRequest();
  }
  return value;
};

const readEndHuddleInput = async (
  request: IncomingMessage,
): Promise<EndHuddleInput> => {
  let url: URL;
  try {
    url = new URL(request.url ?? "", "http://handrail.invalid");
  } catch {
    throw invalidHuddleEndRequest();
  }
  const match = END_HUDDLE_PATH_PATTERN.exec(url.pathname);
  const encodedHuddleSessionId = match?.[1];
  if (
    encodedHuddleSessionId === undefined ||
    [...url.searchParams].length !== 0
  ) {
    throw invalidHuddleEndRequest();
  }

  let huddleSessionId: string;
  try {
    huddleSessionId = decodeURIComponent(encodedHuddleSessionId);
  } catch {
    throw invalidHuddleEndRequest();
  }
  if (
    huddleSessionId.trim().length === 0 ||
    Buffer.byteLength(huddleSessionId, "utf8") > 255 ||
    huddleSessionId.includes("/") ||
    huddleSessionId.includes("\\") ||
    /\p{Cc}/u.test(huddleSessionId)
  ) {
    throw invalidHuddleEndRequest();
  }

  const contentType = request.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !CONVERSATION_CREATION_JSON_CONTENT_TYPE_PATTERN.test(contentType)
  ) {
    throw invalidHuddleEndRequest();
  }
  const headerIdempotencyKey = readEndHuddleIdempotencyKey(request);

  const decoded = await readBoundedJsonBody(
    request,
    MAX_END_HUDDLE_REQUEST_BYTES,
    invalidHuddleEndRequest,
  );

  let input: EndHuddleInput;
  try {
    input = parseEndHuddleInput(decoded);
  } catch (error) {
    if (error instanceof HuddleContractError) {
      throw invalidHuddleEndRequest();
    }
    throw error;
  }
  if (
    input.huddleSessionId !== huddleSessionId ||
    input.idempotencyKey !== headerIdempotencyKey
  ) {
    throw invalidHuddleEndRequest();
  }
  return input;
};

type AttachmentLifecycleInput =
  | FinalizeAttachmentInput
  | AbortAttachmentInput;

const ATTACHMENT_LIFECYCLE_PATH_PATTERN =
  /^\/attachments\/([^/]+)\/lifecycle$/u;

const readAttachmentLifecycleIdempotencyKey = (
  request: IncomingMessage,
): string => {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === "idempotency-key") {
      values.push(request.rawHeaders[index + 1] ?? "");
    }
  }
  const value = values[0];
  if (
    values.length !== 1 ||
    value === undefined ||
    Buffer.byteLength(value, "utf8") >
      MAX_ATTACHMENT_IDEMPOTENCY_KEY_UTF8_BYTES ||
    !PREPARE_ATTACHMENT_IDEMPOTENCY_KEY_PATTERN.test(value)
  ) {
    throw invalidAttachmentLifecycleRequest();
  }
  return value;
};

const readAttachmentLifecycleInput = async (
  request: IncomingMessage,
): Promise<AttachmentLifecycleInput> => {
  let url: URL;
  try {
    url = new URL(request.url ?? "", "http://handrail.invalid");
  } catch {
    throw invalidAttachmentLifecycleRequest();
  }
  const match = ATTACHMENT_LIFECYCLE_PATH_PATTERN.exec(url.pathname);
  const encodedAttachmentId = match?.[1];
  if (
    encodedAttachmentId === undefined ||
    [...url.searchParams].length !== 0
  ) {
    throw invalidAttachmentLifecycleRequest();
  }

  let attachmentId: string;
  try {
    attachmentId = decodeURIComponent(encodedAttachmentId);
  } catch {
    throw invalidAttachmentLifecycleRequest();
  }
  if (
    attachmentId.trim().length === 0 ||
    Buffer.byteLength(attachmentId, "utf8") >
      MAX_ATTACHMENT_IDENTIFIER_UTF8_BYTES ||
    attachmentId.includes("/") ||
    attachmentId.includes("\\") ||
    /\p{Cc}/u.test(attachmentId)
  ) {
    throw invalidAttachmentLifecycleRequest();
  }

  const contentType = request.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !CONVERSATION_CREATION_JSON_CONTENT_TYPE_PATTERN.test(contentType)
  ) {
    throw invalidAttachmentLifecycleRequest();
  }
  const headerIdempotencyKey =
    readAttachmentLifecycleIdempotencyKey(request);
  const decoded = await readBoundedJsonBody(
    request,
    MAX_ATTACHMENT_LIFECYCLE_REQUEST_BYTES,
    invalidAttachmentLifecycleRequest,
  );

  let input: AttachmentLifecycleInput;
  try {
    const parsed = parseAttachmentMutationInput(decoded);
    if (
      parsed.operation !== "finalize_attachment" &&
      parsed.operation !== "abort_attachment"
    ) {
      throw invalidAttachmentLifecycleRequest();
    }
    input = parsed;
  } catch (error) {
    if (error instanceof AttachmentTransportError) {
      throw invalidAttachmentLifecycleRequest();
    }
    throw error;
  }
  if (
    input.attachmentId !== attachmentId ||
    !PREPARE_ATTACHMENT_IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey) ||
    input.idempotencyKey !== headerIdempotencyKey
  ) {
    throw invalidAttachmentLifecycleRequest();
  }
  return Object.freeze(input);
};

const ATTACHMENT_DOWNLOAD_PATH_PATTERN =
  /^\/attachments\/([^/]+)\/download$/u;

const readAttachmentDownloadInput = (
  request: IncomingMessage,
): GetAttachmentDownloadInput => {
  if (
    (request.headers["content-length"] !== undefined &&
      request.headers["content-length"] !== "0") ||
    request.headers["transfer-encoding"] !== undefined
  ) {
    throw invalidAttachmentDownloadRequest();
  }

  let url: URL;
  try {
    url = new URL(request.url ?? "", "http://handrail.invalid");
  } catch {
    throw invalidAttachmentDownloadRequest();
  }
  const match = ATTACHMENT_DOWNLOAD_PATH_PATTERN.exec(url.pathname);
  const encodedAttachmentId = match?.[1];
  if (encodedAttachmentId === undefined || url.hash !== "") {
    throw invalidAttachmentDownloadRequest();
  }

  const rawQuery = url.search.startsWith("?") ? url.search.slice(1) : "";
  const queryParts = rawQuery.split("&");
  const separatorIndex = queryParts[0]?.indexOf("=") ?? -1;
  if (
    rawQuery.length === 0 ||
    queryParts.length !== 1 ||
    separatorIndex < 0 ||
    queryParts[0]?.indexOf("=", separatorIndex + 1) !== -1 ||
    queryParts[0]?.slice(0, separatorIndex) !== "messageId"
  ) {
    throw invalidAttachmentDownloadRequest();
  }

  let attachmentId: string;
  let messageId: string;
  try {
    attachmentId = decodeURIComponent(encodedAttachmentId);
    messageId = decodeURIComponent(
      (queryParts[0]?.slice(separatorIndex + 1) ?? "").replaceAll("+", " "),
    );
  } catch {
    throw invalidAttachmentDownloadRequest();
  }
  if (
    attachmentId.includes("/") ||
    attachmentId.includes("\\") ||
    messageId.includes("/") ||
    messageId.includes("\\")
  ) {
    throw invalidAttachmentDownloadRequest();
  }

  try {
    return Object.freeze(parseGetAttachmentDownloadInput({
      operation: "get_attachment_download",
      attachmentId,
      messageId,
    }));
  } catch (error) {
    if (error instanceof AttachmentTransportError) {
      throw invalidAttachmentDownloadRequest();
    }
    throw error;
  }
};

const MESSAGE_EDIT_PATH_PATTERN = /^\/messages\/([^/]+)$/u;

const readMessageEditIdempotencyKey = (request: IncomingMessage): string => {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === "idempotency-key") {
      values.push(request.rawHeaders[index + 1] ?? "");
    }
  }
  const value = values[0];
  if (
    values.length !== 1 ||
    value === undefined ||
    !CONVERSATION_CREATION_IDEMPOTENCY_KEY_PATTERN.test(value)
  ) {
    throw invalidMessageEditRequest();
  }
  return value;
};

const readMessageEditInput = async (
  request: IncomingMessage,
): Promise<EditMessageInput> => {
  let url: URL;
  try {
    url = new URL(request.url ?? "", "http://handrail.invalid");
  } catch {
    throw invalidMessageEditRequest();
  }
  const match = MESSAGE_EDIT_PATH_PATTERN.exec(url.pathname);
  const encodedMessageId = match?.[1];
  if (encodedMessageId === undefined || [...url.searchParams].length !== 0) {
    throw invalidMessageEditRequest();
  }

  let messageId: string;
  try {
    messageId = decodeURIComponent(encodedMessageId);
  } catch {
    throw invalidMessageEditRequest();
  }
  if (
    messageId.trim().length === 0 ||
    messageId.includes("/") ||
    messageId.includes("\\") ||
    messageId.includes("\0")
  ) {
    throw invalidMessageEditRequest();
  }

  const contentType = request.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !CONVERSATION_CREATION_JSON_CONTENT_TYPE_PATTERN.test(contentType)
  ) {
    throw invalidMessageEditRequest();
  }
  const headerIdempotencyKey = readMessageEditIdempotencyKey(request);

  const decoded = await readBoundedJsonBody(
    request,
    MAX_EDIT_MESSAGE_REQUEST_BYTES,
    invalidMessageEditRequest,
  );

  let input: EditMessageInput;
  try {
    input = parseEditMessageInput(decoded);
  } catch (error) {
    if (error instanceof MessageMutationParseError) {
      throw invalidMessageEditRequest();
    }
    throw error;
  }
  if (
    input.messageId !== messageId ||
    !CONVERSATION_CREATION_IDEMPOTENCY_KEY_PATTERN.test(
      input.idempotencyKey,
    ) ||
    input.idempotencyKey !== headerIdempotencyKey
  ) {
    throw invalidMessageEditRequest();
  }
  return input;
};

const MESSAGE_DELETE_PATH_PATTERN = /^\/messages\/([^/]+)$/u;

const readMessageDeleteIdempotencyKey = (request: IncomingMessage): string => {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === "idempotency-key") {
      values.push(request.rawHeaders[index + 1] ?? "");
    }
  }
  const value = values[0];
  if (
    values.length !== 1 ||
    value === undefined ||
    !CONVERSATION_CREATION_IDEMPOTENCY_KEY_PATTERN.test(value)
  ) {
    throw invalidMessageDeleteRequest();
  }
  return value;
};

const readMessageDeleteInput = async (
  request: IncomingMessage,
): Promise<SoftDeleteMessageInput> => {
  let url: URL;
  try {
    url = new URL(request.url ?? "", "http://handrail.invalid");
  } catch {
    throw invalidMessageDeleteRequest();
  }
  const match = MESSAGE_DELETE_PATH_PATTERN.exec(url.pathname);
  const encodedMessageId = match?.[1];
  if (encodedMessageId === undefined || [...url.searchParams].length !== 0) {
    throw invalidMessageDeleteRequest();
  }

  let messageId: string;
  try {
    messageId = decodeURIComponent(encodedMessageId);
  } catch {
    throw invalidMessageDeleteRequest();
  }
  if (
    messageId.trim().length === 0 ||
    messageId.includes("/") ||
    messageId.includes("\\") ||
    messageId.includes("\0")
  ) {
    throw invalidMessageDeleteRequest();
  }

  const contentType = request.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !CONVERSATION_CREATION_JSON_CONTENT_TYPE_PATTERN.test(contentType)
  ) {
    throw invalidMessageDeleteRequest();
  }
  const headerIdempotencyKey = readMessageDeleteIdempotencyKey(request);

  const decoded = await readBoundedJsonBody(
    request,
    MAX_DELETE_MESSAGE_REQUEST_BYTES,
    invalidMessageDeleteRequest,
  );

  let input: SoftDeleteMessageInput;
  try {
    input = parseSoftDeleteMessageInput(decoded);
  } catch (error) {
    if (error instanceof MessageMutationParseError) {
      throw invalidMessageDeleteRequest();
    }
    throw error;
  }
  if (
    input.messageId !== messageId ||
    !CONVERSATION_CREATION_IDEMPOTENCY_KEY_PATTERN.test(
      input.idempotencyKey,
    ) ||
    input.idempotencyKey !== headerIdempotencyKey
  ) {
    throw invalidMessageDeleteRequest();
  }
  return input;
};

const MESSAGE_REACTION_PATH_PATTERN =
  /^\/messages\/([^/]+)\/reactions\/([^/]+)$/u;
const MESSAGE_REACTION_IDEMPOTENCY_KEY_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

const readMessageReactionIdempotencyKey = (
  request: IncomingMessage,
): string => {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === "idempotency-key") {
      values.push(request.rawHeaders[index + 1] ?? "");
    }
  }
  const value = values[0];
  if (
    values.length !== 1 ||
    value === undefined ||
    !MESSAGE_REACTION_IDEMPOTENCY_KEY_PATTERN.test(value) ||
    Buffer.byteLength(value, "utf8") >
      MAX_REACTION_IDEMPOTENCY_KEY_UTF8_BYTES
  ) {
    throw invalidMessageReactionRequest();
  }
  return value;
};

const decodeMessageReactionPathValue = (
  encodedValue: string,
): string => {
  let value: string;
  try {
    value = decodeURIComponent(encodedValue);
  } catch {
    throw invalidMessageReactionRequest();
  }
  if (
    value.trim().length === 0 ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    throw invalidMessageReactionRequest();
  }
  return value;
};

const readMessageReactionInput = async (
  request: IncomingMessage,
): Promise<ReactionMutationInput> => {
  let url: URL;
  try {
    url = new URL(request.url ?? "", "http://handrail.invalid");
  } catch {
    throw invalidMessageReactionRequest();
  }
  const match = MESSAGE_REACTION_PATH_PATTERN.exec(url.pathname);
  const encodedMessageId = match?.[1];
  const encodedReactionKey = match?.[2];
  if (
    encodedMessageId === undefined ||
    encodedReactionKey === undefined ||
    [...url.searchParams].length !== 0
  ) {
    throw invalidMessageReactionRequest();
  }

  const messageId = decodeMessageReactionPathValue(encodedMessageId);
  const reactionKey = decodeMessageReactionPathValue(encodedReactionKey);
  if (
    reactionKey !== reactionKey.normalize("NFC") ||
    Buffer.byteLength(reactionKey, "utf8") > MAX_REACTION_KEY_UTF8_BYTES
  ) {
    throw invalidMessageReactionRequest();
  }

  const contentType = request.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !CONVERSATION_CREATION_JSON_CONTENT_TYPE_PATTERN.test(contentType)
  ) {
    throw invalidMessageReactionRequest();
  }
  const headerIdempotencyKey = readMessageReactionIdempotencyKey(request);

  const decoded = await readBoundedJsonBody(
    request,
    MAX_REACTION_MUTATION_REQUEST_BYTES,
    invalidMessageReactionRequest,
  );

  let input: ReactionMutationInput;
  try {
    input = parseReactionMutationInput(decoded);
  } catch (error) {
    if (error instanceof ReactionMutationParseError) {
      throw invalidMessageReactionRequest();
    }
    throw error;
  }
  if (
    input.messageId !== messageId ||
    input.reactionKey !== reactionKey ||
    !MESSAGE_REACTION_IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey) ||
    input.idempotencyKey !== headerIdempotencyKey
  ) {
    throw invalidMessageReactionRequest();
  }
  return input;
};

const SAVED_MESSAGE_PATH_PATTERN = /^\/messages\/([^/]+)\/saved$/u;
const SAVED_MESSAGE_IDEMPOTENCY_KEY_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

const readSavedMessageIdempotencyKey = (
  request: IncomingMessage,
): string => {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === "idempotency-key") {
      values.push(request.rawHeaders[index + 1] ?? "");
    }
  }
  const value = values[0];
  if (
    values.length !== 1 ||
    value === undefined ||
    !SAVED_MESSAGE_IDEMPOTENCY_KEY_PATTERN.test(value) ||
    Buffer.byteLength(value, "utf8") >
      MAX_SAVED_MESSAGE_IDEMPOTENCY_KEY_UTF8_BYTES
  ) {
    throw invalidSavedMessageRequest();
  }
  return value;
};

const decodeSavedMessagePathId = (encodedValue: string): string => {
  let value: string;
  try {
    value = decodeURIComponent(encodedValue);
  } catch {
    throw invalidSavedMessageRequest();
  }
  if (
    value.length === 0 ||
    value.trim() !== value ||
    value !== value.normalize("NFC") ||
    value.includes("/") ||
    value.includes("\\") ||
    /[\u0000-\u001F\u007F-\u009F\uD800-\uDFFF]/u.test(value) ||
    Buffer.byteLength(value, "utf8") >
      MAX_SAVED_MESSAGE_IDENTIFIER_UTF8_BYTES
  ) {
    throw invalidSavedMessageRequest();
  }
  return value;
};

const readSavedMessageInput = async (
  request: IncomingMessage,
): Promise<SetSavedMessageInput> => {
  let url: URL;
  try {
    url = new URL(request.url ?? "", "http://handrail.invalid");
  } catch {
    throw invalidSavedMessageRequest();
  }
  const match = SAVED_MESSAGE_PATH_PATTERN.exec(url.pathname);
  const encodedMessageId = match?.[1];
  if (
    encodedMessageId === undefined ||
    [...url.searchParams].length !== 0
  ) {
    throw invalidSavedMessageRequest();
  }
  const messageId = decodeSavedMessagePathId(encodedMessageId);

  const contentType = request.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !CONVERSATION_CREATION_JSON_CONTENT_TYPE_PATTERN.test(contentType)
  ) {
    throw invalidSavedMessageRequest();
  }
  const headerIdempotencyKey = readSavedMessageIdempotencyKey(request);

  const decoded = await readBoundedJsonBody(
    request,
    MAX_SAVED_MESSAGE_REQUEST_BYTES,
    invalidSavedMessageRequest,
  );

  let input: SetSavedMessageInput;
  try {
    input = parseSetSavedMessageInput(decoded);
  } catch (error) {
    if (error instanceof SavedMessageMutationParseError) {
      throw invalidSavedMessageRequest();
    }
    throw error;
  }
  if (
    input.messageId !== messageId ||
    !SAVED_MESSAGE_IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey) ||
    input.idempotencyKey !== headerIdempotencyKey
  ) {
    throw invalidSavedMessageRequest();
  }
  return input;
};

const MESSAGE_REMINDER_PATH_PATTERN =
  /^\/conversations\/([^/]+)\/messages\/([^/]+)\/reminder$/u;
const MESSAGE_REMINDER_IDEMPOTENCY_KEY_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;

const readMessageReminderIdempotencyKey = (
  request: IncomingMessage,
): string => {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === "idempotency-key") {
      values.push(request.rawHeaders[index + 1] ?? "");
    }
  }
  const value = values[0];
  if (
    values.length !== 1 ||
    value === undefined ||
    !MESSAGE_REMINDER_IDEMPOTENCY_KEY_PATTERN.test(value) ||
    Buffer.byteLength(value, "utf8") >
      MAX_MESSAGE_REMINDER_IDEMPOTENCY_KEY_UTF8_BYTES
  ) {
    throw invalidMessageReminderRequest();
  }
  return value;
};

const decodeMessageReminderPathId = (encodedValue: string): string => {
  let value: string;
  try {
    value = decodeURIComponent(encodedValue);
  } catch {
    throw invalidMessageReminderRequest();
  }
  if (
    value.length === 0 ||
    value.trim() !== value ||
    value !== value.normalize("NFC") ||
    value.includes("/") ||
    value.includes("\\") ||
    /[\u0000-\u001F\u007F-\u009F\uD800-\uDFFF]/u.test(value) ||
    Buffer.byteLength(value, "utf8") >
      MAX_MESSAGE_REMINDER_IDENTIFIER_UTF8_BYTES
  ) {
    throw invalidMessageReminderRequest();
  }
  return value;
};

const readMessageReminderInput = async (
  request: IncomingMessage,
): Promise<MessageReminderInput> => {
  let url: URL;
  try {
    url = new URL(request.url ?? "", "http://handrail.invalid");
  } catch {
    throw invalidMessageReminderRequest();
  }
  const match = MESSAGE_REMINDER_PATH_PATTERN.exec(url.pathname);
  if (
    match?.[1] === undefined ||
    match[2] === undefined ||
    [...url.searchParams].length !== 0
  ) {
    throw invalidMessageReminderRequest();
  }
  const conversationId = decodeMessageReminderPathId(match[1]);
  const messageId = decodeMessageReminderPathId(match[2]);
  const contentType = request.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !CONVERSATION_CREATION_JSON_CONTENT_TYPE_PATTERN.test(contentType)
  ) {
    throw invalidMessageReminderRequest();
  }
  const headerIdempotencyKey = readMessageReminderIdempotencyKey(request);
  const decoded = await readBoundedJsonBody(
    request,
    MAX_MESSAGE_REMINDER_REQUEST_BYTES,
    invalidMessageReminderRequest,
  );
  let input: MessageReminderInput;
  try {
    input = parseMessageReminderInput(decoded);
  } catch (error) {
    if (error instanceof MessageReminderParseError) {
      throw invalidMessageReminderRequest();
    }
    throw error;
  }
  if (
    input.conversationId !== conversationId ||
    input.messageId !== messageId ||
    !MESSAGE_REMINDER_IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey) ||
    input.idempotencyKey !== headerIdempotencyKey
  ) {
    throw invalidMessageReminderRequest();
  }
  return input;
};

const parseDirectorySearchQuery = (requestUrl: string | undefined): unknown => {
  let url: URL;
  try {
    url = new URL(requestUrl ?? "", "http://handrail.invalid");
  } catch {
    throw invalidDirectoryRequest();
  }

  const input: Record<string, unknown> = {};
  for (const [key, value] of url.searchParams) {
    if (Object.hasOwn(input, key)) {
      input[key] = [input[key], value];
      continue;
    }
    input[key] = key === "limit" && /^\d+$/.test(value) ? Number(value) : value;
  }
  return input;
};

const parseRequestUrl = (requestUrl: string | undefined): URL => {
  try {
    return new URL(requestUrl ?? "", "http://handrail.invalid");
  } catch {
    throw invalidConversationSnapshotRequest();
  }
};

const readSearchParameters = (url: URL): Record<string, unknown> => {
  const parameters: Record<string, unknown> = {};
  for (const [key, value] of url.searchParams) {
    if (Object.hasOwn(parameters, key)) {
      const existing = parameters[key];
      parameters[key] = Array.isArray(existing)
        ? [...existing, value]
        : [existing, value];
    } else {
      parameters[key] = value;
    }
  }
  return parameters;
};

const assertEmptyGetRequestBody = (request: IncomingMessage): void => {
  if (
    (request.headers["content-length"] !== undefined &&
      request.headers["content-length"] !== "0") ||
    request.headers["transfer-encoding"] !== undefined
  ) {
    throw invalidConversationSnapshotRequest();
  }
};

const assertValidSavedMessageListGetRequest = (
  request: IncomingMessage,
): void => {
  if (
    (request.headers["content-length"] !== undefined &&
      request.headers["content-length"] !== "0") ||
    request.headers["transfer-encoding"] !== undefined
  ) {
    throw invalidSavedMessageListRequest();
  }
};

const assertValidMessageReminderListGetRequest = (
  request: IncomingMessage,
): void => {
  if (
    (request.headers["content-length"] !== undefined &&
      request.headers["content-length"] !== "0") ||
    request.headers["transfer-encoding"] !== undefined
  ) {
    throw invalidMessageReminderListRequest();
  }
};

const assertEmptyMessageTimelineGetRequestBody = (
  request: IncomingMessage,
): void => {
  if (
    (request.headers["content-length"] !== undefined &&
      request.headers["content-length"] !== "0") ||
    request.headers["transfer-encoding"] !== undefined
  ) {
    throw invalidMessageTimelineRequest();
  }
};

const assertEmptyActiveHuddleSnapshotGetRequestBody = (
  request: IncomingMessage,
): void => {
  if (
    (request.headers["content-length"] !== undefined &&
      request.headers["content-length"] !== "0") ||
    request.headers["transfer-encoding"] !== undefined
  ) {
    throw invalidActiveHuddleSnapshotRequest();
  }
};

const TRUSTED_CONTEXT_HEADER_PATTERN =
  /^(?:x-)?(?:(?:handrail|chat)-)?(?:tenant(?:-?id)?|organization(?:-?id)?|actor(?:-?(?:id|context|role|roles|user-id))?|user(?:-?id)?|roles?|capabilities?|permissions?)$/iu;

const readMessageSearchInput = async (
  request: IncomingMessage,
): Promise<MessageSearchRequest> => {
  let url: URL;
  try {
    url = new URL(request.url ?? "", "http://handrail.invalid");
  } catch {
    throw invalidMessageSearchRequest();
  }
  if (
    url.pathname !== MESSAGE_SEARCH_ROUTE ||
    [...url.searchParams].length > 0 ||
    Object.keys(request.headers).some((name) =>
      TRUSTED_CONTEXT_HEADER_PATTERN.test(name),
    )
  ) {
    throw invalidMessageSearchRequest();
  }
  const contentType = request.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    !CONVERSATION_CREATION_JSON_CONTENT_TYPE_PATTERN.test(contentType)
  ) {
    throw invalidMessageSearchRequest();
  }

  const decoded = await readBoundedJsonBody(
    request,
    MAX_MESSAGE_SEARCH_REQUEST_BYTES,
    invalidMessageSearchRequest,
  );
  try {
    return parseMessageSearchRequest(decoded);
  } catch (error) {
    if (error instanceof MessageSearchParseError) {
      throw invalidMessageSearchRequest();
    }
    throw error;
  }
};

const assertValidConversationDraftSnapshotGetRequest = (
  request: IncomingMessage,
): void => {
  if (
    (request.headers["content-length"] !== undefined &&
      request.headers["content-length"] !== "0") ||
    request.headers["transfer-encoding"] !== undefined ||
    Object.keys(request.headers).some((name) =>
      TRUSTED_CONTEXT_HEADER_PATTERN.test(name),
    )
  ) {
    throw invalidConversationDraftSnapshotRequest();
  }
};

const parseConversationListHttpInput = (
  requestUrl: string | undefined,
) => {
  const query = readSearchParameters(parseRequestUrl(requestUrl));
  const input: Record<string, unknown> = { ...query };
  const scope = query.scope;

  if (scope === "organization") {
    input.scope = { type: "organization" };
  } else if (scope === "entity") {
    input.scope = {
      type: "entity",
      entity: { type: query.entityType, id: query.entityId },
    };
    delete input.entityType;
    delete input.entityId;
  }

  if (typeof query.limit === "string" && /^\d+$/.test(query.limit)) {
    input.limit = Number(query.limit);
  }

  try {
    return parseConversationListSnapshotInput(input);
  } catch (error) {
    if (error instanceof ConversationSnapshotParseError) {
      throw invalidConversationSnapshotRequest();
    }
    throw error;
  }
};

const parseSavedMessageListHttpInput = (
  requestUrl: string | undefined,
) => {
  let url: URL;
  try {
    url = new URL(requestUrl ?? "", "http://handrail.invalid");
  } catch {
    throw invalidSavedMessageListRequest();
  }

  const input = readSearchParameters(url);
  if (typeof input.limit === "string" && /^\d+$/u.test(input.limit)) {
    input.limit = Number(input.limit);
  }

  try {
    return parseSavedMessageListSnapshotInput(input);
  } catch (error) {
    if (error instanceof PrivateUserStateSnapshotParseError) {
      throw invalidSavedMessageListRequest();
    }
    throw error;
  }
};

const parseMessageReminderListHttpInput = (
  requestUrl: string | undefined,
) => {
  let url: URL;
  try {
    url = new URL(requestUrl ?? "", "http://handrail.invalid");
  } catch {
    throw invalidMessageReminderListRequest();
  }
  const input = readSearchParameters(url);
  if (typeof input.limit === "string" && /^\d+$/u.test(input.limit)) {
    input.limit = Number(input.limit);
  }
  if (input.includeCancelled === "true" || input.includeCancelled === "false") {
    input.includeCancelled = input.includeCancelled === "true";
  }
  try {
    return parseMessageReminderListSnapshotInput(input);
  } catch (error) {
    if (error instanceof PrivateUserStateSnapshotParseError) {
      throw invalidMessageReminderListRequest();
    }
    throw error;
  }
};

const parseConversationDetailHttpInput = (
  requestUrl: string | undefined,
) => {
  const url = parseRequestUrl(requestUrl);
  const encodedConversationId = url.pathname.slice(
    CONVERSATION_DETAIL_ROUTE_PREFIX.length,
  );
  if (
    encodedConversationId.length === 0 ||
    encodedConversationId.includes("/")
  ) {
    throw invalidConversationSnapshotRequest();
  }

  let conversationId: string;
  try {
    conversationId = decodeURIComponent(encodedConversationId);
  } catch {
    throw invalidConversationSnapshotRequest();
  }

  const query = readSearchParameters(url);
  const input: Record<string, unknown> = {
    conversationId,
    ...query,
  };
  if (Object.hasOwn(query, "conversationId")) {
    input.conversationId = [conversationId, query.conversationId];
  }

  try {
    return parseConversationDetailSnapshotInput(input);
  } catch (error) {
    if (error instanceof ConversationSnapshotParseError) {
      throw invalidConversationSnapshotRequest();
    }
    throw error;
  }
};

const MESSAGE_TIMELINE_PATH_PATTERN =
  /^\/conversations\/([^/]+)\/messages$/u;

const ACTIVE_HUDDLE_SNAPSHOT_PATH_PATTERN =
  /^\/conversations\/([^/]+)\/huddle$/u;

const parseActiveHuddleSnapshotHttpInput = (
  requestUrl: string | undefined,
): Readonly<{ conversationId: string }> => {
  let url: URL;
  try {
    url = new URL(requestUrl ?? "", "http://handrail.invalid");
  } catch {
    throw invalidActiveHuddleSnapshotRequest();
  }

  const match = ACTIVE_HUDDLE_SNAPSHOT_PATH_PATTERN.exec(url.pathname);
  const encodedConversationId = match?.[1];
  if (encodedConversationId === undefined || [...url.searchParams].length > 0) {
    throw invalidActiveHuddleSnapshotRequest();
  }

  let conversationId: string;
  try {
    conversationId = decodeURIComponent(encodedConversationId);
  } catch {
    throw invalidActiveHuddleSnapshotRequest();
  }
  if (
    conversationId.trim().length === 0 ||
    conversationId.includes("/") ||
    conversationId.includes("\\") ||
    conversationId.includes("\0")
  ) {
    throw invalidActiveHuddleSnapshotRequest();
  }

  return { conversationId };
};

const CONVERSATION_DRAFT_SNAPSHOT_PATH_PATTERN =
  /^\/conversations\/([^/]+)\/draft$/u;

const parseConversationDraftSnapshotHttpInput = (
  requestUrl: string | undefined,
): ConversationDraftSnapshotInput => {
  let url: URL;
  try {
    url = new URL(requestUrl ?? "", "http://handrail.invalid");
  } catch {
    throw invalidConversationDraftSnapshotRequest();
  }

  const match = CONVERSATION_DRAFT_SNAPSHOT_PATH_PATTERN.exec(url.pathname);
  const encodedConversationId = match?.[1];
  if (encodedConversationId === undefined || [...url.searchParams].length > 0) {
    throw invalidConversationDraftSnapshotRequest();
  }

  let conversationId: string;
  try {
    conversationId = decodeURIComponent(encodedConversationId);
  } catch {
    throw invalidConversationDraftSnapshotRequest();
  }
  if (
    conversationId.trim().length === 0 ||
    conversationId.includes("/") ||
    conversationId.includes("\\") ||
    conversationId.includes("\0")
  ) {
    throw invalidConversationDraftSnapshotRequest();
  }

  try {
    return parseConversationDraftSnapshotInput({ conversationId });
  } catch (error) {
    if (error instanceof PrivateUserStateSnapshotParseError) {
      throw invalidConversationDraftSnapshotRequest();
    }
    throw error;
  }
};

const parseMessageTimelineHttpInput = (
  requestUrl: string | undefined,
): Record<string, unknown> => {
  let url: URL;
  try {
    url = new URL(requestUrl ?? "", "http://handrail.invalid");
  } catch {
    throw invalidMessageTimelineRequest();
  }

  const match = MESSAGE_TIMELINE_PATH_PATTERN.exec(url.pathname);
  const encodedConversationId = match?.[1];
  if (encodedConversationId === undefined) {
    throw invalidMessageTimelineRequest();
  }

  let conversationId: string;
  try {
    conversationId = decodeURIComponent(encodedConversationId);
  } catch {
    throw invalidMessageTimelineRequest();
  }
  if (
    conversationId.trim().length === 0 ||
    conversationId.includes("/") ||
    conversationId.includes("\\") ||
    conversationId.includes("\0")
  ) {
    throw invalidMessageTimelineRequest();
  }

  const query = readSearchParameters(url);
  const hasBefore = Object.hasOwn(query, "before");
  const hasAfter = Object.hasOwn(query, "after");
  const direction = hasAfter && !hasBefore ? "forward" : "backward";
  const input: Record<string, unknown> = {
    ...query,
    conversationId,
    direction,
    limit: DEFAULT_MESSAGE_TIMELINE_LIMIT,
  };

  if (Object.hasOwn(query, "conversationId")) {
    input.conversationId = [conversationId, query.conversationId];
  }
  if (Object.hasOwn(query, "direction")) {
    input.direction = [direction, query.direction];
  }
  if (Object.hasOwn(query, "limit")) {
    input.limit =
      typeof query.limit === "string" && /^\d+$/u.test(query.limit)
        ? Number(query.limit)
        : query.limit;
  }

  if (hasBefore !== hasAfter) {
    const cursorParameter = hasBefore ? "before" : "after";
    const cursorValue = query[cursorParameter];
    delete input.before;
    delete input.after;
    const cursor =
      typeof cursorValue === "string" && /^\d+$/u.test(cursorValue)
        ? Number(cursorValue)
        : cursorValue;
    input.cursor = Object.hasOwn(query, "cursor")
      ? [cursor, query.cursor]
      : cursor;
  }

  return input;
};

interface ChatHttpRouteMatcher {
  readonly method: ChatRequestAdmissionMethod;
  readonly routeTemplate: ChatRequestAdmissionRouteTemplate;
  matches(pathname: string): boolean;
}

const staticChatRoute = (
  method: ChatRequestAdmissionMethod,
  routeTemplate: ChatRequestAdmissionRouteTemplate,
): ChatHttpRouteMatcher =>
  Object.freeze({
    method,
    routeTemplate,
    matches: (pathname: string) => pathname === routeTemplate,
  });

const parameterizedChatRoute = (
  method: ChatRequestAdmissionMethod,
  routeTemplate: ChatRequestAdmissionRouteTemplate,
  pattern: RegExp,
): ChatHttpRouteMatcher =>
  Object.freeze({
    method,
    routeTemplate,
    matches: (pathname: string) => pattern.test(pathname),
  });

const MESSAGE_CONTEXT_PATH_PATTERN = /^\/conversations\/([^/]+)\/messages\/([^/]+)\/context$/u;

const THREAD_LIST_PATH_PATTERN = /^\/conversations\/([^/]+)\/threads$/u;

/** The single authoritative set of recognized chat HTTP method/path shapes. */
const CHAT_HTTP_ROUTE_MATCHERS: readonly ChatHttpRouteMatcher[] = Object.freeze([
  staticChatRoute("GET", "/_meta"),
  staticChatRoute("GET", REPLY_STYLE_PREFERENCE_ROUTE),
  staticChatRoute("PATCH", REPLY_STYLE_PREFERENCE_ROUTE),
  staticChatRoute("POST", HOST_DIRECTORY_BATCH_ROUTE),
  staticChatRoute("GET", HOST_DIRECTORY_SEARCH_ROUTE),
  staticChatRoute("GET", CONVERSATION_LIST_ROUTE),
  parameterizedChatRoute("GET", THREAD_LIST_PATH, THREAD_LIST_PATH_PATTERN),
  parameterizedChatRoute("GET", MESSAGE_CONTEXT_PATH, MESSAGE_CONTEXT_PATH_PATTERN),
  staticChatRoute("POST", CONVERSATION_LIST_ROUTE),
  staticChatRoute("GET", SAVED_MESSAGE_LIST_ROUTE),
  staticChatRoute("GET", MESSAGE_REMINDER_LIST_ROUTE),
  staticChatRoute("POST", FORWARD_MESSAGE_ROUTE),
  staticChatRoute("POST", MESSAGE_SEARCH_ROUTE),
  parameterizedChatRoute(
    "GET",
    "/conversations/:conversationId/draft",
    CONVERSATION_DRAFT_SNAPSHOT_PATH_PATTERN,
  ),
  parameterizedChatRoute(
    "PATCH",
    "/conversations/:conversationId/draft",
    DRAFT_SYNCHRONIZATION_PATH_PATTERN,
  ),
  parameterizedChatRoute(
    "GET",
    "/conversations/:conversationId/messages",
    MESSAGE_TIMELINE_PATH_PATTERN,
  ),
  parameterizedChatRoute(
    "POST",
    "/conversations/:conversationId/messages",
    MESSAGE_SEND_PATH_PATTERN,
  ),
  parameterizedChatRoute(
    "GET",
    "/conversations/:conversationId/huddle",
    ACTIVE_HUDDLE_SNAPSHOT_PATH_PATTERN,
  ),
  parameterizedChatRoute(
    "POST",
    "/conversations/:conversationId/huddles",
    START_HUDDLE_PATH_PATTERN,
  ),
  parameterizedChatRoute(
    "POST",
    "/conversations/:conversationId/attachments",
    PREPARE_ATTACHMENT_PATH_PATTERN,
  ),
  parameterizedChatRoute(
    "PUT",
    "/conversations/:conversationId/messages/:messageId/reminder",
    MESSAGE_REMINDER_PATH_PATTERN,
  ),
  parameterizedChatRoute(
    "PATCH",
    "/conversations/:conversationId/lifecycle",
    CONVERSATION_ARCHIVE_PATH_PATTERN,
  ),
  parameterizedChatRoute(
    "PATCH",
    "/conversations/:conversationId/membership",
    CONVERSATION_MEMBERSHIP_PATH_PATTERN,
  ),
  parameterizedChatRoute(
    "PATCH",
    "/conversations/:conversationId/preference",
    CONVERSATION_PREFERENCE_PATH_PATTERN,
  ),
  parameterizedChatRoute(
    "PATCH",
    "/conversations/:conversationId/read-cursor",
    READ_CURSOR_PATH_PATTERN,
  ),
  parameterizedChatRoute(
    "PATCH",
    "/conversations/:threadId/follow",
    THREAD_FOLLOW_PATH_PATTERN,
  ),
  parameterizedChatRoute(
    "GET",
    "/conversations/:conversationId",
    /^\/conversations\/([^/]+)$/u,
  ),
  parameterizedChatRoute(
    "PUT",
    "/devices/:deviceId/push-token",
    DEVICE_PUSH_TOKEN_PATH_PATTERN,
  ),
  parameterizedChatRoute(
    "POST",
    "/messages/:rootMessageId/thread",
    THREAD_CREATION_PATH_PATTERN,
  ),
  parameterizedChatRoute(
    "PATCH",
    "/messages/:messageId/reactions/:reactionKey",
    MESSAGE_REACTION_PATH_PATTERN,
  ),
  parameterizedChatRoute(
    "PATCH",
    "/messages/:messageId/saved",
    SAVED_MESSAGE_PATH_PATTERN,
  ),
  parameterizedChatRoute(
    "PATCH",
    "/messages/:messageId",
    MESSAGE_EDIT_PATH_PATTERN,
  ),
  parameterizedChatRoute(
    "DELETE",
    "/messages/:messageId",
    MESSAGE_DELETE_PATH_PATTERN,
  ),
  parameterizedChatRoute(
    "POST",
    "/huddles/:huddleSessionId/join",
    JOIN_HUDDLE_PATH_PATTERN,
  ),
  parameterizedChatRoute(
    "POST",
    "/huddles/:huddleSessionId/leave",
    LEAVE_HUDDLE_PATH_PATTERN,
  ),
  parameterizedChatRoute(
    "PATCH",
    "/huddles/:huddleSessionId/screen-share",
    HUDDLE_SCREEN_SHARE_PATH_PATTERN,
  ),
  parameterizedChatRoute(
    "POST",
    "/huddles/:huddleSessionId/end",
    END_HUDDLE_PATH_PATTERN,
  ),
  parameterizedChatRoute(
    "PATCH",
    "/attachments/:attachmentId/lifecycle",
    ATTACHMENT_LIFECYCLE_PATH_PATTERN,
  ),
  parameterizedChatRoute(
    "GET",
    "/attachments/:attachmentId/download",
    ATTACHMENT_DOWNLOAD_PATH_PATTERN,
  ),
]);

interface RecognizedChatHttpRoute {
  readonly method: ChatRequestAdmissionMethod;
  readonly routeTemplate: ChatRequestAdmissionRouteTemplate;
}

const matchChatHttpRoute = (
  method: string | undefined,
  pathname: string | undefined,
): RecognizedChatHttpRoute | undefined => {
  if (pathname === undefined) {
    return undefined;
  }
  const matcher = CHAT_HTTP_ROUTE_MATCHERS.find(
    (candidate) =>
      candidate.method === method && candidate.matches(pathname),
  );
  return matcher === undefined
    ? undefined
    : Object.freeze({
        method: matcher.method,
        routeTemplate: matcher.routeTemplate,
      });
};

const isSafeChatHttpRequestId = (value: unknown): value is string =>
  typeof value === "string" &&
  Buffer.byteLength(value, "utf8") <= MAX_CHAT_HTTP_REQUEST_ID_UTF8_BYTES &&
  /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value);

const sanitizeChatHttpStatusCode = (value: unknown): number =>
  Number.isInteger(value) && (value as number) >= 100 && (value as number) <= 599
    ? (value as number)
    : 500;

const sanitizeChatHttpOutcomeCode = (value: unknown): string | undefined =>
  typeof value === "string" && /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u.test(value)
    ? value
    : undefined;

const readChatHttpClock = (now: () => number): number => {
  try {
    const value = now();
    return Number.isFinite(value) ? value : performance.now();
  } catch {
    return performance.now();
  }
};

interface ChatHttpRequestLifecycle {
  readonly requestId: string;
  trustActor(actor: TrustedChatActorContext): void;
  setOutcome(statusCode: number, outcomeCode?: string): void;
  settle(statusCode?: number, outcomeCode?: string): void;
}

const createChatHttpRequestLifecycle = <Request>(
  request: IncomingMessage,
  response: ServerResponse,
  route: RecognizedChatHttpRoute,
  options: NormalizedChatHttpObservabilityOptions<Request>,
): ChatHttpRequestLifecycle => {
  let requestId: string = randomUUID();
  if (options.createRequestId !== undefined) {
    try {
      const supplied = options.createRequestId(
        Object.freeze({
          request: request as IncomingMessage & Request,
          method: route.method,
          routeTemplate: route.routeTemplate,
        }),
      );
      if (isSafeChatHttpRequestId(supplied)) {
        requestId = supplied;
      }
    } catch {
      // A host correlation provider cannot affect request handling.
    }
  }
  if (!response.headersSent) {
    response.setHeader(CHAT_HTTP_REQUEST_ID_HEADER, requestId);
  }

  const startedAt = readChatHttpClock(options.now);
  let actor: TrustedChatActorContext | undefined;
  let plannedStatusCode: number | undefined;
  let plannedOutcomeCode: string | undefined;
  let settled = false;

  const report = (outcome: ChatHttpRequestOutcome): void => {
    try {
      void Promise.resolve(options.onOutcome?.(outcome)).catch(() => undefined);
    } catch {
      // Observation must never affect the response or middleware chain.
    }
  };

  const removeListeners = (): void => {
    request.off?.("aborted", onAborted);
    response.off?.("finish", onFinish);
    response.off?.("close", onClose);
    response.off?.("error", onResponseError);
  };

  const settle = (statusCode?: number, outcomeCode?: string): void => {
    if (settled) return;
    settled = true;
    removeListeners();
    const completedAt = readChatHttpClock(options.now);
    const safeOutcomeCode = sanitizeChatHttpOutcomeCode(
      outcomeCode ?? plannedOutcomeCode,
    );
    const outcome = Object.freeze({
      requestId,
      method: route.method,
      routeTemplate: route.routeTemplate,
      statusCode: sanitizeChatHttpStatusCode(
        statusCode ?? plannedStatusCode ?? response.statusCode,
      ),
      ...(safeOutcomeCode === undefined
        ? {}
        : { outcomeCode: safeOutcomeCode }),
      durationMs: Math.max(0, completedAt - startedAt),
      ...(actor === undefined
        ? {}
        : { tenantId: actor.tenantId, userId: actor.userId }),
    }) satisfies ChatHttpRequestOutcome;
    report(outcome);
  };

  function onAborted(): void {
    settle(499, CHAT_HTTP_CLIENT_DISCONNECTED_CODE);
  }
  function onFinish(): void {
    settle();
  }
  function onClose(): void {
    if (response.writableFinished) {
      settle();
    } else {
      settle(499, CHAT_HTTP_CLIENT_DISCONNECTED_CODE);
    }
  }
  function onResponseError(): void {
    settle(500, CHAT_HTTP_RESPONSE_ERROR_CODE);
  }

  request.once?.("aborted", onAborted);
  response.once?.("finish", onFinish);
  response.once?.("close", onClose);
  response.once?.("error", onResponseError);

  return Object.freeze({
    requestId,
    trustActor(value: TrustedChatActorContext) {
      actor = value;
    },
    setOutcome(statusCode: number, outcomeCode?: string) {
      plannedStatusCode = sanitizeChatHttpStatusCode(statusCode);
      plannedOutcomeCode = sanitizeChatHttpOutcomeCode(outcomeCode);
    },
    settle,
  });
};

const projectConversationSummary = (
  conversation: ConversationSnapshotSummary,
): ConversationSnapshotSummary => {
  const archiveState =
    conversation.archivedAt === undefined ||
    conversation.archivedByUserId === undefined
      ? {}
      : {
          archivedAt: conversation.archivedAt,
          archivedByUserId: conversation.archivedByUserId,
        };
  const currentState = {
    latestSequence: conversation.latestSequence,
    activityAt: conversation.activityAt,
    unreadMentionCount: conversation.unreadMentionCount,
    activeMemberUserIds: [...conversation.activeMemberUserIds],
    currentMember: {
      tenantId: conversation.currentMember.tenantId,
      conversationId: conversation.currentMember.conversationId,
      userId: conversation.currentMember.userId,
      role: conversation.currentMember.role,
      state: conversation.currentMember.state,
      joinedAt: conversation.currentMember.joinedAt,
      updatedAt: conversation.currentMember.updatedAt,
    },
    currentReadState: {
      conversationId: conversation.currentReadState.conversationId,
      userId: conversation.currentReadState.userId,
      lastReadSequence: conversation.currentReadState.lastReadSequence,
      ...(conversation.currentReadState.manualUnreadFromSequence === undefined
        ? {}
        : {
            manualUnreadFromSequence:
              conversation.currentReadState.manualUnreadFromSequence,
          }),
      updatedAt: conversation.currentReadState.updatedAt,
    },
    currentPreference: {
      conversationId: conversation.currentPreference.conversationId,
      userId: conversation.currentPreference.userId,
      isStarred: conversation.currentPreference.isStarred,
      notificationPreference:
        conversation.currentPreference.notificationPreference,
      mute:
        conversation.currentPreference.mute.muted === false
          ? { muted: false as const }
          : {
              muted: true as const,
              ...(conversation.currentPreference.mute.mutedUntil === undefined
                ? {}
                : {
                    mutedUntil:
                      conversation.currentPreference.mute.mutedUntil,
                  }),
            },
      updatedAt: conversation.currentPreference.updatedAt,
    },
  };
  const base = {
    id: conversation.id,
    tenantId: conversation.tenantId,
    visibility: conversation.visibility,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    ...archiveState,
    ...currentState,
  };

  switch (conversation.type) {
    case "channel":
      return {
        ...base,
        type: "channel",
        name: conversation.name,
        ...(conversation.entity === undefined
          ? {}
          : {
              entity: {
                type: conversation.entity.type,
                id: conversation.entity.id,
              },
            }),
      };
    case "direct":
      return { ...base, type: "direct", visibility: "private" };
    case "group_direct":
      return { ...base, type: "group_direct", visibility: "private" };
    case "thread":
      return {
        ...base,
        type: "thread",
        ...(conversation.name === undefined ? {} : { name: conversation.name }),
        ...(conversation.threadLifecycle === undefined
          ? {}
          : { threadLifecycle: conversation.threadLifecycle }),
        parentConversationId: conversation.parentConversationId,
        rootMessageId: conversation.rootMessageId,
      };
  }
};

const projectConversationDetail = (
  conversation: ConversationDetailSnapshotConversation,
): ConversationDetailSnapshotConversation =>
  ({
    ...projectConversationSummary(conversation),
    memberUserIds: [...conversation.memberUserIds],
    ...(conversation.currentThreadFollow === undefined
      ? {}
      : { currentThreadFollow: conversation.currentThreadFollow }),
    ...(conversation.memberListRevision === undefined
      ? {}
      : { memberListRevision: conversation.memberListRevision }),
    currentPreference: {
      conversationId: conversation.currentPreference.conversationId,
      userId: conversation.currentPreference.userId,
      isStarred: conversation.currentPreference.isStarred,
      notificationPreference:
        conversation.currentPreference.notificationPreference,
      mute:
        conversation.currentPreference.mute.muted === false
          ? { muted: false }
          : {
              muted: true,
              ...(conversation.currentPreference.mute.mutedUntil === undefined
                ? {}
                : {
                    mutedUntil:
                      conversation.currentPreference.mute.mutedUntil,
                  }),
            },
      updatedAt: conversation.currentPreference.updatedAt,
    },
  }) as ConversationDetailSnapshotConversation;

const projectConversationListSummary = (
  conversation: ConversationListSnapshotSummary,
): ConversationListSnapshotSummary => ({
  ...projectConversationSummary(conversation),
  hasActiveHuddle: conversation.hasActiveHuddle,
});

const projectDirectoryAvatar = (
  candidate: Record<string, unknown>,
): unknown => {
  if (isObject(candidate.avatar)) {
    if (candidate.avatar.kind === "image") {
      return {
        kind: "image",
        url: candidate.avatar.url,
        ...(candidate.avatar.altText === undefined
          ? {}
          : { altText: candidate.avatar.altText }),
      };
    }
    if (candidate.avatar.kind === "initials") {
      return { kind: "initials", initials: candidate.avatar.initials };
    }
    if (candidate.avatar.kind === "none") {
      return { kind: "none" };
    }
    return { kind: candidate.avatar.kind };
  }
  if (candidate.avatarUrl !== undefined) {
    return { kind: "image", url: candidate.avatarUrl };
  }
  return { kind: "none" };
};

const projectDirectoryStatus = (
  candidate: Record<string, unknown>,
): unknown => {
  if (!isObject(candidate.status)) {
    return undefined;
  }
  const status: Record<string, unknown> = {};
  for (const key of ["availability", "text", "emoji", "expiresAt"] as const) {
    if (candidate.status[key] !== undefined) {
      status[key] = candidate.status[key];
    }
  }
  return status;
};

const projectDirectoryUser = (
  value: unknown,
  actor: TrustedChatActorContext,
  expectedUserId?: UserId,
): HostDirectoryUserSummary | undefined => {
  if (!isObject(value)) {
    throw directoryUnavailable();
  }

  if (value.tenantId !== actor.tenantId) {
    return expectedUserId === undefined
      ? undefined
      : { kind: "unavailable", userId: expectedUserId, reason: "missing" };
  }
  if (typeof value.userId !== "string" || value.userId.length === 0) {
    if (expectedUserId === undefined) {
      throw directoryUnavailable();
    }
    return { kind: "unavailable", userId: expectedUserId, reason: "missing" };
  }
  if (expectedUserId !== undefined && value.userId !== expectedUserId) {
    return { kind: "unavailable", userId: expectedUserId, reason: "missing" };
  }

  const userId = value.userId as UserId;
  if (value.kind === "redacted") {
    return { kind: "redacted", userId };
  }
  if (value.kind === "unavailable") {
    return {
      kind: "unavailable",
      userId,
      reason: value.reason as "missing" | "temporarily_unavailable",
    };
  }
  if (value.kind !== undefined && value.kind !== "active") {
    throw directoryUnavailable();
  }

  const status = projectDirectoryStatus(value);
  return {
    kind: "active",
    userId,
    displayName: value.displayName as string,
    avatar: projectDirectoryAvatar(value) as HostDirectoryAvatar,
    ...(status === undefined
      ? {}
      : { status: status as HostDirectoryUserStatus }),
  };
};

const writeDirectoryJson = (
  response: ServerResponse,
  statusCode: number,
  value: unknown,
): void => {
  let body: string;
  try {
    body = JSON.stringify(value);
  } catch {
    throw directoryUnavailable();
  }
  if (Buffer.byteLength(body) > MAX_HOST_DIRECTORY_RESPONSE_BYTES) {
    throw directoryUnavailable();
  }
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "private, no-store");
  response.end(body);
};

const writeConversationSnapshotJson = (
  response: ServerResponse,
  value:
    | ConversationListSnapshot<FeatureName>
    | ConversationDetailSnapshot<FeatureName>,
  pagination?: Readonly<{
    limit: number;
    nextCursor?: string;
    nextUrl?: string;
  }>,
): void => {
  let body: string;
  try {
    body = JSON.stringify(value);
  } catch {
    throw conversationSnapshotUnavailable();
  }
  if (Buffer.byteLength(body) > MAX_CONVERSATION_SNAPSHOT_RESPONSE_BYTES) {
    throw conversationSnapshotUnavailable();
  }

  response.statusCode = 200;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "private, no-store");
  if (pagination !== undefined) {
    response.setHeader(
      CONVERSATION_SNAPSHOT_LIMIT_HEADER,
      String(pagination.limit),
    );
    if (pagination.nextCursor !== undefined) {
      response.setHeader(
        CONVERSATION_SNAPSHOT_NEXT_CURSOR_HEADER,
        pagination.nextCursor,
      );
    }
    if (pagination.nextUrl !== undefined) {
      response.setHeader("link", `<${pagination.nextUrl}>; rel="next"`);
    }
  }
  response.end(body);
};

const writeSavedMessageListJson = (
  response: ServerResponse,
  value: SavedMessageListSnapshot,
): void => {
  let body: string;
  try {
    body = JSON.stringify(value);
  } catch {
    throw savedMessageListUnavailable();
  }
  if (Buffer.byteLength(body) > MAX_SAVED_MESSAGE_LIST_RESPONSE_BYTES) {
    throw savedMessageListUnavailable();
  }

  response.statusCode = 200;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "private, no-store");
  response.end(body);
};

const writeMessageReminderListJson = (
  response: ServerResponse,
  value: MessageReminderListSnapshot,
): void => {
  let body: string;
  try {
    body = JSON.stringify(value);
  } catch {
    throw messageReminderListUnavailable();
  }
  if (Buffer.byteLength(body) > MAX_MESSAGE_REMINDER_LIST_RESPONSE_BYTES) {
    throw messageReminderListUnavailable();
  }
  response.statusCode = 200;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "private, no-store");
  response.end(body);
};

const writeActiveHuddleSnapshotJson = (
  response: ServerResponse,
  value: HuddleSessionState,
): void => {
  let body: string;
  try {
    body = JSON.stringify(value);
  } catch {
    throw activeHuddleSnapshotUnavailable();
  }
  if (Buffer.byteLength(body) > MAX_ACTIVE_HUDDLE_SNAPSHOT_RESPONSE_BYTES) {
    throw activeHuddleSnapshotUnavailable();
  }

  response.statusCode = 200;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "private, no-store");
  response.end(body);
};

const writeConversationDraftSnapshotJson = (
  response: ServerResponse,
  value: ConversationDraftSnapshot,
): void => {
  let body: string;
  try {
    body = JSON.stringify(value);
  } catch {
    throw conversationDraftSnapshotUnavailable();
  }
  if (
    Buffer.byteLength(body) > MAX_CONVERSATION_DRAFT_SNAPSHOT_RESPONSE_BYTES
  ) {
    throw conversationDraftSnapshotUnavailable();
  }

  response.statusCode = 200;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "private, no-store");
  response.end(body);
};

const writeConversationCreationJson = (
  response: ServerResponse,
  value: ConversationCreationResult,
): void => {
  let body: string;
  try {
    body = JSON.stringify(value);
  } catch {
    throw conversationCreationUnavailable();
  }
  if (Buffer.byteLength(body) > MAX_CONVERSATION_CREATION_RESPONSE_BYTES) {
    throw conversationCreationUnavailable();
  }

  response.statusCode = value.reconciliationStatus === "created" ? 201 : 200;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "private, no-store");
  response.end(body);
};

const writeConversationArchiveJson = (
  response: ServerResponse,
  value: ConversationArchiveResult,
): void => {
  let body: string;
  try {
    body = JSON.stringify(value);
  } catch {
    throw conversationArchiveUnavailable();
  }
  if (Buffer.byteLength(body) > MAX_CONVERSATION_ARCHIVE_RESPONSE_BYTES) {
    throw conversationArchiveUnavailable();
  }

  response.statusCode =
    value.reconciliationStatus === "lifecycle_conflict" ? 409 : 200;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "private, no-store");
  response.end(body);
};

const writeConversationMembershipJson = (
  response: ServerResponse,
  value: ConversationMembershipMutationResult,
): void => {
  let body: string;
  try {
    body = JSON.stringify(value);
  } catch {
    throw conversationMembershipUnavailable();
  }
  if (Buffer.byteLength(body) > MAX_CONVERSATION_MEMBERSHIP_RESPONSE_BYTES) {
    throw conversationMembershipUnavailable();
  }

  response.statusCode =
    value.reconciliationStatus === "member_list_conflict" ||
    value.reconciliationStatus === "safety_rejected"
      ? 409
      : 200;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "private, no-store");
  response.end(body);
};

const writeConversationPreferenceJson = (
  response: ServerResponse,
  value: UpdateConversationPreferenceResult,
): void => {
  let body: string;
  try {
    body = JSON.stringify(value);
  } catch {
    throw conversationPreferenceUnavailable();
  }
  if (Buffer.byteLength(body) > MAX_CONVERSATION_PREFERENCE_RESPONSE_BYTES) {
    throw conversationPreferenceUnavailable();
  }

  response.statusCode =
    value.reconciliationStatus === "preference_revision_conflict" ? 409 : 200;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "private, no-store");
  response.end(body);
};

const writeDevicePushTokenJson = (
  response: ServerResponse,
  value: DevicePushTokenResult,
): void => {
  let body: string;
  try {
    body = JSON.stringify(value);
  } catch {
    throw devicePushTokenUnavailable();
  }
  if (Buffer.byteLength(body) > MAX_DEVICE_PUSH_TOKEN_RESPONSE_BYTES) {
    throw devicePushTokenUnavailable();
  }

  response.statusCode = 200;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "private, no-store");
  response.end(body);
};

const writeThreadFollowJson = (
  response: ServerResponse,
  value: SetThreadFollowResult,
): void => {
  let body: string;
  try {
    body = JSON.stringify(value);
  } catch {
    throw threadFollowUnavailable();
  }
  if (Buffer.byteLength(body) > MAX_THREAD_FOLLOW_RESPONSE_BYTES) {
    throw threadFollowUnavailable();
  }

  response.statusCode =
    value.reconciliationStatus === "follow_revision_conflict" ? 409 : 200;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "private, no-store");
  response.end(body);
};

const writeReadCursorJson = (
  response: ServerResponse,
  value: ReadCursorMutationResult,
): void => {
  let body: string;
  try {
    body = JSON.stringify(value);
  } catch {
    throw readCursorUnavailable();
  }
  if (Buffer.byteLength(body) > MAX_READ_CURSOR_RESPONSE_BYTES) {
    throw readCursorUnavailable();
  }

  response.statusCode = 200;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "private, no-store");
  response.end(body);
};

const writeDraftSynchronizationJson = (
  response: ServerResponse,
  value: SynchronizeDraftResult,
): void => {
  let body: string;
  try {
    body = JSON.stringify(value);
  } catch {
    throw draftSynchronizationUnavailable();
  }
  if (
    Buffer.byteLength(body) > MAX_DRAFT_SYNCHRONIZATION_RESPONSE_BYTES
  ) {
    throw draftSynchronizationUnavailable();
  }

  response.statusCode =
    value.reconciliationStatus === "stale_base" ? 409 : 200;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "private, no-store");
  response.end(body);
};

const writeThreadCreationJson = (
  response: ServerResponse,
  value: ThreadCreationResult,
): void => {
  let body: string;
  try {
    body = JSON.stringify(value);
  } catch {
    throw threadCreationUnavailable();
  }
  if (Buffer.byteLength(body) > MAX_THREAD_CREATION_RESPONSE_BYTES) {
    throw threadCreationUnavailable();
  }

  response.statusCode = value.reconciliationStatus === "created" ? 201 : 200;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "private, no-store");
  response.end(body);
};

const writeMessageSendJson = (
  response: ServerResponse,
  value: SendMessageResult,
): void => {
  let body: string;
  try {
    body = JSON.stringify(value);
  } catch {
    throw messageSendUnavailable();
  }
  if (Buffer.byteLength(body) > MAX_SEND_MESSAGE_RESPONSE_BYTES) {
    throw messageSendUnavailable();
  }

  response.statusCode = value.reconciliationStatus === "applied" ? 201 : 200;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "private, no-store");
  response.end(body);
};

const writeMessageForwardJson = (
  response: ServerResponse,
  value: ForwardMessageResult,
): void => {
  let body: string;
  try {
    body = JSON.stringify(value);
  } catch {
    throw messageForwardUnavailable();
  }
  if (Buffer.byteLength(body) > MAX_FORWARD_MESSAGE_RESPONSE_BYTES) {
    throw messageForwardUnavailable();
  }

  response.statusCode = value.reconciliationStatus === "applied" ? 201 : 200;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "private, no-store");
  response.end(body);
};

const writeMessageEditJson = (
  response: ServerResponse,
  value: EditMessageResult,
): void => {
  let body: string;
  try {
    body = JSON.stringify(value);
  } catch {
    throw messageEditUnavailable();
  }
  if (Buffer.byteLength(body) > MAX_EDIT_MESSAGE_RESPONSE_BYTES) {
    throw messageEditUnavailable();
  }

  response.statusCode =
    value.reconciliationStatus === "revision_conflict" ? 409 : 200;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "private, no-store");
  response.end(body);
};

const writeMessageDeleteJson = (
  response: ServerResponse,
  value: SoftDeleteMessageResult,
): void => {
  let body: string;
  try {
    body = JSON.stringify(value);
  } catch {
    throw messageDeleteUnavailable();
  }
  if (Buffer.byteLength(body) > MAX_DELETE_MESSAGE_RESPONSE_BYTES) {
    throw messageDeleteUnavailable();
  }

  response.statusCode =
    value.reconciliationStatus === "revision_conflict" ? 409 : 200;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "private, no-store");
  response.end(body);
};

const writeMessageReactionJson = (
  response: ServerResponse,
  value: ReactionMutationResult,
): void => {
  let body: string;
  try {
    body = JSON.stringify(value);
  } catch {
    throw messageReactionUnavailable();
  }
  if (Buffer.byteLength(body) > MAX_REACTION_MUTATION_RESPONSE_BYTES) {
    throw messageReactionUnavailable();
  }

  response.statusCode = 200;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "private, no-store");
  response.end(body);
};

const writeSavedMessageJson = (
  response: ServerResponse,
  value: SetSavedMessageResult,
): void => {
  let body: string;
  try {
    body = JSON.stringify(value);
  } catch {
    throw savedMessageUnavailable();
  }
  if (Buffer.byteLength(body) > MAX_SAVED_MESSAGE_RESPONSE_BYTES) {
    throw savedMessageUnavailable();
  }

  response.statusCode =
    value.reconciliationStatus === "saved_message_revision_conflict"
      ? 409
      : 200;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "private, no-store");
  response.end(body);
};

const writeMessageReminderJson = (
  response: ServerResponse,
  value: MessageReminderResult,
): void => {
  let body: string;
  try {
    body = JSON.stringify(value);
  } catch {
    throw messageReminderUnavailable();
  }
  if (Buffer.byteLength(body) > MAX_MESSAGE_REMINDER_RESPONSE_BYTES) {
    throw messageReminderUnavailable();
  }
  response.statusCode =
    value.reconciliationStatus === "revision-conflict" ? 409 : 200;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "private, no-store");
  response.end(body);
};

const writePrepareAttachmentJson = (
  response: ServerResponse,
  value: PrepareAttachmentResult,
): void => {
  let body: string;
  try {
    body = JSON.stringify(value);
  } catch {
    throw attachmentPreparationUnavailable();
  }
  if (Buffer.byteLength(body) > MAX_PREPARE_ATTACHMENT_RESPONSE_BYTES) {
    throw attachmentPreparationUnavailable();
  }

  response.statusCode = 200;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "private, no-store");
  response.end(body);
};

const writeHuddleStartJson = (
  response: ServerResponse,
  value: StartHuddleResult | HuddleFeatureDisabledResult,
): void => {
  let body: string;
  try {
    body = JSON.stringify(value);
  } catch {
    throw huddleStartUnavailable();
  }
  if (Buffer.byteLength(body) > MAX_START_HUDDLE_RESPONSE_BYTES) {
    throw huddleStartUnavailable();
  }

  response.statusCode = 200;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "private, no-store");
  response.end(body);
};

const writeHuddleJoinJson = (
  response: ServerResponse,
  value: JoinHuddleResult | HuddleFeatureDisabledResult,
): void => {
  let body: string;
  try {
    body = JSON.stringify(value);
  } catch {
    throw huddleJoinUnavailable();
  }
  if (Buffer.byteLength(body) > MAX_JOIN_HUDDLE_RESPONSE_BYTES) {
    throw huddleJoinUnavailable();
  }

  response.statusCode = 200;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "private, no-store");
  response.end(body);
};

const writeHuddleLeaveJson = (
  response: ServerResponse,
  value: LeaveHuddleResult,
): void => {
  let body: string;
  try {
    body = JSON.stringify(value);
  } catch {
    throw huddleLeaveUnavailable();
  }
  if (Buffer.byteLength(body) > MAX_LEAVE_HUDDLE_RESPONSE_BYTES) {
    throw huddleLeaveUnavailable();
  }

  response.statusCode = 200;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "private, no-store");
  response.end(body);
};

const writeHuddleScreenShareJson = (
  response: ServerResponse,
  value: SetHuddleScreenShareResult,
): void => {
  let body: string;
  try {
    body = JSON.stringify(value);
  } catch {
    throw huddleScreenShareUnavailable();
  }
  if (Buffer.byteLength(body) > MAX_HUDDLE_SCREEN_SHARE_RESPONSE_BYTES) {
    throw huddleScreenShareUnavailable();
  }

  response.statusCode = 200;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "private, no-store");
  response.end(body);
};

const writeHuddleEndJson = (
  response: ServerResponse,
  value: EndHuddleResult,
): void => {
  let body: string;
  try {
    body = JSON.stringify(value);
  } catch {
    throw huddleEndUnavailable();
  }
  if (Buffer.byteLength(body) > MAX_END_HUDDLE_RESPONSE_BYTES) {
    throw huddleEndUnavailable();
  }

  response.statusCode = 200;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "private, no-store");
  response.end(body);
};

const writeAttachmentLifecycleJson = (
  response: ServerResponse,
  value: FinalizeAttachmentResult | AbortAttachmentResult,
): void => {
  let body: string;
  try {
    body = JSON.stringify(value);
  } catch {
    throw attachmentLifecycleUnavailable();
  }
  if (Buffer.byteLength(body) > MAX_ATTACHMENT_LIFECYCLE_RESPONSE_BYTES) {
    throw attachmentLifecycleUnavailable();
  }

  response.statusCode = 200;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "private, no-store");
  response.end(body);
};

const setAttachmentDownloadSecurityHeaders = (
  response: ServerResponse,
): void => {
  response.setHeader("cache-control", "private, no-store");
  response.setHeader("pragma", "no-cache");
  response.setHeader("expires", "0");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("content-security-policy", "default-src 'none'");
  response.setHeader("referrer-policy", "no-referrer");
};

const writeAttachmentDownloadJson = (
  response: ServerResponse,
  value: GetAttachmentDownloadResult,
): void => {
  let body: string;
  try {
    body = JSON.stringify(value);
  } catch {
    throw attachmentDownloadUnavailable();
  }
  if (Buffer.byteLength(body) > MAX_ATTACHMENT_DOWNLOAD_RESPONSE_BYTES) {
    throw attachmentDownloadUnavailable();
  }

  response.statusCode = 200;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-length", String(Buffer.byteLength(body)));
  setAttachmentDownloadSecurityHeaders(response);
  response.end(body);
};

const writeMessageTimelineJson = (
  response: ServerResponse,
  value: MessageTimelinePage,
  limit: number,
): void => {
  let body: string;
  try {
    body = JSON.stringify(value);
  } catch {
    throw messageTimelineUnavailable();
  }
  if (Buffer.byteLength(body) > MAX_MESSAGE_TIMELINE_RESPONSE_BYTES) {
    throw messageTimelineUnavailable();
  }

  response.statusCode = 200;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "private, no-store");
  response.setHeader(MESSAGE_TIMELINE_LIMIT_HEADER, String(limit));
  response.end(body);
};

const writeMessageSearchJson = (
  response: ServerResponse,
  value: MessageSearchResponse,
): void => {
  let body: string;
  try {
    body = JSON.stringify(parseMessageSearchResponse(value));
  } catch {
    throw messageSearchUnavailable();
  }
  if (Buffer.byteLength(body) > MAX_MESSAGE_SEARCH_RESPONSE_BYTES) {
    throw messageSearchUnavailable();
  }

  response.statusCode = 200;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "private, no-store");
  response.end(body);
};

const writeChatRequestAdmissionDenied = (
  response: ServerResponse,
  retryAfterSeconds: number,
): void => {
  if (!response.headersSent) {
    response.statusCode = 429;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("cache-control", "private, no-store");
    response.setHeader("retry-after", String(retryAfterSeconds));
  }
  response.end(
    JSON.stringify({
      error: {
        code: CHAT_REQUEST_ADMISSION_DENIED_CODE,
        message: CHAT_REQUEST_ADMISSION_DENIED_MESSAGE,
      },
    }),
  );
};

const writeChatError = (
  response: ServerResponse,
  error:
    | ChatAuthenticationError
    | ChatAuthorizationError
    | ChatDirectoryRouteError
    | ChatConversationCreationRouteError
    | ChatConversationArchiveRouteError
    | ChatThreadLifecycleRouteError
    | ChatConversationMembershipRouteError
    | ChatConversationPreferenceRouteError
    | ChatReplyStylePreferenceRouteError
    | ChatDevicePushTokenRouteError
    | ChatThreadFollowRouteError
    | ChatReadCursorRouteError
    | ChatDraftSynchronizationRouteError
    | ChatThreadCreationRouteError
    | ChatMessageSendRouteError
    | ChatMessageForwardRouteError
    | ChatAttachmentPreparationRouteError
    | ChatHuddleStartRouteError
    | ChatHuddleJoinRouteError
    | ChatHuddleLeaveRouteError
    | ChatAttachmentLifecycleRouteError
    | ChatAttachmentDownloadRouteError
    | ChatMessageEditRouteError
    | ChatMessageDeleteRouteError
    | ChatMessageReactionRouteError
    | ChatSavedMessageRouteError
    | ChatSavedMessageListRouteError
    | ChatMessageReminderRouteError
    | ChatMessageReminderListRouteError
    | ChatConversationSnapshotRouteError
    | ChatMessageTimelineRouteError
    | ChatMessageContextRouteError
    | ChatMessageSearchRouteError
    | ChatThreadListRouteError
    | ChatActiveHuddleSnapshotRouteError
    | ChatConversationDraftSnapshotRouteError,
): void => {
  if (!response.headersSent) {
    response.statusCode = error.statusCode;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("cache-control", "private, no-store");
    if (error.code === CHAT_DIRECTORY_RATE_LIMITED_CODE) {
      response.setHeader(
        "retry-after",
        String(Math.ceil(HOST_DIRECTORY_RATE_LIMIT_WINDOW_MS / 1_000)),
      );
    }
  }
  response.end(
    JSON.stringify({ error: { code: error.code, message: error.message } }),
  );
};

/**
 * Creates an embedded server runtime without opening a database connection,
 * running migrations, or contacting host providers during construction. Routes
 * resolve their trusted host dependencies lazily per request.
 */
export function createChatServer<
  Request = unknown,
  Capability extends string = string,
  EntityAction extends string = string,
>(
  config: CreateChatServerConfig<Request, Capability, EntityAction>,
): ChatServerRuntime<Request, Capability, EntityAction> {
  const unsafeConfig = requireObject(config, "configuration");
  const databaseConfig = validateDatabase(unsafeConfig.database);

  validateAdapter(unsafeConfig.auth, "auth", ["resolveActor"]);
  if (
    isObject(unsafeConfig.auth) &&
    unsafeConfig.auth.revalidateActiveSession !== undefined
  ) {
    requireFunction(
      unsafeConfig.auth.revalidateActiveSession,
      "auth.revalidateActiveSession",
    );
  }
  validateAdapter(unsafeConfig.directory, "directory", [
    "getUser",
    "searchUsers",
  ]);
  validateAdapter(unsafeConfig.permissions, "permissions", [
    "getCapabilities",
    "authorizeEntity",
  ]);

  const optionalAdapters = {
    admission: unsafeConfig.admission,
    storage: unsafeConfig.storage,
    notifications: unsafeConfig.notifications,
    pushTokenProtector: unsafeConfig.pushTokenProtector,
    audit: unsafeConfig.audit,
    realtime: unsafeConfig.realtime,
    media: unsafeConfig.media,
  };
  const optionalMethods = {
    admission: ["admit"],
    storage: [
      "createUploadUrl",
      "verifyObject",
      "createDownloadUrl",
      "deleteObject",
    ],
    notifications: ["send"],
    pushTokenProtector: ["protect", "unprotect"],
    audit: ["record"],
    realtime: ["publish"],
    media: ["createRoom", "createParticipantToken", "terminateRoom"],
  } as const;

  for (const [name, adapter] of Object.entries(optionalAdapters)) {
    if (adapter !== undefined) {
      validateAdapter(
        adapter,
        name,
        optionalMethods[name as keyof typeof optionalMethods],
      );
    }
  }
  if (
    isObject(optionalAdapters.realtime) &&
    optionalAdapters.realtime.subscribe !== undefined
  ) {
    requireFunction(optionalAdapters.realtime.subscribe, "realtime.subscribe");
  }

  const httpObservability = normalizeChatHttpObservability<Request>(
    unsafeConfig.httpObservability,
  );
  const features = normalizeFeatures(unsafeConfig.features);
  const realtimeDelivery = normalizeRealtimeDelivery(
    unsafeConfig.realtimeDelivery,
  );
  if (realtimeDelivery === "clustered") {
    if (!features.realtime) {
      throw new ChatServerConfigurationError(
        "realtimeDelivery clustered requires features.realtime to be true",
      );
    }
    if (optionalAdapters.realtime === undefined) {
      throw new ChatServerConfigurationError(
        "realtimeDelivery clustered requires the realtime adapter",
      );
    }
    requireFunction(
      (optionalAdapters.realtime as Record<string, unknown>).subscribe,
      "realtime.subscribe",
    );
  }
  const outbox = normalizeOutboxOptions(unsafeConfig.outbox);
  const postgresMaintenanceOptions = normalizePostgresMaintenanceOptions(
    unsafeConfig.postgresMaintenance,
  );
  const attachmentCleanup = normalizeAttachmentCleanupOptions(
    unsafeConfig.attachmentCleanup,
  );
  const auditDelivery = normalizeAuditDeliveryOptions(
    unsafeConfig.auditDelivery,
  );
  const notificationDelivery = normalizeNotificationDeliveryOptions(
    unsafeConfig.notificationDelivery,
  );
  let ephemeralSignals: NormalizedChatEphemeralSignalOptions;
  try {
    ephemeralSignals = normalizeChatEphemeralSignalOptions(
      unsafeConfig.ephemeralSignals as ChatEphemeralSignalOptions | undefined,
    );
  } catch (error) {
    throw new ChatServerConfigurationError(
      error instanceof Error ? error.message : "ephemeralSignals is invalid",
    );
  }
  const webSocket = normalizeWebSocketOptions<Capability>(
    unsafeConfig.webSocket,
  );
  for (const [feature, adapterName] of Object.entries(FEATURE_ADAPTERS) as Array<
    [
      keyof typeof FEATURE_ADAPTERS,
      (typeof FEATURE_ADAPTERS)[keyof typeof FEATURE_ADAPTERS],
    ]
  >) {
    if (features[feature] && optionalAdapters[adapterName] === undefined) {
      throw new ChatServerConfigurationError(
        `features.${feature} requires the ${adapterName} adapter`,
      );
    }
  }
  if (
    features.notifications &&
    optionalAdapters.pushTokenProtector === undefined
  ) {
    throw new ChatServerConfigurationError(
      "features.notifications requires the pushTokenProtector adapter",
    );
  }

  const adapters = Object.freeze({
    admission: optionalAdapters.admission as
      | ChatRequestAdmissionAdapter<Request>
      | undefined,
    auth: unsafeConfig.auth as unknown as ChatAuthAdapter<Request>,
    directory: unsafeConfig.directory as unknown as ChatDirectoryAdapter,
    permissions: unsafeConfig.permissions as unknown as ChatPermissionAdapter<
      Capability,
      EntityAction
    >,
    storage: optionalAdapters.storage as ChatStorageAdapter | undefined,
    notifications: optionalAdapters.notifications as
      | ChatNotificationAdapter
      | undefined,
    pushTokenProtector: optionalAdapters.pushTokenProtector as
      | ChatPushTokenProtector
      | undefined,
    audit: optionalAdapters.audit as ChatAuditAdapter | undefined,
    realtime: optionalAdapters.realtime as ChatRealtimeAdapter | undefined,
    media: optionalAdapters.media as ChatMediaAdapter | undefined,
  });
  const normalizedConfig = Object.freeze({
    database: Object.freeze({
      schema: databaseConfig.schema,
      owned: databaseConfig.owned,
    }),
    httpObservability,
    adapters,
    features,
    realtimeDelivery,
    outbox,
    postgresMaintenance: postgresMaintenanceOptions,
    attachmentCleanup,
    auditDelivery,
    notificationDelivery,
    ephemeralSignals,
    webSocket,
  });

  let database: PostgresMigrationDatabase;
  if (databaseConfig.owned) {
    const connectionString = databaseConfig.source.connectionString as string;
    const createPool = (databaseConfig.source.createPool ??
      createDefaultPool) as ChatServerPoolFactory;
    const created = createPool({ connectionString });
    try {
      validateAdapter(created, "database.createPool result", [
        "query",
        "connect",
        "end",
      ]);
    } catch (error) {
      cleanupInvalidOwnedDatabase(created);
      throw error;
    }
    database = created;
  } else {
    database = databaseConfig.source.pool as unknown as PostgresMigrationDatabase;
  }

  const ownedDatabase = databaseConfig.owned
    ? (database as ChatServerOwnedDatabase)
    : undefined;
  let closed = false;
  let closePromise: Promise<void> | undefined;

  const migrationRunner = createPostgresMigrationRunner({
    database,
    schema: databaseConfig.schema,
    migrations: handrailChatPostgresMigrations,
  });
  const realtimeHub = createLocalChatRealtimeHub();
  const ephemeralEnabled = features.typing || features.presence;
  const realtimeSubscriber: ChatRealtimeSubscriber | undefined =
    adapters.realtime === undefined
      ? realtimeHub
      : ephemeralEnabled
        ? Object.freeze({
            subscribe(
              listener: Parameters<ChatRealtimeSubscriber["subscribe"]>[0],
            ) {
              const unsubscribeLocal = realtimeHub.subscribe(listener);
              const unsubscribeExternal = adapters.realtime?.subscribe?.(listener);
              let subscribed = true;
              return () => {
                if (!subscribed) return;
                subscribed = false;
                unsubscribeLocal();
                unsubscribeExternal?.();
              };
            },
          })
        : adapters.realtime.subscribe === undefined
          ? undefined
          : (adapters.realtime as ChatRealtimeSubscriber);
  const ephemeralRealtime = Object.freeze({
    async publish(event: Parameters<ChatRealtimeAdapter["publish"]>[0]) {
      await realtimeHub.publish(event);
      if (adapters.realtime !== undefined) {
        await adapters.realtime.publish(event);
      }
    },
  });
  const outboxPublisher = createChatOutboxPublisher({
    database,
    schema: databaseConfig.schema,
    realtime: adapters.realtime ?? realtimeHub,
    batchSize: outbox.batchSize,
    pollIntervalMs: outbox.pollIntervalMs,
    leaseDurationMs: outbox.leaseDurationMs,
    initialRetryDelayMs: outbox.initialRetryDelayMs,
    maxRetryDelayMs: outbox.maxRetryDelayMs,
    ...(outbox.onError === undefined ? {} : { onError: outbox.onError }),
    ...(outbox.onBatch === undefined ? {} : { onBatch: outbox.onBatch }),
  });
  const postgresMaintenance = createPostgresMaintenance({
    jobs: [
      createExpiredIdempotencyKeyMaintenanceJob({
        database,
        schema: databaseConfig.schema,
        batchSize:
          postgresMaintenanceOptions.expiredIdempotencyKeys.batchSize,
      }),
      createExpiredOutboxEventMaintenanceJob({
        database,
        schema: databaseConfig.schema,
        batchSize: postgresMaintenanceOptions.expiredOutboxEvents.batchSize,
      }),
      createExpiredPendingAttachmentMaintenanceJob({
        database,
        schema: databaseConfig.schema,
        batchSize:
          postgresMaintenanceOptions.expiredPendingAttachments.batchSize,
      }),
    ],
    pollIntervalMs: postgresMaintenanceOptions.pollIntervalMs,
    ...(postgresMaintenanceOptions.onError === undefined
      ? {}
      : { onError: postgresMaintenanceOptions.onError }),
    ...(postgresMaintenanceOptions.onBatch === undefined
      ? {}
      : { onBatch: postgresMaintenanceOptions.onBatch }),
  });
  const attachmentCleanupDispatcher =
    features.attachments && adapters.storage !== undefined
      ? createChatAttachmentCleanupDispatcher({
          database,
          schema: databaseConfig.schema,
          adapter: adapters.storage,
          batchSize: attachmentCleanup.batchSize,
          pollIntervalMs: attachmentCleanup.pollIntervalMs,
          leaseDurationMs: attachmentCleanup.leaseDurationMs,
          maxAttempts: attachmentCleanup.maxAttempts,
          initialRetryDelayMs: attachmentCleanup.initialRetryDelayMs,
          maxRetryDelayMs: attachmentCleanup.maxRetryDelayMs,
          ...(attachmentCleanup.onError === undefined
            ? {}
            : { onError: attachmentCleanup.onError }),
          ...(attachmentCleanup.onBatch === undefined
            ? {}
            : { onBatch: attachmentCleanup.onBatch }),
          monotonicNow: attachmentCleanup.monotonicNow,
        })
      : undefined;
  const auditDispatcher =
    features.audit && adapters.audit !== undefined
      ? createChatAuditDispatcher({
          database,
          schema: databaseConfig.schema,
          adapter: adapters.audit,
          batchSize: auditDelivery.batchSize,
          pollIntervalMs: auditDelivery.pollIntervalMs,
          leaseDurationMs: auditDelivery.leaseDurationMs,
          initialRetryDelayMs: auditDelivery.initialRetryDelayMs,
          maxRetryDelayMs: auditDelivery.maxRetryDelayMs,
          ...(auditDelivery.onError === undefined
            ? {}
            : { onError: auditDelivery.onError }),
          ...(auditDelivery.onBatch === undefined
            ? {}
            : { onBatch: auditDelivery.onBatch }),
          monotonicNow: auditDelivery.monotonicNow,
        })
      : undefined;
  const notificationDispatcher =
    features.notifications && adapters.notifications !== undefined
      ? createChatNotificationDispatcher({
          database,
          schema: databaseConfig.schema,
          adapter: adapters.notifications,
          directory: adapters.directory,
          permissions: adapters.permissions,
          pushTokenProtector: adapters.pushTokenProtector!,
          batchSize: notificationDelivery.batchSize,
          pollIntervalMs: notificationDelivery.pollIntervalMs,
          leaseDurationMs: notificationDelivery.leaseDurationMs,
          maxAttempts: notificationDelivery.maxAttempts,
          initialRetryDelayMs: notificationDelivery.initialRetryDelayMs,
          maxRetryDelayMs: notificationDelivery.maxRetryDelayMs,
          ...(notificationDelivery.isRecipientActive === undefined
            ? {}
            : {
                isRecipientActive: notificationDelivery.isRecipientActive,
              }),
          ...(notificationDelivery.onError === undefined
            ? {}
            : { onError: notificationDelivery.onError }),
          ...(notificationDelivery.onBatch === undefined
            ? {}
            : { onBatch: notificationDelivery.onBatch }),
        })
      : undefined;

  // Read-only, uncached readiness: canonical migrations plus current database
  // privileges. It cannot promise that a later transaction will succeed.
  const replyStylePreferenceReady = async (
    status?: Awaited<ReturnType<typeof migrationRunner.status>>,
  ): Promise<boolean> => {
    if (!features[REPLY_STYLE_PREFERENCE_FEATURE]) return false;
    try {
      const migrations = status ?? (await migrationRunner.status());
      if (
        migrations.incompatible.length > 0 ||
        !migrations.applied.some(
          ({ id }) => id === chatUserReplyStylePreferencesMigration.id,
        ) ||
        migrations.pending.some(
          ({ order }) => order <= chatUserReplyStylePreferencesMigration.order,
        )
      ) {
        return false;
      }
      const prefix = `"${databaseConfig.schema.replaceAll('"', '""')}"`;
      const result = await database.query<{ ready: boolean }>(
        `SELECT current_setting('transaction_read_only') = 'off'
          AND has_schema_privilege($1, 'USAGE')
          AND has_function_privilege($2, 'EXECUTE')
          AND bool_and(has_table_privilege(relation, privilege)) AS ready
         FROM (VALUES
           ($3::text, 'SELECT'), ($3, 'INSERT'), ($3, 'UPDATE'),
           ($4, 'SELECT'), ($4, 'INSERT'), ($4, 'UPDATE'),
           ($5, 'INSERT'), ($6, 'INSERT')
         ) AS required(relation, privilege)`,
        [
          databaseConfig.schema,
          `${prefix}.claim_chat_idempotency_key(text,text,text,text,text,timestamptz)`,
          `${prefix}.chat_user_reply_style_preferences`,
          `${prefix}.chat_idempotency_keys`,
          `${prefix}.chat_audit_events`,
          `${prefix}.chat_outbox_events`,
        ],
      );
      return result.rows[0]?.ready === true;
    } catch {
      return false;
    }
  };

  const capabilityReady = async (
    feature: ChatReplyThreadFeature,
    status?: Awaited<ReturnType<typeof migrationRunner.status>>,
  ): Promise<boolean> => {
    if (!features[feature]) return false;
    if (feature === REPLY_THREAD_FEATURES.savedReplyStyle) return replyStylePreferenceReady(status);
    if (feature === REPLY_THREAD_FEATURES.threadInactivity &&
        (!features[REPLY_THREAD_FEATURES.threadDiscovery] ||
         typeof unsafeConfig.threadInactivityPolicy !== "function")) return false;
    try {
      return await replyThreadStorageReady({ feature, database,
        schema: databaseConfig.schema, status: status ?? await migrationRunner.status() });
    } catch {
      return false;
    }
  };

  const readMetadata = async (): Promise<ChatServerMetadata> => {
    const migrationStatus = await migrationRunner.status();
    const schemaVersion = migrationStatus.applied.reduce(
      (highestOrder, migration) => Math.max(highestOrder, migration.order),
      0,
    );

    const effectiveCapabilities: Partial<Record<ChatReplyThreadFeature, boolean>> = {};
    for (const feature of Object.values(REPLY_THREAD_FEATURES)) {
      effectiveCapabilities[feature] = await capabilityReady(feature, migrationStatus);
    }
    return createServerHandshakeMetadata({
      packageVersion: PACKAGE_VERSION,
      protocolVersion: CHAT_PROTOCOL_VERSION,
      schemaVersion,
      enabledFeatures: {
        ...features,
        ...effectiveCapabilities,
      },
    });
  };

  const webSocketController = createChatWebSocketController<
    Request,
    Capability,
    EntityAction,
    FeatureName
  >({
    ...(adapters.admission === undefined
      ? {}
      : {
          admission: adapters.admission as ChatRequestAdmissionAdapter<
            IncomingMessage & Request
          >,
        }),
    auth: adapters.auth as ChatAuthAdapter<IncomingMessage & Request>,
    permissions: adapters.permissions,
    database,
    schema: databaseConfig.schema,
    ...(realtimeSubscriber === undefined ? {} : { realtime: realtimeSubscriber }),
    ephemeralSignals: createChatEphemeralSignalController({
      database,
      schema: databaseConfig.schema,
      permissions: adapters.permissions as ChatPermissionAdapter<string, string>,
      realtime: ephemeralRealtime,
      features: {
        typing: features.typing,
        presence: features.presence,
      } satisfies Record<EphemeralSignalFeature, boolean>,
      options: ephemeralSignals,
    }),
    options: webSocket,
    readMetadata,
  });

  const directoryRateLimits = new Map<
    string,
    { count: number; resetAt: number }
  >();
  let directoryRateLimitChecks = 0;

  const consumeDirectoryRateLimit = (
    actor: TrustedChatActorContext,
  ): void => {
    const now = Date.now();
    const key = JSON.stringify([actor.tenantId, actor.userId]);
    const current = directoryRateLimits.get(key);
    if (current === undefined || current.resetAt <= now) {
      directoryRateLimits.set(key, {
        count: 1,
        resetAt: now + HOST_DIRECTORY_RATE_LIMIT_WINDOW_MS,
      });
    } else {
      if (current.count >= HOST_DIRECTORY_RATE_LIMIT_REQUESTS) {
        throw directoryRateLimited();
      }
      current.count += 1;
    }

    directoryRateLimitChecks += 1;
    if (directoryRateLimitChecks % 256 === 0) {
      for (const [candidateKey, state] of directoryRateLimits) {
        if (state.resetAt <= now) {
          directoryRateLimits.delete(candidateKey);
        }
      }
    }
  };

  const authorizeDirectory = async (
    actor: TrustedChatActorContext,
    action:
      | typeof HOST_DIRECTORY_LOOKUP_POLICY_ACTION
      | typeof HOST_DIRECTORY_SEARCH_POLICY_ACTION,
  ): Promise<void> => {
    let allowed: boolean;
    try {
      allowed = await adapters.permissions.authorizeEntity({
        actor,
        entity: {
          type: "handrail.chat.tenant-directory",
          id: actor.tenantId,
        },
        action: action satisfies ChatDirectoryPolicyAction,
      });
    } catch {
      throw new ChatAuthorizationError();
    }
    if (allowed !== true) {
      throw new ChatAuthorizationError();
    }
  };

  const readDirectoryMetadata = async () =>
    createHostDirectorySnapshotMetadata(await readMetadata());

  const handleDirectoryBatch = async (
    request: IncomingMessage,
    response: ServerResponse,
    actor: TrustedChatActorContext,
  ): Promise<void> => {
    let url: URL;
    try {
      url = new URL(request.url ?? "", "http://handrail.invalid");
    } catch {
      throw invalidDirectoryRequest();
    }
    if ([...url.searchParams].length > 0) {
      throw invalidDirectoryRequest();
    }

    const body = await readDirectoryJsonBody(request);
    let input;
    try {
      input = parseHostDirectoryBatchLookupInput(body);
    } catch (error) {
      if (error instanceof HostDirectorySnapshotParseError) {
        throw invalidDirectoryRequest();
      }
      throw error;
    }

    const users = await Promise.all(
      input.userIds.map(async (userId): Promise<HostDirectoryUserSummary> => {
        const result = await adapters.directory.getUser({ actor, userId });
        if (result === null) {
          return { kind: "unavailable", userId, reason: "missing" };
        }
        return (
          projectDirectoryUser(result, actor, userId) ?? {
            kind: "unavailable",
            userId,
            reason: "missing",
          }
        );
      }),
    );

    const result: HostDirectoryBatchLookupResult<FeatureName> = {
      kind: "host_directory_batch",
      users,
      _meta: await readDirectoryMetadata(),
    };
    writeDirectoryJson(
      response,
      200,
      parseHostDirectoryBatchLookupResult<FeatureName>(result),
    );
  };

  const handleDirectorySearch = async (
    request: IncomingMessage,
    response: ServerResponse,
    actor: TrustedChatActorContext,
  ): Promise<void> => {
    if (
      (request.headers["content-length"] !== undefined &&
        request.headers["content-length"] !== "0") ||
      request.headers["transfer-encoding"] !== undefined
    ) {
      throw invalidDirectoryRequest();
    }

    let input;
    try {
      input = parseHostDirectorySearchInput(
        parseDirectorySearchQuery(request.url),
      );
    } catch (error) {
      if (error instanceof HostDirectorySnapshotParseError) {
        throw invalidDirectoryRequest();
      }
      throw error;
    }

    const limit = input.limit ?? DEFAULT_HOST_DIRECTORY_SEARCH_LIMIT;
    const continuation =
      input.cursor === undefined
        ? undefined
        : decodeHostDirectorySearchCursor(input.cursor).continuation;
    const adapterResult = await adapters.directory.searchUsers({
      actor,
      query: input.query,
      limit,
      ...(continuation === undefined ? {} : { continuation }),
    });
    const unsafeUsers = Array.isArray(adapterResult)
      ? adapterResult
      : isObject(adapterResult)
        ? adapterResult.users
        : undefined;
    const nextContinuation =
      !Array.isArray(adapterResult) && isObject(adapterResult)
        ? adapterResult.continuation
        : undefined;
    if (!Array.isArray(unsafeUsers) || unsafeUsers.length > limit) {
      throw directoryUnavailable();
    }
    if (
      nextContinuation !== undefined &&
      typeof nextContinuation !== "string"
    ) {
      throw directoryUnavailable();
    }

    const users: HostDirectoryUserSummary[] = [];
    const seenUserIds = new Set<string>();
    for (const unsafeUser of unsafeUsers) {
      const user = projectDirectoryUser(unsafeUser, actor);
      if (user === undefined || seenUserIds.has(user.userId)) {
        continue;
      }
      seenUserIds.add(user.userId);
      users.push(user);
    }
    if (users.length > MAX_HOST_DIRECTORY_SEARCH_LIMIT) {
      throw directoryUnavailable();
    }

    const result: HostDirectorySearchResult<FeatureName> = {
      kind: "host_directory_search",
      users,
      page:
        nextContinuation === undefined
          ? {}
          : {
              nextCursor: encodeHostDirectorySearchCursor({
                query: input.query,
                continuation: nextContinuation,
              }),
            },
      _meta: await readDirectoryMetadata(),
    };
    writeDirectoryJson(
      response,
      200,
      parseHostDirectorySearchResult<FeatureName>(result),
    );
  };

  const threadListHandlerOptions = createThreadListHandlerOptions(
    unsafeConfig.threadInactivityPolicy,
  );

  const handleReplyStylePreference = async (
    request: IncomingMessage,
    response: ServerResponse,
    actor: TrustedChatActorContext,
    requestId: string,
  ): Promise<void> => {
    if (!features[REPLY_STYLE_PREFERENCE_FEATURE]) {
      throw new ChatReplyStylePreferenceRouteError(
        "chat_reply_style_preference_disabled",
        501,
        "Reply-style preference is not supported",
      );
    }
    const input = await (async () => {
      try {
        const url = parseRequestUrl(request.url);
        if (
          [...url.searchParams].length > 0 ||
          Object.keys(request.headers).some((name) =>
            TRUSTED_CONTEXT_HEADER_PATTERN.test(name),
          )
        ) {
          throw invalidReplyStylePreferenceRequest();
        }
        if (request.method === "GET") {
          assertEmptyGetRequestBody(request);
          return parseGetReplyStylePreferenceInput({});
        }
        const contentType = request.headers["content-type"];
        if (
          typeof contentType !== "string" ||
          !CONVERSATION_CREATION_JSON_CONTENT_TYPE_PATTERN.test(contentType)
        ) {
          throw invalidReplyStylePreferenceRequest();
        }
        return parseUpdateReplyStylePreferenceInput(
          await readBoundedJsonBody(
            request, 64 * 1_024, invalidReplyStylePreferenceRequest,
          ),
        );
      } catch {
        throw invalidReplyStylePreferenceRequest();
      }
    })();
    if (!(await capabilityReady(REPLY_THREAD_FEATURES.savedReplyStyle))) {
      throw replyStylePreferenceUnavailable();
    }
    const options = { database, schema: databaseConfig.schema, actor, input };
    const result = request.method === "GET"
      ? await queryReplyStylePreference(options)
      : await updateReplyStylePreference({ ...options, requestId });
    response.statusCode =
      "reconciliationStatus" in result &&
      result.reconciliationStatus === "preference_revision_conflict" ? 409 : 200;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("cache-control", "private, no-store");
    response.end(JSON.stringify(result));
  };

  const handleThreadList = async (
    request: IncomingMessage,
    response: ServerResponse,
    actor: TrustedChatActorContext,
  ): Promise<void> => {
    if (!features[REPLY_THREAD_FEATURES.threadDiscovery]) {
      throw new ChatThreadListRouteError(
        "chat_thread_discovery_disabled",
        501,
        "Thread discovery is not supported",
      );
    }
    const input = (() => {
      try {
        assertEmptyGetRequestBody(request);
        if (
          Object.keys(request.headers).some((name) =>
            TRUSTED_CONTEXT_HEADER_PATTERN.test(name),
          )
        ) {
          throw invalidThreadListRequest();
        }
        const url = parseRequestUrl(request.url);
        const encodedParentId = THREAD_LIST_PATH_PATTERN.exec(url.pathname)?.[1];
        if (encodedParentId === undefined) throw invalidThreadListRequest();
        const query: Record<string, string> = Object.create(null);
        for (const [key, value] of url.searchParams) {
          if (Object.hasOwn(query, key)) throw invalidThreadListRequest();
          query[key] = value;
        }
        return parseThreadListHttpRequest(
          decodeURIComponent(encodedParentId),
          query,
        );
      } catch {
        throw invalidThreadListRequest();
      }
    })();
    if (!(await capabilityReady(REPLY_THREAD_FEATURES.threadDiscovery))) {
      throw threadListUnavailable();
    }
    const result = await queryThreadList({
      database,
      schema: databaseConfig.schema,
      permissions: adapters.permissions as ChatPermissionAdapter<
        string,
        typeof THREAD_LIST_ENTITY_POLICY_ACTION
      >,
      actor,
      input,
      ...(await capabilityReady(REPLY_THREAD_FEATURES.threadInactivity)
        ? threadListHandlerOptions : {}),
      lifecycleSupported: await capabilityReady(REPLY_THREAD_FEATURES.threadLifecycle),
    });
    response.statusCode = 200;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("cache-control", "private, no-store");
    response.end(JSON.stringify(result));
  };

  const handleConversationList = async (
    request: IncomingMessage,
    response: ServerResponse,
    actor: TrustedChatActorContext,
  ): Promise<void> => {
    assertEmptyGetRequestBody(request);
    const input = parseConversationListHttpInput(request.url);
    const [result, metadata] = await Promise.all([
      queryConversationList({
        database,
        permissions: adapters.permissions as ChatPermissionAdapter<
          string,
          typeof CONVERSATION_LIST_ENTITY_POLICY_ACTION
        >,
        actor,
        input,
        schema: databaseConfig.schema,
      }),
      readMetadata(),
    ]);
    const snapshot = parseConversationListSnapshot<FeatureName>({
      kind: "conversation_list",
      scope: input.scope,
      items: result.items.map(projectConversationListSummary),
      page:
        result.nextCursor === undefined
          ? {}
          : { nextCursor: result.nextCursor },
      _meta: createConversationSnapshotMetadata(metadata),
    });
    const nextUrl =
      result.nextCursor === undefined
        ? undefined
        : (() => {
            const url = parseRequestUrl(request.url);
            url.searchParams.set("cursor", result.nextCursor);
            return `${url.pathname}${url.search}`;
          })();

    writeConversationSnapshotJson(response, snapshot, {
      limit: input.limit ?? DEFAULT_CONVERSATION_LIST_LIMIT,
      ...(result.nextCursor === undefined || nextUrl === undefined
        ? {}
        : { nextCursor: result.nextCursor, nextUrl }),
    });
  };

  const handleConversationCreation = async (
    request: IncomingMessage,
    response: ServerResponse,
    actor: TrustedChatActorContext,
    requestId: string,
  ): Promise<void> => {
    const input = await readConversationCreationInput(request);
    const metadata = await readMetadata();
    const result = await createConversation<FeatureName>({
      database,
      directory: adapters.directory,
      permissions: adapters.permissions as ChatPermissionAdapter<
        string,
        typeof CREATE_CONVERSATION_ENTITY_POLICY_ACTION
      >,
      actor,
      input,
      schema: databaseConfig.schema,
      metadata,
      requestId,
    });
    writeConversationCreationJson(
      response,
      parseConversationCreationResult(result, input),
    );
  };

  const handleThreadCreation = async (
    request: IncomingMessage,
    response: ServerResponse,
    actor: TrustedChatActorContext,
    requestId: string,
  ): Promise<void> => {
    const input = await readThreadCreationInput(request);
    if (input.name !== undefined) {
      if (!features[REPLY_THREAD_FEATURES.namedThreads]) {
        throw new ChatThreadCreationRouteError("chat_named_threads_disabled", 501,
          "Named-thread creation is not supported");
      }
      if (!(await capabilityReady(REPLY_THREAD_FEATURES.namedThreads))) {
        throw threadCreationUnavailable();
      }
    }
    const metadata = await readMetadata();
    const result = await createThread<FeatureName>({
      database,
      permissions: adapters.permissions as ChatPermissionAdapter<
        string,
        typeof CREATE_THREAD_ENTITY_POLICY_ACTION
      >,
      actor,
      input,
      schema: databaseConfig.schema,
      metadata,
      requestId,
    });
    writeThreadCreationJson(
      response,
      parseThreadCreationResult(result, input),
    );
  };

  const handleMessageSend = async (
    request: IncomingMessage,
    response: ServerResponse,
    actor: TrustedChatActorContext,
    requestId: string,
  ): Promise<void> => {
    const input = await readMessageSendInput(request);
    if (input.replyTo !== undefined) {
      if (!features[REPLY_THREAD_FEATURES.inlineReplies]) {
        throw new ChatMessageSendRouteError("chat_inline_replies_disabled", 501,
          "Inline replies are not supported");
      }
      if (!(await capabilityReady(REPLY_THREAD_FEATURES.inlineReplies))) {
        throw messageSendUnavailable();
      }
    }
    const result = await sendMessage({
      database,
      directory: adapters.directory,
      permissions: adapters.permissions as ChatPermissionAdapter<
        string,
        typeof SEND_MESSAGE_ENTITY_POLICY_ACTION
      >,
      actor,
      input,
      schema: databaseConfig.schema,
      requestId,
    });
    writeMessageSendJson(response, parseSendMessageResult(result));
  };

  const handleMessageForward = async (
    request: IncomingMessage,
    response: ServerResponse,
    actor: TrustedChatActorContext,
    requestId: string,
  ): Promise<void> => {
    const input = await readMessageForwardInput(request);
    const result = await forwardMessage({
      database,
      directory: adapters.directory,
      permissions: adapters.permissions as ChatPermissionAdapter<
        string,
        | typeof FORWARD_MESSAGE_SOURCE_ENTITY_POLICY_ACTION
        | typeof FORWARD_MESSAGE_DESTINATION_ENTITY_POLICY_ACTION
      >,
      actor,
      input,
      schema: databaseConfig.schema,
      requestId,
    });
    writeMessageForwardJson(
      response,
      parseForwardMessageResult(result, input),
    );
  };

  const handleMessageEdit = async (
    request: IncomingMessage,
    response: ServerResponse,
    actor: TrustedChatActorContext,
    requestId: string,
  ): Promise<void> => {
    const input = await readMessageEditInput(request);
    const result = await editMessage({
      database,
      permissions: adapters.permissions,
      actor,
      input,
      schema: databaseConfig.schema,
      requestId,
    });
    writeMessageEditJson(response, parseEditMessageResult(result));
  };

  const handleMessageDelete = async (
    request: IncomingMessage,
    response: ServerResponse,
    actor: TrustedChatActorContext,
    requestId: string,
  ): Promise<void> => {
    const input = await readMessageDeleteInput(request);
    const result = await softDeleteMessage({
      database,
      permissions: adapters.permissions,
      actor,
      input,
      schema: databaseConfig.schema,
      requestId,
    });
    writeMessageDeleteJson(response, parseSoftDeleteMessageResult(result));
  };

  const handleMessageReaction = async (
    request: IncomingMessage,
    response: ServerResponse,
    actor: TrustedChatActorContext,
    requestId: string,
  ): Promise<void> => {
    const input = await readMessageReactionInput(request);
    const result = await setReaction({
      database,
      permissions: adapters.permissions as ChatPermissionAdapter<
        string,
        typeof SET_REACTION_ENTITY_POLICY_ACTION
      >,
      actor,
      input,
      schema: databaseConfig.schema,
      requestId,
    });
    writeMessageReactionJson(
      response,
      parseReactionMutationResult(result),
    );
  };

  const handleSavedMessage = async (
    request: IncomingMessage,
    response: ServerResponse,
    actor: TrustedChatActorContext,
    requestId: string,
  ): Promise<void> => {
    const input = await readSavedMessageInput(request);
    const result = await setSavedMessage({
      database,
      permissions: adapters.permissions as ChatPermissionAdapter<
        string,
        typeof SET_SAVED_MESSAGE_ENTITY_POLICY_ACTION
      >,
      actor,
      input,
      schema: databaseConfig.schema,
      requestId,
    });
    writeSavedMessageJson(
      response,
      parseSetSavedMessageResult(result, input),
    );
  };

  const handleMessageReminder = async (
    request: IncomingMessage,
    response: ServerResponse,
    actor: TrustedChatActorContext,
    requestId: string,
  ): Promise<void> => {
    const input = await readMessageReminderInput(request);
    const result = await setMessageReminder({
      database,
      permissions: adapters.permissions as ChatPermissionAdapter<
        string,
        typeof SET_MESSAGE_REMINDER_ENTITY_POLICY_ACTION
      >,
      actor,
      input,
      schema: databaseConfig.schema,
      requestId,
    });
    writeMessageReminderJson(
      response,
      parseMessageReminderResult(result, input),
    );
  };

  const handlePrepareAttachment = async (
    request: IncomingMessage,
    response: ServerResponse,
    actor: TrustedChatActorContext,
  ): Promise<void> => {
    const { conversationId, input } =
      await readPrepareAttachmentInput(request);
    const result = await prepareAttachment({
      database,
      schema: databaseConfig.schema,
      attachmentsEnabled: features.attachments,
      ...(adapters.storage === undefined ? {} : { storage: adapters.storage }),
      permissions: adapters.permissions as ChatPermissionAdapter<
        string,
        typeof PREPARE_ATTACHMENT_ENTITY_POLICY_ACTION
      >,
      actor,
      conversationId,
      input,
    });
    writePrepareAttachmentJson(
      response,
      parsePrepareAttachmentResult(result, input),
    );
  };

  const handleStartHuddle = async (
    request: IncomingMessage,
    response: ServerResponse,
    actor: TrustedChatActorContext,
    requestId: string,
  ): Promise<void> => {
    const input = await readStartHuddleInput(request);
    const result = await startHuddle({
      database,
      schema: databaseConfig.schema,
      permissions: adapters.permissions as ChatPermissionAdapter<
        string,
        typeof START_HUDDLE_ENTITY_POLICY_ACTION
      >,
      actor,
      input,
      mediaEnabled: normalizedConfig.features.media,
      ...(adapters.media === undefined ? {} : { media: adapters.media }),
      requestId,
    });
    const parsed = parseHuddleCommandResult(result, input);
    if (parsed.operation !== "start_huddle") {
      throw huddleStartUnavailable();
    }
    writeHuddleStartJson(response, parsed);
  };

  const handleJoinHuddle = async (
    request: IncomingMessage,
    response: ServerResponse,
    actor: TrustedChatActorContext,
  ): Promise<void> => {
    const input = await readJoinHuddleInput(request);
    const result = await joinHuddle({
      database,
      schema: databaseConfig.schema,
      permissions: adapters.permissions as ChatPermissionAdapter<
        string,
        typeof JOIN_HUDDLE_ENTITY_POLICY_ACTION
      >,
      actor,
      input,
      mediaEnabled: normalizedConfig.features.media,
      ...(adapters.media === undefined ? {} : { media: adapters.media }),
    });
    const parsed = parseHuddleCommandResult(result, input);
    if (parsed.operation !== "join_huddle") {
      throw huddleJoinUnavailable();
    }
    writeHuddleJoinJson(
      response,
      parsed as JoinHuddleResult | HuddleFeatureDisabledResult,
    );
  };

  const handleLeaveHuddle = async (
    request: IncomingMessage,
    response: ServerResponse,
    actor: TrustedChatActorContext,
  ): Promise<void> => {
    const input = await readLeaveHuddleInput(request);
    const result = await leaveHuddle({
      database,
      schema: databaseConfig.schema,
      permissions: adapters.permissions as ChatPermissionAdapter<
        string,
        typeof LEAVE_HUDDLE_ENTITY_POLICY_ACTION
      >,
      actor,
      input,
    });
    const parsed = parseHuddleCommandResult(result, input);
    if (parsed.operation !== "leave_huddle") {
      throw huddleLeaveUnavailable();
    }
    writeHuddleLeaveJson(response, parsed);
  };

  const handleHuddleScreenShare = async (
    request: IncomingMessage,
    response: ServerResponse,
    actor: TrustedChatActorContext,
  ): Promise<void> => {
    const input = await readHuddleScreenShareInput(request);
    const result = await setHuddleScreenShare({
      database,
      schema: databaseConfig.schema,
      permissions: adapters.permissions as ChatPermissionAdapter<
        string,
        typeof HUDDLE_SCREEN_SHARE_ENTITY_POLICY_ACTION
      >,
      actor,
      input,
      maxActiveScreenSharers: normalizedConfig.features.media ? 1 : 0,
    });
    const parsed = parseHuddleCommandResult(result, input);
    if (parsed.operation !== "set_huddle_screen_share") {
      throw huddleScreenShareUnavailable();
    }
    writeHuddleScreenShareJson(response, parsed);
  };

  const handleEndHuddle = async (
    request: IncomingMessage,
    response: ServerResponse,
    actor: TrustedChatActorContext,
    requestId: string,
  ): Promise<void> => {
    const input = await readEndHuddleInput(request);
    if (adapters.media === undefined) {
      throw huddleEndUnavailable();
    }
    const result = await endHuddle({
      database,
      schema: databaseConfig.schema,
      permissions: adapters.permissions as ChatPermissionAdapter<
        string,
        typeof END_HUDDLE_ENTITY_POLICY_ACTION
      >,
      actor,
      input,
      media: adapters.media,
      requestId,
    });
    const parsed = parseHuddleCommandResult(result, input);
    if (parsed.operation !== "end_huddle") {
      throw huddleEndUnavailable();
    }
    writeHuddleEndJson(response, parsed);
  };

  const handleAttachmentLifecycle = async (
    request: IncomingMessage,
    response: ServerResponse,
    actor: TrustedChatActorContext,
    requestId: string,
  ): Promise<void> => {
    const input = await readAttachmentLifecycleInput(request);
    if (!features.attachments || adapters.storage === undefined) {
      throw attachmentLifecycleUnavailable();
    }
    if (input.operation === "finalize_attachment") {
      const result = await finalizeAttachment({
        database,
        schema: databaseConfig.schema,
        storage: adapters.storage,
        actor,
        input,
        requestId,
      });
      writeAttachmentLifecycleJson(
        response,
        parseFinalizeAttachmentResult(result, input),
      );
      return;
    }
    const result = await abortAttachment({
      database,
      schema: databaseConfig.schema,
      storage: adapters.storage,
      actor,
      input,
      requestId,
    });
    writeAttachmentLifecycleJson(
      response,
      parseAbortAttachmentResult(result, input),
    );
  };

  const handleAttachmentDownload = async (
    request: IncomingMessage,
    response: ServerResponse,
    actor: TrustedChatActorContext,
  ): Promise<void> => {
    const input = readAttachmentDownloadInput(request);
    if (!features.attachments || adapters.storage === undefined) {
      throw attachmentDownloadUnavailable();
    }
    const result = await queryAttachmentDownload({
      database,
      schema: databaseConfig.schema,
      permissions: adapters.permissions as ChatPermissionAdapter<
        string,
        typeof ATTACHMENT_DOWNLOAD_ENTITY_POLICY_ACTION
      >,
      storage: adapters.storage,
      actor,
      input,
    });
    writeAttachmentDownloadJson(response, result);
  };

  const handleConversationLifecycle = async (
    request: IncomingMessage,
    response: ServerResponse,
    actor: TrustedChatActorContext,
    requestId: string,
  ): Promise<void> => {
    const input = await readConversationLifecycleInput(request);
    if (input.operation === "update_thread_lifecycle") {
      if (!features[REPLY_THREAD_FEATURES.threadLifecycle]) {
        throw new ChatThreadLifecycleRouteError("chat_thread_lifecycle_disabled", 501,
          "Thread lifecycle is not supported");
      }
      if (!(await capabilityReady(REPLY_THREAD_FEATURES.threadLifecycle))) {
        throw threadLifecycleUnavailable();
      }
      try {
        const result = parseThreadLifecycleResult(
          await updateThreadLifecycle({
            database,
            permissions: adapters.permissions as ChatPermissionAdapter<
              string,
              "message.send" | "thread.manage"
            >,
            actor,
            input,
            schema: databaseConfig.schema,
          }),
          input,
        );
        const body = JSON.stringify(result);
        if (Buffer.byteLength(body) > MAX_CONVERSATION_ARCHIVE_RESPONSE_BYTES) {
          throw threadLifecycleUnavailable();
        }
        response.statusCode =
          result.reconciliationStatus === "lifecycle_conflict" ? 409 : 200;
        response.setHeader("content-type", "application/json; charset=utf-8");
        response.setHeader("cache-control", "private, no-store");
        response.end(body);
      } catch (error) {
        if (error instanceof ChatAuthorizationError) throw error;
        if (error instanceof UpdateThreadLifecycleCommandError) {
          throw threadLifecycleConflict();
        }
        // Invalid command results and internal errors must never disclose state.
        throw threadLifecycleUnavailable();
      }
      return;
    }
    const result = await archiveConversation({
      database,
      permissions: adapters.permissions as ChatPermissionAdapter<
        string,
        typeof ARCHIVE_CONVERSATION_ENTITY_POLICY_ACTION
      >,
      actor,
      input,
      schema: databaseConfig.schema,
      requestId,
    });
    writeConversationArchiveJson(
      response,
      parseConversationArchiveResult(result, input),
    );
  };

  const handleConversationMembership = async (
    request: IncomingMessage,
    response: ServerResponse,
    actor: TrustedChatActorContext,
    requestId: string,
  ): Promise<void> => {
    const input = await readConversationMembershipInput(request);
    const result = await mutateConversationMembership({
      database,
      directory: adapters.directory,
      permissions: adapters.permissions as ChatPermissionAdapter<
        string,
        typeof CONVERSATION_MEMBERSHIP_ENTITY_POLICY_ACTION
      >,
      actor,
      input,
      schema: databaseConfig.schema,
      requestId,
    });
    writeConversationMembershipJson(
      response,
      parseConversationMembershipMutationResult(result, input),
    );
  };

  const handleConversationPreference = async (
    request: IncomingMessage,
    response: ServerResponse,
    actor: TrustedChatActorContext,
    requestId: string,
  ): Promise<void> => {
    const input = await readConversationPreferenceInput(request);
    const result = await updateConversationPreference({
      database,
      permissions: adapters.permissions as ChatPermissionAdapter<
        string,
        "conversation.preference.update"
      >,
      actor,
      input,
      schema: databaseConfig.schema,
      requestId,
    });
    writeConversationPreferenceJson(
      response,
      parseUpdateConversationPreferenceResult(result, input),
    );
  };

  const handleDevicePushToken = async (
    request: IncomingMessage,
    response: ServerResponse,
    actor: TrustedChatActorContext,
    requestId: string,
  ): Promise<void> => {
    const input = await readDevicePushTokenInput(request);
    if (adapters.pushTokenProtector === undefined) {
      throw devicePushTokenUnavailable();
    }
    const result = await updateDevicePushToken({
      database,
      pushTokenProtector: adapters.pushTokenProtector,
      actor,
      input,
      schema: databaseConfig.schema,
      requestId,
    });
    writeDevicePushTokenJson(
      response,
      parseDevicePushTokenResult(result, input),
    );
  };

  const handleThreadFollow = async (
    request: IncomingMessage,
    response: ServerResponse,
    actor: TrustedChatActorContext,
    requestId: string,
  ): Promise<void> => {
    const input = await readThreadFollowInput(request);
    const result = await setThreadFollow({
      database,
      permissions: adapters.permissions as ChatPermissionAdapter<
        string,
        typeof SET_THREAD_FOLLOW_ENTITY_POLICY_ACTION
      >,
      actor,
      input,
      schema: databaseConfig.schema,
      requestId,
    });
    writeThreadFollowJson(
      response,
      parseSetThreadFollowResult(result, input),
    );
  };

  const handleReadCursor = async (
    request: IncomingMessage,
    response: ServerResponse,
    actor: TrustedChatActorContext,
    requestId: string,
  ): Promise<void> => {
    const input = await readReadCursorInput(request);
    const result = await updateReadCursor({
      database,
      permissions: adapters.permissions as ChatPermissionAdapter<
        string,
        "conversation.read_cursor.update"
      >,
      actor,
      input,
      schema: databaseConfig.schema,
      requestId,
    });
    writeReadCursorJson(response, parseReadCursorMutationResult(result));
  };

  const handleDraftSynchronization = async (
    request: IncomingMessage,
    response: ServerResponse,
    actor: TrustedChatActorContext,
  ): Promise<void> => {
    const input = await readDraftSynchronizationInput(request);
    const result = await synchronizeDraft({
      database,
      permissions: adapters.permissions as ChatPermissionAdapter<
        string,
        "conversation.draft.synchronize"
      >,
      actor,
      input,
      schema: databaseConfig.schema,
    });
    writeDraftSynchronizationJson(
      response,
      parseSynchronizeDraftResult(result, input),
    );
  };

  const handleConversationDraftSnapshot = async (
    request: IncomingMessage,
    response: ServerResponse,
    actor: TrustedChatActorContext,
  ): Promise<void> => {
    assertValidConversationDraftSnapshotGetRequest(request);
    const input = parseConversationDraftSnapshotHttpInput(request.url);
    const snapshot = await queryConversationDraftSnapshot({
      database,
      permissions: adapters.permissions as ChatPermissionAdapter<
        string,
        typeof CONVERSATION_DRAFT_SNAPSHOT_ENTITY_POLICY_ACTION
      >,
      actor,
      input,
      schema: databaseConfig.schema,
    });
    writeConversationDraftSnapshotJson(
      response,
      parseConversationDraftSnapshot(snapshot, input),
    );
  };

  const handleConversationDetail = async (
    request: IncomingMessage,
    response: ServerResponse,
    actor: TrustedChatActorContext,
  ): Promise<void> => {
    assertEmptyGetRequestBody(request);
    const input = parseConversationDetailHttpInput(request.url);
    const [conversation, metadata] = await Promise.all([
      queryConversationDetail({
        database,
        permissions: adapters.permissions as ChatPermissionAdapter<
          string,
          typeof CONVERSATION_DETAIL_ENTITY_POLICY_ACTION
        >,
        actor,
        input,
        schema: databaseConfig.schema,
      }),
      readMetadata(),
    ]);
    const snapshot = parseConversationDetailSnapshot<FeatureName>({
      kind: "conversation_detail",
      conversation: projectConversationDetail(conversation),
      _meta: createConversationSnapshotMetadata(metadata),
    });
    writeConversationSnapshotJson(response, snapshot);
  };

  const handleActiveHuddleSnapshot = async (
    request: IncomingMessage,
    response: ServerResponse,
    actor: TrustedChatActorContext,
  ): Promise<void> => {
    assertEmptyActiveHuddleSnapshotGetRequestBody(request);
    const input = parseActiveHuddleSnapshotHttpInput(request.url);
    const state = await queryActiveHuddleSnapshot({
      database,
      permissions: adapters.permissions as ChatPermissionAdapter<
        string,
        typeof ACTIVE_HUDDLE_ENTITY_POLICY_ACTION
      >,
      actor,
      input,
      schema: databaseConfig.schema,
    });
    writeActiveHuddleSnapshotJson(
      response,
      parseHuddleSessionState(state),
    );
  };

  const messageTimelineStorage =
    adapters.storage ??
    Object.freeze({
      async createDownloadUrl(): Promise<never> {
        throw messageTimelineUnavailable();
      },
    });

  const savedMessageListStorage =
    adapters.storage ??
    Object.freeze({
      async createDownloadUrl(): Promise<never> {
        throw savedMessageListUnavailable();
      },
    });

  const handleSavedMessageList = async (
    request: IncomingMessage,
    response: ServerResponse,
    actor: TrustedChatActorContext,
  ): Promise<void> => {
    assertValidSavedMessageListGetRequest(request);
    const input = parseSavedMessageListHttpInput(request.url);
    const result = await querySavedMessageList({
      database,
      permissions: adapters.permissions as ChatPermissionAdapter<
        string,
        typeof SAVED_MESSAGE_LIST_ENTITY_POLICY_ACTION
      >,
      storage: savedMessageListStorage,
      actor,
      input,
      schema: databaseConfig.schema,
    });
    writeSavedMessageListJson(
      response,
      parseSavedMessageListSnapshot(result, input),
    );
  };

  const handleMessageReminderList = async (
    request: IncomingMessage,
    response: ServerResponse,
    actor: TrustedChatActorContext,
  ): Promise<void> => {
    assertValidMessageReminderListGetRequest(request);
    const input = parseMessageReminderListHttpInput(request.url);
    const result = await queryMessageReminderList({
      database,
      permissions: adapters.permissions as ChatPermissionAdapter<
        string,
        typeof MESSAGE_REMINDER_LIST_ENTITY_POLICY_ACTION
      >,
      actor,
      input,
      schema: databaseConfig.schema,
    });
    writeMessageReminderListJson(
      response,
      parseMessageReminderListSnapshot(result, input),
    );
  };

  const handleMessageContext = async (
    request: IncomingMessage,
    response: ServerResponse,
    actor: TrustedChatActorContext,
  ): Promise<void> => {
    const input = (() => {
      // Only caller input errors are 400s. Query/result failures remain retryable.
      try {
        assertEmptyGetRequestBody(request);
        if (Object.keys(request.headers).some((name) =>
          TRUSTED_CONTEXT_HEADER_PATTERN.test(name),
        )) {
          throw invalidMessageContextRequest();
        }
        const url = parseRequestUrl(request.url);
        if (url.searchParams.size !== 0) throw invalidMessageContextRequest();
        const match = MESSAGE_CONTEXT_PATH_PATTERN.exec(url.pathname);
        if (match?.[1] === undefined || match[2] === undefined) {
          throw invalidMessageContextRequest();
        }
        return parseMessageContextRequest({
          conversationId: decodeURIComponent(match[1]),
          messageId: decodeURIComponent(match[2]),
        });
      } catch {
        throw invalidMessageContextRequest();
      }
    })();
    const result = parseMessageContextResult(await queryMessageContext({
      database,
      schema: databaseConfig.schema,
      permissions: adapters.permissions as ChatPermissionAdapter<
        string,
        typeof MESSAGE_TIMELINE_ENTITY_POLICY_ACTION
      >,
      storage: messageTimelineStorage,
      actor,
      input,
    }), input);
    const serialized = JSON.stringify(result);
    response.statusCode = 200;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("cache-control", "private, no-store");
    response.end(serialized);
  };

  const handleMessageTimeline = async (
    request: IncomingMessage,
    response: ServerResponse,
    actor: TrustedChatActorContext,
  ): Promise<void> => {
    assertEmptyMessageTimelineGetRequestBody(request);
    const input = parseMessageTimelineHttpInput(request.url);
    const timeline = await queryMessageTimeline({
      database,
      permissions: adapters.permissions as ChatPermissionAdapter<
        string,
        typeof MESSAGE_TIMELINE_ENTITY_POLICY_ACTION
      >,
      storage: messageTimelineStorage,
      actor,
      input,
      schema: databaseConfig.schema,
    });
    writeMessageTimelineJson(response, timeline, input.limit as number);
  };

  const handleMessageSearch = async (
    request: IncomingMessage,
    response: ServerResponse,
    actor: TrustedChatActorContext,
  ): Promise<void> => {
    const input = await readMessageSearchInput(request);
    const result = await queryMessageSearch({
      database,
      permissions: adapters.permissions as ChatPermissionAdapter<
        string,
        typeof MESSAGE_SEARCH_ENTITY_POLICY_ACTION
      >,
      actor,
      input,
      schema: databaseConfig.schema,
    });
    writeMessageSearchJson(response, parseMessageSearchResponse(result));
  };

  const router: ChatRouter = (request, response, next) => {
    const pathname = request.url?.split("?", 1)[0];
    const route = matchChatHttpRoute(request.method, pathname);
    if (route === undefined) {
      if (next) {
        next();
        return;
      }
      if (!response.headersSent) {
        response.statusCode = 404;
      }
      response.end();
      return;
    }
    const lifecycle = createChatHttpRequestLifecycle(
      request,
      response,
      route,
      httpObservability,
    );

    const isDirectoryBatch =
      route.method === "POST" &&
      route.routeTemplate === HOST_DIRECTORY_BATCH_ROUTE;
    const isDirectorySearch =
      route.method === "GET" &&
      route.routeTemplate === HOST_DIRECTORY_SEARCH_ROUTE;
    const isReplyStylePreference =
      route.routeTemplate === REPLY_STYLE_PREFERENCE_ROUTE;
    const isThreadList =
      route.method === "GET" && route.routeTemplate === THREAD_LIST_PATH;
    const isConversationList =
      route.method === "GET" && route.routeTemplate === CONVERSATION_LIST_ROUTE;
    const isSavedMessageList =
      route.method === "GET" && route.routeTemplate === SAVED_MESSAGE_LIST_ROUTE;
    const isMessageReminderList =
      route.method === "GET" &&
      route.routeTemplate === MESSAGE_REMINDER_LIST_ROUTE;
    const isConversationCreation =
      route.method === "POST" && route.routeTemplate === CONVERSATION_LIST_ROUTE;
    const isThreadCreation =
      route.method === "POST" &&
      route.routeTemplate === "/messages/:rootMessageId/thread";
    const isMessageSend =
      route.method === "POST" &&
      route.routeTemplate === "/conversations/:conversationId/messages";
    const isMessageForward =
      route.method === "POST" && route.routeTemplate === FORWARD_MESSAGE_ROUTE;
    const isPrepareAttachment =
      route.method === "POST" &&
      route.routeTemplate === "/conversations/:conversationId/attachments";
    const isStartHuddle =
      route.method === "POST" &&
      route.routeTemplate === "/conversations/:conversationId/huddles";
    const isJoinHuddle =
      route.method === "POST" &&
      route.routeTemplate === "/huddles/:huddleSessionId/join";
    const isLeaveHuddle =
      route.method === "POST" &&
      route.routeTemplate === "/huddles/:huddleSessionId/leave";
    const isHuddleScreenShare =
      route.method === "PATCH" &&
      route.routeTemplate === "/huddles/:huddleSessionId/screen-share";
    const isEndHuddle =
      route.method === "POST" &&
      route.routeTemplate === "/huddles/:huddleSessionId/end";
    const isAttachmentLifecycle =
      route.method === "PATCH" &&
      route.routeTemplate === "/attachments/:attachmentId/lifecycle";
    const isAttachmentDownload =
      route.method === "GET" &&
      route.routeTemplate === "/attachments/:attachmentId/download";
    const isMessageReaction =
      route.method === "PATCH" &&
      route.routeTemplate === "/messages/:messageId/reactions/:reactionKey";
    const isSavedMessage =
      route.method === "PATCH" &&
      route.routeTemplate === "/messages/:messageId/saved";
    const isMessageReminder =
      route.method === "PUT" &&
      route.routeTemplate ===
        "/conversations/:conversationId/messages/:messageId/reminder";
    const isMessageEdit =
      route.method === "PATCH" && route.routeTemplate === "/messages/:messageId";
    const isMessageDelete =
      route.method === "DELETE" && route.routeTemplate === "/messages/:messageId";
    const isConversationArchive =
      route.method === "PATCH" &&
      route.routeTemplate === "/conversations/:conversationId/lifecycle";
    const isConversationMembership =
      route.method === "PATCH" &&
      route.routeTemplate === "/conversations/:conversationId/membership";
    const isConversationPreference =
      route.method === "PATCH" &&
      route.routeTemplate === "/conversations/:conversationId/preference";
    const isDevicePushToken =
      route.method === "PUT" &&
      route.routeTemplate === "/devices/:deviceId/push-token";
    const isThreadFollow =
      route.method === "PATCH" &&
      route.routeTemplate === "/conversations/:threadId/follow";
    const isReadCursor =
      route.method === "PATCH" &&
      route.routeTemplate === "/conversations/:conversationId/read-cursor";
    const isDraftSynchronization =
      route.method === "PATCH" &&
      route.routeTemplate === "/conversations/:conversationId/draft";
    const isConversationDraftSnapshot =
      route.method === "GET" &&
      route.routeTemplate === "/conversations/:conversationId/draft";
    const isMessageContext =
      route.method === "GET" && route.routeTemplate === MESSAGE_CONTEXT_PATH;
    const isMessageTimeline =
      route.method === "GET" &&
      route.routeTemplate === "/conversations/:conversationId/messages";
    const isMessageSearch =
      route.method === "POST" && route.routeTemplate === MESSAGE_SEARCH_ROUTE;
    const isActiveHuddleSnapshot =
      route.method === "GET" &&
      route.routeTemplate === "/conversations/:conversationId/huddle";
    const isConversationDetail =
      request.method === "GET" &&
      route.routeTemplate === "/conversations/:conversationId";

    void (async () => {
      let admission = ADMITTED_CHAT_REQUEST;
      if (adapters.admission !== undefined) {
        try {
          const outcome = await adapters.admission.admit(
            Object.freeze({
              request: request as IncomingMessage & Request,
              method: route.method,
              routeTemplate: route.routeTemplate,
            }),
          );
          admission = normalizeChatRequestAdmissionOutcome(outcome);
        } catch {
          admission = failedClosedChatRequestAdmission();
        }
      }
      if (!admission.admitted) {
        lifecycle.setOutcome(429, CHAT_REQUEST_ADMISSION_DENIED_CODE);
        writeChatRequestAdmissionDenied(
          response,
          admission.retryAfterSeconds,
        );
        return;
      }

      if (route.method === "GET" && route.routeTemplate === "/_meta") {
        try {
          const metadata = await readMetadata();
          response.statusCode = 200;
          response.setHeader("content-type", "application/json; charset=utf-8");
          response.end(JSON.stringify(metadata));
        } catch (error) {
          lifecycle.setOutcome(500, CHAT_HTTP_INTERNAL_ERROR_CODE);
          if (next) {
            lifecycle.settle(500, CHAT_HTTP_INTERNAL_ERROR_CODE);
            try {
              next(error);
            } catch {
              // Completion is already observed; middleware throws stay isolated.
            }
            return;
          }
          if (!response.headersSent) {
            response.statusCode = 500;
          }
          response.end();
        }
        return;
      }

      const context = await resolveChatRequestContext(
        request as IncomingMessage & Request,
        adapters.auth as ChatAuthAdapter<IncomingMessage & Request>,
        adapters.permissions,
      );
      lifecycle.trustActor(context.actor);
      if (isReplyStylePreference) {
        await handleReplyStylePreference(
          request, response, context.actor, lifecycle.requestId,
        );
        return;
      }
      if (isDirectoryBatch || isDirectorySearch) {
        consumeDirectoryRateLimit(context.actor);
        await authorizeDirectory(
          context.actor,
          isDirectoryBatch
            ? HOST_DIRECTORY_LOOKUP_POLICY_ACTION
            : HOST_DIRECTORY_SEARCH_POLICY_ACTION,
        );
        if (isDirectoryBatch) {
          await handleDirectoryBatch(request, response, context.actor);
        } else {
          await handleDirectorySearch(request, response, context.actor);
        }
        return;
      }
      if (isMessageContext) {
        await handleMessageContext(request, response, context.actor);
        return;
      }
      if (isThreadList) {
        await handleThreadList(request, response, context.actor);
        return;
      }
      if (isConversationList) {
        await handleConversationList(request, response, context.actor);
        return;
      }
      if (isSavedMessageList) {
        await handleSavedMessageList(request, response, context.actor);
        return;
      }
      if (isMessageReminderList) {
        await handleMessageReminderList(request, response, context.actor);
        return;
      }
      if (isConversationCreation) {
        await handleConversationCreation(
          request,
          response,
          context.actor,
          lifecycle.requestId,
        );
        return;
      }
      if (isThreadCreation) {
        await handleThreadCreation(
          request,
          response,
          context.actor,
          lifecycle.requestId,
        );
        return;
      }
      if (isMessageSend) {
        await handleMessageSend(
          request,
          response,
          context.actor,
          lifecycle.requestId,
        );
        return;
      }
      if (isMessageForward) {
        await handleMessageForward(
          request,
          response,
          context.actor,
          lifecycle.requestId,
        );
        return;
      }
      if (isPrepareAttachment) {
        await handlePrepareAttachment(request, response, context.actor);
        return;
      }
      if (isStartHuddle) {
        await handleStartHuddle(
          request,
          response,
          context.actor,
          lifecycle.requestId,
        );
        return;
      }
      if (isJoinHuddle) {
        await handleJoinHuddle(request, response, context.actor);
        return;
      }
      if (isLeaveHuddle) {
        await handleLeaveHuddle(request, response, context.actor);
        return;
      }
      if (isHuddleScreenShare) {
        await handleHuddleScreenShare(request, response, context.actor);
        return;
      }
      if (isEndHuddle) {
        await handleEndHuddle(
          request,
          response,
          context.actor,
          lifecycle.requestId,
        );
        return;
      }
      if (isAttachmentLifecycle) {
        await handleAttachmentLifecycle(
          request,
          response,
          context.actor,
          lifecycle.requestId,
        );
        return;
      }
      if (isAttachmentDownload) {
        await handleAttachmentDownload(request, response, context.actor);
        return;
      }
      if (isMessageReaction) {
        await handleMessageReaction(
          request,
          response,
          context.actor,
          lifecycle.requestId,
        );
        return;
      }
      if (isSavedMessage) {
        await handleSavedMessage(
          request,
          response,
          context.actor,
          lifecycle.requestId,
        );
        return;
      }
      if (isMessageReminder) {
        await handleMessageReminder(
          request,
          response,
          context.actor,
          lifecycle.requestId,
        );
        return;
      }
      if (isMessageEdit) {
        await handleMessageEdit(
          request,
          response,
          context.actor,
          lifecycle.requestId,
        );
        return;
      }
      if (isMessageDelete) {
        await handleMessageDelete(
          request,
          response,
          context.actor,
          lifecycle.requestId,
        );
        return;
      }
      if (isConversationArchive) {
        await handleConversationLifecycle(
          request,
          response,
          context.actor,
          lifecycle.requestId,
        );
        return;
      }
      if (isConversationMembership) {
        await handleConversationMembership(
          request,
          response,
          context.actor,
          lifecycle.requestId,
        );
        return;
      }
      if (isConversationPreference) {
        await handleConversationPreference(
          request,
          response,
          context.actor,
          lifecycle.requestId,
        );
        return;
      }
      if (isDevicePushToken) {
        await handleDevicePushToken(
          request,
          response,
          context.actor,
          lifecycle.requestId,
        );
        return;
      }
      if (isThreadFollow) {
        await handleThreadFollow(
          request,
          response,
          context.actor,
          lifecycle.requestId,
        );
        return;
      }
      if (isReadCursor) {
        await handleReadCursor(
          request,
          response,
          context.actor,
          lifecycle.requestId,
        );
        return;
      }
      if (isDraftSynchronization) {
        await handleDraftSynchronization(request, response, context.actor);
        return;
      }
      if (isConversationDraftSnapshot) {
        await handleConversationDraftSnapshot(request, response, context.actor);
        return;
      }
      if (isMessageTimeline) {
        await handleMessageTimeline(request, response, context.actor);
        return;
      }
      if (isMessageSearch) {
        await handleMessageSearch(request, response, context.actor);
        return;
      }
      if (isActiveHuddleSnapshot) {
        await handleActiveHuddleSnapshot(request, response, context.actor);
        return;
      }
      if (isConversationDetail) {
        await handleConversationDetail(request, response, context.actor);
        return;
      }

      if (next) {
        lifecycle.settle(404);
        try {
          next();
        } catch {
          // Completion is already observed; middleware throws stay isolated.
        }
        return;
      }
      if (!response.headersSent) {
        response.statusCode = 404;
      }
      response.end();
    })().then(() => lifecycle.settle()).catch((error: unknown) => {
      const safeError =
        isAttachmentDownload
          ? error instanceof ChatAuthenticationError
            ? error
            : error instanceof ChatAttachmentDownloadRouteError
              ? error
              : error instanceof ChatAuthorizationError
                ? attachmentDownloadAttachmentUnavailable()
                : error instanceof AttachmentTransportError
                  ? invalidAttachmentDownloadRequest()
                  : error instanceof AttachmentDownloadQueryError
                    ? attachmentDownloadUnavailable()
                    : attachmentDownloadUnavailable()
        : error instanceof ChatAuthorizationError
          ? error
          : error instanceof ChatAuthenticationError
            ? error
            : isReplyStylePreference
              ? error instanceof ChatReplyStylePreferenceRouteError
                ? error
                : error instanceof UpdateReplyStylePreferenceCommandError
                  ? new ChatReplyStylePreferenceRouteError(
                    `chat_reply_style_preference_${error.code}`,
                    409,
                    "Reply-style preference request conflicts with current server state",
                  )
                  : replyStylePreferenceUnavailable()
            : isMessageContext
              ? error instanceof ChatMessageContextRouteError
                ? error
                : messageContextUnavailable()
            : isThreadList
              ? error instanceof ChatThreadListRouteError
                ? error
                : threadListUnavailable()
            : error instanceof ChatDirectoryRouteError
              ? error
              : error instanceof ChatConversationCreationRouteError
                ? error
              : error instanceof ChatThreadLifecycleRouteError
                ? error
              : error instanceof ChatConversationArchiveRouteError
                ? error
              : error instanceof ChatConversationMembershipRouteError
                ? error
              : error instanceof ChatConversationPreferenceRouteError
                ? error
              : error instanceof ChatDevicePushTokenRouteError
                ? error
              : error instanceof ChatThreadFollowRouteError
                ? error
              : error instanceof ChatReadCursorRouteError
                ? error
              : error instanceof ChatDraftSynchronizationRouteError
                ? error
              : error instanceof ChatThreadCreationRouteError
                ? error
              : error instanceof ChatMessageSendRouteError
                ? error
              : error instanceof ChatMessageForwardRouteError
                ? error
              : error instanceof ChatAttachmentPreparationRouteError
                ? error
              : error instanceof ChatHuddleStartRouteError
                ? error
              : error instanceof ChatHuddleJoinRouteError
                ? error
              : error instanceof ChatHuddleLeaveRouteError
                ? error
              : error instanceof ChatHuddleScreenShareRouteError
                ? error
              : error instanceof ChatHuddleEndRouteError
                ? error
              : error instanceof ChatAttachmentLifecycleRouteError
                ? error
              : error instanceof ChatMessageEditRouteError
                ? error
              : error instanceof ChatMessageDeleteRouteError
                ? error
              : error instanceof ChatMessageReactionRouteError
                ? error
              : error instanceof ChatSavedMessageRouteError
                ? error
              : error instanceof ChatSavedMessageListRouteError
                ? error
              : error instanceof ChatMessageReminderRouteError
                ? error
              : error instanceof ChatMessageReminderListRouteError
                ? error
              : error instanceof ChatConversationSnapshotRouteError
                ? error
              : error instanceof ChatMessageTimelineRouteError
                  ? error
                : error instanceof ChatMessageSearchRouteError
                  ? error
                : error instanceof ChatActiveHuddleSnapshotRouteError
                  ? error
                : error instanceof ChatConversationDraftSnapshotRouteError
                  ? error
                  : isMessageTimeline &&
                      error instanceof MessageTimelineContractError &&
                      error.code === "invalid_request"
                    ? invalidMessageTimelineRequest()
                    : isMessageTimeline
                      ? messageTimelineUnavailable()
                    : isMessageSearch &&
                        (error instanceof MessageSearchParseError ||
                          (error instanceof MessageSearchQueryError &&
                            error.code === "invalid_cursor"))
                      ? invalidMessageSearchRequest()
                      : isMessageSearch
                        ? messageSearchUnavailable()
                      : isConversationCreation &&
                          error instanceof CreateConversationCommandError &&
                          error.code === "directory_user_unavailable"
                        ? conversationCreationMemberUnavailable()
                        : isConversationCreation &&
                            error instanceof CreateConversationCommandError
                          ? conversationCreationConflict()
                          : isConversationCreation
                            ? conversationCreationUnavailable()
                      : isConversationArchive &&
                          error instanceof ArchiveConversationCommandError
                        ? conversationArchiveConflict()
                      : isConversationArchive
                          ? conversationArchiveUnavailable()
                      : isConversationMembership &&
                          error instanceof ConversationMembershipCommandError &&
                          error.code === "directory_user_unavailable"
                        ? conversationMembershipMemberUnavailable()
                        : isConversationMembership &&
                            error instanceof ConversationMembershipCommandError &&
                            error.code === "membership_invariant"
                          ? conversationMembershipInvariant()
                          : isConversationMembership &&
                              error instanceof ConversationMembershipCommandError
                            ? conversationMembershipConflict()
                            : isConversationMembership
                              ? conversationMembershipUnavailable()
                      : isConversationPreference &&
                          error instanceof UpdateConversationPreferenceCommandError
                        ? conversationPreferenceConflict()
                      : isConversationPreference
                          ? conversationPreferenceUnavailable()
                      : isDevicePushToken &&
                          error instanceof DevicePushTokenCommandError &&
                          error.statusCode === 409
                        ? devicePushTokenConflict()
                        : isDevicePushToken
                          ? devicePushTokenUnavailable()
                      : isThreadFollow &&
                          error instanceof SetThreadFollowCommandError
                        ? threadFollowConflict()
                        : isThreadFollow
                          ? threadFollowUnavailable()
                      : isReadCursor &&
                          error instanceof ReadCursorMutationError &&
                          (error.code === "cursor_regression" ||
                            error.code === "sequence_out_of_range")
                        ? readCursorSequenceConflict()
                        : isReadCursor &&
                            error instanceof UpdateReadCursorCommandError
                          ? readCursorConflict()
                      : isReadCursor
                            ? readCursorUnavailable()
                      : isDraftSynchronization &&
                          error instanceof SynchronizeDraftCommandError
                        ? draftSynchronizationConflict()
                        : isDraftSynchronization
                          ? draftSynchronizationUnavailable()
                      : isThreadCreation &&
                          error instanceof CreateThreadCommandError
                        ? threadCreationConflict()
                        : isThreadCreation
                          ? threadCreationUnavailable()
                      : isMessageForward &&
                          error instanceof ForwardMessageCommandError &&
                          (error.code === "source_message_not_found" ||
                            error.code === "source_message_forbidden")
                        ? messageForwardSourceUnavailable()
                        : isMessageForward &&
                            error instanceof ForwardMessageCommandError &&
                            (error.code === "destination_conversation_not_found" ||
                              error.code === "destination_conversation_forbidden")
                          ? messageForwardDestinationUnavailable()
                          : isMessageForward &&
                              error instanceof ForwardMessageCommandError &&
                              error.code === "source_attachments_unsupported"
                            ? messageForwardAttachmentsUnsupported()
                            : isMessageForward &&
                                error instanceof ForwardMessageCommandError &&
                                error.code === "source_content_unsupported"
                              ? messageForwardContentUnsupported()
                              : isMessageForward &&
                                  error instanceof ForwardMessageCommandError
                                ? messageForwardConflict()
                                : isMessageForward
                                  ? messageForwardUnavailable()
                      : isMessageSend &&
                          error instanceof SendMessageCommandError &&
                          error.code === "invalid_mention"
                        ? messageSendMentionUnavailable()
                        : isMessageSend &&
                            error instanceof SendMessageCommandError &&
                            error.code === "attachment_unavailable"
                          ? messageSendAttachmentUnavailable()
                          : isMessageSend &&
                              error instanceof SendMessageCommandError
                            ? messageSendConflict()
                            : isMessageSend
                              ? messageSendUnavailable()
                      : isPrepareAttachment &&
                          error instanceof PrepareAttachmentCommandError &&
                          (error.code === "idempotency_conflict" ||
                            error.code === "idempotency_in_progress")
                        ? attachmentPreparationConflict()
                      : isPrepareAttachment
                          ? attachmentPreparationUnavailable()
                      : isStartHuddle &&
                          error instanceof StartHuddleCommandError &&
                          (error.code === "idempotency_conflict" ||
                            error.code === "idempotency_in_progress" ||
                            error.code === "huddle_already_active")
                        ? huddleStartConflict()
                      : isStartHuddle
                          ? huddleStartUnavailable()
                      : isJoinHuddle &&
                          error instanceof JoinHuddleCommandError &&
                          error.code === "huddle_not_live"
                        ? huddleJoinNotLive()
                      : isJoinHuddle &&
                          error instanceof JoinHuddleCommandError &&
                          (error.code === "idempotency_conflict" ||
                            error.code === "idempotency_in_progress" ||
                            error.code === "participant_already_joined" ||
                            error.code === "participant_rejoin_disallowed")
                        ? huddleJoinConflict()
                      : isJoinHuddle
                          ? huddleJoinUnavailable()
                      : isLeaveHuddle &&
                          error instanceof LeaveHuddleCommandError &&
                          (error.code === "participant_already_left" ||
                            error.code === "huddle_not_active" ||
                            error.code === "idempotency_conflict" ||
                            error.code === "idempotency_in_progress")
                        ? huddleLeaveConflict()
                      : isLeaveHuddle
                          ? huddleLeaveUnavailable()
                      : isHuddleScreenShare &&
                          error instanceof SetHuddleScreenShareCommandError &&
                          error.code === "screen_share_disabled"
                        ? huddleScreenShareDisabled()
                      : isHuddleScreenShare &&
                          error instanceof SetHuddleScreenShareCommandError
                        ? huddleScreenShareConflict()
                      : isHuddleScreenShare
                          ? huddleScreenShareUnavailable()
                      : isEndHuddle &&
                          error instanceof EndHuddleCommandError &&
                          (error.code === "idempotency_conflict" ||
                            error.code === "huddle_not_live")
                        ? huddleEndConflict()
                      : isEndHuddle
                          ? huddleEndUnavailable()
                      : isAttachmentLifecycle &&
                          (error instanceof FinalizeAttachmentCommandError ||
                            error instanceof AbortAttachmentCommandError) &&
                          error.code === "attachment_unavailable"
                        ? attachmentLifecycleAttachmentUnavailable()
                        : isAttachmentLifecycle &&
                            (error instanceof FinalizeAttachmentCommandError ||
                              error instanceof AbortAttachmentCommandError) &&
                            (error.code === "idempotency_conflict" ||
                              error.code === "idempotency_in_progress")
                          ? attachmentLifecycleConflict()
                          : isAttachmentLifecycle
                            ? attachmentLifecycleUnavailable()
                      : isMessageEdit &&
                          error instanceof MessageMutationParseError
                        ? invalidMessageEditRequest()
                        : isMessageEdit &&
                            error instanceof EditMessageCommandError
                          ? messageEditConflict()
                          : isMessageEdit
                            ? messageEditUnavailable()
                      : isMessageReaction &&
                          error instanceof SetReactionCommandError
                        ? messageReactionConflict()
                        : isMessageReaction
                          ? messageReactionUnavailable()
                      : isSavedMessage &&
                          error instanceof SetSavedMessageCommandError
                        ? savedMessageConflict()
                      : isSavedMessage
                          ? savedMessageUnavailable()
                      : isSavedMessageList
                        ? savedMessageListUnavailable()
                      : isMessageReminder &&
                          error instanceof MessageReminderParseError
                        ? invalidMessageReminderRequest()
                      : isMessageReminder &&
                          error instanceof SetMessageReminderCommandError
                        ? messageReminderConflict()
                      : isMessageReminder
                        ? messageReminderUnavailable()
                      : isMessageReminderList
                        ? messageReminderListUnavailable()
                      : isMessageDelete &&
                          error instanceof SoftDeleteMessageCommandError
                        ? messageDeleteConflict()
                        : isMessageDelete
                          ? messageDeleteUnavailable()
                      : isConversationList || isConversationDetail
                        ? conversationSnapshotUnavailable()
                      : isActiveHuddleSnapshot
                        ? activeHuddleSnapshotUnavailable()
                      : isConversationDraftSnapshot
                        ? conversationDraftSnapshotUnavailable()
                      : directoryUnavailable();
      if (isAttachmentDownload && !response.headersSent) {
        setAttachmentDownloadSecurityHeaders(response);
      }
      if (isSavedMessageList && !response.headersSent) {
        response.setHeader("cache-control", "private, no-store");
      }
      lifecycle.setOutcome(safeError.statusCode, safeError.code);
      if (next) {
        lifecycle.settle(safeError.statusCode, safeError.code);
        try {
          next(safeError);
        } catch {
          // Completion is already observed; middleware throws stay isolated.
        }
        return;
      }
      writeChatError(response, safeError);
      lifecycle.settle(safeError.statusCode, safeError.code);
    });
  };

  const runtime: ChatServerRuntime<Request, Capability, EntityAction> = {
    router,
    database,
    config: normalizedConfig,
    threadListHandlerOptions,
    outboxPublisher,
    postgresMaintenance,
    attachmentCleanupDispatcher,
    auditDispatcher,
    notificationDispatcher,
    realtimeHub,
    get closed() {
      return closed;
    },
    get webSocketSessionCount() {
      return webSocketController.sessionCount;
    },
    get webSocketSubscriptionCount() {
      return webSocketController.subscriptionCount;
    },
    attachWebSocket(server) {
      if (closed) {
        throw new Error("The chat server runtime is closed");
      }
      validateAdapter(server, "WebSocket server", ["on", "off"]);
      webSocketController.attach(server);
    },
    detachWebSocket() {
      webSocketController.detach();
    },
    revalidateWebSocketSubscriptions(scope) {
      if (closed) {
        return Promise.resolve(0);
      }
      return webSocketController.revalidateSubscriptions(scope);
    },
    dispatchAttachmentCleanupOnce() {
      return attachmentCleanupDispatcher?.runOnce() ?? Promise.resolve({
        claimed: 0,
        delivered: 0,
        failed: 0,
      });
    },
    close() {
      closePromise ??= (async () => {
        closed = true;
        webSocketController.detach();
        try {
          await Promise.all([
            webSocketController.drainEphemeralSignals(),
            webSocketController.drainHuddleDisconnects(),
          ]);
        } finally {
          try {
            await postgresMaintenance.stop();
            await Promise.all([
              outboxPublisher.stop(),
              attachmentCleanupDispatcher?.stop(),
              auditDispatcher?.stop(),
              notificationDispatcher?.stop(),
            ]);
          } finally {
            await ownedDatabase?.end();
          }
        }
      })();
      return closePromise;
    },
  };

  outboxPublisher.start();
  postgresMaintenance.start();
  attachmentCleanupDispatcher?.start();
  auditDispatcher?.start();
  notificationDispatcher?.start();
  return Object.freeze(runtime);
}
