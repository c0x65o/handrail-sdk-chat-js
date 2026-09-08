import type { HostEntityReference } from "../contracts/conversation.js";
import type {
  HostDirectoryAvatar,
  HostDirectoryUserStatus,
} from "../contracts/host-directory-snapshot.js";
import type {
  AttachmentId,
  ConversationId,
  DeviceId,
  IsoTimestamp,
  TenantId,
  UserId,
} from "../contracts/identifiers.js";
import type {
  DevicePlatform,
  DevicePushProvider,
  DevicePushProviderEnvironment,
  OpaquePushToken,
} from "../contracts/device-push-token.js";
import type { ChatEvent } from "../contracts/realtime.js";

/** Identity established by the host's trusted server-side session. */
export interface TrustedChatActorContext {
  readonly tenantId: TenantId;
  readonly userId: UserId;
  readonly roles: readonly string[];
}

/**
 * Original request already authenticated by resolveActor, plus the previously
 * trusted actor. The request can still contain client-authored fields; hosts
 * must consult only their authoritative server-side session attachment. No
 * WebSocket frame contributes identity or authorization data to this input.
 */
export interface ChatActiveSessionRevalidationInput<Request = unknown> {
  readonly request: Request;
  readonly actor: TrustedChatActorContext;
}

/** Methods exposed by recognized chat HTTP and WebSocket admission boundaries. */
export type ChatRequestAdmissionMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE";

/** Stable, low-cardinality templates for recognized HTTP routes and upgrades. */
export type ChatRequestAdmissionRouteTemplate =
  | "/_meta"
  | "/_realtime"
  | "/preferences/reply-style"
  | "/directory/users:batch"
  | "/directory/users/search"
  | "/conversations"
  | "/conversations/:parentConversationId/threads"
  | "/conversations/:conversationId"
  | "/conversations/:conversationId/lifecycle"
  | "/conversations/:conversationId/membership"
  | "/conversations/:conversationId/preference"
  | "/conversations/:conversationId/read-cursor"
  | "/conversations/:conversationId/draft"
  | "/conversations/:conversationId/messages"
  | "/conversations/:conversationId/messages/:messageId/context"
  | "/conversations/:conversationId/messages/:messageId/reminder"
  | "/conversations/:conversationId/attachments"
  | "/conversations/:conversationId/huddle"
  | "/conversations/:conversationId/huddles"
  | "/conversations/:threadId/follow"
  | "/devices/:deviceId/push-token"
  | "/messages/:rootMessageId/thread"
  | "/messages/:messageId"
  | "/messages/:messageId/reactions/:reactionKey"
  | "/messages/:messageId/saved"
  | "/messages/forward"
  | "/messages/search"
  | "/saved-messages"
  | "/message-reminders"
  | "/huddles/:huddleSessionId/join"
  | "/huddles/:huddleSessionId/leave"
  | "/huddles/:huddleSessionId/screen-share"
  | "/huddles/:huddleSessionId/end"
  | "/attachments/:attachmentId/lifecycle"
  | "/attachments/:attachmentId/download";

/** Bounded route metadata plus the untouched request owned by the host. */
export interface ChatRequestAdmissionInput<Request = unknown> {
  readonly request: Request;
  readonly method: ChatRequestAdmissionMethod;
  /** Stable template such as /conversations/:conversationId; never a raw path. */
  readonly routeTemplate: ChatRequestAdmissionRouteTemplate;
}

export interface ChatRequestAdmissionAllow {
  readonly decision: "allow";
}

export interface ChatRequestAdmissionDeny {
  readonly decision: "deny";
  readonly retryAfterSeconds: number;
}

/** The only accepted outcomes from a request-admission adapter. */
export type ChatRequestAdmissionOutcome =
  | ChatRequestAdmissionAllow
  | ChatRequestAdmissionDeny;

/** Optional host-owned, pre-authentication boundary for HTTP and WebSockets. */
export interface ChatRequestAdmissionAdapter<Request = unknown> {
  admit(
    input: ChatRequestAdmissionInput<Request>,
  ): Promise<ChatRequestAdmissionOutcome>;
}

/** Trusted request-id input. Raw headers are deliberately not inspected. */
export interface ChatHttpRequestIdInput<Request = unknown> {
  readonly request: Request;
  readonly method: ChatRequestAdmissionMethod;
  readonly routeTemplate: ChatRequestAdmissionRouteTemplate;
}

/** Synchronous so the id can be validated and written before any response. */
export type ChatHttpRequestIdProvider<Request = unknown> = (
  input: ChatHttpRequestIdInput<Request>,
) => string;

/** Privacy-safe, low-cardinality result for one recognized chat HTTP request. */
export interface ChatHttpRequestOutcome {
  readonly requestId: string;
  readonly method: ChatRequestAdmissionMethod;
  readonly routeTemplate: ChatRequestAdmissionRouteTemplate;
  readonly statusCode: number;
  readonly outcomeCode?: string;
  readonly durationMs: number;
  readonly tenantId?: TenantId;
  readonly userId?: UserId;
}

export type ChatHttpRequestOutcomeObserver = (
  outcome: ChatHttpRequestOutcome,
) => void | Promise<void>;

/** Optional host boundary for request correlation and completion telemetry. */
export interface ChatHttpObservabilityOptions<Request = unknown> {
  /** Returns a trusted opaque id; invalid/throwing providers fall back safely. */
  readonly createRequestId?: ChatHttpRequestIdProvider<Request>;
  /** Receives one immutable outcome for each recognized chat HTTP request. */
  readonly onOutcome?: ChatHttpRequestOutcomeObserver;
  /** Monotonic millisecond clock, primarily for deterministic host tests. */
  readonly now?: () => number;
}

/** Resolves trusted chat identity from the host application's request/session. */
export interface ChatAuthAdapter<Request = unknown> {
  resolveActor(request: Request): Promise<TrustedChatActorContext>;
  /**
   * Optionally checks authoritative active-session state for accepted sockets.
   * Return null for a revoked or expired session. A returned actor must retain
   * the original tenant and user identity, but may contain refreshed roles.
   */
  revalidateActiveSession?(
    input: ChatActiveSessionRevalidationInput<Request>,
  ): Promise<TrustedChatActorContext | null>;
}

export interface ChatDirectoryUser {
  readonly tenantId: TenantId;
  readonly userId: UserId;
  readonly kind?: "active";
  readonly displayName: string;
  /** Prefer the structured avatar; avatarUrl remains for adapter compatibility. */
  readonly avatar?: HostDirectoryAvatar;
  readonly avatarUrl?: string;
  readonly status?: HostDirectoryUserStatus;
}

export interface ChatDirectoryRedactedUser {
  readonly tenantId: TenantId;
  readonly userId: UserId;
  readonly kind: "redacted";
}

export interface ChatDirectoryUnavailableUser {
  readonly tenantId: TenantId;
  readonly userId: UserId;
  readonly kind: "unavailable";
  readonly reason: "missing" | "temporarily_unavailable";
}

/** Explicit host outcome for a lookup; null is retained as the missing shorthand. */
export type ChatDirectoryLookupResult =
  | ChatDirectoryUser
  | ChatDirectoryRedactedUser
  | ChatDirectoryUnavailableUser;

export interface ChatDirectoryLookupInput {
  readonly actor: TrustedChatActorContext;
  readonly userId: UserId;
}

export interface ChatDirectorySearchInput {
  readonly actor: TrustedChatActorContext;
  readonly query: string;
  readonly limit?: number;
  /** Opaque host-provider continuation decoded from the public HTTP cursor. */
  readonly continuation?: string;
}

export interface ChatDirectorySearchPage {
  readonly users: readonly ChatDirectoryLookupResult[];
  readonly continuation?: string;
}

/** Host-owned user directory lookup and actor-filtered search. */
export interface ChatDirectoryAdapter {
  getUser(
    input: ChatDirectoryLookupInput,
  ): Promise<ChatDirectoryLookupResult | null>;
  searchUsers(
    input: ChatDirectorySearchInput,
  ): Promise<
    readonly ChatDirectoryLookupResult[] | ChatDirectorySearchPage
  >;
}

export interface ChatCapabilityResolutionInput {
  readonly actor: TrustedChatActorContext;
}

export interface ChatEntityAuthorizationInput<Action extends string = string> {
  readonly actor: TrustedChatActorContext;
  readonly entity: HostEntityReference;
  readonly action: Action;
}

/** Standard actions used to authorize actor access to the tenant directory. */
export type ChatDirectoryPolicyAction = "directory.lookup" | "directory.search";

/** Standard action used before subscribing to an entity-scoped conversation. */
export type ChatRealtimePolicyAction = "conversation.subscribe";

/**
 * Maps host roles to chat capabilities and keeps access to host entities under
 * host-application authority.
 */
export interface ChatPermissionAdapter<
  Capability extends string = string,
  EntityAction extends string = string,
> {
  getCapabilities(
    input: ChatCapabilityResolutionInput,
  ): Promise<readonly Capability[]>;
  /** Optional host narrowing after ordinary message.send and parent access checks.
   * Absence preserves legacy send authority; following never grants permission.
   * Also checked when reconciling a completed thread send.
   */
  authorizeThreadSend?(input: {
    readonly actor: TrustedChatActorContext;
    readonly threadId: string;
    readonly parentConversationId: string;
    readonly capabilities: readonly Capability[];
  }): Promise<boolean>;
  authorizeEntity(
    input: ChatEntityAuthorizationInput<
      EntityAction | ChatDirectoryPolicyAction | ChatRealtimePolicyAction
    >,
  ): Promise<boolean>;
}

export interface ChatStorageUploadInput {
  readonly actor: TrustedChatActorContext;
  readonly attachmentId: AttachmentId;
  readonly fileName: string;
  readonly contentType: string;
  readonly contentLengthBytes: number;
}

export interface ChatStorageObjectInput {
  readonly actor: TrustedChatActorContext;
  readonly attachmentId: AttachmentId;
  readonly objectKey: string;
}

/** Authorized download intent supplied only after chat visibility checks pass. */
export interface ChatStorageDownloadInput extends ChatStorageObjectInput {
  readonly fileName: string;
  readonly contentDisposition: "attachment";
}

export interface ChatStorageUrl {
  readonly url: string;
  readonly expiresAt: IsoTimestamp;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface ChatStorageUploadUrl extends ChatStorageUrl {
  readonly objectKey: string;
  readonly method: "PUT" | "POST";
}

export type ChatStorageVerificationRejectionReason =
  | "missing_object"
  | "size_mismatch"
  | "checksum_mismatch"
  | "content_type_mismatch"
  | "unsafe"
  | "scan_failed"
  | "invalid_metadata";

export interface ChatStorageVerifiedObject {
  readonly status: "verified";
  readonly exists: true;
  readonly sizeBytes: number;
  readonly checksum: string;
  readonly contentType: string;
  readonly safetyDisposition: "accepted";
}

export interface ChatStorageRejectedObject {
  readonly status: "rejected";
  readonly reason: ChatStorageVerificationRejectionReason;
}

/** Sanitized storage inspection result; provider payloads never cross this boundary. */
export type ChatStorageObjectVerification =
  | ChatStorageVerifiedObject
  | ChatStorageRejectedObject;

export type ChatStorageVerificationFailureClass =
  | "transient"
  | "rate_limited"
  | "configuration";

/** Optional adapter classification used without exposing provider diagnostics. */
export class ChatStorageVerificationError extends Error {
  public constructor(
    public readonly failureClass: ChatStorageVerificationFailureClass,
    message = `Attachment storage verification failed: ${failureClass}`,
  ) {
    super(message);
    this.name = "ChatStorageVerificationError";
  }
}

/** Object-storage boundary; uploaded bytes remain outside the chat runtime. */
export interface ChatStorageAdapter {
  createUploadUrl(input: ChatStorageUploadInput): Promise<ChatStorageUploadUrl>;
  verifyObject(
    input: ChatStorageObjectInput,
  ): Promise<ChatStorageObjectVerification>;
  createDownloadUrl(input: ChatStorageDownloadInput): Promise<ChatStorageUrl>;
  /**
   * At-least-once cleanup boundary. Calls may repeat with the stable
   * (tenantId, attachmentId, objectKey) retry identity. Repeated deletion,
   * including when the object is already absent, must resolve successfully.
   * Provider messages and object keys must never enter telemetry.
   */
  deleteObject(input: ChatStorageObjectInput): Promise<void>;
}

export type ChatNotificationMetadataValue = string | number | boolean | null;

/** Bounded, content-free metadata supplied to the notification host boundary. */
export type ChatNotificationMetadata = Readonly<
  Record<string, ChatNotificationMetadataValue>
>;

/** Hard cap applied per delivery before protected provider tokens are resolved. */
export const MAX_CHAT_NOTIFICATION_TARGETS = 100;

/**
 * Secret-bearing provider target available only at notification send time.
 * The dispatcher freezes each target and keeps token non-enumerable so generic
 * JSON/stringification paths cannot accidentally serialize the credential.
 */
export interface ChatNotificationTarget {
  readonly deviceId: DeviceId;
  readonly platform: DevicePlatform;
  readonly provider: DevicePushProvider;
  readonly environment: DevicePushProviderEnvironment;
  readonly token: OpaquePushToken;
}

export interface ChatNotificationInput {
  /** Stable across retries and processes; hosts should use this for idempotency. */
  readonly deliveryId: string;
  readonly sourceEventId: string;
  readonly tenantId: TenantId;
  readonly recipientUserId: UserId;
  readonly type: string;
  readonly occurredAt: IsoTimestamp;
  readonly conversationId: ConversationId;
  readonly messageId: string;
  readonly sequence: number;
  readonly actorUserId: UserId;
  /** Never contains message content, credentials, or provider payloads. */
  readonly metadata: ChatNotificationMetadata;
  /** Deterministically ordered, deeply immutable, and capped at 100 targets. */
  readonly targets: readonly ChatNotificationTarget[];
}

export interface ChatNotificationAdapter {
  send(input: ChatNotificationInput): Promise<void>;
}

/** Maximum UTF-8 size accepted by storage for a host-encrypted token envelope. */
export const MAX_CHAT_PUSH_TOKEN_CIPHERTEXT_UTF8_BYTES = 4_096;

/** Maximum UTF-8 size accepted by storage for a non-secret host key identifier. */
export const MAX_CHAT_PUSH_TOKEN_KEY_ID_UTF8_BYTES = 255;

export interface ChatProtectedPushToken {
  /** Opaque encrypted envelope, bounded to 4096 UTF-8 bytes. */
  readonly ciphertext: string;
  /** Non-secret rotation identifier, bounded to 255 UTF-8 bytes. */
  readonly keyId: string;
}

/** Trusted server-side identity used to bind token protection to one device. */
export interface ChatPushTokenProtectionContext {
  readonly tenantId: TenantId;
  readonly userId: UserId;
  readonly deviceId: DeviceId;
}

export interface ChatPushTokenProtectInput
  extends ChatPushTokenProtectionContext {
  readonly token: OpaquePushToken;
}

export interface ChatPushTokenUnprotectInput
  extends ChatPushTokenProtectionContext {
  readonly protectedToken: ChatProtectedPushToken;
}

/**
 * Host cryptographic boundary for private provider credentials. Key custody,
 * authenticated encryption, rotation, and audit belong to the host and its KMS;
 * the SDK neither selects algorithms nor stores keys. Implementations must
 * sanitize all errors crossing this boundary so token material, key material,
 * and provider diagnostics cannot escape through SDK responses or telemetry.
 */
export interface ChatPushTokenProtector {
  protect(input: ChatPushTokenProtectInput): Promise<ChatProtectedPushToken>;
  unprotect(input: ChatPushTokenUnprotectInput): Promise<OpaquePushToken>;
}

/** Adapter-classified failures; rejected/configuration failures are terminal. */
export type ChatNotificationFailureClass =
  | "transient"
  | "rate_limited"
  | "permanent"
  | "rejected"
  | "configuration";

export class ChatNotificationDeliveryError extends Error {
  public constructor(
    public readonly failureClass: ChatNotificationFailureClass,
    message = `Notification delivery failed: ${failureClass}`,
  ) {
    super(message);
    this.name = "ChatNotificationDeliveryError";
  }
}

export interface ChatAuditEvent<Metadata = unknown> {
  /** Stable identity of the immutable audit row; use for adapter idempotency. */
  readonly auditEventId: string;
  readonly tenantId: TenantId;
  readonly actorUserId: UserId | null;
  readonly action: string;
  readonly occurredAt: IsoTimestamp;
  readonly metadata: Metadata;
  readonly requestId: string;
  readonly correlationId?: string;
  readonly target?: HostEntityReference;
}

/** Adapter-classified failures; invalid/rejected/configuration are terminal. */
export type ChatAuditDeliveryFailureClass =
  | "transient"
  | "rate_limited"
  | "invalid"
  | "rejected"
  | "configuration";

export class ChatAuditDeliveryError extends Error {
  public constructor(
    public readonly failureClass: ChatAuditDeliveryFailureClass,
    message = `Audit delivery failed: ${failureClass}`,
  ) {
    super(message);
    this.name = "ChatAuditDeliveryError";
  }
}

export interface ChatAuditAdapter {
  record(event: ChatAuditEvent): Promise<void>;
}

/** Receives an event from a local or external realtime fanout. */
export type ChatRealtimeListener = (event: ChatEvent) => void | Promise<void>;

/** Optional inbound side of a realtime adapter. */
export interface ChatRealtimeSubscriber {
  /** Returns an idempotent unsubscribe function. */
  subscribe(listener: ChatRealtimeListener): () => void;
}

/** Realtime delivery domain selected by the embedding host. */
export type ChatRealtimeDelivery = "single_process" | "clustered";

/** Optional fanout boundary for deployments that publish beyond one process. */
export interface ChatRealtimeAdapter {
  publish(event: ChatEvent): Promise<void>;
  /**
   * Enables live socket delivery from configured fanout implementations.
   * Publish-only adapters remain supported in single-process delivery mode.
   * Clustered delivery requires this member.
   */
  subscribe?: ChatRealtimeSubscriber["subscribe"];
}

export interface ChatMediaParticipantPermissions {
  readonly audio: boolean;
  readonly video: boolean;
  readonly screenShare: boolean;
}

export interface ChatMediaCreateRoomInput {
  readonly actor: TrustedChatActorContext;
  readonly conversationId: ConversationId;
}

export interface ChatMediaRoom {
  readonly roomId: string;
}

export interface ChatMediaParticipantTokenInput {
  readonly actor: TrustedChatActorContext;
  readonly roomId: string;
  readonly permissions: ChatMediaParticipantPermissions;
}

export interface ChatMediaParticipantToken {
  readonly token: string;
  readonly expiresAt: IsoTimestamp;
}

export interface ChatMediaTerminateRoomInput {
  readonly actor: TrustedChatActorContext;
  readonly roomId: string;
}

/**
 * Media-provider lifecycle boundary. WebRTC/SFU transport remains the media
 * provider's responsibility and is intentionally absent from this contract.
 */
export interface ChatMediaAdapter {
  createRoom(input: ChatMediaCreateRoomInput): Promise<ChatMediaRoom>;
  createParticipantToken(
    input: ChatMediaParticipantTokenInput,
  ): Promise<ChatMediaParticipantToken>;
  terminateRoom(input: ChatMediaTerminateRoomInput): Promise<void>;
}

interface TrustedActorFields {
  readonly tenantId?: never;
  readonly userId?: never;
  readonly actor?: never;
  readonly actorId?: never;
  readonly roles?: never;
}

/**
 * Shared shape for caller-authored mutation data. Trusted identity cannot be
 * supplied by the caller; it is attached only after host authentication.
 */
export type UntrustedChatMutationInput<Payload extends object = object> =
  Payload & TrustedActorFields;

/** Server-internal pairing of validated caller input and its resolved actor. */
export interface TrustedChatMutationRequest<Payload extends object = object> {
  readonly actor: TrustedChatActorContext;
  readonly input: UntrustedChatMutationInput<Payload>;
}

/** Required host boundaries plus optional provider integration points. */
export interface ChatHostAdapters<
  Request = unknown,
  Capability extends string = string,
  EntityAction extends string = string,
> {
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
}
