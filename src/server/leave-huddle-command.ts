import { createHash, randomUUID } from "node:crypto";

import {
  parseHuddleCommandResult,
  parseLeaveHuddleInput,
  validateHuddleStateTransition,
  type ActiveHuddleState,
  type HuddleParticipant,
  type HuddleSessionState,
  type LeaveHuddleInput,
  type LeaveHuddleResult,
} from "../contracts/huddle-session.js";
import type { IsoTimestamp, UserId } from "../contracts/identifiers.js";
import { CHAT_PROTOCOL_VERSION } from "../contracts/realtime.js";
import type {
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

export const LEAVE_HUDDLE_ENTITY_POLICY_ACTION = "huddle.leave" as const;
export const LEAVE_HUDDLE_IDEMPOTENCY_OPERATION = "huddle.leave" as const;
export const LEAVE_HUDDLE_OUTBOX_EVENT_TYPE = "huddle.updated" as const;
export const DEFAULT_LEAVE_HUDDLE_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_LEAVE_HUDDLE_OUTBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export const HUDDLE_LEAVE_REASONS = Object.freeze({
  explicit: "explicit_leave",
  disconnect: "disconnect",
  huddleEnded: "huddle_ended",
} as const);

export type HuddleLeaveReason =
  (typeof HUDDLE_LEAVE_REASONS)[keyof typeof HUDDLE_LEAVE_REASONS];

export type LeaveHuddleCommandErrorCode =
  | "idempotency_conflict"
  | "idempotency_in_progress"
  | "huddle_not_active"
  | "participant_already_left";

/** Stable, provider-neutral failure suitable for explicit and cleanup callers. */
export class LeaveHuddleCommandError extends Error {
  public readonly statusCode = 409;

  public constructor(
    public readonly code: LeaveHuddleCommandErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LeaveHuddleCommandError";
  }
}

interface LeaveHuddleDependencies {
  readonly database: PostgresMigrationDatabase;
  readonly permissions: Pick<
    ChatPermissionAdapter<string, typeof LEAVE_HUDDLE_ENTITY_POLICY_ACTION>,
    "authorizeEntity"
  >;
  readonly actor: TrustedChatActorContext;
  readonly schema?: string;
  readonly idempotencyTtlMs?: number;
  readonly outboxRetentionMs?: number;
  readonly createId?: () => string;
}

export interface LeaveHuddleCommandOptions extends LeaveHuddleDependencies {
  /** JSON-decoded caller input; identity and leave reason are server-derived. */
  readonly input: unknown;
}

export interface LeaveHuddleParticipationOptions extends LeaveHuddleDependencies {
  readonly huddleSessionId: string;
  readonly idempotencyKey: string;
  readonly reason: HuddleLeaveReason;
}

export interface LeaveJoinedHuddlesOnDisconnectOptions
  extends Omit<LeaveHuddleDependencies, "createId"> {
  /** Stable authenticated socket session identity, never caller input. */
  readonly disconnectIdentity: string;
  readonly createId?: () => string;
}

interface ClaimedIdempotencyRow {
  readonly idempotency_state: string;
  readonly stored_response_body: unknown;
}

interface EligibleParticipantRow {
  readonly id: string;
  readonly conversation_id: string;
  readonly status: string;
  readonly started_at: Date | string;
  readonly active_screen_share_owner_user_id: string | null;
  readonly entity_type: string | null;
  readonly entity_id: string | null;
  readonly user_id: string;
  readonly joined_at: Date | string;
  readonly left_at: Date | string | null;
}

interface StoredParticipantRow {
  readonly user_id: string;
  readonly joined_at: Date | string;
  readonly left_at: Date | string | null;
}

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

const validateLeaveReason = (value: unknown): HuddleLeaveReason => {
  if (!Object.values(HUDDLE_LEAVE_REASONS).includes(value as HuddleLeaveReason)) {
    throw new TypeError("reason must be a canonical huddle leave reason");
  }
  return value as HuddleLeaveReason;
};

const toIsoTimestamp = (value: Date | string, label: string): IsoTimestamp => {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.valueOf())) {
    throw new Error(`PostgreSQL returned an invalid ${label}`);
  }
  return date.toISOString() as IsoTimestamp;
};

const requestHash = (
  huddleSessionId: string,
  reason: HuddleLeaveReason,
): string =>
  `sha256:${createHash("sha256")
    .update(JSON.stringify({
      operation: "leave_huddle",
      huddleSessionId,
      reason,
    }))
    .digest("hex")}`;

const participantFromRow = (row: StoredParticipantRow): HuddleParticipant => {
  const joinedAt = toIsoTimestamp(row.joined_at, "participant join timestamp");
  return row.left_at === null
    ? { userId: row.user_id as UserId, status: "joined", joinedAt }
    : {
        userId: row.user_id as UserId,
        status: "left",
        joinedAt,
        leftAt: toIsoTimestamp(row.left_at, "participant leave timestamp"),
      };
};

const stateFromRows = (
  session: EligibleParticipantRow,
  participants: readonly StoredParticipantRow[],
): ActiveHuddleState => {
  if (session.status !== "active") {
    throw new LeaveHuddleCommandError(
      "huddle_not_active",
      "The huddle session is not active",
    );
  }
  return {
    status: "active",
    conversationId: session.conversation_id as ActiveHuddleState["conversationId"],
    huddleSessionId: session.id as ActiveHuddleState["huddleSessionId"],
    startedAt: toIsoTimestamp(session.started_at, "huddle start timestamp"),
    participants: participants.map(participantFromRow),
    screenShareOwnerUserId:
      session.active_screen_share_owner_user_id as UserId | null,
  };
};

const readParticipants = async (
  connection: PostgresMigrationConnection,
  prefix: string,
  actor: TrustedChatActorContext,
  sessionId: string,
): Promise<StoredParticipantRow[]> => {
  const result = await connection.query<StoredParticipantRow>(
    `SELECT user_id, joined_at, left_at
       FROM ${prefix}.chat_huddle_participants
      WHERE tenant_id = $1 AND huddle_session_id = $2
      ORDER BY joined_at, user_id`,
    [actor.tenantId, sessionId],
  );
  return result.rows;
};

const authorizeEntity = async (
  session: EligibleParticipantRow,
  options: LeaveHuddleDependencies,
): Promise<void> => {
  if (session.entity_type === null && session.entity_id === null) return;
  if (session.entity_type === null || session.entity_id === null) {
    throw new ChatAuthorizationError();
  }
  try {
    const allowed = await options.permissions.authorizeEntity({
      actor: options.actor,
      entity: { type: session.entity_type, id: session.entity_id },
      action: LEAVE_HUDDLE_ENTITY_POLICY_ACTION,
    });
    if (!allowed) throw new Error("denied");
  } catch {
    throw new ChatAuthorizationError();
  }
};

const rollback = async (connection: PostgresMigrationConnection): Promise<void> => {
  await connection.query("ROLLBACK").catch(() => undefined);
};

/**
 * The single durable leave operation used by explicit commands and authenticated
 * socket cleanup. It never calls the media adapter or changes session status.
 */
export async function leaveHuddleParticipation(
  options: LeaveHuddleParticipationOptions,
): Promise<LeaveHuddleResult> {
  validateActor(options.actor);
  if (!nonEmptyString(options.huddleSessionId)) {
    throw new TypeError("huddleSessionId must be a non-empty string");
  }
  if (!nonEmptyString(options.idempotencyKey)) {
    throw new TypeError("idempotencyKey must be a non-empty string");
  }
  const input: LeaveHuddleInput = parseLeaveHuddleInput({
    operation: "leave_huddle",
    huddleSessionId: options.huddleSessionId,
    idempotencyKey: options.idempotencyKey,
  });
  const reason = validateLeaveReason(options.reason);
  const schema = validatePostgresSchema(options.schema ?? DEFAULT_POSTGRES_SCHEMA);
  const prefix = quoteIdentifier(schema);
  const idempotencyTtlMs = positiveSafeInteger(
    options.idempotencyTtlMs ?? DEFAULT_LEAVE_HUDDLE_IDEMPOTENCY_TTL_MS,
    "idempotencyTtlMs",
  );
  const outboxRetentionMs = positiveSafeInteger(
    options.outboxRetentionMs ?? DEFAULT_LEAVE_HUDDLE_OUTBOX_RETENTION_MS,
    "outboxRetentionMs",
  );
  const hash = requestHash(input.huddleSessionId, reason);
  const createId = options.createId ?? randomUUID;
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
        LEAVE_HUDDLE_IDEMPOTENCY_OPERATION,
        input.idempotencyKey,
        hash,
        idempotencyTtlMs,
      ],
    );
    const claimed = claim.rows[0];
    if (claimed === undefined) {
      throw new LeaveHuddleCommandError(
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

    await connection.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [JSON.stringify([options.actor.tenantId, input.huddleSessionId, "huddle"])],
    );
    const eligible = await connection.query<EligibleParticipantRow>(
      `SELECT session.id, session.conversation_id, session.status,
              session.started_at, session.active_screen_share_owner_user_id,
              COALESCE(conversation.entity_type, parent.entity_type) AS entity_type,
              COALESCE(conversation.entity_id, parent.entity_id) AS entity_id,
              participant.user_id, participant.joined_at, participant.left_at
         FROM ${prefix}.chat_huddle_sessions AS session
         INNER JOIN ${prefix}.chat_conversations AS conversation
           ON conversation.tenant_id = session.tenant_id
          AND conversation.id = session.conversation_id
         INNER JOIN ${prefix}.chat_conversation_members AS member
           ON member.tenant_id = conversation.tenant_id
          AND member.conversation_id = conversation.id
          AND member.user_id = $3
          AND member.state = 'active'
         INNER JOIN ${prefix}.chat_huddle_participants AS participant
           ON participant.tenant_id = session.tenant_id
          AND participant.huddle_session_id = session.id
          AND participant.user_id = $3
         LEFT JOIN ${prefix}.chat_conversations AS parent
           ON parent.tenant_id = conversation.tenant_id
          AND parent.id = conversation.parent_conversation_id
        WHERE session.tenant_id = $1
          AND session.id = $2
          AND conversation.archived_at IS NULL
        FOR UPDATE OF session, conversation, participant`,
      [options.actor.tenantId, input.huddleSessionId, options.actor.userId],
    );
    const session = eligible.rows[0];
    if (session === undefined) throw new ChatAuthorizationError();
    await authorizeEntity(session, options);

    if (claimed.idempotency_state === "completed") {
      const original = parseHuddleCommandResult(
        claimed.stored_response_body,
        input,
      ) as LeaveHuddleResult;
      const replay = parseHuddleCommandResult(
        { ...original, reconciliationStatus: "replayed" },
        input,
        { replayOf: original },
      ) as LeaveHuddleResult;
      await connection.query("COMMIT");
      return replay;
    }

    if (session.left_at !== null) {
      throw new LeaveHuddleCommandError(
        "participant_already_left",
        "The actor has already left this huddle",
      );
    }
    const beforeParticipants = await readParticipants(
      connection,
      prefix,
      options.actor,
      input.huddleSessionId,
    );
    const previousState: HuddleSessionState = stateFromRows(
      session,
      beforeParticipants,
    );
    // Keep PostgreSQL microseconds intact until persistence; Date truncates them.
    const timestampResult = await connection.query<{ left_at: string }>(
      "SELECT clock_timestamp()::text AS left_at",
    );
    const leftAtValue = timestampResult.rows[0]?.left_at;
    if (leftAtValue === undefined) {
      throw new Error("PostgreSQL returned no participant leave timestamp");
    }

    let sessionAfterLeave = session;
    if (session.active_screen_share_owner_user_id === options.actor.userId) {
      const cleared = await connection.query(
        `UPDATE ${prefix}.chat_huddle_sessions
            SET active_screen_share_owner_user_id = NULL,
                updated_at = GREATEST($1::timestamptz, updated_at)
          WHERE tenant_id = $2 AND id = $3
            AND status = 'active'
            AND active_screen_share_owner_user_id = $4`,
        [
          leftAtValue,
          options.actor.tenantId,
          input.huddleSessionId,
          options.actor.userId,
        ],
      );
      if (cleared.rowCount !== 1) {
        throw new LeaveHuddleCommandError(
          "huddle_not_active",
          "The huddle session is not active",
        );
      }
      sessionAfterLeave = {
        ...session,
        active_screen_share_owner_user_id: null,
      };
    }

    const updated = await connection.query<StoredParticipantRow>(
      `UPDATE ${prefix}.chat_huddle_participants
          SET left_at = $1, leave_reason = $2
        WHERE tenant_id = $3 AND huddle_session_id = $4 AND user_id = $5
          AND left_at IS NULL
      RETURNING user_id, joined_at, left_at::text AS left_at`,
      [
        leftAtValue,
        reason,
        options.actor.tenantId,
        input.huddleSessionId,
        options.actor.userId,
      ],
    );
    const leftParticipant = updated.rows[0];
    if (leftParticipant === undefined) {
      throw new LeaveHuddleCommandError(
        "participant_already_left",
        "The actor has already left this huddle",
      );
    }
    const participants = beforeParticipants.map((participant) =>
      participant.user_id === options.actor.userId
        ? leftParticipant
        : participant,
    );
    const state = stateFromRows(sessionAfterLeave, participants);
    validateHuddleStateTransition(previousState, state, input);
    const result = parseHuddleCommandResult(
      {
        operation: input.operation,
        outcome: "ok",
        reconciliationStatus: "applied",
        state,
      },
      input,
      { previousState },
    ) as LeaveHuddleResult;
    const participant = participantFromRow(leftParticipant);

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
        options.actor.tenantId,
        session.conversation_id,
        LEAVE_HUDDLE_OUTBOX_EVENT_TYPE,
        leftParticipant.left_at,
        { operation: input.operation, reason, participant, state },
        outboxRetentionMs,
      ],
    );
    const completed = await connection.query(
      `UPDATE ${prefix}.chat_idempotency_keys
          SET state = 'completed', response_status = 200,
              response_body = $1, completed_at = statement_timestamp(),
              updated_at = statement_timestamp()
        WHERE tenant_id = $2 AND user_id = $3 AND operation_name = $4
          AND client_key = $5 AND request_hash = $6 AND state = 'pending'`,
      [
        result,
        options.actor.tenantId,
        options.actor.userId,
        LEAVE_HUDDLE_IDEMPOTENCY_OPERATION,
        input.idempotencyKey,
        hash,
      ],
    );
    if (completed.rowCount !== 1) {
      throw new LeaveHuddleCommandError(
        "idempotency_in_progress",
        "The idempotent request is already in progress",
      );
    }
    await connection.query("COMMIT");
    return result;
  } catch (error) {
    await rollback(connection);
    throw error;
  } finally {
    connection.release();
  }
}

/** Public trusted-actor command. The caller cannot choose the persisted reason. */
export async function leaveHuddle(
  options: LeaveHuddleCommandOptions,
): Promise<LeaveHuddleResult> {
  const input = parseLeaveHuddleInput(options.input);
  return leaveHuddleParticipation({
    database: options.database,
    permissions: options.permissions,
    actor: options.actor,
    huddleSessionId: input.huddleSessionId,
    idempotencyKey: input.idempotencyKey,
    reason: HUDDLE_LEAVE_REASONS.explicit,
    ...(options.schema === undefined ? {} : { schema: options.schema }),
    ...(options.idempotencyTtlMs === undefined
      ? {}
      : { idempotencyTtlMs: options.idempotencyTtlMs }),
    ...(options.outboxRetentionMs === undefined
      ? {}
      : { outboxRetentionMs: options.outboxRetentionMs }),
    ...(options.createId === undefined ? {} : { createId: options.createId }),
  });
}

/** Leaves every currently joined active huddle for one authenticated socket. */
export async function leaveJoinedHuddlesOnDisconnect(
  options: LeaveJoinedHuddlesOnDisconnectOptions,
): Promise<number> {
  validateActor(options.actor);
  if (!nonEmptyString(options.disconnectIdentity)) {
    throw new TypeError("disconnectIdentity must be a non-empty string");
  }
  const schema = validatePostgresSchema(options.schema ?? DEFAULT_POSTGRES_SCHEMA);
  const prefix = quoteIdentifier(schema);
  const joined = await options.database.query<{ id: string }>(
    `SELECT session.id
       FROM ${prefix}.chat_huddle_sessions AS session
       INNER JOIN ${prefix}.chat_huddle_participants AS participant
         ON participant.tenant_id = session.tenant_id
        AND participant.huddle_session_id = session.id
        AND participant.user_id = $2
        AND participant.left_at IS NULL
       INNER JOIN ${prefix}.chat_conversations AS conversation
         ON conversation.tenant_id = session.tenant_id
        AND conversation.id = session.conversation_id
       INNER JOIN ${prefix}.chat_conversation_members AS member
         ON member.tenant_id = conversation.tenant_id
        AND member.conversation_id = conversation.id
        AND member.user_id = $2
        AND member.state = 'active'
      WHERE session.tenant_id = $1
        AND session.status = 'active'
        AND conversation.archived_at IS NULL
      ORDER BY session.id`,
    [options.actor.tenantId, options.actor.userId],
  );
  const identityHash = createHash("sha256")
    .update(options.disconnectIdentity)
    .digest("hex");
  let left = 0;
  for (const row of joined.rows) {
    try {
      await leaveHuddleParticipation({
        database: options.database,
        permissions: options.permissions,
        actor: options.actor,
        huddleSessionId: row.id,
        idempotencyKey: `disconnect:${identityHash}:${createHash("sha256")
          .update(row.id)
          .digest("hex")}`,
        reason: HUDDLE_LEAVE_REASONS.disconnect,
        schema,
        ...(options.idempotencyTtlMs === undefined
          ? {}
          : { idempotencyTtlMs: options.idempotencyTtlMs }),
        ...(options.outboxRetentionMs === undefined
          ? {}
          : { outboxRetentionMs: options.outboxRetentionMs }),
        ...(options.createId === undefined ? {} : { createId: options.createId }),
      });
      left += 1;
    } catch (error) {
      if (
        error instanceof LeaveHuddleCommandError &&
        error.code === "participant_already_left"
      ) {
        continue;
      }
      throw error;
    }
  }
  return left;
}
