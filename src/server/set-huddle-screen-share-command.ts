import { createHash, randomUUID } from "node:crypto";

import {
  parseHuddleCommandResult,
  parseSetHuddleScreenShareInput,
  validateHuddleStateTransition,
  type ActiveHuddleState,
  type HuddleParticipant,
  type SetHuddleScreenShareInput,
  type SetHuddleScreenShareResult,
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

export const HUDDLE_SCREEN_SHARE_CAPABILITY = "huddle.screen_share" as const;
export const HUDDLE_SCREEN_SHARE_ENTITY_POLICY_ACTION =
  "huddle.screen_share" as const;
export const HUDDLE_SCREEN_SHARE_IDEMPOTENCY_OPERATION =
  "huddle.screen_share" as const;
export const HUDDLE_SCREEN_SHARE_OUTBOX_EVENT_TYPE =
  "huddle.updated" as const;
export const DEFAULT_HUDDLE_SCREEN_SHARE_IDEMPOTENCY_TTL_MS =
  24 * 60 * 60 * 1_000;
export const DEFAULT_HUDDLE_SCREEN_SHARE_OUTBOX_RETENTION_MS =
  7 * 24 * 60 * 60 * 1_000;

export type HuddleScreenSharePolicyLimit = 0 | 1;

export type SetHuddleScreenShareCommandErrorCode =
  | "idempotency_conflict"
  | "idempotency_in_progress"
  | "huddle_not_active"
  | "screen_share_disabled"
  | "screen_share_ownership_conflict"
  | "screen_share_not_active";

/** Stable, provider-neutral failure suitable for a future transport boundary. */
export class SetHuddleScreenShareCommandError extends Error {
  public readonly statusCode: number;

  public constructor(
    public readonly code: SetHuddleScreenShareCommandErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SetHuddleScreenShareCommandError";
    this.statusCode = code === "screen_share_disabled" ? 403 : 409;
  }
}

export interface SetHuddleScreenShareCommandOptions {
  readonly database: PostgresMigrationDatabase;
  readonly permissions: Pick<
    ChatPermissionAdapter<
      string,
      typeof HUDDLE_SCREEN_SHARE_ENTITY_POLICY_ACTION
    >,
    "getCapabilities" | "authorizeEntity"
  >;
  /** Trusted host-session identity; caller input cannot override these values. */
  readonly actor: TrustedChatActorContext;
  /** JSON-decoded caller input, validated by the shared huddle contract. */
  readonly input: unknown;
  /** Trusted server policy. The canonical schema currently supports only 0 or 1. */
  readonly maxActiveScreenSharers: HuddleScreenSharePolicyLimit;
  readonly schema?: string;
  readonly idempotencyTtlMs?: number;
  readonly outboxRetentionMs?: number;
  readonly createId?: () => string;
}

interface ClaimedIdempotencyRow {
  readonly idempotency_state: string;
  readonly stored_response_body: unknown;
}

interface ExistingIdempotencyRow {
  readonly request_hash: string;
  readonly state: string;
}

interface EligibleParticipantRow {
  readonly id: string;
  readonly conversation_id: string;
  readonly status: string;
  readonly started_at: Date | string;
  readonly active_screen_share_owner_user_id: string | null;
  readonly entity_type: string | null;
  readonly entity_id: string | null;
  readonly participant_left_at: Date | string | null;
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

const validatePolicy = (value: unknown): HuddleScreenSharePolicyLimit => {
  if (value !== 0 && value !== 1) {
    throw new TypeError("maxActiveScreenSharers must be 0 or 1");
  }
  return value;
};

const hashRequest = (input: SetHuddleScreenShareInput): string =>
  `sha256:${createHash("sha256")
    .update(JSON.stringify({
      operation: input.operation,
      huddleSessionId: input.huddleSessionId,
      intent: input.intent,
    }))
    .digest("hex")}`;

const toIsoTimestamp = (value: Date | string, label: string): IsoTimestamp => {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.valueOf())) {
    throw new Error(`PostgreSQL returned an invalid ${label}`);
  }
  return date.toISOString() as IsoTimestamp;
};

const requireCapability = async (
  options: SetHuddleScreenShareCommandOptions,
): Promise<void> => {
  try {
    const capabilities = await options.permissions.getCapabilities({
      actor: options.actor,
    });
    if (
      !Array.isArray(capabilities) ||
      !capabilities.every(nonEmptyString) ||
      !capabilities.includes(HUDDLE_SCREEN_SHARE_CAPABILITY)
    ) {
      throw new Error("denied");
    }
  } catch {
    throw new ChatAuthorizationError();
  }
};

const authorizeEntity = async (
  session: EligibleParticipantRow,
  options: SetHuddleScreenShareCommandOptions,
): Promise<void> => {
  if (session.entity_type === null && session.entity_id === null) return;
  if (session.entity_type === null || session.entity_id === null) {
    throw new ChatAuthorizationError();
  }
  try {
    const allowed = await options.permissions.authorizeEntity({
      actor: options.actor,
      entity: { type: session.entity_type, id: session.entity_id },
      action: HUDDLE_SCREEN_SHARE_ENTITY_POLICY_ACTION,
    });
    if (!allowed) throw new Error("denied");
  } catch {
    throw new ChatAuthorizationError();
  }
};

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

const stateFromRows = (
  session: EligibleParticipantRow,
  participants: readonly StoredParticipantRow[],
  ownerUserId: string | null = session.active_screen_share_owner_user_id,
): ActiveHuddleState => {
  if (session.status !== "active") {
    throw new SetHuddleScreenShareCommandError(
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
    screenShareOwnerUserId: ownerUserId as UserId | null,
  };
};

const rollback = async (connection: PostgresMigrationConnection): Promise<void> => {
  await connection.query("ROLLBACK").catch(() => undefined);
};

/**
 * Applies only canonical ownership metadata. Display capture, media bytes,
 * provider rooms, and signaling remain outside this trusted server command.
 */
export async function setHuddleScreenShare(
  options: SetHuddleScreenShareCommandOptions,
): Promise<SetHuddleScreenShareResult> {
  validateActor(options.actor);
  const input = parseSetHuddleScreenShareInput(options.input);
  const maxActiveScreenSharers = validatePolicy(options.maxActiveScreenSharers);
  const schema = validatePostgresSchema(options.schema ?? DEFAULT_POSTGRES_SCHEMA);
  const prefix = quoteIdentifier(schema);
  const idempotencyTtlMs = positiveSafeInteger(
    options.idempotencyTtlMs ??
      DEFAULT_HUDDLE_SCREEN_SHARE_IDEMPOTENCY_TTL_MS,
    "idempotencyTtlMs",
  );
  const outboxRetentionMs = positiveSafeInteger(
    options.outboxRetentionMs ??
      DEFAULT_HUDDLE_SCREEN_SHARE_OUTBOX_RETENTION_MS,
    "outboxRetentionMs",
  );
  const requestHash = hashRequest(input);
  const createId = options.createId ?? randomUUID;

  await requireCapability(options);
  const connection = await options.database.connect();
  try {
    await connection.query("BEGIN");
    const existing = await connection.query<ExistingIdempotencyRow>(
      `SELECT request_hash, state
         FROM ${prefix}.chat_idempotency_keys
        WHERE tenant_id = $1 AND user_id = $2 AND operation_name = $3
          AND client_key = $4`,
      [
        options.actor.tenantId,
        options.actor.userId,
        HUDDLE_SCREEN_SHARE_IDEMPOTENCY_OPERATION,
        input.idempotencyKey,
      ],
    );
    const existingRow = existing.rows[0];
    if (existingRow?.state === "pending" && existingRow.request_hash === requestHash) {
      throw new SetHuddleScreenShareCommandError(
        "idempotency_in_progress",
        "The idempotent request is already in progress",
      );
    }
    const claim = await connection.query<ClaimedIdempotencyRow>(
      `SELECT * FROM ${prefix}.claim_chat_idempotency_key(
         $1, $2, $3, $4, $5,
         clock_timestamp() + ($6::double precision * interval '1 millisecond')
       )`,
      [
        options.actor.tenantId,
        options.actor.userId,
        HUDDLE_SCREEN_SHARE_IDEMPOTENCY_OPERATION,
        input.idempotencyKey,
        requestHash,
        idempotencyTtlMs,
      ],
    );
    const claimed = claim.rows[0];
    if (claimed === undefined) {
      throw new SetHuddleScreenShareCommandError(
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

    // This is deliberately identical to leave-huddle's ordering key.
    await connection.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [JSON.stringify([options.actor.tenantId, input.huddleSessionId, "huddle"])],
    );
    const eligible = await connection.query<EligibleParticipantRow>(
      `SELECT session.id, session.conversation_id, session.status,
              session.started_at, session.active_screen_share_owner_user_id,
              COALESCE(conversation.entity_type, parent.entity_type) AS entity_type,
              COALESCE(conversation.entity_id, parent.entity_id) AS entity_id,
              participant.left_at AS participant_left_at
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
      ) as SetHuddleScreenShareResult;
      const replay = parseHuddleCommandResult(
        { ...original, reconciliationStatus: "replayed" },
        input,
        { replayOf: original },
      ) as SetHuddleScreenShareResult;
      await connection.query("COMMIT");
      return replay;
    }

    if (session.status !== "active") {
      throw new SetHuddleScreenShareCommandError(
        "huddle_not_active",
        "The huddle session is not active",
      );
    }
    if (session.participant_left_at !== null) {
      throw new ChatAuthorizationError();
    }

    const currentOwner = session.active_screen_share_owner_user_id;
    let nextOwner: string | null;
    if (input.intent === "set") {
      if (maxActiveScreenSharers === 0) {
        throw new SetHuddleScreenShareCommandError(
          "screen_share_disabled",
          "Screen sharing is disabled by server policy",
        );
      }
      if (currentOwner !== null && currentOwner !== options.actor.userId) {
        throw new SetHuddleScreenShareCommandError(
          "screen_share_ownership_conflict",
          "Another participant already owns the active screen share",
        );
      }
      nextOwner = options.actor.userId;
    } else {
      if (currentOwner === null) {
        throw new SetHuddleScreenShareCommandError(
          "screen_share_not_active",
          "The actor does not have an active screen share to clear",
        );
      }
      if (currentOwner !== options.actor.userId) {
        throw new SetHuddleScreenShareCommandError(
          "screen_share_ownership_conflict",
          "The actor cannot clear another participant's screen share",
        );
      }
      nextOwner = null;
    }

    const participants = await readParticipants(
      connection,
      prefix,
      options.actor,
      input.huddleSessionId,
    );
    const previousState = stateFromRows(session, participants);
    const updated = await connection.query<{ updated_at: Date | string }>(
      `UPDATE ${prefix}.chat_huddle_sessions
          SET active_screen_share_owner_user_id = $1,
              updated_at = GREATEST(clock_timestamp(), updated_at)
        WHERE tenant_id = $2 AND id = $3 AND status = 'active'
          AND active_screen_share_owner_user_id IS NOT DISTINCT FROM $4::text
      RETURNING updated_at`,
      [
        nextOwner,
        options.actor.tenantId,
        input.huddleSessionId,
        currentOwner,
      ],
    );
    const updatedAtValue = updated.rows[0]?.updated_at;
    if (updatedAtValue === undefined) {
      throw new SetHuddleScreenShareCommandError(
        "huddle_not_active",
        "The huddle session is not active",
      );
    }
    const occurredAt = toIsoTimestamp(
      updatedAtValue,
      "screen-share update timestamp",
    );
    const state = stateFromRows(session, participants, nextOwner);
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
    ) as SetHuddleScreenShareResult;

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
        HUDDLE_SCREEN_SHARE_OUTBOX_EVENT_TYPE,
        occurredAt,
        { operation: input.operation, intent: input.intent, state },
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
        HUDDLE_SCREEN_SHARE_IDEMPOTENCY_OPERATION,
        input.idempotencyKey,
        requestHash,
      ],
    );
    if (completed.rowCount !== 1) {
      throw new SetHuddleScreenShareCommandError(
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
