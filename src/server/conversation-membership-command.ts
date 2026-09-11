import { createHash, randomUUID } from "node:crypto";

import {
  parseConversationMembershipMutationInput,
  parseConversationMembershipMutationResult,
  type CanonicalConversationMemberState,
  type ConversationMembershipMutationInput,
  type ConversationMembershipMutationResult,
  type ConversationMembershipReconciliationStatus,
  type ConversationMembershipSafetyError,
} from "../contracts/conversation-membership.js";
import type { ConversationMemberRole } from "../contracts/member-read-state.js";
import type { IsoTimestamp, UserId } from "../contracts/identifiers.js";
import { CHAT_PROTOCOL_VERSION } from "../contracts/realtime.js";
import type {
  ChatDirectoryAdapter,
  ChatPermissionAdapter,
  TrustedChatActorContext,
} from "./contracts.js";
import {
  DEFAULT_POSTGRES_SCHEMA,
  validatePostgresSchema,
  type PostgresMigrationConnection,
  type PostgresMigrationDatabase,
} from "./postgres-migrations.js";
import { ChatAuthorizationError } from "./request-context.js";
import { authorizeThreadAccess } from "./thread-access.js";

export const CONVERSATION_MEMBERSHIP_MANAGE_CAPABILITY =
  "chat.members.manage" as const;
export const CONVERSATION_MEMBERSHIP_ASSIGN_OWNER_CAPABILITY =
  "chat.members.assign_owner" as const;
export const CONVERSATION_MEMBERSHIP_ENTITY_POLICY_ACTION =
  "conversation.membership.mutate" as const;
export const CONVERSATION_MEMBERSHIP_IDEMPOTENCY_OPERATION =
  "conversation.membership.mutate" as const;
export const CONVERSATION_MEMBERSHIP_UPDATED_EVENT =
  "conversation.membership.updated" as const;
export const DEFAULT_CONVERSATION_MEMBERSHIP_IDEMPOTENCY_TTL_MS =
  24 * 60 * 60 * 1_000;
export const DEFAULT_CONVERSATION_MEMBERSHIP_OUTBOX_RETENTION_MS =
  7 * 24 * 60 * 60 * 1_000;

export type ConversationMembershipCommandErrorCode =
  | "idempotency_conflict"
  | "idempotency_in_progress"
  | "directory_user_unavailable"
  | "membership_invariant";

/** Stable command failure suitable for a future transport boundary. */
export class ConversationMembershipCommandError extends Error {
  public readonly statusCode: number;

  public constructor(
    public readonly code: ConversationMembershipCommandErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ConversationMembershipCommandError";
    this.statusCode = code.startsWith("idempotency_") ? 409 : 422;
  }
}

export interface ConversationMembershipCommandOptions {
  readonly database: PostgresMigrationDatabase;
  readonly directory: Pick<ChatDirectoryAdapter, "getUser">;
  readonly permissions: Pick<
    ChatPermissionAdapter<
      string,
      typeof CONVERSATION_MEMBERSHIP_ENTITY_POLICY_ACTION
    >,
    "getCapabilities" | "authorizeEntity"
  >;
  /** Trusted host-session identity; caller input cannot override these values. */
  readonly actor: TrustedChatActorContext;
  /** JSON-decoded caller input, validated by the shared membership contract. */
  readonly input: unknown;
  readonly schema?: string;
  readonly idempotencyTtlMs?: number;
  readonly outboxRetentionMs?: number;
  /** Trusted transport correlation id used only by the existing audit record. */
  readonly requestId?: string;
  /** Supplies opaque durable identifiers; defaults to cryptographic UUIDs. */
  readonly createId?: () => string;
}

interface ClaimedIdempotencyRow {
  readonly idempotency_state: string;
  readonly stored_response_body: unknown | null;
}

interface LockedConversationRow {
  readonly type: string;
  readonly parent_conversation_id: string | null;
  readonly visibility: string;
  readonly member_list_revision: string | number;
  readonly current_message_sequence: string | number;
  readonly archived_at: Date | string | null;
  readonly entity_type: string | null;
  readonly entity_id: string | null;
  readonly actor_role: string | null;
  readonly actor_state: string | null;
  readonly occurred_at: Date | string;
}

interface StoredMemberRow {
  readonly user_id: string;
  readonly role: string;
  readonly state: string;
  readonly joined_at: Date | string;
  readonly updated_at: Date | string;
}

type MembershipIntent = ConversationMembershipMutationInput["intent"];
type ConversationType = "channel" | "direct" | "group_direct" | "thread";

const quoteIdentifier = (identifier: string): string =>
  `"${identifier.replaceAll('"', '""')}"`;

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const positiveSafeInteger = (value: unknown, label: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value as number;
};

const validateActor = (actor: TrustedChatActorContext): void => {
  if (
    !nonEmptyString(actor.tenantId) ||
    !nonEmptyString(actor.userId) ||
    !Array.isArray(actor.roles) ||
    !actor.roles.every(nonEmptyString)
  ) {
    throw new TypeError("A valid trusted chat actor is required");
  }
};

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Conversation membership input must contain finite numbers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") {
    throw new TypeError("Conversation membership input must be JSON-compatible");
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
};

const hashRequest = (input: ConversationMembershipMutationInput): string =>
  `sha256:${createHash("sha256")
    .update(
      canonicalJson({
        operation: input.operation,
        intent: input.intent,
        conversationId: input.conversationId,
        expectedMemberListRevision: input.expectedMemberListRevision,
        ...(input.intent === "join" || input.intent === "leave"
          ? {}
          : { targetUserId: input.targetUserId }),
        ...(input.intent === "add_member" || input.intent === "change_member_role"
          ? { requestedRole: input.requestedRole }
          : {}),
      }),
    )
    .digest("hex")}`;

const toIsoTimestamp = (value: Date | string, label: string): IsoTimestamp => {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.valueOf())) {
    throw new Error(`PostgreSQL returned an invalid ${label}`);
  }
  return date.toISOString() as IsoTimestamp;
};

const toSafeInteger = (value: string | number, label: string): number => {
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error(`PostgreSQL returned an invalid ${label}`);
  }
  return result;
};

const conversationType = (value: string): ConversationType => {
  if (
    value !== "channel" &&
    value !== "direct" &&
    value !== "group_direct" &&
    value !== "thread"
  ) {
    throw new Error("PostgreSQL returned an invalid conversation type");
  }
  return value;
};

const role = (value: string): ConversationMemberRole => {
  if (value !== "owner" && value !== "moderator" && value !== "member") {
    throw new Error("PostgreSQL returned an invalid conversation member role");
  }
  return value;
};

const canonicalMembers = (
  rows: readonly StoredMemberRow[],
): readonly CanonicalConversationMemberState[] =>
  rows.map((row) => {
    if (row.state !== "active" && row.state !== "left" && row.state !== "removed") {
      throw new Error("PostgreSQL returned an invalid conversation member state");
    }
    return {
      userId: row.user_id as UserId,
      role: role(row.role),
      state: row.state,
      joinedAt: toIsoTimestamp(row.joined_at, "membership joined_at"),
      updatedAt: toIsoTimestamp(row.updated_at, "membership updated_at"),
    };
  });

const affectedUserId = (
  input: ConversationMembershipMutationInput,
  actor: TrustedChatActorContext,
): UserId =>
  (input.intent === "join" || input.intent === "leave"
    ? actor.userId
    : input.targetUserId) as UserId;

const intentFields = (input: ConversationMembershipMutationInput) =>
  input.intent === "join" || input.intent === "leave"
    ? {}
    : {
        targetUserId: input.targetUserId,
        ...(input.intent === "remove_member"
          ? {}
          : { requestedRole: input.requestedRole }),
      };

const buildResult = (
  input: ConversationMembershipMutationInput,
  memberUserId: UserId,
  memberListRevision: number,
  members: readonly CanonicalConversationMemberState[],
  reconciliationStatus: ConversationMembershipReconciliationStatus,
  safetyError?: ConversationMembershipSafetyError,
): ConversationMembershipMutationResult =>
  parseConversationMembershipMutationResult(
    {
      operation: input.operation,
      intent: input.intent,
      reconciliationStatus,
      conversationId: input.conversationId,
      expectedMemberListRevision: input.expectedMemberListRevision,
      memberListRevision,
      memberUserId,
      members,
      ...intentFields(input),
      ...(safetyError === undefined ? {} : { safetyError }),
    },
    input,
  );

const replayStoredResult = (
  stored: unknown,
  input: ConversationMembershipMutationInput,
): ConversationMembershipMutationResult => {
  const canonical = parseConversationMembershipMutationResult(stored, input);
  if (canonical.reconciliationStatus !== "applied") return canonical;
  return parseConversationMembershipMutationResult(
    { ...canonical, reconciliationStatus: "replayed" },
    input,
  );
};

const readCapabilities = async (
  actor: TrustedChatActorContext,
  permissions: ConversationMembershipCommandOptions["permissions"],
): Promise<readonly string[]> => {
  try {
    const capabilities = await permissions.getCapabilities({ actor });
    if (!Array.isArray(capabilities) || !capabilities.every(nonEmptyString)) {
      throw new Error("invalid capabilities");
    }
    return capabilities;
  } catch {
    throw new ChatAuthorizationError();
  }
};

const authorizeEntity = async (
  row: LockedConversationRow,
  actor: TrustedChatActorContext,
  permissions: ConversationMembershipCommandOptions["permissions"],
): Promise<void> => {
  if (row.entity_type === null && row.entity_id === null) return;
  if (row.entity_type === null || row.entity_id === null) {
    throw new ChatAuthorizationError();
  }
  try {
    const allowed = await permissions.authorizeEntity({
      actor,
      entity: { type: row.entity_type, id: row.entity_id },
      action: CONVERSATION_MEMBERSHIP_ENTITY_POLICY_ACTION,
    });
    if (!allowed) throw new Error("denied");
  } catch {
    throw new ChatAuthorizationError();
  }
};

const validateTargetDirectoryUser = async (
  input: ConversationMembershipMutationInput,
  actor: TrustedChatActorContext,
  directory: ConversationMembershipCommandOptions["directory"],
): Promise<void> => {
  if (input.intent === "join" || input.intent === "leave") return;
  try {
    const user = await directory.getUser({ actor, userId: input.targetUserId });
    if (
      user === null ||
      user.kind === "redacted" ||
      user.kind === "unavailable" ||
      user.tenantId !== actor.tenantId ||
      user.userId !== input.targetUserId
    ) {
      throw new Error("unavailable");
    }
  } catch {
    throw new ConversationMembershipCommandError(
      "directory_user_unavailable",
      "The requested conversation member is unavailable",
    );
  }
};

const requireIntentAuthorization = (
  input: ConversationMembershipMutationInput,
  row: LockedConversationRow,
  capabilities: readonly string[],
): void => {
  const actorActive = row.actor_state === "active";
  const actorRole = row.actor_role === null ? null : role(row.actor_role);

  if (input.intent === "join") {
    if (
      actorActive ||
      row.visibility !== "public" ||
      (row.type !== "channel" && row.type !== "thread")
    ) {
      if (!actorActive) throw new ChatAuthorizationError();
    }
    return;
  }
  if (input.intent === "leave") {
    if (!actorActive) throw new ChatAuthorizationError();
    return;
  }

  const canManage =
    (actorActive && (actorRole === "owner" || actorRole === "moderator")) ||
    capabilities.includes(CONVERSATION_MEMBERSHIP_MANAGE_CAPABILITY);
  if (!canManage) throw new ChatAuthorizationError();

  const assignsOwner =
    (input.intent === "add_member" || input.intent === "change_member_role") &&
    input.requestedRole === "owner";
  const targetIsOwner = false;
  if (
    assignsOwner &&
    actorRole !== "owner" &&
    !capabilities.includes(CONVERSATION_MEMBERSHIP_ASSIGN_OWNER_CAPABILITY)
  ) {
    throw new ChatAuthorizationError();
  }
  // Kept here so owner-target checks below share the same non-leaking failure.
  void targetIsOwner;
};

const requireTargetRoleAuthorization = (
  input: ConversationMembershipMutationInput,
  row: LockedConversationRow,
  target: CanonicalConversationMemberState | undefined,
  capabilities: readonly string[],
): void => {
  if (input.intent === "join" || input.intent === "leave") return;
  const actorIsOwner = row.actor_state === "active" && row.actor_role === "owner";
  const canManageOwner =
    actorIsOwner ||
    capabilities.includes(CONVERSATION_MEMBERSHIP_ASSIGN_OWNER_CAPABILITY);
  if (target?.state === "active" && target.role === "owner" && !canManageOwner) {
    throw new ChatAuthorizationError();
  }
};

const desiredAlreadyPresent = (
  input: ConversationMembershipMutationInput,
  target: CanonicalConversationMemberState | undefined,
): boolean => {
  if (target === undefined) return false;
  switch (input.intent) {
    case "join":
      return target.state === "active";
    case "leave":
      return target.state === "left";
    case "add_member":
      return target.state === "active" && target.role === input.requestedRole;
    case "remove_member":
      return target.state === "removed";
    case "change_member_role":
      return target.state === "active" && target.role === input.requestedRole;
  }
};

const safetyError = (
  input: ConversationMembershipMutationInput,
  target: CanonicalConversationMemberState | undefined,
  members: readonly CanonicalConversationMemberState[],
): ConversationMembershipSafetyError | undefined => {
  if (target?.state !== "active") return undefined;
  const active = members.filter((member) => member.state === "active");
  const activeOwners = active.filter((member) => member.role === "owner");
  const removesOwner =
    (input.intent === "leave" || input.intent === "remove_member") ||
    (input.intent === "change_member_role" && input.requestedRole !== "owner");
  if (
    removesOwner &&
    target.role === "owner" &&
    activeOwners.length === 1
  ) {
    return {
      code: "last_owner",
      message: "A conversation must retain at least one active owner.",
    };
  }
  if (
    (input.intent === "leave" || input.intent === "remove_member") &&
    active.length === 1
  ) {
    return {
      code: "last_active_member",
      message: "A conversation must retain at least one active member.",
    };
  }
  return undefined;
};

const requireConversationIdentityInvariant = (
  input: ConversationMembershipMutationInput,
  type: ConversationType,
  target: CanonicalConversationMemberState | undefined,
  members: readonly CanonicalConversationMemberState[],
): void => {
  if (
    input.intent === "add_member" &&
    target?.state === "active" &&
    target.role !== input.requestedRole
  ) {
    throw new ConversationMembershipCommandError(
      "membership_invariant",
      "An active member role must be changed with change_member_role",
    );
  }
  const changesActiveIdentity =
    input.intent === "join" ||
    input.intent === "leave" ||
    input.intent === "remove_member" ||
    (input.intent === "add_member" && target?.state !== "active");
  if (type === "direct" && changesActiveIdentity) {
    throw new ConversationMembershipCommandError(
      "membership_invariant",
      "Direct conversation participant identity is immutable",
    );
  }
  if (
    type === "group_direct" &&
    (input.intent === "leave" || input.intent === "remove_member") &&
    target?.state === "active" &&
    members.filter((member) => member.state === "active").length <= 3
  ) {
    throw new ConversationMembershipCommandError(
      "membership_invariant",
      "A group-direct conversation requires at least three active members",
    );
  }
};

const loadMembers = async (
  connection: PostgresMigrationConnection,
  prefix: string,
  actor: TrustedChatActorContext,
  conversationId: string,
): Promise<readonly CanonicalConversationMemberState[]> => {
  const result = await connection.query<StoredMemberRow>(
    `SELECT user_id, role, state, joined_at, updated_at
       FROM ${prefix}.chat_conversation_members
      WHERE tenant_id = $1 AND conversation_id = $2
      ORDER BY user_id`,
    [actor.tenantId, conversationId],
  );
  if (result.rows.length === 0) {
    throw new Error("A conversation membership list cannot be empty");
  }
  return canonicalMembers(result.rows);
};

const initializeActiveState = async (
  connection: PostgresMigrationConnection,
  prefix: string,
  actor: TrustedChatActorContext,
  input: ConversationMembershipMutationInput,
  memberUserId: UserId,
  occurredAt: IsoTimestamp,
): Promise<void> => {
  const requestedRole =
    input.intent === "add_member" ? input.requestedRole : "member";
  await connection.query(
    `INSERT INTO ${prefix}.chat_conversation_members (
       tenant_id, conversation_id, user_id, role, state, joined_at, updated_at
     ) VALUES ($1, $2, $3, $4, 'active', $5, $5)
     ON CONFLICT (tenant_id, conversation_id, user_id)
     DO UPDATE SET role = EXCLUDED.role, state = 'active',
                   joined_at = CASE
                     WHEN chat_conversation_members.state = 'active'
                       THEN chat_conversation_members.joined_at
                     ELSE EXCLUDED.joined_at
                   END,
                   updated_at = EXCLUDED.updated_at`,
    [
      actor.tenantId,
      input.conversationId,
      memberUserId,
      requestedRole,
      occurredAt,
    ],
  );
  await connection.query(
    `INSERT INTO ${prefix}.chat_read_cursors (
       tenant_id, conversation_id, user_id, last_read_sequence,
       manual_unread_from_sequence, updated_at
     ) VALUES ($1, $2, $3, 0, NULL, $4)
     ON CONFLICT (tenant_id, conversation_id, user_id)
     DO UPDATE SET last_read_sequence = 0, manual_unread_from_sequence = NULL,
                   updated_at = EXCLUDED.updated_at`,
    [actor.tenantId, input.conversationId, memberUserId, occurredAt],
  );
  await connection.query(
    `INSERT INTO ${prefix}.chat_conversation_preferences (
       tenant_id, conversation_id, user_id, notification_level, muted,
       muted_until, created_at, updated_at
     ) VALUES ($1, $2, $3, 'all', false, NULL, $4, $4)
     ON CONFLICT (tenant_id, conversation_id, user_id)
     DO UPDATE SET notification_level = 'all', muted = false,
                   muted_until = NULL, updated_at = EXCLUDED.updated_at`,
    [actor.tenantId, input.conversationId, memberUserId, occurredAt],
  );
  await connection.query(
    `INSERT INTO ${prefix}.chat_thread_follows (
       tenant_id, conversation_id, user_id, is_following,
       follow_source, created_at, updated_at
     ) SELECT $1, conversation.id, $3, false, 'manual', $4, $4
         FROM ${prefix}.chat_conversations AS conversation
        WHERE conversation.tenant_id = $1
          AND conversation.id = $2
          AND conversation.type = 'thread'
     ON CONFLICT (tenant_id, conversation_id, user_id)
     DO UPDATE SET is_following = false, follow_source = 'manual',
                   updated_at = EXCLUDED.updated_at`,
    [actor.tenantId, input.conversationId, memberUserId, occurredAt],
  );
};

const retireActiveState = async (
  connection: PostgresMigrationConnection,
  prefix: string,
  actor: TrustedChatActorContext,
  input: ConversationMembershipMutationInput,
  memberUserId: UserId,
  occurredAt: IsoTimestamp,
): Promise<void> => {
  await connection.query(
    `UPDATE ${prefix}.chat_thread_follows AS follow
        SET is_following = false, follow_source = 'manual', updated_at = $4
       FROM ${prefix}.chat_conversations AS thread
      WHERE follow.tenant_id = $1
        AND follow.user_id = $3
        AND thread.tenant_id = follow.tenant_id
        AND thread.id = follow.conversation_id
        AND (thread.id = $2 OR thread.parent_conversation_id = $2)
        AND EXISTS (
          SELECT 1
            FROM ${prefix}.chat_conversation_members AS active_member
           WHERE active_member.tenant_id = $1
             AND active_member.conversation_id = $2
             AND active_member.user_id = $3
             AND active_member.state = 'active'
        )`,
    [actor.tenantId, input.conversationId, memberUserId, occurredAt],
  );
  await connection.query(
    `DELETE FROM ${prefix}.chat_read_cursors
      WHERE tenant_id = $1 AND conversation_id = $2 AND user_id = $3`,
    [actor.tenantId, input.conversationId, memberUserId],
  );
  await connection.query(
    `DELETE FROM ${prefix}.chat_conversation_preferences
      WHERE tenant_id = $1 AND conversation_id = $2 AND user_id = $3`,
    [actor.tenantId, input.conversationId, memberUserId],
  );
  await connection.query(
    `UPDATE ${prefix}.chat_conversation_members
        SET state = $4, updated_at = $5
      WHERE tenant_id = $1 AND conversation_id = $2 AND user_id = $3`,
    [
      actor.tenantId,
      input.conversationId,
      memberUserId,
      input.intent === "leave" ? "left" : "removed",
      occurredAt,
    ],
  );
};

const applyMutation = async (
  connection: PostgresMigrationConnection,
  prefix: string,
  actor: TrustedChatActorContext,
  input: ConversationMembershipMutationInput,
  memberUserId: UserId,
  occurredAt: IsoTimestamp,
): Promise<void> => {
  if (input.intent === "join" || input.intent === "add_member") {
    await initializeActiveState(
      connection,
      prefix,
      actor,
      input,
      memberUserId,
      occurredAt,
    );
    return;
  }
  if (input.intent === "leave" || input.intent === "remove_member") {
    await retireActiveState(
      connection,
      prefix,
      actor,
      input,
      memberUserId,
      occurredAt,
    );
    return;
  }
  const updated = await connection.query(
    `UPDATE ${prefix}.chat_conversation_members
        SET role = $4, updated_at = $5
      WHERE tenant_id = $1 AND conversation_id = $2 AND user_id = $3
        AND state = 'active'`,
    [
      actor.tenantId,
      input.conversationId,
      memberUserId,
      input.requestedRole,
      occurredAt,
    ],
  );
  if (updated.rowCount !== 1) throw new ChatAuthorizationError();
};

const persistOutcome = async (
  connection: PostgresMigrationConnection,
  prefix: string,
  actor: TrustedChatActorContext,
  input: ConversationMembershipMutationInput,
  requestHash: string,
  result: ConversationMembershipMutationResult,
  occurredAt: IsoTimestamp,
): Promise<void> => {
  const completed = await connection.query(
    `UPDATE ${prefix}.chat_idempotency_keys
        SET state = 'completed', response_status = 200, response_body = $1,
            completed_at = GREATEST($2::timestamptz, created_at),
            updated_at = GREATEST($2::timestamptz, created_at)
      WHERE tenant_id = $3 AND user_id = $4 AND operation_name = $5
        AND client_key = $6 AND request_hash = $7 AND state = 'pending'`,
    [
      result,
      occurredAt,
      actor.tenantId,
      actor.userId,
      CONVERSATION_MEMBERSHIP_IDEMPOTENCY_OPERATION,
      input.idempotencyKey,
      requestHash,
    ],
  );
  if (completed.rowCount !== 1) {
    throw new ConversationMembershipCommandError(
      "idempotency_in_progress",
      "The idempotent request is already in progress",
    );
  }
};

const persistAppliedEffects = async (
  connection: PostgresMigrationConnection,
  prefix: string,
  actor: TrustedChatActorContext,
  input: ConversationMembershipMutationInput,
  result: ConversationMembershipMutationResult,
  previousMember: CanonicalConversationMemberState | undefined,
  occurredAt: IsoTimestamp,
  outboxRetentionMs: number,
  createId: () => string,
  requestId: string | undefined,
): Promise<void> => {
  const currentMember = result.members.find(
    (member) => member.userId === result.memberUserId,
  );
  if (currentMember === undefined) {
    throw new Error("Applied membership result omitted the affected member");
  }
  const activeMemberCount = result.members.filter(
    (member) => member.state === "active",
  ).length;
  const metadata = {
    conversationId: input.conversationId,
    intent: input.intent,
    memberUserId: result.memberUserId,
    previousRole: previousMember?.role ?? null,
    currentRole: currentMember.role,
    previousState: previousMember?.state ?? null,
    currentState: currentMember.state,
    previousMemberListRevision: input.expectedMemberListRevision,
    currentMemberListRevision: result.memberListRevision,
    activeMemberCount,
  };
  const auditId = createId();
  await connection.query(
    `INSERT INTO ${prefix}.chat_audit_events (
       tenant_id, event_id, actor_user_id, action, target_type, target_id,
       occurred_at, metadata, request_id
     ) VALUES ($1, $2, $3, $4, 'conversation', $5, $6, $7, $8)`,
    [
      actor.tenantId,
      auditId,
      actor.userId,
      CONVERSATION_MEMBERSHIP_UPDATED_EVENT,
      input.conversationId,
      occurredAt,
      metadata,
      requestId ?? auditId,
    ],
  );

  const payload = { input, result };
  for (const streamId of [
    input.conversationId,
    `user:${result.memberUserId}`,
  ]) {
    await connection.query(
      `INSERT INTO ${prefix}.chat_outbox_events (
         event_id, protocol_version, tenant_id, stream_id, type,
         occurred_at, payload, expires_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         $6::timestamptz + ($8::double precision * interval '1 millisecond')
       )`,
      [
        createId(),
        CHAT_PROTOCOL_VERSION,
        actor.tenantId,
        streamId,
        CONVERSATION_MEMBERSHIP_UPDATED_EVENT,
        occurredAt,
        payload,
        outboxRetentionMs,
      ],
    );
  }
};

const rollback = async (
  connection: PostgresMigrationConnection,
): Promise<void> => {
  await connection.query("ROLLBACK").catch(() => undefined);
};

/** Atomically applies one explicit tenant-scoped conversation membership intent. */
export async function mutateConversationMembership(
  options: ConversationMembershipCommandOptions,
): Promise<ConversationMembershipMutationResult> {
  validateActor(options.actor);
  const input = parseConversationMembershipMutationInput(options.input);
  const schema = validatePostgresSchema(options.schema ?? DEFAULT_POSTGRES_SCHEMA);
  const prefix = quoteIdentifier(schema);
  const idempotencyTtlMs = positiveSafeInteger(
    options.idempotencyTtlMs ??
      DEFAULT_CONVERSATION_MEMBERSHIP_IDEMPOTENCY_TTL_MS,
    "idempotencyTtlMs",
  );
  const outboxRetentionMs = positiveSafeInteger(
    options.outboxRetentionMs ??
      DEFAULT_CONVERSATION_MEMBERSHIP_OUTBOX_RETENTION_MS,
    "outboxRetentionMs",
  );
  const requestHash = hashRequest(input);
  const createId = options.createId ?? randomUUID;
  const memberUserId = affectedUserId(input, options.actor);

  const connection = await options.database.connect();
  try {
    await connection.query("BEGIN");
    const claim = await connection.query<ClaimedIdempotencyRow>(
      `SELECT * FROM ${prefix}.claim_chat_idempotency_key(
         $1, $2, $3, $4, $5,
         clock_timestamp() + ($6::double precision * interval '1 millisecond')
       )`,
      [
        options.actor.tenantId,
        options.actor.userId,
        CONVERSATION_MEMBERSHIP_IDEMPOTENCY_OPERATION,
        input.idempotencyKey,
        requestHash,
        idempotencyTtlMs,
      ],
    );
    const claimed = claim.rows[0];
    if (claimed === undefined) {
      throw new ConversationMembershipCommandError(
        "idempotency_conflict",
        "The idempotency key was already used for a different request",
      );
    }
    if (
      claimed.idempotency_state !== "pending" &&
      claimed.idempotency_state !== "completed"
    ) {
      throw new Error("PostgreSQL returned an invalid idempotency state");
    }

    // Match thread lifecycle/send lock order so parent membership revocation
    // cannot race a successful child mutation or an idempotent replay.
    const parents = await connection.query<{ id: string }>(
      `SELECT parent.id FROM ${prefix}.chat_conversations AS parent
       WHERE parent.tenant_id = $1 AND parent.id = (
         SELECT parent_conversation_id FROM ${prefix}.chat_conversations
         WHERE tenant_id = $1 AND id = $2 AND type = 'thread'
       ) FOR UPDATE`,
      [options.actor.tenantId, input.conversationId],
    );
    const locked = await connection.query<LockedConversationRow>(
      `SELECT conversation.type, conversation.parent_conversation_id, conversation.visibility,
              conversation.member_list_revision,
              conversation.current_message_sequence,
              conversation.archived_at,
              COALESCE(conversation.entity_type, parent.entity_type) AS entity_type,
              COALESCE(conversation.entity_id, parent.entity_id) AS entity_id,
              actor_member.role AS actor_role,
              actor_member.state AS actor_state,
              clock_timestamp() AS occurred_at
         FROM ${prefix}.chat_conversations AS conversation
         LEFT JOIN ${prefix}.chat_conversation_members AS actor_member
           ON actor_member.tenant_id = conversation.tenant_id
          AND actor_member.conversation_id = conversation.id
          AND actor_member.user_id = $3
         LEFT JOIN ${prefix}.chat_conversations AS parent
           ON parent.tenant_id = conversation.tenant_id
          AND parent.id = conversation.parent_conversation_id
        WHERE conversation.tenant_id = $1
          AND conversation.id = $2
        FOR UPDATE OF conversation`,
      [options.actor.tenantId, input.conversationId, options.actor.userId],
    );
    const conversation = locked.rows[0];
    if (conversation === undefined || conversation.archived_at !== null) {
      throw new ChatAuthorizationError();
    }
    const capabilities = await readCapabilities(options.actor, options.permissions);
    await authorizeEntity(conversation, options.actor, options.permissions);
    if (conversation.type === "thread") {
      const parent = parents.rows[0];
      if (parent === undefined || conversation.parent_conversation_id !== parent.id) {
        throw new ChatAuthorizationError();
      }
      await connection.query(
        `SELECT conversation_id FROM ${prefix}.chat_conversation_members
         WHERE tenant_id = $1 AND conversation_id = ANY($2::text[]) AND user_id = $3
         ORDER BY conversation_id FOR SHARE`,
        [options.actor.tenantId, [parent.id, input.conversationId], options.actor.userId],
      );
      // Access foundation only: preserve the membership action and the existing
      // intent-specific role/capability rules below.
      await authorizeThreadAccess({
        database: connection, schema, actor: options.actor,
        threadId: input.conversationId, operation: "read",
        entityAction: CONVERSATION_MEMBERSHIP_ENTITY_POLICY_ACTION,
        permissions: options.permissions,
      });
    }
    requireIntentAuthorization(input, conversation, capabilities);

    if (claimed.idempotency_state === "completed") {
      if (claimed.stored_response_body === null) {
        throw new Error("Completed membership outcome has no response body");
      }
      const replay = replayStoredResult(claimed.stored_response_body, input);
      await connection.query("COMMIT");
      return replay;
    }
    await validateTargetDirectoryUser(input, options.actor, options.directory);

    const occurredAt = toIsoTimestamp(
      conversation.occurred_at,
      "conversation membership command timestamp",
    );
    const memberListRevision = toSafeInteger(
      conversation.member_list_revision,
      "conversation member-list revision",
    );
    const members = await loadMembers(
      connection,
      prefix,
      options.actor,
      input.conversationId,
    );
    const target = members.find((member) => member.userId === memberUserId);
    requireTargetRoleAuthorization(
      input,
      conversation,
      target,
      capabilities,
    );

    if (memberListRevision !== input.expectedMemberListRevision) {
      const result = buildResult(
        input,
        memberUserId,
        memberListRevision,
        members,
        "member_list_conflict",
      );
      await persistOutcome(
        connection,
        prefix,
        options.actor,
        input,
        requestHash,
        result,
        occurredAt,
      );
      await connection.query("COMMIT");
      return result;
    }

    if (desiredAlreadyPresent(input, target)) {
      const result = buildResult(
        input,
        memberUserId,
        memberListRevision,
        members,
        "already_requested_state",
      );
      await persistOutcome(
        connection,
        prefix,
        options.actor,
        input,
        requestHash,
        result,
        occurredAt,
      );
      await connection.query("COMMIT");
      return result;
    }

    requireConversationIdentityInvariant(
      input,
      conversationType(conversation.type),
      target,
      members,
    );
    const requiresActiveTarget =
      input.intent === "leave" || input.intent === "change_member_role";
    const requiresExistingTarget = input.intent === "remove_member";
    if (target === undefined) {
      if (input.intent !== "add_member" && input.intent !== "join") {
        throw new ChatAuthorizationError();
      }
    } else if (
      (requiresActiveTarget && target.state !== "active") ||
      (requiresExistingTarget && target.state === "removed")
    ) {
      throw new ChatAuthorizationError();
    }
    const protectedOutcome = safetyError(input, target, members);
    if (protectedOutcome !== undefined) {
      const result = buildResult(
        input,
        memberUserId,
        memberListRevision,
        members,
        "safety_rejected",
        protectedOutcome,
      );
      await persistOutcome(
        connection,
        prefix,
        options.actor,
        input,
        requestHash,
        result,
        occurredAt,
      );
      await connection.query("COMMIT");
      return result;
    }

    const nextRevision = memberListRevision + 1;
    if (!Number.isSafeInteger(nextRevision)) {
      throw new Error("Conversation member-list revision cannot be advanced safely");
    }
    await applyMutation(
      connection,
      prefix,
      options.actor,
      input,
      memberUserId,
      occurredAt,
    );
    const revisionUpdate = await connection.query(
      `UPDATE ${prefix}.chat_conversations
          SET member_list_revision = $3, updated_at = $4
        WHERE tenant_id = $1 AND id = $2 AND member_list_revision = $5`,
      [
        options.actor.tenantId,
        input.conversationId,
        nextRevision,
        occurredAt,
        memberListRevision,
      ],
    );
    if (revisionUpdate.rowCount !== 1) {
      throw new Error("Conversation membership serialization was lost");
    }
    const updatedMembers = await loadMembers(
      connection,
      prefix,
      options.actor,
      input.conversationId,
    );
    const result = buildResult(
      input,
      memberUserId,
      nextRevision,
      updatedMembers,
      "applied",
    );
    await persistAppliedEffects(
      connection,
      prefix,
      options.actor,
      input,
      result,
      target,
      occurredAt,
      outboxRetentionMs,
      createId,
      options.requestId,
    );
    await persistOutcome(
      connection,
      prefix,
      options.actor,
      input,
      requestHash,
      result,
      occurredAt,
    );
    await connection.query("COMMIT");
    return result;
  } catch (error) {
    await rollback(connection);
    // The canonical follow guard also protects a newly added member's access
    // to a private parent. Keep that denial actionable without exposing SQL.
    if (typeof error === "object" && error !== null &&
        "code" in error && error.code === "23514" &&
        "constraint" in error && error.constraint === "chat_thread_follows_active_membership_check") {
      throw new ChatAuthorizationError();
    }
    throw error;
  } finally {
    connection.release();
  }
}
