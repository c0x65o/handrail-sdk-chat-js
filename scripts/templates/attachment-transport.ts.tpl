import type {
  AttachmentId,
  IsoTimestamp,
  MessageId,
} from "./identifiers.js";

const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const CHECKSUM_PATTERN = /^sha256:[0-9a-f]{64}$/;
const UNSAFE_FILE_NAME_PATTERN = /[\p{Cc}\p{Cf}<>:"/\\|?*]/u;

/** Matches the tenant-scoped identifier bound used by persisted chat rows. */
export const MAX_ATTACHMENT_IDENTIFIER_UTF8_BYTES = 255;
/** Matches `chat_idempotency_keys.client_key`. */
export const MAX_ATTACHMENT_IDEMPOTENCY_KEY_UTF8_BYTES = 255;
/** A deliberately smaller public policy bound than the storage schema ceiling. */
export const MAX_ATTACHMENT_FILE_NAME_UTF8_BYTES = 255;
export const MAX_ATTACHMENT_CONTENT_TYPE_UTF8_BYTES = 127;
/** Application policy: one attachment may contain at most 100 MiB. */
export const MAX_ATTACHMENT_SIZE_BYTES = 100 * 1024 * 1024;
export const MAX_ATTACHMENT_OPAQUE_DESCRIPTOR_UTF8_BYTES = 4_096;
export const MAX_ATTACHMENT_UPLOAD_DESCRIPTOR_TTL_MS = 15 * 60_000;
export const MAX_ATTACHMENT_DOWNLOAD_DESCRIPTOR_TTL_MS = 5 * 60_000;
export const MAX_ATTACHMENT_PENDING_TTL_MS = 24 * 60 * 60_000;

/** Explicitly excludes active content, executables, SVG, and generic binary data. */
export const SUPPORTED_ATTACHMENT_CONTENT_TYPES = Object.freeze([
  "application/pdf",
  "audio/mpeg",
  "audio/ogg",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/plain",
  "video/mp4",
  "video/webm",
] as const);

export type SupportedAttachmentContentType =
  (typeof SUPPORTED_ATTACHMENT_CONTENT_TYPES)[number];

/** Compile-time guard for identity and authorization resolved by the server. */
export interface NoTrustedAttachmentContext {
  readonly tenant?: never;
  readonly tenantId?: never;
  readonly organization?: never;
  readonly organizationId?: never;
  readonly actor?: never;
  readonly actorId?: never;
  readonly actorUserId?: never;
  readonly currentUser?: never;
  readonly currentUserId?: never;
  readonly user?: never;
  readonly userId?: never;
  readonly uploader?: never;
  readonly uploaderId?: never;
  readonly uploaderUserId?: never;
  readonly owner?: never;
  readonly ownerId?: never;
  readonly session?: never;
  readonly sessionId?: never;
  readonly auth?: never;
  readonly authorization?: never;
  readonly roles?: never;
  readonly capabilities?: never;
  readonly permissions?: never;
}

/** Compile-time guard for storage/provider configuration and secret material. */
export interface NoAttachmentProviderInternals {
  readonly provider?: never;
  readonly providerId?: never;
  readonly providerName?: never;
  readonly objectKey?: never;
  readonly storageKey?: never;
  readonly bucket?: never;
  readonly region?: never;
  readonly endpoint?: never;
  readonly headers?: never;
  readonly authorizationHeader?: never;
  readonly credentials?: never;
  readonly apiKey?: never;
  readonly secret?: never;
  readonly token?: never;
  readonly accessToken?: never;
  readonly refreshToken?: never;
  readonly signature?: never;
  readonly providerResponse?: never;
  readonly internalResponse?: never;
  readonly etag?: never;
}

export interface AttachmentMetadata {
  readonly fileName: string;
  readonly contentType: SupportedAttachmentContentType;
  readonly sizeBytes: number;
}

export interface AttachmentUploadDescriptor
  extends NoAttachmentProviderInternals {
  readonly kind: "opaque_attachment_upload";
  readonly descriptor: string;
  readonly expiresAt: IsoTimestamp;
}

export interface AttachmentDownloadDescriptor
  extends NoAttachmentProviderInternals {
  readonly kind: "opaque_attachment_download";
  readonly descriptor: string;
  readonly expiresAt: IsoTimestamp;
}

interface AttachmentStateBase
  extends NoTrustedAttachmentContext,
    NoAttachmentProviderInternals {
  readonly attachmentId: AttachmentId;
  readonly metadata: AttachmentMetadata;
  readonly createdAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
}

export interface PendingAttachmentState extends AttachmentStateBase {
  readonly status: "pending";
  readonly messageId?: never;
  readonly checksum?: never;
  readonly attachedAt?: never;
  readonly abandonedAt?: never;
}

/** Storage-authoritative metadata verified before a later message claim. */
export interface FinalizedAttachmentState extends AttachmentStateBase {
  readonly status: "finalized";
  readonly checksum: string;
  readonly finalizedAt: IsoTimestamp;
  readonly messageId?: never;
  readonly attachedAt?: never;
  readonly abandonedAt?: never;
  readonly rejectedAt?: never;
  readonly rejectionReason?: never;
}

export type AttachmentRejectionReason =
  | "missing_object"
  | "size_mismatch"
  | "checksum_mismatch"
  | "content_type_mismatch"
  | "unsafe"
  | "scan_failed"
  | "invalid_metadata";

/** A terminal, deliberately provider-neutral verification rejection. */
export interface RejectedAttachmentState extends AttachmentStateBase {
  readonly status: "rejected";
  readonly rejectionReason: AttachmentRejectionReason;
  readonly rejectedAt: IsoTimestamp;
  readonly messageId?: never;
  readonly checksum?: never;
  readonly attachedAt?: never;
  readonly abandonedAt?: never;
}

export interface AttachedAttachmentState extends AttachmentStateBase {
  readonly status: "attached";
  readonly messageId: MessageId;
  readonly checksum: string;
  readonly attachedAt: IsoTimestamp;
  readonly abandonedAt?: never;
}

export interface AbandonedAttachmentState extends AttachmentStateBase {
  readonly status: "abandoned";
  readonly messageId?: never;
  readonly checksum?: never;
  readonly attachedAt?: never;
  readonly abandonedAt: IsoTimestamp;
}

export type AttachmentLifecycleState =
  | PendingAttachmentState
  | FinalizedAttachmentState
  | RejectedAttachmentState
  | AttachedAttachmentState
  | AbandonedAttachmentState;
export type AttachmentLifecycleStatus = AttachmentLifecycleState["status"];

interface AttachmentMutationInputBase<Operation extends string>
  extends NoTrustedAttachmentContext,
    NoAttachmentProviderInternals {
  readonly operation: Operation;
  readonly idempotencyKey: string;
}

export interface PrepareAttachmentInput
  extends AttachmentMutationInputBase<"prepare_attachment"> {
  readonly metadata: AttachmentMetadata;
}

export interface FinalizeAttachmentInput
  extends AttachmentMutationInputBase<"finalize_attachment"> {
  /** Ownership is authorized exclusively from trusted actor context. */
  readonly attachmentId: AttachmentId;
}

export interface AbortAttachmentInput
  extends AttachmentMutationInputBase<"abort_attachment"> {
  readonly attachmentId: AttachmentId;
}

export interface GetAttachmentDownloadInput
  extends NoTrustedAttachmentContext,
    NoAttachmentProviderInternals {
  readonly operation: "get_attachment_download";
  /** Both claims require server authorization and do not assert ownership. */
  readonly attachmentId: AttachmentId;
  readonly messageId: MessageId;
}

export type AttachmentMutationInput =
  | PrepareAttachmentInput
  | FinalizeAttachmentInput
  | AbortAttachmentInput;
export type AttachmentTransportInput =
  | AttachmentMutationInput
  | GetAttachmentDownloadInput;
export type AttachmentMutationOperation = AttachmentMutationInput["operation"];
export type AttachmentReconciliationStatus = "applied" | "replayed";

interface AttachmentMutationResultBase<Operation extends string>
  extends NoTrustedAttachmentContext,
    NoAttachmentProviderInternals {
  readonly operation: Operation;
  readonly reconciliationStatus: AttachmentReconciliationStatus;
  /** Exact echo used to reconcile retry results with their mutation. */
  readonly idempotencyKey: string;
}

export interface PrepareAttachmentResult
  extends AttachmentMutationResultBase<"prepare_attachment"> {
  readonly attachment: PendingAttachmentState;
  readonly upload: AttachmentUploadDescriptor;
}

export interface FinalizeAttachmentResult
  extends AttachmentMutationResultBase<"finalize_attachment"> {
  readonly attachmentId: AttachmentId;
  readonly outcome: "finalized" | "rejected";
  readonly attachment: FinalizedAttachmentState | RejectedAttachmentState;
}

export interface AbortAttachmentResult
  extends AttachmentMutationResultBase<"abort_attachment"> {
  readonly attachmentId: AttachmentId;
  readonly attachment: AbandonedAttachmentState;
}

export interface GetAttachmentDownloadResult
  extends NoTrustedAttachmentContext,
    NoAttachmentProviderInternals {
  readonly operation: "get_attachment_download";
  readonly attachmentId: AttachmentId;
  readonly messageId: MessageId;
  readonly attachment: AttachedAttachmentState;
  readonly download: AttachmentDownloadDescriptor;
}

export type AttachmentMutationResult =
  | PrepareAttachmentResult
  | FinalizeAttachmentResult
  | AbortAttachmentResult;
export type AttachmentTransportResult =
  | AttachmentMutationResult
  | GetAttachmentDownloadResult;

export interface AttachmentTransportParseOptions {
  /** Deterministic clock used to validate public descriptor expiry. */
  readonly now?: number | Date | IsoTimestamp;
  /** Trusted state immediately before an applied mutation or at replay time. */
  readonly previousState?: AttachmentLifecycleState | null;
  /** Original accepted result when validating an idempotent replay. */
  readonly replayOf?: AttachmentMutationResult;
}

export type AttachmentTransportErrorCode =
  | "malformed_input"
  | "trusted_context_field"
  | "provider_field"
  | "secret_field"
  | "unsafe_filename"
  | "unsupported_content_type"
  | "oversized_attachment"
  | "malformed_checksum"
  | "malformed_descriptor"
  | "expired_descriptor"
  | "malformed_state"
  | "incoherent_state"
  | "invalid_transition"
  | "malformed_result"
  | "incoherent_result"
  | "replay_mismatch";

export class AttachmentTransportError extends Error {
  readonly code: AttachmentTransportErrorCode;

  constructor(code: AttachmentTransportErrorCode, message: string) {
    super(message);
    this.name = "AttachmentTransportError";
    this.code = code;
  }
}

const TRUSTED_CONTEXT_FIELDS = new Set([
  "tenant", "tenantid", "organization", "organizationid", "actor",
  "actorid", "actorcontext", "actoruserid", "currentactor",
  "currentactorid", "currentuser", "currentuserid", "user", "userid",
  "uploader", "uploaderid", "uploaderuserid", "owner", "ownerid",
  "principal", "principalid", "subject", "subjectid", "session",
  "sessionid", "auth", "authentication", "authorization", "role",
  "roles", "capability", "capabilities", "permission", "permissions",
]);

const PROVIDER_FIELDS = new Set([
  "provider", "providerid", "providername", "storageprovider",
  "storageproviderid", "objectkey", "storagekey", "bucket", "bucketid",
  "region", "endpoint", "providerconfiguration", "storageconfiguration",
  "providerresponse", "internalresponse", "rawresponse", "rawproviderresponse",
  "requestid", "statuscode", "etag",
]);

const SECRET_FIELDS = new Set([
  "authorizationheader", "authorization", "headers", "header", "credential",
  "credentials", "apikey", "secret", "clientsecret", "password", "token",
  "accesstoken", "refreshtoken", "uploadtoken", "downloadtoken", "signature",
  "signedurl", "cookie", "setcookie",
]);

const CONTENT_TYPE_EXTENSIONS: Readonly<
  Record<SupportedAttachmentContentType, readonly string[]>
> = Object.freeze({
  "application/pdf": ["pdf"],
  "audio/mpeg": ["mp3"],
  "audio/ogg": ["oga", "ogg"],
  "image/gif": ["gif"],
  "image/jpeg": ["jpeg", "jpg"],
  "image/png": ["png"],
  "image/webp": ["webp"],
  "text/plain": ["log", "md", "text", "txt"],
  "video/mp4": ["m4v", "mp4"],
  "video/webm": ["webm"],
});

const INPUT_KEYS = {
  prepare_attachment: ["operation", "metadata", "idempotencyKey"],
  finalize_attachment: [
    "operation", "attachmentId", "idempotencyKey",
  ],
  abort_attachment: ["operation", "attachmentId", "idempotencyKey"],
  get_attachment_download: ["operation", "attachmentId", "messageId"],
} as const;

export function parseAttachmentMetadata(value: unknown): AttachmentMetadata {
  rejectForbiddenPublicFields(value, "metadata");
  const metadata = requireRecord(value, "metadata", "malformed_input");
  assertExactKeys(
    metadata,
    ["fileName", "contentType", "sizeBytes"],
    "metadata",
    "malformed_input",
  );
  const contentType = readContentType(metadata.contentType, "metadata.contentType");
  const fileName = readFileName(metadata.fileName, contentType, "metadata.fileName");
  return {
    fileName,
    contentType,
    sizeBytes: readSize(metadata.sizeBytes, "metadata.sizeBytes"),
  };
}

export function parseAttachmentTransportInput(
  value: unknown,
  options: Pick<AttachmentTransportParseOptions, "now"> = {},
): AttachmentTransportInput {
  rejectForbiddenPublicFields(value, "input");
  const input = requireRecord(value, "input", "malformed_input");
  const operation = readOperation(input.operation);
  assertExactKeys(input, INPUT_KEYS[operation], "input", "malformed_input");

  if (operation === "prepare_attachment") {
    return {
      operation,
      metadata: parseAttachmentMetadata(input.metadata),
      idempotencyKey: readIdempotencyKey(input.idempotencyKey),
    };
  }
  const attachmentId = readIdentifier(
    input.attachmentId,
    "input.attachmentId",
    "malformed_input",
  ) as AttachmentId;
  if (operation === "abort_attachment") {
    return {
      operation,
      attachmentId,
      idempotencyKey: readIdempotencyKey(input.idempotencyKey),
    };
  }
  if (operation === "finalize_attachment") {
    return {
      operation,
      attachmentId,
      idempotencyKey: readIdempotencyKey(input.idempotencyKey),
    };
  }
  const messageId = readIdentifier(
    input.messageId,
    "input.messageId",
    "malformed_input",
  ) as MessageId;
  return { operation, attachmentId, messageId };
}

export function parseAttachmentMutationInput(
  value: unknown,
  options: Pick<AttachmentTransportParseOptions, "now"> = {},
): AttachmentMutationInput {
  const input = parseAttachmentTransportInput(value, options);
  if (input.operation === "get_attachment_download") {
    throw attachmentError("malformed_input", "download lookup is not a mutation");
  }
  return input;
}

export function parsePrepareAttachmentInput(value: unknown): PrepareAttachmentInput {
  return requireInputOperation(
    parseAttachmentMutationInput(value),
    "prepare_attachment",
  );
}

export function parseFinalizeAttachmentInput(
  value: unknown,
  options: Pick<AttachmentTransportParseOptions, "now"> = {},
): FinalizeAttachmentInput {
  return requireInputOperation(
    parseAttachmentMutationInput(value, options),
    "finalize_attachment",
  );
}

export function parseAbortAttachmentInput(value: unknown): AbortAttachmentInput {
  return requireInputOperation(
    parseAttachmentMutationInput(value),
    "abort_attachment",
  );
}

export function parseGetAttachmentDownloadInput(
  value: unknown,
): GetAttachmentDownloadInput {
  const input = parseAttachmentTransportInput(value);
  if (input.operation !== "get_attachment_download") {
    throw attachmentError(
      "malformed_input",
      "input.operation must be get_attachment_download",
    );
  }
  return input;
}

export function parseAttachmentUploadDescriptor(
  value: unknown,
  options: Pick<AttachmentTransportParseOptions, "now"> = {},
): AttachmentUploadDescriptor {
  return parseOpaqueDescriptor(
    value,
    "opaque_attachment_upload",
    "upload",
    MAX_ATTACHMENT_UPLOAD_DESCRIPTOR_TTL_MS,
    options,
  );
}

export function parseAttachmentDownloadDescriptor(
  value: unknown,
  options: Pick<AttachmentTransportParseOptions, "now"> = {},
): AttachmentDownloadDescriptor {
  return parseOpaqueDescriptor(
    value,
    "opaque_attachment_download",
    "download",
    MAX_ATTACHMENT_DOWNLOAD_DESCRIPTOR_TTL_MS,
    options,
  );
}

export function parseAttachmentLifecycleState(
  value: unknown,
): AttachmentLifecycleState {
  rejectForbiddenPublicFields(value, "attachment");
  const state = requireRecord(value, "attachment", "malformed_state");
  if (
    state.status !== "pending" &&
    state.status !== "finalized" &&
    state.status !== "rejected" &&
    state.status !== "attached" &&
    state.status !== "abandoned"
  ) {
    throw attachmentError(
      "malformed_state",
      "attachment.status must be pending, finalized, rejected, attached, or abandoned",
    );
  }
  const terminalKeys = state.status === "finalized"
    ? [
        "status", "attachmentId", "metadata", "createdAt", "expiresAt",
        "checksum", "finalizedAt",
      ]
    : state.status === "rejected"
      ? [
          "status", "attachmentId", "metadata", "createdAt", "expiresAt",
          "rejectionReason", "rejectedAt",
        ]
    : state.status === "attached"
    ? [
        "status", "attachmentId", "metadata", "createdAt", "expiresAt",
        "messageId", "checksum", "attachedAt",
      ]
    : state.status === "abandoned"
      ? [
          "status", "attachmentId", "metadata", "createdAt", "expiresAt",
          "abandonedAt",
        ]
      : ["status", "attachmentId", "metadata", "createdAt", "expiresAt"];
  assertExactKeys(state, terminalKeys, "attachment", "malformed_state");

  const attachmentId = readIdentifier(
    state.attachmentId,
    "attachment.attachmentId",
    "malformed_state",
  ) as AttachmentId;
  const metadata = parseStateMetadata(state.metadata);
  const createdAt = readIsoTimestamp(
    state.createdAt,
    "attachment.createdAt",
    "malformed_state",
  );
  const expiresAt = readIsoTimestamp(
    state.expiresAt,
    "attachment.expiresAt",
    "malformed_state",
  );
  const pendingTtl = timestamp(expiresAt) - timestamp(createdAt);
  if (pendingTtl <= 0 || pendingTtl > MAX_ATTACHMENT_PENDING_TTL_MS) {
    throw attachmentError(
      "incoherent_state",
      `attachment expiry must follow creation by at most ${MAX_ATTACHMENT_PENDING_TTL_MS}ms`,
    );
  }

  if (state.status === "pending") {
    return { status: "pending", attachmentId, metadata, createdAt, expiresAt };
  }
  if (state.status === "finalized") {
    const checksum = readChecksum(
      state.checksum,
      "attachment.checksum",
      "malformed_state",
    );
    const finalizedAt = readIsoTimestamp(
      state.finalizedAt,
      "attachment.finalizedAt",
      "malformed_state",
    );
    if (
      timestamp(finalizedAt) < timestamp(createdAt) ||
      timestamp(finalizedAt) > timestamp(expiresAt)
    ) {
      throw attachmentError(
        "incoherent_state",
        "attachment.finalizedAt must be between creation and upload expiry",
      );
    }
    return {
      status: "finalized",
      attachmentId,
      metadata,
      createdAt,
      expiresAt,
      checksum,
      finalizedAt,
    };
  }
  if (state.status === "rejected") {
    const rejectionReason = readRejectionReason(state.rejectionReason);
    const rejectedAt = readIsoTimestamp(
      state.rejectedAt,
      "attachment.rejectedAt",
      "malformed_state",
    );
    if (timestamp(rejectedAt) < timestamp(createdAt)) {
      throw attachmentError(
        "incoherent_state",
        "attachment.rejectedAt cannot precede creation",
      );
    }
    return {
      status: "rejected",
      attachmentId,
      metadata,
      createdAt,
      expiresAt,
      rejectionReason,
      rejectedAt,
    };
  }
  if (state.status === "attached") {
    const messageId = readIdentifier(
      state.messageId,
      "attachment.messageId",
      "malformed_state",
    ) as MessageId;
    const checksum = readChecksum(
      state.checksum,
      "attachment.checksum",
      "malformed_state",
    );
    const attachedAt = readIsoTimestamp(
      state.attachedAt,
      "attachment.attachedAt",
      "malformed_state",
    );
    if (
      timestamp(attachedAt) < timestamp(createdAt) ||
      timestamp(attachedAt) > timestamp(expiresAt)
    ) {
      throw attachmentError(
        "incoherent_state",
        "attachment.attachedAt must be between creation and upload expiry",
      );
    }
    return {
      status: "attached",
      attachmentId,
      metadata,
      createdAt,
      expiresAt,
      messageId,
      checksum,
      attachedAt,
    };
  }
  const abandonedAt = readIsoTimestamp(
    state.abandonedAt,
    "attachment.abandonedAt",
    "malformed_state",
  );
  if (timestamp(abandonedAt) < timestamp(createdAt)) {
    throw attachmentError(
      "incoherent_state",
      "attachment.abandonedAt cannot precede creation",
    );
  }
  return {
    status: "abandoned",
    attachmentId,
    metadata,
    createdAt,
    expiresAt,
    abandonedAt,
  };
}

export function isAllowedAttachmentLifecycleTransition(
  from: AttachmentLifecycleStatus | null,
  to: AttachmentLifecycleStatus,
): boolean {
  return (
    (from === null && to === "pending") ||
    (from === "pending" &&
      (to === "finalized" || to === "rejected" || to === "abandoned")) ||
    (from === "finalized" && to === "attached")
  );
}

/** Proves an applied transition or an immutable idempotent replay. */
export function validateAttachmentLifecycleTransition(
  previousValue: unknown,
  nextValue: unknown,
  inputValue: unknown,
  reconciliationStatus: AttachmentReconciliationStatus = "applied",
  options: Pick<AttachmentTransportParseOptions, "now"> = {},
): AttachmentLifecycleState {
  const input = parseAttachmentMutationInput(inputValue, options);
  const previous = previousValue === null
    ? null
    : parseAttachmentLifecycleState(previousValue);
  const next = parseAttachmentLifecycleState(nextValue);

  if (reconciliationStatus === "replayed") {
    if (previous === null || !sameCanonicalValue(previous, next)) {
      throw attachmentError(
        "replay_mismatch",
        "a replay must preserve the same canonical attachment state",
      );
    }
    assertResultStateMatchesInput(next, input);
    return next;
  }
  if (!isAllowedAttachmentLifecycleTransition(previous?.status ?? null, next.status)) {
    throw attachmentError(
      "invalid_transition",
      `attachment lifecycle cannot transition from ${previous?.status ?? "absent"} to ${next.status}`,
    );
  }

  if (input.operation === "prepare_attachment") {
    if (
      previous !== null ||
      next.status !== "pending" ||
      !sameCanonicalValue(next.metadata, input.metadata)
    ) {
      throw attachmentError(
        "invalid_transition",
        "prepare_attachment must create matching pending metadata",
      );
    }
    return next;
  }
  if (previous === null || previous.status !== "pending") {
    throw attachmentError(
      "invalid_transition",
      "only a pending attachment can be finalized or abandoned",
    );
  }
  assertSameAttachment(previous, next, input.attachmentId);
  if (input.operation === "finalize_attachment") {
    if (next.status !== "finalized" && next.status !== "rejected") {
      throw attachmentError(
        "invalid_transition",
        "finalize_attachment must produce a storage-verified or rejected outcome",
      );
    }
  } else if (next.status !== "abandoned") {
    throw attachmentError(
      "invalid_transition",
      "abort_attachment must abandon the pending attachment",
    );
  }
  return next;
}

export function parseAttachmentMutationResult(
  value: unknown,
  expectedInput: AttachmentMutationInput,
  options: AttachmentTransportParseOptions = {},
): AttachmentMutationResult {
  const input = parseAttachmentMutationInput(expectedInput, options);
  rejectForbiddenPublicFields(value, "result");
  const result = requireRecord(value, "result", "malformed_result");
  if (result.operation !== input.operation) {
    throw attachmentError(
      "incoherent_result",
      "result.operation must match the mutation",
    );
  }
  const reconciliationStatus = readReconciliationStatus(
    result.reconciliationStatus,
  );
  const idempotencyKey = readBoundedNonblankString(
    result.idempotencyKey,
    "result.idempotencyKey",
    MAX_ATTACHMENT_IDEMPOTENCY_KEY_UTF8_BYTES,
    "malformed_result",
  );
  if (idempotencyKey !== input.idempotencyKey) {
    throw attachmentError(
      "incoherent_result",
      "result.idempotencyKey must match the mutation",
    );
  }

  let parsed: AttachmentMutationResult;
  if (input.operation === "prepare_attachment") {
    assertExactKeys(
      result,
      ["operation", "reconciliationStatus", "idempotencyKey", "attachment", "upload"],
      "result",
      "malformed_result",
    );
    const attachment = parseAttachmentLifecycleState(result.attachment);
    if (
      attachment.status !== "pending" ||
      !sameCanonicalValue(attachment.metadata, input.metadata)
    ) {
      throw attachmentError(
        "incoherent_result",
        "prepare result must echo matching pending metadata",
      );
    }
    parsed = {
      operation: "prepare_attachment",
      reconciliationStatus,
      idempotencyKey,
      attachment,
      upload: parseAttachmentUploadDescriptor(result.upload, options),
    };
  } else if (input.operation === "finalize_attachment") {
    assertExactKeys(
      result,
      [
        "operation", "reconciliationStatus", "idempotencyKey", "attachmentId",
        "outcome", "attachment",
      ],
      "result",
      "malformed_result",
    );
    const attachmentId = readIdentifier(
      result.attachmentId,
      "result.attachmentId",
      "malformed_result",
    ) as AttachmentId;
    const attachment = parseAttachmentLifecycleState(result.attachment);
    const outcome = result.outcome;
    if (
      attachmentId !== input.attachmentId ||
      attachment.attachmentId !== attachmentId ||
      (outcome !== "finalized" && outcome !== "rejected") ||
      attachment.status !== outcome
    ) {
      throw attachmentError(
        "incoherent_result",
        "finalize result must identify one sanitized verified or rejected attachment outcome",
      );
    }
    parsed = {
      operation: "finalize_attachment",
      reconciliationStatus,
      idempotencyKey,
      attachmentId,
      outcome,
      attachment,
    };
  } else {
    assertExactKeys(
      result,
      ["operation", "reconciliationStatus", "idempotencyKey", "attachmentId", "attachment"],
      "result",
      "malformed_result",
    );
    const attachmentId = readIdentifier(
      result.attachmentId,
      "result.attachmentId",
      "malformed_result",
    ) as AttachmentId;
    const attachment = parseAttachmentLifecycleState(result.attachment);
    if (
      attachmentId !== input.attachmentId ||
      attachment.status !== "abandoned" ||
      attachment.attachmentId !== attachmentId
    ) {
      throw attachmentError(
        "incoherent_result",
        "abort result must echo the abandoned attachment claim",
      );
    }
    parsed = {
      operation: "abort_attachment",
      reconciliationStatus,
      idempotencyKey,
      attachmentId,
      attachment,
    };
  }

  if (options.previousState !== undefined) {
    validateAttachmentLifecycleTransition(
      options.previousState,
      parsed.attachment,
      input,
      reconciliationStatus,
      options,
    );
  }
  if (reconciliationStatus === "replayed" && options.replayOf !== undefined) {
    const original = parseAttachmentMutationResult(options.replayOf, input, {
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    if (
      original.operation !== parsed.operation ||
      !sameCanonicalValue(original.attachment, parsed.attachment)
    ) {
      throw attachmentError(
        "replay_mismatch",
        "a replay must preserve the original operation and canonical attachment",
      );
    }
  }
  return parsed;
}

export function parsePrepareAttachmentResult(
  value: unknown,
  expectedInput: PrepareAttachmentInput,
  options: AttachmentTransportParseOptions = {},
): PrepareAttachmentResult {
  return requireResultOperation(
    parseAttachmentMutationResult(value, expectedInput, options),
    "prepare_attachment",
  );
}

export function parseFinalizeAttachmentResult(
  value: unknown,
  expectedInput: FinalizeAttachmentInput,
  options: AttachmentTransportParseOptions = {},
): FinalizeAttachmentResult {
  return requireResultOperation(
    parseAttachmentMutationResult(value, expectedInput, options),
    "finalize_attachment",
  );
}

export function parseAbortAttachmentResult(
  value: unknown,
  expectedInput: AbortAttachmentInput,
  options: AttachmentTransportParseOptions = {},
): AbortAttachmentResult {
  return requireResultOperation(
    parseAttachmentMutationResult(value, expectedInput, options),
    "abort_attachment",
  );
}

export function parseAttachmentTransportResult(
  value: unknown,
  expectedInput: PrepareAttachmentInput,
  options?: AttachmentTransportParseOptions,
): PrepareAttachmentResult;
export function parseAttachmentTransportResult(
  value: unknown,
  expectedInput: FinalizeAttachmentInput,
  options?: AttachmentTransportParseOptions,
): FinalizeAttachmentResult;
export function parseAttachmentTransportResult(
  value: unknown,
  expectedInput: AbortAttachmentInput,
  options?: AttachmentTransportParseOptions,
): AbortAttachmentResult;
export function parseAttachmentTransportResult(
  value: unknown,
  expectedInput: GetAttachmentDownloadInput,
  options?: AttachmentTransportParseOptions,
): GetAttachmentDownloadResult;
export function parseAttachmentTransportResult(
  value: unknown,
  expectedInput: AttachmentTransportInput,
  options?: AttachmentTransportParseOptions,
): AttachmentTransportResult;
/** Parses any public attachment response against the exact accepted request. */
export function parseAttachmentTransportResult(
  value: unknown,
  expectedInput: AttachmentTransportInput,
  options: AttachmentTransportParseOptions = {},
): AttachmentTransportResult {
  const input = parseAttachmentTransportInput(expectedInput, options);
  return input.operation === "get_attachment_download"
    ? parseGetAttachmentDownloadResult(value, input, options)
    : parseAttachmentMutationResult(value, input, options);
}

export function parseGetAttachmentDownloadResult(
  value: unknown,
  expectedInput: GetAttachmentDownloadInput,
  options: Pick<AttachmentTransportParseOptions, "now"> = {},
): GetAttachmentDownloadResult {
  const input = parseGetAttachmentDownloadInput(expectedInput);
  rejectForbiddenPublicFields(value, "result");
  const result = requireRecord(value, "result", "malformed_result");
  assertExactKeys(
    result,
    ["operation", "attachmentId", "messageId", "attachment", "download"],
    "result",
    "malformed_result",
  );
  if (result.operation !== "get_attachment_download") {
    throw attachmentError(
      "malformed_result",
      "result.operation must be get_attachment_download",
    );
  }
  const attachmentId = readIdentifier(
    result.attachmentId,
    "result.attachmentId",
    "malformed_result",
  ) as AttachmentId;
  const messageId = readIdentifier(
    result.messageId,
    "result.messageId",
    "malformed_result",
  ) as MessageId;
  const attachment = parseAttachmentLifecycleState(result.attachment);
  if (
    attachmentId !== input.attachmentId ||
    messageId !== input.messageId ||
    attachment.status !== "attached" ||
    attachment.attachmentId !== attachmentId ||
    attachment.messageId !== messageId
  ) {
    throw attachmentError(
      "incoherent_result",
      "download result must identify the authorized attached message claim",
    );
  }
  return {
    operation: "get_attachment_download",
    attachmentId,
    messageId,
    attachment,
    download: parseAttachmentDownloadDescriptor(result.download, options),
  };
}

function parseOpaqueDescriptor<
  Kind extends
    | AttachmentUploadDescriptor["kind"]
    | AttachmentDownloadDescriptor["kind"],
>(
  value: unknown,
  expectedKind: Kind,
  path: string,
  maxTtlMs: number,
  options: Pick<AttachmentTransportParseOptions, "now">,
): { readonly kind: Kind; readonly descriptor: string; readonly expiresAt: IsoTimestamp } {
  rejectForbiddenPublicFields(value, path);
  const descriptor = requireRecord(value, path, "malformed_descriptor");
  assertExactKeys(
    descriptor,
    ["kind", "descriptor", "expiresAt"],
    path,
    "malformed_descriptor",
  );
  if (descriptor.kind !== expectedKind) {
    throw attachmentError(
      "malformed_descriptor",
      `${path}.kind must be ${expectedKind}`,
    );
  }
  const opaqueValue = readBoundedNonblankString(
    descriptor.descriptor,
    `${path}.descriptor`,
    MAX_ATTACHMENT_OPAQUE_DESCRIPTOR_UTF8_BYTES,
    "malformed_descriptor",
  );
  rejectSerializedDescriptorFields(opaqueValue, `${path}.descriptor`);
  const expiresAt = readIsoTimestamp(
    descriptor.expiresAt,
    `${path}.expiresAt`,
    "malformed_descriptor",
  );
  const ttl = timestamp(expiresAt) - readNow(options.now);
  if (ttl <= 0) {
    throw attachmentError(
      "expired_descriptor",
      `${path}.expiresAt must be in the future`,
    );
  }
  if (ttl > maxTtlMs) {
    throw attachmentError(
      "malformed_descriptor",
      `${path}.expiresAt cannot exceed ${maxTtlMs}ms from now`,
    );
  }
  return { kind: expectedKind, descriptor: opaqueValue, expiresAt };
}

function parseStateMetadata(value: unknown): AttachmentMetadata {
  try {
    return parseAttachmentMetadata(value);
  } catch (error) {
    if (!(error instanceof AttachmentTransportError)) throw error;
    if (
      error.code === "unsafe_filename" ||
      error.code === "unsupported_content_type" ||
      error.code === "oversized_attachment" ||
      error.code === "trusted_context_field" ||
      error.code === "provider_field" ||
      error.code === "secret_field"
    ) {
      throw error;
    }
    throw attachmentError("malformed_state", error.message);
  }
}

function readFileName(
  value: unknown,
  contentType: SupportedAttachmentContentType,
  path: string,
): string {
  const fileName = readBoundedNonblankString(
    value,
    path,
    MAX_ATTACHMENT_FILE_NAME_UTF8_BYTES,
    "unsafe_filename",
  );
  if (
    fileName !== fileName.trim() ||
    fileName !== fileName.normalize("NFC") ||
    fileName === "." ||
    fileName === ".." ||
    fileName.startsWith(".") ||
    fileName.endsWith(".") ||
    UNSAFE_FILE_NAME_PATTERN.test(fileName)
  ) {
    throw attachmentError(
      "unsafe_filename",
      `${path} must be a normalized basename without separators or control characters`,
    );
  }
  const separator = fileName.lastIndexOf(".");
  const extension = separator < 1 ? "" : fileName.slice(separator + 1).toLowerCase();
  if (!CONTENT_TYPE_EXTENSIONS[contentType].includes(extension)) {
    throw attachmentError(
      "unsafe_filename",
      `${path} extension is not allowed for ${contentType}`,
    );
  }
  return fileName;
}

function readContentType(value: unknown, path: string): SupportedAttachmentContentType {
  const contentType = readBoundedNonblankString(
    value,
    path,
    MAX_ATTACHMENT_CONTENT_TYPE_UTF8_BYTES,
    "unsupported_content_type",
  );
  if (
    !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(contentType) ||
    !(SUPPORTED_ATTACHMENT_CONTENT_TYPES as readonly string[]).includes(contentType)
  ) {
    throw attachmentError(
      "unsupported_content_type",
      `${path} is not a supported canonical media type`,
    );
  }
  return contentType as SupportedAttachmentContentType;
}

function readSize(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw attachmentError(
      "malformed_input",
      `${path} must be a nonnegative safe integer`,
    );
  }
  if ((value as number) > MAX_ATTACHMENT_SIZE_BYTES) {
    throw attachmentError(
      "oversized_attachment",
      `${path} cannot exceed ${MAX_ATTACHMENT_SIZE_BYTES} bytes`,
    );
  }
  return value as number;
}

function readChecksum(
  value: unknown,
  path: string,
  code: "malformed_input" | "malformed_state",
): string {
  if (typeof value !== "string" || !CHECKSUM_PATTERN.test(value)) {
    throw attachmentError(
      code === "malformed_input" ? "malformed_checksum" : code,
      `${path} must be a lowercase sha256 checksum`,
    );
  }
  return value;
}

function readIdempotencyKey(value: unknown): string {
  return readBoundedNonblankString(
    value,
    "input.idempotencyKey",
    MAX_ATTACHMENT_IDEMPOTENCY_KEY_UTF8_BYTES,
    "malformed_input",
  );
}

function readIdentifier(
  value: unknown,
  path: string,
  code: "malformed_input" | "malformed_state" | "malformed_result",
): string {
  const identifier = readBoundedNonblankString(
    value,
    path,
    MAX_ATTACHMENT_IDENTIFIER_UTF8_BYTES,
    code,
  );
  if (/\p{Cc}/u.test(identifier)) {
    throw attachmentError(code, `${path} cannot contain control characters`);
  }
  return identifier;
}

function readOperation(value: unknown): AttachmentTransportInput["operation"] {
  if (
    value !== "prepare_attachment" &&
    value !== "finalize_attachment" &&
    value !== "abort_attachment" &&
    value !== "get_attachment_download"
  ) {
    throw attachmentError("malformed_input", "unsupported attachment operation");
  }
  return value;
}

function readReconciliationStatus(value: unknown): AttachmentReconciliationStatus {
  if (value !== "applied" && value !== "replayed") {
    throw attachmentError(
      "malformed_result",
      "result.reconciliationStatus must be applied or replayed",
    );
  }
  return value;
}

function readRejectionReason(value: unknown): AttachmentRejectionReason {
  if (
    value !== "missing_object" &&
    value !== "size_mismatch" &&
    value !== "checksum_mismatch" &&
    value !== "content_type_mismatch" &&
    value !== "unsafe" &&
    value !== "scan_failed" &&
    value !== "invalid_metadata"
  ) {
    throw attachmentError(
      "malformed_state",
      "attachment.rejectionReason is invalid",
    );
  }
  return value;
}

function assertSameAttachment(
  previous: PendingAttachmentState,
  next: AttachmentLifecycleState,
  attachmentId: AttachmentId,
): void {
  if (
    previous.attachmentId !== attachmentId ||
    next.attachmentId !== attachmentId ||
    previous.createdAt !== next.createdAt ||
    previous.expiresAt !== next.expiresAt ||
    !sameCanonicalValue(previous.metadata, next.metadata)
  ) {
    throw attachmentError(
      "invalid_transition",
      "attachment identity and prepared metadata are immutable",
    );
  }
}

function assertResultStateMatchesInput(
  state: AttachmentLifecycleState,
  input: AttachmentMutationInput,
): void {
  if (
    (input.operation === "prepare_attachment" &&
      (state.status !== "pending" ||
        !sameCanonicalValue(state.metadata, input.metadata))) ||
    (input.operation === "finalize_attachment" &&
      ((state.status !== "finalized" && state.status !== "rejected") ||
        state.attachmentId !== input.attachmentId)) ||
    (input.operation === "abort_attachment" &&
      (state.status !== "abandoned" || state.attachmentId !== input.attachmentId))
  ) {
    throw attachmentError(
      "replay_mismatch",
      "replayed attachment state does not match the original mutation claims",
    );
  }
}

function rejectForbiddenPublicFields(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      rejectForbiddenPublicFields(entry, `${path}[${index}]`),
    );
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    const normalized = normalizeKey(key);
    if (TRUSTED_CONTEXT_FIELDS.has(normalized)) {
      throw attachmentError(
        "trusted_context_field",
        `${path}.${key} is server-derived and cannot be public attachment transport data`,
      );
    }
    if (PROVIDER_FIELDS.has(normalized)) {
      throw attachmentError(
        "provider_field",
        `${path}.${key} exposes a storage-provider implementation detail`,
      );
    }
    if (SECRET_FIELDS.has(normalized)) {
      throw attachmentError(
        "secret_field",
        `${path}.${key} is secret-bearing and cannot be public attachment transport data`,
      );
    }
    rejectForbiddenPublicFields(nested, `${path}.${key}`);
  }
}

function rejectSerializedDescriptorFields(value: string, path: string): void {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return;
  try {
    rejectForbiddenPublicFields(JSON.parse(trimmed), `${path}.serialized`);
  } catch (error) {
    if (error instanceof AttachmentTransportError) throw error;
    // An opaque descriptor need not itself be JSON; malformed JSON stays opaque.
  }
}

function requireInputOperation<Operation extends AttachmentMutationOperation>(
  input: AttachmentMutationInput,
  operation: Operation,
): Extract<AttachmentMutationInput, { readonly operation: Operation }> {
  if (input.operation !== operation) {
    throw attachmentError("malformed_input", `input.operation must be ${operation}`);
  }
  return input as Extract<AttachmentMutationInput, { readonly operation: Operation }>;
}

function requireResultOperation<Operation extends AttachmentMutationOperation>(
  result: AttachmentMutationResult,
  operation: Operation,
): Extract<AttachmentMutationResult, { readonly operation: Operation }> {
  if (result.operation !== operation) {
    throw attachmentError("malformed_result", `result.operation must be ${operation}`);
  }
  return result as Extract<AttachmentMutationResult, { readonly operation: Operation }>;
}

function requireRecord(
  value: unknown,
  path: string,
  code: AttachmentTransportErrorCode,
): Record<string, unknown> {
  if (!isRecord(value)) throw attachmentError(code, `${path} must be an object`);
  return value;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
  code: AttachmentTransportErrorCode,
): void {
  const keys = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) throw attachmentError(code, `${path}.${key} is not supported`);
  }
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) throw attachmentError(code, `${path}.${key} is required`);
  }
}

function readBoundedNonblankString(
  value: unknown,
  path: string,
  maxBytes: number,
  code: AttachmentTransportErrorCode,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw attachmentError(code, `${path} must be a nonblank string`);
  }
  if (new TextEncoder().encode(value).byteLength > maxBytes) {
    throw attachmentError(code, `${path} cannot exceed ${maxBytes} UTF-8 bytes`);
  }
  return value;
}

function readIsoTimestamp(
  value: unknown,
  path: string,
  code: AttachmentTransportErrorCode,
): IsoTimestamp {
  if (
    typeof value !== "string" ||
    !ISO_TIMESTAMP_PATTERN.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw attachmentError(code, `${path} must be an ISO-8601 timestamp`);
  }
  return value;
}

function readNow(value: AttachmentTransportParseOptions["now"]): number {
  if (value === undefined) return Date.now();
  const parsed = value instanceof Date
    ? value.getTime()
    : typeof value === "number"
      ? value
      : Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw attachmentError("malformed_descriptor", "options.now must be a valid time");
  }
  return parsed;
}

function timestamp(value: IsoTimestamp): number {
  return Date.parse(value);
}

function sameCanonicalValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeKey(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function attachmentError(
  code: AttachmentTransportErrorCode,
  message: string,
): AttachmentTransportError {
  return new AttachmentTransportError(code, message);
}
