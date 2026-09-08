import { createHash, randomUUID } from "node:crypto";

import {
  parseEndHuddleInput,
  parseHuddleCommandResult,
  type ActiveHuddleState,
  type EndedHuddleState,
  type EndHuddleInput,
  type EndHuddleResult,
  type HuddleParticipant,
  type StartingHuddleState,
} from "../contracts/huddle-session.js";
import type { IsoTimestamp, UserId } from "../contracts/identifiers.js";
import { CHAT_PROTOCOL_VERSION } from "../contracts/realtime.js";
import type {
  ChatMediaAdapter,
  ChatPermissionAdapter,
  TrustedChatActorContext,
} from "./contracts.js";
import { HUDDLE_LEAVE_REASONS } from "./leave-huddle-command.js";
import {
  DEFAULT_POSTGRES_SCHEMA,
  validatePostgresSchema,
  type PostgresMigrationConnection,
  type PostgresMigrationDatabase,
} from "./postgres-migrations.js";
import { ChatAuthorizationError } from "./request-context.js";

export const END_HUDDLE_MODERATION_CAPABILITY = "huddle.end" as const;
export const END_HUDDLE_ENTITY_POLICY_ACTION = "huddle.end" as const;
export const END_HUDDLE_IDEMPOTENCY_OPERATION = "huddle.end" as const;
export const END_HUDDLE_AUDIT_ACTION = "huddle.ended" as const;
export const END_HUDDLE_OUTBOX_EVENT_TYPE = "huddle.updated" as const;
export const END_HUDDLE_INTERNAL_ENDING_STATUS = "ending" as const;
export const DEFAULT_END_HUDDLE_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_END_HUDDLE_OUTBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export type EndHuddleCommandErrorCode =
  | "idempotency_conflict"
  | "huddle_not_live"
  | "media_termination_failed";

/** Stable, provider-neutral failure suitable for a future transport boundary. */
export class EndHuddleCommandError extends Error {
  public readonly statusCode: number;

  public constructor(
    public readonly code: EndHuddleCommandErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "EndHuddleCommandError";
    this.statusCode = code === "media_termination_failed" ? 503 : 409;
  }
}

export interface EndHuddleCommandOptions {
  readonly database: PostgresMigrationDatabase;
  readonly permissions: Pick<
    ChatPermissionAdapter<string, typeof END_HUDDLE_ENTITY_POLICY_ACTION>,
    "getCapabilities" | "authorizeEntity"
  >;
  /** Trusted host-session identity; caller input cannot override these values. */
  readonly actor: TrustedChatActorContext;
  /** JSON-decoded caller input, validated by the shared huddle contract. */
  readonly input: unknown;
  readonly media: Pick<ChatMediaAdapter, "terminateRoom">;
  readonly schema?: string;
  readonly idempotencyTtlMs?: number;
  readonly outboxRetentionMs?: number;
  /** Trusted transport correlation id used only by the existing audit record. */
  readonly requestId?: string;
  readonly createId?: () => string;
}

interface ClaimedIdempotencyRow {
  readonly idempotency_state: string;
  readonly stored_response_body: unknown;
}

interface StoredSessionRow {
  readonly id: string;
  readonly conversation_id: string;
  readonly provider_room_reference: string;
  readonly status: string;
  readonly initiated_by_user_id: string;
  readonly started_at: Date | string;
  readonly activated_at: Date | string | null;
  readonly ended_at: Date | string | null;
  readonly ended_by_user_id: string | null;
  readonly active_screen_share_owner_user_id: string | null;
  readonly entity_type: string | null;
  readonly entity_id: string | null;
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

const toIsoTimestamp = (value: Date | string, label: string): IsoTimestamp => {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.valueOf())) {
    throw new Error(`PostgreSQL returned an invalid ${label}`);
  }
  return date.toISOString() as IsoTimestamp;
};

const hashRequest = (input: EndHuddleInput): string =>
  `sha256:${createHash("sha256")
    .update(JSON.stringify({
      operation: input.operation,
      huddleSessionId: input.huddleSessionId,
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

const liveStateFromRows = (
  session: StoredSessionRow,
  participants: readonly StoredParticipantRow[],
): StartingHuddleState | ActiveHuddleState => ({
  status: session.activated_at === null ? "starting" : "active",
  conversationId: session.conversation_id as ActiveHuddleState["conversationId"],
  huddleSessionId: session.id as ActiveHuddleState["huddleSessionId"],
  startedAt: toIsoTimestamp(session.started_at, "huddle start timestamp"),
  participants: participants.map(participantFromRow),
  screenShareOwnerUserId:
    session.active_screen_share_owner_user_id as UserId | null,
});

const endedStateFromRows = (
  session: StoredSessionRow,
  participants: readonly StoredParticipantRow[],
): EndedHuddleState => {
  if (
    session.status !== "ended" ||
    session.ended_at === null ||
    session.ended_by_user_id === null
  ) {
    throw new Error("PostgreSQL returned an incomplete ended huddle");
  }
  return {
    status: "ended",
    conversationId: session.conversation_id as EndedHuddleState["conversationId"],
    huddleSessionId: session.id as EndedHuddleState["huddleSessionId"],
    startedAt: toIsoTimestamp(session.started_at, "huddle start timestamp"),
    endedAt: toIsoTimestamp(session.ended_at, "huddle end timestamp"),
    endedByUserId: session.ended_by_user_id as UserId,
    participants: participants.map((row) => {
      const participant = participantFromRow(row);
      if (participant.status !== "left") {
        throw new Error("An ended huddle retained a joined participant");
      }
      return participant;
    }),
    screenShareOwnerUserId: null,
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

const readEligibleSession = async (
  connection: PostgresMigrationConnection,
  prefix: string,
  actor: TrustedChatActorContext,
  sessionId: string,
): Promise<StoredSessionRow> => {
  const result = await connection.query<StoredSessionRow>(
    `SELECT session.id, session.conversation_id,
            session.provider_room_reference, session.status,
            session.initiated_by_user_id, session.started_at,
            session.activated_at, session.ended_at,
            session.ended_by_user_id,
            session.active_screen_share_owner_user_id,
            COALESCE(conversation.entity_type, parent.entity_type) AS entity_type,
            COALESCE(conversation.entity_id, parent.entity_id) AS entity_id
       FROM ${prefix}.chat_huddle_sessions AS session
       INNER JOIN ${prefix}.chat_conversations AS conversation
         ON conversation.tenant_id = session.tenant_id
        AND conversation.id = session.conversation_id
       INNER JOIN ${prefix}.chat_conversation_members AS member
         ON member.tenant_id = conversation.tenant_id
        AND member.conversation_id = conversation.id
        AND member.user_id = $3
        AND member.state = 'active'
       LEFT JOIN ${prefix}.chat_conversations AS parent
         ON parent.tenant_id = conversation.tenant_id
        AND parent.id = conversation.parent_conversation_id
      WHERE session.tenant_id = $1
        AND session.id = $2
        AND conversation.archived_at IS NULL
      FOR UPDATE OF session, conversation`,
    [actor.tenantId, sessionId, actor.userId],
  );
  const session = result.rows[0];
  if (session === undefined) throw new ChatAuthorizationError();
  return session;
};

const readSessionForFinalization = async (
  connection: PostgresMigrationConnection,
  prefix: string,
  actor: TrustedChatActorContext,
  sessionId: string,
): Promise<StoredSessionRow> => {
  const result = await connection.query<StoredSessionRow>(
    `SELECT id, conversation_id, provider_room_reference, status,
            initiated_by_user_id, started_at, activated_at, ended_at,
            ended_by_user_id, active_screen_share_owner_user_id,
            NULL::text AS entity_type, NULL::text AS entity_id
       FROM ${prefix}.chat_huddle_sessions
      WHERE tenant_id = $1 AND id = $2
      FOR UPDATE`,
    [actor.tenantId, sessionId],
  );
  const session = result.rows[0];
  if (session === undefined) {
    throw new Error("The authorized ending huddle disappeared before finalization");
  }
  return session;
};

const authorize = async (
  session: StoredSessionRow,
  options: EndHuddleCommandOptions,
): Promise<void> => {
  if (session.initiated_by_user_id !== options.actor.userId) {
    try {
      const capabilities = await options.permissions.getCapabilities({
        actor: options.actor,
      });
      if (
        !Array.isArray(capabilities) ||
        !capabilities.every(nonEmptyString) ||
        !capabilities.includes(END_HUDDLE_MODERATION_CAPABILITY)
      ) {
        throw new Error("denied");
      }
    } catch {
      throw new ChatAuthorizationError();
    }
  }

  if (session.entity_type === null && session.entity_id === null) return;
  if (session.entity_type === null || session.entity_id === null) {
    throw new ChatAuthorizationError();
  }
  try {
    const allowed = await options.permissions.authorizeEntity({
      actor: options.actor,
      entity: { type: session.entity_type, id: session.entity_id },
      action: END_HUDDLE_ENTITY_POLICY_ACTION,
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
 * Persists a recoverable ending intent before crossing the provider boundary,
 * then atomically commits the one canonical public ended state.
 */
export async function endHuddle(
  options: EndHuddleCommandOptions,
): Promise<EndHuddleResult> {
  validateActor(options.actor);
  const input = parseEndHuddleInput(options.input);
  if (typeof options.media?.terminateRoom !== "function") {
    throw new TypeError("A media adapter with terminateRoom is required");
  }
  const schema = validatePostgresSchema(options.schema ?? DEFAULT_POSTGRES_SCHEMA);
  const prefix = quoteIdentifier(schema);
  const idempotencyTtlMs = positiveSafeInteger(
    options.idempotencyTtlMs ?? DEFAULT_END_HUDDLE_IDEMPOTENCY_TTL_MS,
    "idempotencyTtlMs",
  );
  const outboxRetentionMs = positiveSafeInteger(
    options.outboxRetentionMs ?? DEFAULT_END_HUDDLE_OUTBOX_RETENTION_MS,
    "outboxRetentionMs",
  );
  const requestHash = hashRequest(input);
  const createId = options.createId ?? randomUUID;
  const lockKey = JSON.stringify([
    options.actor.tenantId,
    input.huddleSessionId,
    "huddle",
  ]);
  const connection = await options.database.connect();
  let lockHeld = false;
  let providerRoomReference: string | undefined;

  try {
    await connection.query(
      "SELECT pg_advisory_lock(hashtextextended($1, 0))",
      [lockKey],
    );
    lockHeld = true;
    await connection.query("BEGIN");
    const claim = await connection.query<ClaimedIdempotencyRow>(
      `SELECT * FROM ${prefix}.claim_chat_idempotency_key(
         $1, $2, $3, $4, $5,
         clock_timestamp() + ($6::double precision * interval '1 millisecond')
       )`,
      [
        options.actor.tenantId,
        options.actor.userId,
        END_HUDDLE_IDEMPOTENCY_OPERATION,
        input.idempotencyKey,
        requestHash,
        idempotencyTtlMs,
      ],
    );
    const claimed = claim.rows[0];
    if (claimed === undefined) {
      throw new EndHuddleCommandError(
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

    let session = await readEligibleSession(
      connection,
      prefix,
      options.actor,
      input.huddleSessionId,
    );
    await authorize(session, options);

    if (claimed.idempotency_state === "completed") {
      const original = parseHuddleCommandResult(
        claimed.stored_response_body,
        input,
      ) as EndHuddleResult;
      const replay = parseHuddleCommandResult(
        { ...original, reconciliationStatus: "replayed" },
        input,
        { replayOf: original },
      ) as EndHuddleResult;
      await connection.query("COMMIT");
      return replay;
    }

    if (
      session.status !== "starting" &&
      session.status !== "active" &&
      session.status !== END_HUDDLE_INTERNAL_ENDING_STATUS
    ) {
      throw new EndHuddleCommandError(
        "huddle_not_live",
        "The huddle session is not available to end",
      );
    }
    if (session.status !== END_HUDDLE_INTERNAL_ENDING_STATUS) {
      const ending = await connection.query<StoredSessionRow>(
        `UPDATE ${prefix}.chat_huddle_sessions
            SET status = $1, ended_by_user_id = $2,
                updated_at = GREATEST(clock_timestamp(), updated_at)
          WHERE tenant_id = $3 AND id = $4
            AND status IN ('starting', 'active')
        RETURNING id, conversation_id, provider_room_reference, status,
                  initiated_by_user_id, started_at, activated_at, ended_at,
                  ended_by_user_id, active_screen_share_owner_user_id,
                  NULL::text AS entity_type, NULL::text AS entity_id`,
        [
          END_HUDDLE_INTERNAL_ENDING_STATUS,
          options.actor.userId,
          options.actor.tenantId,
          input.huddleSessionId,
        ],
      );
      const persisted = ending.rows[0];
      if (persisted === undefined) {
        throw new EndHuddleCommandError(
          "huddle_not_live",
          "The huddle session is not available to end",
        );
      }
      session = { ...persisted, entity_type: session.entity_type, entity_id: session.entity_id };
    }
    providerRoomReference = session.provider_room_reference;
    await connection.query("COMMIT");

    try {
      await options.media.terminateRoom({
        actor: options.actor,
        roomId: providerRoomReference,
      });
    } catch (error) {
      throw new EndHuddleCommandError(
        "media_termination_failed",
        "The media provider could not terminate the huddle room",
        { cause: error },
      );
    }

    await connection.query("BEGIN");
    session = await readSessionForFinalization(
      connection,
      prefix,
      options.actor,
      input.huddleSessionId,
    );
    if (session.status !== END_HUDDLE_INTERNAL_ENDING_STATUS) {
      throw new EndHuddleCommandError(
        "huddle_not_live",
        "The huddle session is not available to end",
      );
    }
    const beforeParticipants = await readParticipants(
      connection,
      prefix,
      options.actor,
      input.huddleSessionId,
    );
    const previousState = liveStateFromRows(session, beforeParticipants);
    // Keep PostgreSQL microseconds through every terminal write. Wire timestamps
    // are normalized only when constructing state from the persisted rows below.
    const timestampResult = await connection.query<{ ended_at: string }>(
      "SELECT clock_timestamp()::text AS ended_at",
    );
    const endedAt = timestampResult.rows[0]?.ended_at;
    if (endedAt === undefined) {
      throw new Error("PostgreSQL returned no huddle end timestamp");
    }

    await connection.query(
      `UPDATE ${prefix}.chat_huddle_sessions
          SET active_screen_share_owner_user_id = NULL,
              updated_at = GREATEST($1::timestamptz, updated_at)
        WHERE tenant_id = $2 AND id = $3 AND status = $4`,
      [
        endedAt,
        options.actor.tenantId,
        input.huddleSessionId,
        END_HUDDLE_INTERNAL_ENDING_STATUS,
      ],
    );
    await connection.query(
      `UPDATE ${prefix}.chat_huddle_participants
          SET left_at = $1, leave_reason = $2
        WHERE tenant_id = $3 AND huddle_session_id = $4
          AND left_at IS NULL`,
      [
        endedAt,
        HUDDLE_LEAVE_REASONS.huddleEnded,
        options.actor.tenantId,
        input.huddleSessionId,
      ],
    );
    const ended = await connection.query<StoredSessionRow>(
      `UPDATE ${prefix}.chat_huddle_sessions
          SET status = 'ended', ended_at = $1,
              updated_at = GREATEST($1::timestamptz, updated_at)
        WHERE tenant_id = $2 AND id = $3 AND status = $4
      RETURNING id, conversation_id, provider_room_reference, status,
                initiated_by_user_id, started_at, activated_at, ended_at,
                ended_by_user_id, active_screen_share_owner_user_id,
                NULL::text AS entity_type, NULL::text AS entity_id`,
      [
        endedAt,
        options.actor.tenantId,
        input.huddleSessionId,
        END_HUDDLE_INTERNAL_ENDING_STATUS,
      ],
    );
    const endedSession = ended.rows[0];
    if (endedSession === undefined) {
      throw new EndHuddleCommandError(
        "huddle_not_live",
        "The huddle session is not available to end",
      );
    }
    const participants = await readParticipants(
      connection,
      prefix,
      options.actor,
      input.huddleSessionId,
    );
    const state = endedStateFromRows(endedSession, participants);
    const result = parseHuddleCommandResult(
      {
        operation: input.operation,
        outcome: "ok",
        reconciliationStatus: "applied",
        state,
      },
      input,
      { previousState },
    ) as EndHuddleResult;
    const durableEvent = { operation: input.operation, state };

    const auditEventId = createId();
    await connection.query(
      `INSERT INTO ${prefix}.chat_audit_events (
         tenant_id, event_id, actor_user_id, action, target_type, target_id,
         occurred_at, metadata, request_id
       ) VALUES ($1, $2, $3, $4, 'conversation', $5, $6, $7, $8)`,
      [
        options.actor.tenantId,
        auditEventId,
        state.endedByUserId,
        END_HUDDLE_AUDIT_ACTION,
        state.conversationId,
        state.endedAt,
        durableEvent,
        options.requestId ?? auditEventId,
      ],
    );
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
        state.conversationId,
        END_HUDDLE_OUTBOX_EVENT_TYPE,
        state.endedAt,
        durableEvent,
        outboxRetentionMs,
      ],
    );
    const completed = await connection.query(
      `UPDATE ${prefix}.chat_idempotency_keys
          SET state = 'completed', response_status = 200,
              response_body = $1,
              completed_at = statement_timestamp(),
              updated_at = statement_timestamp()
        WHERE tenant_id = $2 AND user_id = $3 AND operation_name = $4
          AND client_key = $5 AND request_hash = $6 AND state = 'pending'`,
      [
        result,
        options.actor.tenantId,
        options.actor.userId,
        END_HUDDLE_IDEMPOTENCY_OPERATION,
        input.idempotencyKey,
        requestHash,
      ],
    );
    if (completed.rowCount !== 1) {
      throw new EndHuddleCommandError(
        "idempotency_conflict",
        "The idempotent end-huddle outcome could not be completed",
      );
    }
    await connection.query("COMMIT");
    return result;
  } catch (error) {
    await rollback(connection);
    throw error;
  } finally {
    if (lockHeld) {
      await connection.query(
        "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
        [lockKey],
      ).catch(() => undefined);
    }
    connection.release();
  }
}
