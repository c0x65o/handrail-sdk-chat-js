import {
  parseCanonicalThreadFollowState,
  type CanonicalThreadFollowState,
} from "./thread-follow-mutation.js";
import { validateConversationThreadLifecycle, validateThreadConversationName } from "./conversation.js";
import type {
  ChannelConversation,
  Conversation,
  DirectConversation,
  GroupDirectConversation,
  HostEntityReference,
  ThreadConversation,
} from "./conversation.js";
import type {
  ConversationId,
  IsoTimestamp,
  MessageSequence,
  UserId,
} from "./identifiers.js";
import type {
  ConversationMember,
  ConversationMemberPreference,
  ConversationReadState,
} from "./member-read-state.js";
import {
  createServerHandshakeMetadata,
  type ServerHandshakeMetadata,
  type ServerHandshakeMetadataInput,
} from "./realtime.js";

export const CONVERSATION_SNAPSHOT_FEATURE = "conversation_snapshots" as const;
export const CONVERSATION_SNAPSHOT_VERSION = 1 as const;
export const CONVERSATION_SNAPSHOT_CURSOR_VERSION = 3 as const;
export const STARRED_FIRST_LEGACY_CONVERSATION_SNAPSHOT_CURSOR_VERSION = 2 as const;
export const LEGACY_CONVERSATION_SNAPSHOT_CURSOR_VERSION = 1 as const;
/** Stable top-level navigation order; threads are not list-query entries. */
export const CONVERSATION_NAVIGATION_RANK = {
  direct: 0,
  publicChannel: 1,
  privateChannel: 2,
  groupDirect: 3,
} as const;
export type ConversationNavigationRank =
  (typeof CONVERSATION_NAVIGATION_RANK)[keyof typeof CONVERSATION_NAVIGATION_RANK];
/** Maximum active membership identities projected into one list summary. */
export const MAX_CONVERSATION_LIST_ACTIVE_MEMBER_USER_IDS = 100 as const;

const CURSOR_PREFIX = "handrail-conversations.v";
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const TRUSTED_IDENTITY_FIELDS = new Set([
  "tenant",
  "tenantId",
  "organizationId",
  "actor",
  "actorId",
  "actorContext",
  "user",
  "userId",
  "currentUserId",
  "principal",
  "principalId",
  "subject",
  "subjectId",
  "authenticatedUser",
  "authenticatedUserId",
  "identity",
  "session",
  "auth",
  "role",
  "roles",
]);

/** Prevents trusted session identity from becoming part of a client input type. */
export interface NoTrustedSnapshotIdentity {
  readonly tenant?: never;
  readonly tenantId?: never;
  readonly organizationId?: never;
  readonly actor?: never;
  readonly actorId?: never;
  readonly actorContext?: never;
  readonly user?: never;
  readonly userId?: never;
  readonly currentUserId?: never;
  readonly principal?: never;
  readonly principalId?: never;
  readonly subject?: never;
  readonly subjectId?: never;
  readonly authenticatedUser?: never;
  readonly authenticatedUserId?: never;
  readonly identity?: never;
  readonly session?: never;
  readonly auth?: never;
  readonly role?: never;
  readonly roles?: never;
}

/** Lists conversations available to the trusted actor across the organization. */
export type OrganizationConversationSnapshotScope =
  NoTrustedSnapshotIdentity & {
    readonly type: "organization";
    readonly entity?: never;
  };

/**
 * Lists conversations associated with an opaque host entity. The host server
 * must authorize the trusted actor against this untrusted reference.
 */
export type EntityConversationSnapshotScope = NoTrustedSnapshotIdentity & {
  readonly type: "entity";
  readonly entity: HostEntityReference & NoTrustedSnapshotIdentity;
};

export type ConversationSnapshotScope =
  | OrganizationConversationSnapshotScope
  | EntityConversationSnapshotScope;

declare const conversationSnapshotCursorBrand: unique symbol;

/** An opaque continuation token. Callers must not construct or inspect it. */
export type ConversationSnapshotCursor = string & {
  readonly [conversationSnapshotCursorBrand]: "conversation-snapshot-cursor";
};

/** Current starred/navigation keyset with stable activity and ID tie-breakers. */
export interface ConversationSnapshotCursorPosition {
  readonly isStarred: boolean;
  readonly navigationRank: ConversationNavigationRank;
  readonly activityAt: IsoTimestamp;
  readonly conversationId: ConversationId;
}

/** Starred-first position retained for in-flight v2 pagination chains. */
export interface StarredFirstLegacyConversationSnapshotCursorPosition {
  readonly isStarred: boolean;
  readonly activityAt: IsoTimestamp;
  readonly conversationId: ConversationId;
}

/** Activity-only position retained for in-flight v1 pagination chains. */
export interface LegacyConversationSnapshotCursorPosition {
  readonly activityAt: IsoTimestamp;
  readonly conversationId: ConversationId;
}

export type DecodedConversationSnapshotCursorPosition =
  | ConversationSnapshotCursorPosition
  | StarredFirstLegacyConversationSnapshotCursorPosition
  | LegacyConversationSnapshotCursorPosition;

export type ConversationListSnapshotInput = NoTrustedSnapshotIdentity & {
  readonly scope: ConversationSnapshotScope;
  readonly cursor?: ConversationSnapshotCursor;
  readonly limit?: number;
};

export type ConversationDetailSnapshotInput = NoTrustedSnapshotIdentity & {
  readonly conversationId: ConversationId;
};

interface ConversationSnapshotCurrentState {
  /** Latest sequence known when the snapshot was produced. */
  readonly latestSequence: MessageSequence;
  /** Timestamp used as the primary list pagination key. */
  readonly activityAt: IsoTimestamp;
  /** Non-deleted unread messages that canonically mention the current actor. */
  readonly unreadMentionCount: number;
  /** Membership for the server-derived current actor. */
  readonly currentMember: ConversationMember;
  /** Read state for the server-derived current actor. */
  readonly currentReadState: ConversationReadState;
  /** Starred, notification, and mute preference for the server-derived current actor. */
  readonly currentPreference: ConversationMemberPreference;
  /**
   * Deterministically ordered active membership identities for renderer use.
   * Empty when the actor can only discover a public channel.
   */
  readonly activeMemberUserIds: readonly UserId[];
}

type SnapshotSummary<Kind extends Conversation> =
  Kind extends Conversation
    ? Kind & ConversationSnapshotCurrentState
    : never;

/** A discriminated conversation plus the state needed to seed client caches. */
export type ConversationSnapshotSummary = SnapshotSummary<Conversation>;

/** List-only navigation state that is intentionally absent from detail snapshots. */
export type ConversationListSnapshotSummary = ConversationSnapshotSummary & {
  /** Whether the conversation currently has a starting or active huddle. */
  readonly hasActiveHuddle: boolean;
};

export type ChannelConversationSnapshotSummary = SnapshotSummary<ChannelConversation>;
export type DirectConversationSnapshotSummary = SnapshotSummary<DirectConversation>;
export type GroupDirectConversationSnapshotSummary =
  SnapshotSummary<GroupDirectConversation>;
export type ThreadConversationSnapshotSummary = SnapshotSummary<ThreadConversation>;

/** State available only when hydrating one conversation in detail. */
export type ConversationDetailSnapshotConversation =
  ConversationSnapshotSummary & {
    /** Active membership identities, kept opaque to the host directory. */
    readonly memberUserIds: readonly UserId[];
    /** Latest authoritative complete-member-list revision, when supported. */
    readonly memberListRevision?: number;
    /** Actor-private authority; null at revision zero means no stored follow. */
    readonly currentThreadFollow?: {
      readonly followRevision: number;
      readonly follow: CanonicalThreadFollowState | null;
    };
  };

export interface ConversationSnapshotFeatureMetadata {
  readonly name: typeof CONVERSATION_SNAPSHOT_FEATURE;
  readonly version: typeof CONVERSATION_SNAPSHOT_VERSION;
}

/** Snapshot compatibility metadata aligned with realtime handshake metadata. */
export interface ConversationSnapshotMetadata<Feature extends string = string>
  extends ServerHandshakeMetadata<Feature> {
  readonly feature: ConversationSnapshotFeatureMetadata;
}

export interface ConversationListSnapshot<Feature extends string = string> {
  readonly kind: "conversation_list";
  readonly scope: ConversationSnapshotScope;
  readonly items: readonly ConversationListSnapshotSummary[];
  readonly page: {
    readonly nextCursor?: ConversationSnapshotCursor;
  };
  readonly _meta: ConversationSnapshotMetadata<Feature>;
}

export interface ConversationDetailSnapshot<Feature extends string = string> {
  readonly kind: "conversation_detail";
  readonly conversation: ConversationDetailSnapshotConversation;
  readonly _meta: ConversationSnapshotMetadata<Feature>;
}

export type ConversationSnapshotParseErrorCode =
  | "malformed_input"
  | "trusted_identity_field"
  | "malformed_cursor"
  | "unsupported_cursor"
  | "malformed_snapshot";

export class ConversationSnapshotParseError extends Error {
  readonly code: ConversationSnapshotParseErrorCode;

  constructor(code: ConversationSnapshotParseErrorCode, message: string) {
    super(message);
    this.name = "ConversationSnapshotParseError";
    this.code = code;
  }
}

export function createConversationSnapshotMetadata<Feature extends string = string>(
  input: ServerHandshakeMetadataInput<Feature>,
): ConversationSnapshotMetadata<Feature> {
  return {
    ...createServerHandshakeMetadata(input),
    feature: {
      name: CONVERSATION_SNAPSHOT_FEATURE,
      version: CONVERSATION_SNAPSHOT_VERSION,
    },
  };
}

/** Encodes a versioned keyset position without relying on Node APIs. */
export function encodeConversationSnapshotCursor(
  position: ConversationSnapshotCursorPosition,
): ConversationSnapshotCursor {
  if (typeof position.isStarred !== "boolean") {
    throw cursorError("malformed_cursor", "cursor isStarred is invalid");
  }
  assertNavigationRank(position.navigationRank);
  assertIsoTimestamp(position.activityAt, "activityAt");
  assertNonEmptyString(position.conversationId, "conversationId");

  const payload = encodeURIComponent(
    JSON.stringify([
      position.isStarred,
      position.navigationRank,
      position.activityAt,
      position.conversationId,
    ]),
  );
  return `${CURSOR_PREFIX}${CONVERSATION_SNAPSHOT_CURSOR_VERSION}.${payload}` as ConversationSnapshotCursor;
}

/** Keeps a legacy starred-first v2 chain on its original ordering. */
export function encodeStarredFirstLegacyConversationSnapshotCursor(
  position: StarredFirstLegacyConversationSnapshotCursorPosition,
): ConversationSnapshotCursor {
  if (typeof position.isStarred !== "boolean") {
    throw cursorError("malformed_cursor", "cursor isStarred is invalid");
  }
  assertIsoTimestamp(position.activityAt, "activityAt");
  assertNonEmptyString(position.conversationId, "conversationId");

  const payload = encodeURIComponent(
    JSON.stringify([
      position.isStarred,
      position.activityAt,
      position.conversationId,
    ]),
  );
  return `${CURSOR_PREFIX}${STARRED_FIRST_LEGACY_CONVERSATION_SNAPSHOT_CURSOR_VERSION}.${payload}` as ConversationSnapshotCursor;
}

/** Keeps a legacy activity-only pagination chain on its original ordering. */
export function encodeLegacyConversationSnapshotCursor(
  position: LegacyConversationSnapshotCursorPosition,
): ConversationSnapshotCursor {
  assertIsoTimestamp(position.activityAt, "activityAt");
  assertNonEmptyString(position.conversationId, "conversationId");

  const payload = encodeURIComponent(
    JSON.stringify([position.activityAt, position.conversationId]),
  );
  return `${CURSOR_PREFIX}${LEGACY_CONVERSATION_SNAPSHOT_CURSOR_VERSION}.${payload}` as ConversationSnapshotCursor;
}

/** Decodes and validates a versioned opaque cursor deterministically. */
export function decodeConversationSnapshotCursor(
  cursor: string,
): DecodedConversationSnapshotCursorPosition {
  if (typeof cursor !== "string" || cursor.length === 0) {
    throw cursorError("malformed_cursor", "cursor must be a non-empty string");
  }

  const match = /^handrail-conversations\.v(\d+)\.(.+)$/.exec(cursor);
  if (match === null) {
    throw cursorError("malformed_cursor", "cursor has an invalid envelope");
  }

  const version = Number(match[1]);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw cursorError("malformed_cursor", "cursor version is invalid");
  }
  if (
    version !== CONVERSATION_SNAPSHOT_CURSOR_VERSION &&
    version !== STARRED_FIRST_LEGACY_CONVERSATION_SNAPSHOT_CURSOR_VERSION &&
    version !== LEGACY_CONVERSATION_SNAPSHOT_CURSOR_VERSION
  ) {
    throw cursorError("unsupported_cursor", `cursor version ${version} is unsupported`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(decodeURIComponent(match[2] as string));
  } catch {
    throw cursorError("malformed_cursor", "cursor payload is malformed");
  }

  if (!Array.isArray(payload)) {
    throw cursorError("malformed_cursor", "cursor payload has an invalid structure");
  }

  if (version === LEGACY_CONVERSATION_SNAPSHOT_CURSOR_VERSION) {
    if (payload.length !== 2) {
      throw cursorError("malformed_cursor", "cursor payload has an invalid structure");
    }
    const [activityAt, conversationId] = payload;
    return validateDecodedCursorPosition(activityAt, conversationId);
  }

  if (version === STARRED_FIRST_LEGACY_CONVERSATION_SNAPSHOT_CURSOR_VERSION) {
    if (payload.length !== 3 || typeof payload[0] !== "boolean") {
      throw cursorError("malformed_cursor", "cursor payload has an invalid structure");
    }
    const [isStarred, activityAt, conversationId] = payload;
    return {
      isStarred,
      ...validateDecodedCursorPosition(activityAt, conversationId),
    };
  }

  if (payload.length !== 4 || typeof payload[0] !== "boolean") {
    throw cursorError("malformed_cursor", "cursor payload has an invalid structure");
  }
  const [isStarred, navigationRank, activityAt, conversationId] = payload;
  assertNavigationRank(navigationRank);
  return {
    isStarred,
    navigationRank,
    ...validateDecodedCursorPosition(activityAt, conversationId),
  };
}

const assertNavigationRank: (
  navigationRank: unknown,
) => asserts navigationRank is ConversationNavigationRank = (navigationRank) => {
  if (
    !Number.isInteger(navigationRank) ||
    (navigationRank as number) < CONVERSATION_NAVIGATION_RANK.direct ||
    (navigationRank as number) > CONVERSATION_NAVIGATION_RANK.groupDirect
  ) {
    throw cursorError("malformed_cursor", "cursor navigationRank is invalid");
  }
};

const validateDecodedCursorPosition = (
  activityAt: unknown,
  conversationId: unknown,
): LegacyConversationSnapshotCursorPosition => {
  if (typeof activityAt !== "string" || !isIsoTimestamp(activityAt)) {
    throw cursorError("malformed_cursor", "cursor activityAt is invalid");
  }
  if (typeof conversationId !== "string" || conversationId.trim().length === 0) {
    throw cursorError("malformed_cursor", "cursor conversationId is invalid");
  }

  return {
    activityAt,
    conversationId: conversationId as ConversationId,
  };
};

/** Parses only client-controlled list fields; tenant and actor stay server-derived. */
export function parseConversationListSnapshotInput(
  value: unknown,
): ConversationListSnapshotInput {
  rejectTrustedIdentityFields(value);
  const input = requireRecord(value, "input", "malformed_input");
  assertAllowedKeys(input, ["scope", "cursor", "limit"], "input", "malformed_input");

  const scope = parseConversationSnapshotScope(input.scope);
  const output: {
    scope: ConversationSnapshotScope;
    cursor?: ConversationSnapshotCursor;
    limit?: number;
  } = { scope };

  if (input.cursor !== undefined) {
    if (typeof input.cursor !== "string") {
      throw inputError("cursor must be a string");
    }
    decodeConversationSnapshotCursor(input.cursor);
    output.cursor = input.cursor as ConversationSnapshotCursor;
  }

  if (input.limit !== undefined) {
    if (!Number.isSafeInteger(input.limit) || (input.limit as number) < 1 || (input.limit as number) > 100) {
      throw inputError("limit must be a safe integer between 1 and 100");
    }
    output.limit = input.limit as number;
  }

  return output;
}

/** Parses only a conversation ID; trusted actor context is intentionally absent. */
export function parseConversationDetailSnapshotInput(
  value: unknown,
): ConversationDetailSnapshotInput {
  rejectTrustedIdentityFields(value);
  const input = requireRecord(value, "input", "malformed_input");
  assertAllowedKeys(input, ["conversationId"], "input", "malformed_input");
  const conversationId = readNonEmptyString(input, "conversationId", "malformed_input");
  return { conversationId: conversationId as ConversationId };
}

export function parseConversationSnapshotScope(
  value: unknown,
): ConversationSnapshotScope {
  rejectTrustedIdentityFields(value);
  const scope = requireRecord(value, "scope", "malformed_input");

  if (scope.type === "organization") {
    assertAllowedKeys(scope, ["type"], "organization scope", "malformed_input");
    return { type: "organization" };
  }

  if (scope.type === "entity") {
    assertAllowedKeys(scope, ["type", "entity"], "entity scope", "malformed_input");
    const entity = requireRecord(scope.entity, "entity", "malformed_input");
    assertAllowedKeys(entity, ["type", "id"], "entity", "malformed_input");
    return {
      type: "entity",
      entity: {
        type: readNonEmptyString(entity, "type", "malformed_input"),
        id: readNonEmptyString(entity, "id", "malformed_input"),
      },
    };
  }

  throw inputError("scope.type must be organization or entity");
}

/** Parses a JSON-decoded conversation-list snapshot from the server. */
export function parseConversationListSnapshot<Feature extends string = string>(
  value: unknown,
): ConversationListSnapshot<Feature> {
  const snapshot = requireRecord(value, "snapshot", "malformed_snapshot");
  assertAllowedKeys(snapshot, ["kind", "scope", "items", "page", "_meta"], "snapshot", "malformed_snapshot");
  if (snapshot.kind !== "conversation_list") {
    throw snapshotError("kind must be conversation_list");
  }

  const scope = parseSnapshotScope(snapshot.scope);
  if (!Array.isArray(snapshot.items)) {
    throw snapshotError("items must be an array");
  }
  for (const item of snapshot.items) {
    validateConversationListSummary(item);
  }

  const page = requireRecord(snapshot.page, "page", "malformed_snapshot");
  assertAllowedKeys(page, ["nextCursor"], "page", "malformed_snapshot");
  if (page.nextCursor !== undefined) {
    if (typeof page.nextCursor !== "string") {
      throw snapshotError("page.nextCursor must be a string");
    }
    decodeConversationSnapshotCursor(page.nextCursor);
  }

  validateMetadata(snapshot._meta);
  return value as ConversationListSnapshot<Feature>;
}

function validateConversationListSummary(value: unknown): void {
  validateConversationSummary(value);
  const summary = requireRecord(
    value,
    "conversation list summary",
    "malformed_snapshot",
  );
  if (typeof summary.hasActiveHuddle !== "boolean") {
    throw snapshotError("hasActiveHuddle must be a boolean");
  }
}

/** Parses a JSON-decoded one-conversation snapshot from the server. */
export function parseConversationDetailSnapshot<Feature extends string = string>(
  value: unknown,
): ConversationDetailSnapshot<Feature> {
  const snapshot = requireRecord(value, "snapshot", "malformed_snapshot");
  assertAllowedKeys(snapshot, ["kind", "conversation", "_meta"], "snapshot", "malformed_snapshot");
  if (snapshot.kind !== "conversation_detail") {
    throw snapshotError("kind must be conversation_detail");
  }

  validateConversationDetail(snapshot.conversation);
  validateMetadata(snapshot._meta);
  return value as ConversationDetailSnapshot<Feature>;
}

function validateConversationDetail(value: unknown): void {
  validateConversationSummary(value);
  const conversation = requireRecord(
    value,
    "conversation detail",
    "malformed_snapshot",
  );
  validateUserIdArray(conversation.memberUserIds, "memberUserIds");
  if (conversation.currentThreadFollow !== undefined) {
    if (conversation.type !== "thread") throw snapshotError("follow authority requires a thread");
    const authority = requireRecord(
      conversation.currentThreadFollow, "currentThreadFollow", "malformed_snapshot",
    );
    assertAllowedKeys(
      authority, ["followRevision", "follow"], "currentThreadFollow", "malformed_snapshot",
    );
    const revision = readNonNegativeSafeInteger(authority, "followRevision");
    if (authority.follow === null) {
      if (revision !== 0) throw snapshotError("missing follow requires revision zero");
    } else {
      const follow = parseCanonicalThreadFollowState(authority.follow);
      if (follow.target.id !== conversation.id || revision === 0) {
        throw snapshotError("follow authority must match the thread and have a stored revision");
      }
    }
  }
  if (conversation.memberListRevision !== undefined) {
    readPositiveSafeInteger(conversation, "memberListRevision");
  }

}

function parseSnapshotScope(value: unknown): ConversationSnapshotScope {
  try {
    return parseConversationSnapshotScope(value);
  } catch (error) {
    if (error instanceof ConversationSnapshotParseError) {
      throw snapshotError(`scope is invalid: ${error.message}`);
    }
    throw error;
  }
}

/** Reuses canonical summary validation for discovery and other snapshot envelopes. */
export function parseConversationSnapshotSummary(value: unknown): ConversationSnapshotSummary {
  validateConversationSummary(value);
  return value as ConversationSnapshotSummary;
}

function validateConversationSummary(value: unknown): void {
  const summary = requireRecord(value, "conversation summary", "malformed_snapshot");
  const id = readNonEmptyString(summary, "id", "malformed_snapshot");
  const tenantId = readNonEmptyString(summary, "tenantId", "malformed_snapshot");
  readIsoTimestamp(summary, "createdAt");
  readIsoTimestamp(summary, "updatedAt");
  readIsoTimestamp(summary, "activityAt");
  readNonNegativeSafeInteger(summary, "latestSequence");
  readNonNegativeSafeInteger(summary, "unreadMentionCount");
  validateUserIdArray(
    summary.activeMemberUserIds,
    "activeMemberUserIds",
    MAX_CONVERSATION_LIST_ACTIVE_MEMBER_USER_IDS,
  );

  if (summary.type === "channel") {
    readNonEmptyString(summary, "name", "malformed_snapshot");
    readVisibility(summary);
    if (summary.entity !== undefined) {
      validateEntity(summary.entity);
    }
    rejectPresent(summary, ["parentConversationId", "rootMessageId"], "channel");
  } else if (summary.type === "direct" || summary.type === "group_direct") {
    if (summary.visibility !== "private") {
      throw snapshotError(`${summary.type} visibility must be private`);
    }
    rejectPresent(summary, ["name", "entity", "parentConversationId", "rootMessageId"], summary.type);
  } else if (summary.type === "thread") {
    readVisibility(summary);
    readNonEmptyString(summary, "parentConversationId", "malformed_snapshot");
    readNonEmptyString(summary, "rootMessageId", "malformed_snapshot");
    if (Object.hasOwn(summary, "name")) {
      try {
        validateThreadConversationName(summary.name);
      } catch {
        throw snapshotError("thread name is invalid");
      }
    }
    rejectPresent(summary, ["entity"], "thread");
  } else {
    throw snapshotError("conversation type is unsupported");
  }

  try {
    validateConversationThreadLifecycle(summary as unknown as Conversation);
  } catch {
    throw snapshotError("thread lifecycle is invalid");
  }
  validateArchiveState(summary);
  const member = validateCurrentMember(summary.currentMember);
  const readState = validateCurrentReadState(summary.currentReadState);
  const preference = validateCurrentPreference(summary.currentPreference);
  if (
    member.conversationId !== id ||
    readState.conversationId !== id ||
    preference.conversationId !== id
  ) {
    throw snapshotError("current state conversationId must match the conversation");
  }
  if (member.tenantId !== tenantId) {
    throw snapshotError("current member tenantId must match the conversation");
  }
  if (member.userId !== readState.userId || member.userId !== preference.userId) {
    throw snapshotError("current member, read state, and preference must describe the same user");
  }
}

function validateUserIdArray(
  value: unknown,
  label: string,
  maximumLength?: number,
): void {
  if (!Array.isArray(value)) {
    throw snapshotError(`${label} must be an array`);
  }
  if (maximumLength !== undefined && value.length > maximumLength) {
    throw snapshotError(`${label} must contain at most ${maximumLength} user IDs`);
  }

  const userIds = value.map((userId) => {
    if (typeof userId !== "string" || userId.trim().length === 0) {
      throw snapshotError(`${label} must contain non-empty user IDs`);
    }
    return userId;
  });
  if (new Set(userIds).size !== userIds.length) {
    throw snapshotError(`${label} must not contain duplicates`);
  }
}

function validateCurrentMember(value: unknown): {
  conversationId: string;
  tenantId: string;
  userId: string;
} {
  const member = requireRecord(value, "currentMember", "malformed_snapshot");
  const role = member.role;
  const state = member.state;
  if (role !== "owner" && role !== "moderator" && role !== "member") {
    throw snapshotError("currentMember.role is invalid");
  }
  if (state !== "active" && state !== "left" && state !== "removed") {
    throw snapshotError("currentMember.state is invalid");
  }
  readIsoTimestamp(member, "joinedAt");
  readIsoTimestamp(member, "updatedAt");
  return {
    conversationId: readNonEmptyString(member, "conversationId", "malformed_snapshot"),
    tenantId: readNonEmptyString(member, "tenantId", "malformed_snapshot"),
    userId: readNonEmptyString(member, "userId", "malformed_snapshot"),
  };
}

function validateCurrentReadState(value: unknown): {
  conversationId: string;
  userId: string;
} {
  const readState = requireRecord(value, "currentReadState", "malformed_snapshot");
  readNonNegativeSafeInteger(readState, "lastReadSequence");
  if (readState.manualUnreadFromSequence !== undefined) {
    const marker = readPositiveSafeInteger(readState, "manualUnreadFromSequence");
    if (marker > (readState.lastReadSequence as number)) {
      throw snapshotError("manualUnreadFromSequence cannot exceed lastReadSequence");
    }
  }
  readIsoTimestamp(readState, "updatedAt");
  return {
    conversationId: readNonEmptyString(readState, "conversationId", "malformed_snapshot"),
    userId: readNonEmptyString(readState, "userId", "malformed_snapshot"),
  };
}

function validateCurrentPreference(value: unknown): {
  conversationId: string;
  userId: string;
} {
  const preference = requireRecord(
    value,
    "currentPreference",
    "malformed_snapshot",
  );
  if (
    preference.notificationPreference !== "all" &&
    preference.notificationPreference !== "mentions" &&
    preference.notificationPreference !== "none"
  ) {
    throw snapshotError("currentPreference.notificationPreference is invalid");
  }
  if (preference.preferenceRevision !== undefined) {
    readNonNegativeSafeInteger(preference, "preferenceRevision");
  }
  if (typeof preference.isStarred !== "boolean") {
    throw snapshotError("currentPreference.isStarred must be boolean");
  }

  const mute = requireRecord(
    preference.mute,
    "currentPreference.mute",
    "malformed_snapshot",
  );
  if (mute.muted === false) {
    if (mute.mutedUntil !== undefined) {
      throw snapshotError(
        "currentPreference.mute.mutedUntil requires an active mute",
      );
    }
  } else if (mute.muted === true) {
    if (mute.mutedUntil !== undefined) {
      readIsoTimestamp(mute, "mutedUntil");
    }
  } else {
    throw snapshotError("currentPreference.mute.muted must be boolean");
  }

  readIsoTimestamp(preference, "updatedAt");
  return {
    conversationId: readNonEmptyString(
      preference,
      "conversationId",
      "malformed_snapshot",
    ),
    userId: readNonEmptyString(preference, "userId", "malformed_snapshot"),
  };
}

function validateMetadata(value: unknown): void {
  const metadata = requireRecord(value, "_meta", "malformed_snapshot");
  readNonEmptyString(metadata, "packageVersion", "malformed_snapshot");
  readPositiveSafeInteger(metadata, "protocolVersion");
  readNonNegativeSafeInteger(metadata, "schemaVersion");

  const features = requireRecord(metadata.enabledFeatures, "enabledFeatures", "malformed_snapshot");
  for (const enabled of Object.values(features)) {
    if (typeof enabled !== "boolean") {
      throw snapshotError("enabledFeatures values must be boolean");
    }
  }

  const range = requireRecord(metadata.supportedProtocolRange, "supportedProtocolRange", "malformed_snapshot");
  const minimum = readPositiveSafeInteger(range, "minimumVersion");
  const maximum = readPositiveSafeInteger(range, "maximumVersion");
  if (minimum > maximum || (metadata.protocolVersion as number) < minimum || (metadata.protocolVersion as number) > maximum) {
    throw snapshotError("supportedProtocolRange must include protocolVersion");
  }

  const feature = requireRecord(metadata.feature, "feature", "malformed_snapshot");
  if (feature.name !== CONVERSATION_SNAPSHOT_FEATURE || feature.version !== CONVERSATION_SNAPSHOT_VERSION) {
    throw snapshotError("snapshot feature metadata is unsupported");
  }
}

function validateEntity(value: unknown): void {
  const entity = requireRecord(value, "entity", "malformed_snapshot");
  readNonEmptyString(entity, "type", "malformed_snapshot");
  readNonEmptyString(entity, "id", "malformed_snapshot");
}

function validateArchiveState(value: Record<string, unknown>): void {
  const hasArchivedAt = value.archivedAt !== undefined;
  const hasArchivedBy = value.archivedByUserId !== undefined;
  if (hasArchivedAt !== hasArchivedBy) {
    throw snapshotError("archivedAt and archivedByUserId must be provided together");
  }
  if (hasArchivedAt) {
    readIsoTimestamp(value, "archivedAt");
    readNonEmptyString(value, "archivedByUserId", "malformed_snapshot");
  }
}

function readVisibility(value: Record<string, unknown>): void {
  if (value.visibility !== "public" && value.visibility !== "private") {
    throw snapshotError("visibility must be public or private");
  }
}

function rejectPresent(
  value: Record<string, unknown>,
  fields: readonly string[],
  type: string,
): void {
  for (const field of fields) {
    if (value[field] !== undefined) {
      throw snapshotError(`${type} conversations cannot include ${field}`);
    }
  }
}

function rejectTrustedIdentityFields(value: unknown, path = "input"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectTrustedIdentityFields(entry, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (TRUSTED_IDENTITY_FIELDS.has(key)) {
      throw new ConversationSnapshotParseError(
        "trusted_identity_field",
        `${path}.${key} is server-derived and cannot be supplied by a client`,
      );
    }
    rejectTrustedIdentityFields(nested, `${path}.${key}`);
  }
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  code: "malformed_input" | "malformed_snapshot",
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw new ConversationSnapshotParseError(code, `${label}.${key} is not supported`);
    }
  }
}

function requireRecord(
  value: unknown,
  label: string,
  code: "malformed_input" | "malformed_snapshot",
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ConversationSnapshotParseError(code, `${label} must be an object`);
  }
  return value;
}

function readNonEmptyString(
  value: Record<string, unknown>,
  field: string,
  code: "malformed_input" | "malformed_snapshot",
): string {
  const fieldValue = value[field];
  if (typeof fieldValue !== "string" || fieldValue.trim().length === 0) {
    throw new ConversationSnapshotParseError(code, `${field} must be a non-empty string`);
  }
  return fieldValue;
}

function readPositiveSafeInteger(value: Record<string, unknown>, field: string): number {
  const fieldValue = value[field];
  if (!Number.isSafeInteger(fieldValue) || (fieldValue as number) < 1) {
    throw snapshotError(`${field} must be a positive safe integer`);
  }
  return fieldValue as number;
}

function readNonNegativeSafeInteger(value: Record<string, unknown>, field: string): number {
  const fieldValue = value[field];
  if (!Number.isSafeInteger(fieldValue) || (fieldValue as number) < 0) {
    throw snapshotError(`${field} must be a non-negative safe integer`);
  }
  return fieldValue as number;
}

function readIsoTimestamp(value: Record<string, unknown>, field: string): IsoTimestamp {
  const fieldValue = value[field];
  if (typeof fieldValue !== "string" || !isIsoTimestamp(fieldValue)) {
    throw snapshotError(`${field} must be an ISO-8601 timestamp`);
  }
  return fieldValue;
}

function assertIsoTimestamp(value: string, field: string): void {
  if (!isIsoTimestamp(value)) {
    throw new TypeError(`${field} must be an ISO-8601 timestamp`);
  }
}

function isIsoTimestamp(value: string): boolean {
  if (!ISO_TIMESTAMP_PATTERN.test(value) || !Number.isFinite(Date.parse(value))) {
    return false;
  }

  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const hour = Number(value.slice(11, 13));
  const minute = Number(value.slice(14, 16));
  const second = Number(value.slice(17, 19));
  const daysInMonth = [
    31,
    isLeapYear(year) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][month - 1];

  if (
    daysInMonth === undefined ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return false;
  }

  if (!value.endsWith("Z")) {
    const offsetHour = Number(value.slice(-5, -3));
    const offsetMinute = Number(value.slice(-2));
    if (offsetHour > 23 || offsetMinute > 59) {
      return false;
    }
  }

  return true;
}

function isLeapYear(year: number): boolean {
  return year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0);
}

function assertNonEmptyString(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inputError(message: string): ConversationSnapshotParseError {
  return new ConversationSnapshotParseError("malformed_input", message);
}

function snapshotError(message: string): ConversationSnapshotParseError {
  return new ConversationSnapshotParseError("malformed_snapshot", message);
}

function cursorError(
  code: "malformed_cursor" | "unsupported_cursor",
  message: string,
): ConversationSnapshotParseError {
  return new ConversationSnapshotParseError(code, message);
}
