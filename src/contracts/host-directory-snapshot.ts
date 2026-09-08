import type { IsoTimestamp, UserId } from "./identifiers.js";
import {
  createServerHandshakeMetadata,
  type ServerHandshakeMetadata,
  type ServerHandshakeMetadataInput,
} from "./realtime.js";

export const HOST_DIRECTORY_SNAPSHOT_FEATURE = "host_directory_snapshots" as const;
export const HOST_DIRECTORY_SNAPSHOT_VERSION = 1 as const;
export const MAX_HOST_DIRECTORY_BATCH_SIZE = 100 as const;
export const MAX_HOST_DIRECTORY_SEARCH_LIMIT = 100 as const;
export const MAX_HOST_DIRECTORY_QUERY_LENGTH = 200 as const;

const SEARCH_CURSOR_PREFIX = "handrail-host-directory.v";
const MAX_USER_ID_LENGTH = 512;
const MAX_DISPLAY_NAME_LENGTH = 256;
const MAX_AVATAR_URL_LENGTH = 2_048;
const MAX_AVATAR_ALT_TEXT_LENGTH = 256;
const MAX_AVATAR_INITIALS_LENGTH = 8;
const MAX_STATUS_TEXT_LENGTH = 160;
const MAX_STATUS_EMOJI_LENGTH = 32;
const MAX_PROVIDER_CONTINUATION_LENGTH = 2_048;
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const FORBIDDEN_DIRECTORY_FIELDS = new Set([
  "tenant",
  "tenantid",
  "organization",
  "organizationid",
  "actor",
  "actorid",
  "actorcontext",
  "actoruserid",
  "currentactor",
  "currentactorid",
  "currentuserid",
  "authenticateduser",
  "authenticateduserid",
  "principal",
  "principalid",
  "subject",
  "subjectid",
  "identity",
  "session",
  "sessionid",
  "auth",
  "authorization",
  "credential",
  "credentials",
  "password",
  "secret",
  "token",
  "accesstoken",
  "refreshtoken",
  "roles",
  "globalroles",
  "capabilities",
  "permissions",
  "email",
  "emailaddress",
  "phone",
  "phonenumber",
  "address",
  "metadata",
  "profile",
]);

/** Compile-time guard for fields that belong only to trusted host systems. */
export interface NoTrustedOrSensitiveDirectoryFields {
  readonly tenant?: never;
  readonly tenantId?: never;
  readonly organization?: never;
  readonly organizationId?: never;
  readonly actor?: never;
  readonly actorId?: never;
  readonly actorContext?: never;
  readonly actorUserId?: never;
  readonly currentActor?: never;
  readonly currentActorId?: never;
  readonly currentUserId?: never;
  readonly authenticatedUser?: never;
  readonly authenticatedUserId?: never;
  readonly principal?: never;
  readonly principalId?: never;
  readonly subject?: never;
  readonly subjectId?: never;
  readonly identity?: never;
  readonly session?: never;
  readonly sessionId?: never;
  readonly auth?: never;
  readonly authorization?: never;
  readonly credential?: never;
  readonly credentials?: never;
  readonly password?: never;
  readonly secret?: never;
  readonly token?: never;
  readonly accessToken?: never;
  readonly refreshToken?: never;
  readonly roles?: never;
  readonly globalRoles?: never;
  readonly capabilities?: never;
  readonly permissions?: never;
  readonly email?: never;
  readonly emailAddress?: never;
  readonly phone?: never;
  readonly phoneNumber?: never;
  readonly address?: never;
  readonly metadata?: never;
  readonly profile?: never;
}

export type HostDirectoryAvatar =
  | (NoTrustedOrSensitiveDirectoryFields & {
      readonly kind: "none";
      readonly url?: never;
      readonly altText?: never;
      readonly initials?: never;
    })
  | (NoTrustedOrSensitiveDirectoryFields & {
      readonly kind: "image";
      /** An HTTPS URL or same-origin root-relative path. */
      readonly url: string;
      readonly altText?: string;
      readonly initials?: never;
    })
  | (NoTrustedOrSensitiveDirectoryFields & {
      readonly kind: "initials";
      readonly initials: string;
      readonly url?: never;
      readonly altText?: never;
    });

export type HostDirectoryAvailability = "online" | "away" | "busy" | "offline";

/** Optional, host-supplied status. The SDK never infers these fields. */
export interface HostDirectoryUserStatus
  extends NoTrustedOrSensitiveDirectoryFields {
  readonly availability?: HostDirectoryAvailability;
  readonly text?: string;
  readonly emoji?: string;
  readonly expiresAt?: IsoTimestamp;
}

export type ActiveHostDirectoryUserSummary =
  NoTrustedOrSensitiveDirectoryFields & {
    readonly kind: "active";
    readonly userId: UserId;
    readonly displayName: string;
    readonly avatar: HostDirectoryAvatar;
    readonly status?: HostDirectoryUserStatus;
    readonly reason?: never;
  };

/** A known host user whose profile is intentionally hidden from this actor. */
export type RedactedHostDirectoryUserSummary =
  NoTrustedOrSensitiveDirectoryFields & {
    readonly kind: "redacted";
    readonly userId: UserId;
    readonly displayName?: never;
    readonly avatar?: never;
    readonly status?: never;
    readonly reason?: never;
  };

/** A host user ID that cannot currently be resolved, without profile fallback. */
export type UnavailableHostDirectoryUserSummary =
  NoTrustedOrSensitiveDirectoryFields & {
    readonly kind: "unavailable";
    readonly userId: UserId;
    readonly reason: "missing" | "temporarily_unavailable";
    readonly displayName?: never;
    readonly avatar?: never;
    readonly status?: never;
  };

export type HostDirectoryUserSummary =
  | ActiveHostDirectoryUserSummary
  | RedactedHostDirectoryUserSummary
  | UnavailableHostDirectoryUserSummary;

export type HostDirectoryBatchLookupInput =
  NoTrustedOrSensitiveDirectoryFields & {
    readonly userIds: readonly UserId[];
  };

declare const hostDirectorySearchCursorBrand: unique symbol;

/** Opaque HTTP continuation cursor; create it with the exported encoder. */
export type HostDirectorySearchCursor = string & {
  readonly [hostDirectorySearchCursorBrand]: "host-directory-search-cursor";
};

/** Server-side cursor material. The provider continuation remains opaque. */
export interface HostDirectorySearchCursorPosition {
  readonly query: string;
  readonly continuation: string;
}

export type HostDirectorySearchInput =
  NoTrustedOrSensitiveDirectoryFields & {
    readonly query: string;
    readonly cursor?: HostDirectorySearchCursor;
    readonly limit?: number;
  };

export interface HostDirectorySnapshotFeatureMetadata {
  readonly name: typeof HOST_DIRECTORY_SNAPSHOT_FEATURE;
  readonly version: typeof HOST_DIRECTORY_SNAPSHOT_VERSION;
}

export interface HostDirectorySnapshotMetadata<Feature extends string = string>
  extends ServerHandshakeMetadata<Feature> {
  readonly feature: HostDirectorySnapshotFeatureMetadata;
}

export interface HostDirectoryBatchLookupResult<Feature extends string = string> {
  readonly kind: "host_directory_batch";
  readonly users: readonly HostDirectoryUserSummary[];
  readonly _meta: HostDirectorySnapshotMetadata<Feature>;
}

export interface HostDirectorySearchResult<Feature extends string = string> {
  readonly kind: "host_directory_search";
  readonly users: readonly HostDirectoryUserSummary[];
  readonly page: {
    readonly nextCursor?: HostDirectorySearchCursor;
  };
  readonly _meta: HostDirectorySnapshotMetadata<Feature>;
}

export type HostDirectorySnapshotParseErrorCode =
  | "malformed_input"
  | "forbidden_field"
  | "duplicate_user_id"
  | "batch_limit_exceeded"
  | "query_limit_exceeded"
  | "malformed_cursor"
  | "unsupported_cursor"
  | "cursor_query_mismatch"
  | "malformed_snapshot";

export class HostDirectorySnapshotParseError extends Error {
  readonly code: HostDirectorySnapshotParseErrorCode;

  constructor(code: HostDirectorySnapshotParseErrorCode, message: string) {
    super(message);
    this.name = "HostDirectorySnapshotParseError";
    this.code = code;
  }
}

export function createHostDirectorySnapshotMetadata<Feature extends string = string>(
  input: ServerHandshakeMetadataInput<Feature>,
): HostDirectorySnapshotMetadata<Feature> {
  return {
    ...createServerHandshakeMetadata(input),
    feature: {
      name: HOST_DIRECTORY_SNAPSHOT_FEATURE,
      version: HOST_DIRECTORY_SNAPSHOT_VERSION,
    },
  };
}

/** Encodes a host-provider continuation in a browser-safe versioned envelope. */
export function encodeHostDirectorySearchCursor(
  position: HostDirectorySearchCursorPosition,
): HostDirectorySearchCursor {
  validateQuery(position.query, "malformed_cursor");
  validateBoundedString(
    position.continuation,
    "continuation",
    MAX_PROVIDER_CONTINUATION_LENGTH,
    "malformed_cursor",
  );
  return `${SEARCH_CURSOR_PREFIX}${HOST_DIRECTORY_SNAPSHOT_VERSION}.${encodeURIComponent(
    JSON.stringify([position.query, position.continuation]),
  )}` as HostDirectorySearchCursor;
}

export function decodeHostDirectorySearchCursor(
  cursor: string,
): HostDirectorySearchCursorPosition {
  if (typeof cursor !== "string" || cursor.length === 0) {
    throw directoryError("malformed_cursor", "cursor must be a non-empty string");
  }

  const match = /^handrail-host-directory\.v(\d+)\.(.+)$/.exec(cursor);
  if (match === null) {
    throw directoryError("malformed_cursor", "cursor has an invalid envelope");
  }

  const version = Number(match[1]);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw directoryError("malformed_cursor", "cursor version is invalid");
  }
  if (version !== HOST_DIRECTORY_SNAPSHOT_VERSION) {
    throw directoryError(
      "unsupported_cursor",
      `cursor version ${version} is unsupported`,
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(decodeURIComponent(match[2] as string));
  } catch {
    throw directoryError("malformed_cursor", "cursor payload is malformed");
  }
  if (!Array.isArray(payload) || payload.length !== 2) {
    throw directoryError("malformed_cursor", "cursor payload has an invalid structure");
  }

  const [query, continuation] = payload;
  validateQuery(query, "malformed_cursor");
  validateBoundedString(
    continuation,
    "cursor continuation",
    MAX_PROVIDER_CONTINUATION_LENGTH,
    "malformed_cursor",
  );
  return { query, continuation };
}

export function parseHostDirectoryBatchLookupInput(
  value: unknown,
): HostDirectoryBatchLookupInput {
  rejectForbiddenFields(value);
  const input = requireRecord(value, "input", "malformed_input");
  assertAllowedKeys(input, ["userIds"], "input", "malformed_input");
  if (!Array.isArray(input.userIds) || input.userIds.length === 0) {
    throw directoryError("malformed_input", "userIds must be a non-empty array");
  }
  if (input.userIds.length > MAX_HOST_DIRECTORY_BATCH_SIZE) {
    throw directoryError(
      "batch_limit_exceeded",
      `userIds cannot contain more than ${MAX_HOST_DIRECTORY_BATCH_SIZE} entries`,
    );
  }
  return { userIds: parseUniqueUserIds(input.userIds, "input.userIds") };
}

export function parseHostDirectorySearchInput(
  value: unknown,
): HostDirectorySearchInput {
  rejectForbiddenFields(value);
  const input = requireRecord(value, "input", "malformed_input");
  assertAllowedKeys(input, ["query", "cursor", "limit"], "input", "malformed_input");
  validateQuery(input.query, "malformed_input");

  const output: {
    query: string;
    cursor?: HostDirectorySearchCursor;
    limit?: number;
  } = { query: input.query };

  if (input.cursor !== undefined) {
    if (typeof input.cursor !== "string") {
      throw directoryError("malformed_cursor", "cursor must be a string");
    }
    const position = decodeHostDirectorySearchCursor(input.cursor);
    if (position.query !== input.query) {
      throw directoryError(
        "cursor_query_mismatch",
        "cursor belongs to a different directory query",
      );
    }
    output.cursor = input.cursor as HostDirectorySearchCursor;
  }

  if (input.limit !== undefined) {
    if (
      !Number.isSafeInteger(input.limit) ||
      (input.limit as number) < 1 ||
      (input.limit as number) > MAX_HOST_DIRECTORY_SEARCH_LIMIT
    ) {
      throw directoryError(
        "query_limit_exceeded",
        `limit must be a safe integer between 1 and ${MAX_HOST_DIRECTORY_SEARCH_LIMIT}`,
      );
    }
    output.limit = input.limit as number;
  }
  return output;
}

export function parseHostDirectoryBatchLookupResult<Feature extends string = string>(
  value: unknown,
): HostDirectoryBatchLookupResult<Feature> {
  rejectForbiddenFields(value, "snapshot");
  const result = requireRecord(value, "snapshot", "malformed_snapshot");
  assertAllowedKeys(result, ["kind", "users", "_meta"], "snapshot", "malformed_snapshot");
  if (result.kind !== "host_directory_batch") {
    throw directoryError("malformed_snapshot", "kind must be host_directory_batch");
  }
  const users = parseResultUsers(
    result.users,
    MAX_HOST_DIRECTORY_BATCH_SIZE,
    "batch_limit_exceeded",
  );
  return {
    kind: "host_directory_batch",
    users,
    _meta: parseMetadata<Feature>(result._meta),
  };
}

export function parseHostDirectorySearchResult<Feature extends string = string>(
  value: unknown,
): HostDirectorySearchResult<Feature> {
  rejectForbiddenFields(value, "snapshot");
  const result = requireRecord(value, "snapshot", "malformed_snapshot");
  assertAllowedKeys(result, ["kind", "users", "page", "_meta"], "snapshot", "malformed_snapshot");
  if (result.kind !== "host_directory_search") {
    throw directoryError("malformed_snapshot", "kind must be host_directory_search");
  }
  const page = requireRecord(result.page, "page", "malformed_snapshot");
  assertAllowedKeys(page, ["nextCursor"], "page", "malformed_snapshot");
  const parsedPage: { nextCursor?: HostDirectorySearchCursor } = {};
  if (page.nextCursor !== undefined) {
    if (typeof page.nextCursor !== "string") {
      throw directoryError("malformed_cursor", "page.nextCursor must be a string");
    }
    decodeHostDirectorySearchCursor(page.nextCursor);
    parsedPage.nextCursor = page.nextCursor as HostDirectorySearchCursor;
  }
  return {
    kind: "host_directory_search",
    users: parseResultUsers(
      result.users,
      MAX_HOST_DIRECTORY_SEARCH_LIMIT,
      "query_limit_exceeded",
    ),
    page: parsedPage,
    _meta: parseMetadata<Feature>(result._meta),
  };
}

function parseResultUsers(
  value: unknown,
  maximum: number,
  limitErrorCode: "batch_limit_exceeded" | "query_limit_exceeded",
): HostDirectoryUserSummary[] {
  if (!Array.isArray(value)) {
    throw directoryError("malformed_snapshot", "users must be an array");
  }
  if (value.length > maximum) {
    throw directoryError(
      limitErrorCode,
      `users cannot contain more than ${maximum} entries`,
    );
  }
  const users = value.map((user, index) => parseUserSummary(user, `users[${index}]`));
  assertUniqueSummaryIds(users);
  return users;
}

function parseUserSummary(value: unknown, path: string): HostDirectoryUserSummary {
  const user = requireRecord(value, path, "malformed_snapshot");
  const userId = readUserId(user.userId, `${path}.userId`, "malformed_snapshot");

  if (user.kind === "active") {
    assertAllowedKeys(user, ["kind", "userId", "displayName", "avatar", "status"], path, "malformed_snapshot");
    const displayName = readBoundedString(
      user.displayName,
      `${path}.displayName`,
      MAX_DISPLAY_NAME_LENGTH,
      "malformed_snapshot",
    );
    const output: ActiveHostDirectoryUserSummary = {
      kind: "active",
      userId,
      displayName,
      avatar: parseAvatar(user.avatar, `${path}.avatar`),
    };
    if (user.status !== undefined) {
      return { ...output, status: parseStatus(user.status, `${path}.status`) };
    }
    return output;
  }

  if (user.kind === "redacted") {
    assertAllowedKeys(user, ["kind", "userId"], path, "malformed_snapshot");
    return { kind: "redacted", userId };
  }

  if (user.kind === "unavailable") {
    assertAllowedKeys(user, ["kind", "userId", "reason"], path, "malformed_snapshot");
    if (user.reason !== "missing" && user.reason !== "temporarily_unavailable") {
      throw directoryError(
        "malformed_snapshot",
        `${path}.reason must be missing or temporarily_unavailable`,
      );
    }
    return { kind: "unavailable", userId, reason: user.reason };
  }

  throw directoryError("malformed_snapshot", `${path}.kind is unsupported`);
}

function parseAvatar(value: unknown, path: string): HostDirectoryAvatar {
  const avatar = requireRecord(value, path, "malformed_snapshot");
  if (avatar.kind === "none") {
    assertAllowedKeys(avatar, ["kind"], path, "malformed_snapshot");
    return { kind: "none" };
  }
  if (avatar.kind === "initials") {
    assertAllowedKeys(avatar, ["kind", "initials"], path, "malformed_snapshot");
    return {
      kind: "initials",
      initials: readBoundedString(
        avatar.initials,
        `${path}.initials`,
        MAX_AVATAR_INITIALS_LENGTH,
        "malformed_snapshot",
      ),
    };
  }
  if (avatar.kind === "image") {
    assertAllowedKeys(avatar, ["kind", "url", "altText"], path, "malformed_snapshot");
    const url = readSafeAvatarUrl(avatar.url, `${path}.url`);
    if (avatar.altText === undefined) {
      return { kind: "image", url };
    }
    return {
      kind: "image",
      url,
      altText: readBoundedString(
        avatar.altText,
        `${path}.altText`,
        MAX_AVATAR_ALT_TEXT_LENGTH,
        "malformed_snapshot",
        true,
      ),
    };
  }
  throw directoryError("malformed_snapshot", `${path}.kind is unsupported`);
}

function parseStatus(value: unknown, path: string): HostDirectoryUserStatus {
  const status = requireRecord(value, path, "malformed_snapshot");
  assertAllowedKeys(
    status,
    ["availability", "text", "emoji", "expiresAt"],
    path,
    "malformed_snapshot",
  );
  if (Object.keys(status).length === 0) {
    throw directoryError("malformed_snapshot", `${path} must contain a status field`);
  }
  const output: {
    availability?: HostDirectoryAvailability;
    text?: string;
    emoji?: string;
    expiresAt?: IsoTimestamp;
  } = {};
  if (status.availability !== undefined) {
    if (!isAvailability(status.availability)) {
      throw directoryError("malformed_snapshot", `${path}.availability is unsupported`);
    }
    output.availability = status.availability;
  }
  if (status.text !== undefined) {
    output.text = readBoundedString(
      status.text,
      `${path}.text`,
      MAX_STATUS_TEXT_LENGTH,
      "malformed_snapshot",
    );
  }
  if (status.emoji !== undefined) {
    output.emoji = readBoundedString(
      status.emoji,
      `${path}.emoji`,
      MAX_STATUS_EMOJI_LENGTH,
      "malformed_snapshot",
    );
  }
  if (status.expiresAt !== undefined) {
    output.expiresAt = readIsoTimestamp(status.expiresAt, `${path}.expiresAt`);
  }
  return output;
}

function parseMetadata<Feature extends string>(
  value: unknown,
): HostDirectorySnapshotMetadata<Feature> {
  const metadata = requireRecord(value, "_meta", "malformed_snapshot");
  assertAllowedKeys(
    metadata,
    ["packageVersion", "protocolVersion", "schemaVersion", "enabledFeatures", "supportedProtocolRange", "feature"],
    "_meta",
    "malformed_snapshot",
  );
  const packageVersion = readBoundedString(
    metadata.packageVersion,
    "_meta.packageVersion",
    128,
    "malformed_snapshot",
  );
  const protocolVersion = readSafeInteger(metadata.protocolVersion, "_meta.protocolVersion", 1);
  const schemaVersion = readSafeInteger(metadata.schemaVersion, "_meta.schemaVersion", 0);

  const enabledFeatures = requireRecord(
    metadata.enabledFeatures,
    "_meta.enabledFeatures",
    "malformed_snapshot",
  );
  for (const [featureName, enabled] of Object.entries(enabledFeatures)) {
    if (featureName.length === 0 || typeof enabled !== "boolean") {
      throw directoryError(
        "malformed_snapshot",
        "_meta.enabledFeatures must contain boolean feature flags",
      );
    }
  }

  const range = requireRecord(
    metadata.supportedProtocolRange,
    "_meta.supportedProtocolRange",
    "malformed_snapshot",
  );
  assertAllowedKeys(range, ["minimumVersion", "maximumVersion"], "_meta.supportedProtocolRange", "malformed_snapshot");
  const minimumVersion = readSafeInteger(range.minimumVersion, "_meta.supportedProtocolRange.minimumVersion", 1);
  const maximumVersion = readSafeInteger(range.maximumVersion, "_meta.supportedProtocolRange.maximumVersion", 1);
  if (
    minimumVersion > maximumVersion ||
    protocolVersion < minimumVersion ||
    protocolVersion > maximumVersion
  ) {
    throw directoryError(
      "malformed_snapshot",
      "_meta.supportedProtocolRange must include protocolVersion",
    );
  }

  const feature = requireRecord(metadata.feature, "_meta.feature", "malformed_snapshot");
  assertAllowedKeys(feature, ["name", "version"], "_meta.feature", "malformed_snapshot");
  if (
    feature.name !== HOST_DIRECTORY_SNAPSHOT_FEATURE ||
    feature.version !== HOST_DIRECTORY_SNAPSHOT_VERSION
  ) {
    throw directoryError("malformed_snapshot", "directory snapshot feature metadata is unsupported");
  }

  return {
    packageVersion,
    protocolVersion,
    schemaVersion,
    enabledFeatures: enabledFeatures as Readonly<Record<Feature, boolean>>,
    supportedProtocolRange: { minimumVersion, maximumVersion },
    feature: {
      name: HOST_DIRECTORY_SNAPSHOT_FEATURE,
      version: HOST_DIRECTORY_SNAPSHOT_VERSION,
    },
  };
}

function parseUniqueUserIds(value: readonly unknown[], path: string): UserId[] {
  const userIds = value.map((entry, index) =>
    readUserId(entry, `${path}[${index}]`, "malformed_input"),
  );
  const seen = new Set<string>();
  for (const userId of userIds) {
    if (seen.has(userId)) {
      throw directoryError("duplicate_user_id", `${path} must contain unique user IDs`);
    }
    seen.add(userId);
  }
  return userIds;
}

function assertUniqueSummaryIds(users: readonly HostDirectoryUserSummary[]): void {
  const seen = new Set<UserId>();
  for (const user of users) {
    if (seen.has(user.userId)) {
      throw directoryError("duplicate_user_id", "snapshot users must have unique user IDs");
    }
    seen.add(user.userId);
  }
}

function rejectForbiddenFields(value: unknown, path = "input"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectForbiddenFields(entry, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_DIRECTORY_FIELDS.has(normalizeFieldName(key))) {
      throw directoryError(
        "forbidden_field",
        `${path}.${key} is trusted or sensitive and is not part of the directory HTTP contract`,
      );
    }
    rejectForbiddenFields(nested, `${path}.${key}`);
  }
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  code: "malformed_input" | "malformed_snapshot",
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw directoryError(code, `${path}.${key} is not supported`);
    }
  }
}

function validateQuery(
  value: unknown,
  code: "malformed_input" | "malformed_cursor",
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw directoryError(code, "query must be a non-empty string");
  }
  if (value.length > MAX_HOST_DIRECTORY_QUERY_LENGTH) {
    throw directoryError(
      code === "malformed_cursor" ? "malformed_cursor" : "query_limit_exceeded",
      `query cannot exceed ${MAX_HOST_DIRECTORY_QUERY_LENGTH} characters`,
    );
  }
}

function readUserId(
  value: unknown,
  path: string,
  code: "malformed_input" | "malformed_snapshot",
): UserId {
  return readBoundedString(value, path, MAX_USER_ID_LENGTH, code) as UserId;
}

function validateBoundedString(
  value: unknown,
  path: string,
  maximum: number,
  code: HostDirectorySnapshotParseErrorCode,
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw directoryError(code, `${path} must be a non-empty string`);
  }
  if (value.length > maximum) {
    throw directoryError(code, `${path} cannot exceed ${maximum} characters`);
  }
}

function readBoundedString(
  value: unknown,
  path: string,
  maximum: number,
  code: "malformed_input" | "malformed_snapshot",
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.trim().length === 0) ||
    value.length > maximum
  ) {
    throw directoryError(
      code,
      `${path} must be ${allowEmpty ? "a" : "a non-empty"} string of at most ${maximum} characters`,
    );
  }
  return value;
}

function readSafeAvatarUrl(value: unknown, path: string): string {
  const url = readBoundedString(
    value,
    path,
    MAX_AVATAR_URL_LENGTH,
    "malformed_snapshot",
  );
  const rootRelative = url.startsWith("/") && !url.startsWith("//") && !url.includes("\\");
  let secureAbsolute = false;
  try {
    const parsed = new URL(url);
    secureAbsolute = parsed.protocol === "https:" && parsed.username === "" && parsed.password === "";
  } catch {
    // Root-relative URLs are intentionally handled without a base URL.
  }
  if (!rootRelative && !secureAbsolute) {
    throw directoryError(
      "malformed_snapshot",
      `${path} must be an HTTPS URL or same-origin root-relative path`,
    );
  }
  return url;
}

function readIsoTimestamp(value: unknown, path: string): IsoTimestamp {
  if (
    typeof value !== "string" ||
    !ISO_TIMESTAMP_PATTERN.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw directoryError("malformed_snapshot", `${path} must be an ISO-8601 timestamp`);
  }
  return value;
}

function readSafeInteger(value: unknown, path: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw directoryError(
      "malformed_snapshot",
      `${path} must be a safe integer greater than or equal to ${minimum}`,
    );
  }
  return value as number;
}

function isAvailability(value: unknown): value is HostDirectoryAvailability {
  return value === "online" || value === "away" || value === "busy" || value === "offline";
}

function normalizeFieldName(value: string): string {
  return value.replace(/[_-]/g, "").toLowerCase();
}

function requireRecord(
  value: unknown,
  path: string,
  code: "malformed_input" | "malformed_snapshot",
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw directoryError(code, `${path} must be an object`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function directoryError(
  code: HostDirectorySnapshotParseErrorCode,
  message: string,
): HostDirectorySnapshotParseError {
  return new HostDirectorySnapshotParseError(code, message);
}
