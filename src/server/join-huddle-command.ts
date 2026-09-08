import { createHash, randomUUID } from "node:crypto";

import {
  parseHuddleCommandResult,
  parseJoinHuddleInput,
  validateHuddleStateTransition,
  type ActiveHuddleState,
  type HuddleFeatureDisabledResult,
  type HuddleParticipant,
  type HuddleSessionState,
  type JoinHuddleInput,
  type JoinHuddleResult,
} from "../contracts/huddle-session.js";
import type { IsoTimestamp, UserId } from "../contracts/identifiers.js";
import { CHAT_PROTOCOL_VERSION } from "../contracts/realtime.js";
import type {
  ChatMediaAdapter,
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

export const JOIN_HUDDLE_ENTITY_POLICY_ACTION = "huddle.join" as const;
export const JOIN_HUDDLE_IDEMPOTENCY_OPERATION = "huddle.join" as const;
export const JOIN_HUDDLE_OUTBOX_EVENT_TYPE = "huddle.updated" as const;
export const DEFAULT_JOIN_HUDDLE_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_JOIN_HUDDLE_OUTBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
export const JOIN_HUDDLE_PARTICIPANT_PERMISSIONS = Object.freeze({
  audio: true,
  video: true,
  screenShare: true,
});

export type JoinHuddleCommandErrorCode =
  | "idempotency_conflict"
  | "idempotency_in_progress"
  | "huddle_not_live"
  | "participant_already_joined"
  | "participant_rejoin_disallowed"
  | "media_join_unavailable";

/** Stable, provider-neutral failure suitable for a future transport boundary. */
export class JoinHuddleCommandError extends Error {
  public readonly statusCode: number;

  public constructor(
    public readonly code: JoinHuddleCommandErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "JoinHuddleCommandError";
    this.statusCode = code === "media_join_unavailable" ? 503 : 409;
  }
}

export interface JoinHuddleCommandOptions {
  readonly database: PostgresMigrationDatabase;
  readonly permissions: Pick<
    ChatPermissionAdapter<string, typeof JOIN_HUDDLE_ENTITY_POLICY_ACTION>,
    "authorizeEntity"
  >;
  /** Trusted host-session identity; caller input cannot override these values. */
  readonly actor: TrustedChatActorContext;
  /** JSON-decoded caller input, validated by the shared huddle contract. */
  readonly input: unknown;
  /** Must reflect the embedding server's normalized `features.media` value. */
  readonly mediaEnabled: boolean;
  readonly media?: ChatMediaAdapter;
  readonly schema?: string;
  readonly idempotencyTtlMs?: number;
  readonly outboxRetentionMs?: number;
  /** Supplies opaque durable event identifiers; defaults to cryptographic UUIDs. */
  readonly createId?: () => string;
  /** Deterministic descriptor-validation clock for focused tests. */
  readonly now?: () => Date;
}

interface ClaimedIdempotencyRow {
  readonly idempotency_state: string;
  readonly stored_response_reference: string | null;
}

interface EligibleSessionRow {
  readonly id: string;
  readonly conversation_id: string;
  readonly provider_room_reference: string;
  readonly status: string;
  readonly started_at: Date | string;
  readonly active_screen_share_owner_user_id: string | null;
  readonly entity_type: string | null;
  readonly entity_id: string | null;
}

interface StoredParticipantRow {
  readonly user_id: string;
  readonly joined_at: Date | string;
  readonly left_at: Date | string | null;
}

interface PendingDescriptor {
  readonly roomId: string;
  readonly state: ActiveHuddleState;
  readonly previousState: HuddleSessionState;
  readonly reconciliationStatus: "applied" | "replayed";
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

const validateMediaFeature = (value: unknown): boolean => {
  if (typeof value !== "boolean") {
    throw new TypeError("mediaEnabled must be a boolean");
  }
  return value;
};

const hashRequest = (input: JoinHuddleInput): string =>
  `sha256:${createHash("sha256")
    .update(JSON.stringify({
      operation: input.operation,
      huddleSessionId: input.huddleSessionId,
    }))
    .digest("hex")}`;

const toIsoTimestamp = (value: Date | string, label: string): IsoTimestamp => {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.valueOf())) {
    throw new Error(`PostgreSQL returned an invalid ${label}`);
  }
  return date.toISOString() as IsoTimestamp;
};

const authorizeEntity = async (
  session: EligibleSessionRow,
  options: JoinHuddleCommandOptions,
): Promise<void> => {
  if (session.entity_type === null && session.entity_id === null) return;
  if (session.entity_type === null || session.entity_id === null) {
    throw new ChatAuthorizationError();
  }
  try {
    const allowed = await options.permissions.authorizeEntity({
      actor: options.actor,
      entity: { type: session.entity_type, id: session.entity_id },
      action: JOIN_HUDDLE_ENTITY_POLICY_ACTION,
    });
    if (!allowed) throw new Error("denied");
  } catch {
    throw new ChatAuthorizationError();
  }
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
  session: EligibleSessionRow,
  participants: readonly StoredParticipantRow[],
): HuddleSessionState => {
  const common = {
    conversationId: session.conversation_id as ActiveHuddleState["conversationId"],
    huddleSessionId: session.id as ActiveHuddleState["huddleSessionId"],
    startedAt: toIsoTimestamp(session.started_at, "huddle start timestamp"),
    participants: participants.map(participantFromRow),
    screenShareOwnerUserId: session.active_screen_share_owner_user_id as UserId | null,
  };
  if (session.status === "starting") return { ...common, status: "starting" };
  if (session.status === "active") return { ...common, status: "active" };
  throw new JoinHuddleCommandError(
    "huddle_not_live",
    "The huddle session is not available to join",
  );
};

const completeIdempotency = async (
  connection: PostgresMigrationConnection,
  prefix: string,
  actor: TrustedChatActorContext,
  input: JoinHuddleInput,
  requestHash: string,
): Promise<void> => {
  const completed = await connection.query(
    `UPDATE ${prefix}.chat_idempotency_keys
        SET state = 'completed', response_status = 200,
            response_reference = $1, completed_at = statement_timestamp(),
            updated_at = statement_timestamp()
      WHERE tenant_id = $2 AND user_id = $3 AND operation_name = $4
        AND client_key = $5 AND request_hash = $6 AND state = 'pending'`,
    [
      input.huddleSessionId,
      actor.tenantId,
      actor.userId,
      JOIN_HUDDLE_IDEMPOTENCY_OPERATION,
      input.idempotencyKey,
      requestHash,
    ],
  );
  if (completed.rowCount !== 1) {
    throw new JoinHuddleCommandError(
      "idempotency_in_progress",
      "The idempotent request is already in progress",
    );
  }
};

const rollback = async (connection: PostgresMigrationConnection): Promise<void> => {
  await connection.query("ROLLBACK").catch(() => undefined);
};

const issueJoinDescriptor = async (
  media: ChatMediaAdapter,
  actor: TrustedChatActorContext,
  input: JoinHuddleInput,
  pending: PendingDescriptor,
  now: Date,
): Promise<JoinHuddleResult> => {
  try {
    const material = await media.createParticipantToken({
      actor,
      roomId: pending.roomId,
      permissions: JOIN_HUDDLE_PARTICIPANT_PERMISSIONS,
    });
    return parseHuddleCommandResult(
      {
        operation: input.operation,
        outcome: "ok",
        reconciliationStatus: pending.reconciliationStatus,
        state: pending.state,
        mediaJoin: {
          kind: "opaque_media_join",
          descriptor: material.token,
          expiresAt: material.expiresAt,
        },
      },
      input,
      { now, previousState: pending.previousState },
    ) as JoinHuddleResult;
  } catch {
    // Provider errors and raw responses are deliberately not retained as causes.
    throw new JoinHuddleCommandError(
      "media_join_unavailable",
      "The huddle join was retained, but media join material is temporarily unavailable",
    );
  }
};

/**
 * Joins one trusted actor durably, then mints exactly one short-lived opaque
 * descriptor outside the transaction. Successful idempotent replays mint a
 * fresh descriptor without repeating participant or outbox effects.
 */
export async function joinHuddle(
  options: JoinHuddleCommandOptions,
): Promise<JoinHuddleResult | HuddleFeatureDisabledResult> {
  validateActor(options.actor);
  const input = parseJoinHuddleInput(options.input);
  const mediaEnabled = validateMediaFeature(options.mediaEnabled);
  const schema = validatePostgresSchema(options.schema ?? DEFAULT_POSTGRES_SCHEMA);
  const prefix = quoteIdentifier(schema);
  const idempotencyTtlMs = positiveSafeInteger(
    options.idempotencyTtlMs ?? DEFAULT_JOIN_HUDDLE_IDEMPOTENCY_TTL_MS,
    "idempotencyTtlMs",
  );
  const outboxRetentionMs = positiveSafeInteger(
    options.outboxRetentionMs ?? DEFAULT_JOIN_HUDDLE_OUTBOX_RETENTION_MS,
    "outboxRetentionMs",
  );
  const requestHash = hashRequest(input);
  const createId = options.createId ?? randomUUID;
  const connection = await options.database.connect();
  let pending: PendingDescriptor | undefined;
  let disabled: HuddleFeatureDisabledResult | undefined;

  try {
    await connection.query("BEGIN");
    let claimed: ClaimedIdempotencyRow | undefined;
    if (mediaEnabled && options.media !== undefined) {
      const claim = await connection.query<ClaimedIdempotencyRow>(
        `SELECT * FROM ${prefix}.claim_chat_idempotency_key(
           $1, $2, $3, $4, $5,
           clock_timestamp() + ($6::double precision * interval '1 millisecond')
         )`,
        [
          options.actor.tenantId,
          options.actor.userId,
          JOIN_HUDDLE_IDEMPOTENCY_OPERATION,
          input.idempotencyKey,
          requestHash,
          idempotencyTtlMs,
        ],
      );
      claimed = claim.rows[0];
      if (claimed === undefined) {
        throw new JoinHuddleCommandError(
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
    }

    await connection.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [JSON.stringify([options.actor.tenantId, input.huddleSessionId, "huddle"])],
    );
    const eligible = await connection.query<EligibleSessionRow>(
      `SELECT session.id, session.conversation_id,
              session.provider_room_reference, session.status,
              session.started_at, session.active_screen_share_owner_user_id,
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
      [options.actor.tenantId, input.huddleSessionId, options.actor.userId],
    );
    let session = eligible.rows[0];
    if (session === undefined) throw new ChatAuthorizationError();
    await authorizeEntity(session, options);

    const beforeParticipants = await readParticipants(
      connection,
      prefix,
      options.actor,
      input.huddleSessionId,
    );
    const previousState = stateFromRows(session, beforeParticipants);

    if (!mediaEnabled || options.media === undefined) {
      disabled = parseHuddleCommandResult(
        {
          operation: input.operation,
          outcome: "feature_disabled",
          reconciliationStatus: "applied",
          feature: "huddles",
          reason: "media_unavailable",
          state: previousState,
        },
        input,
        { previousState },
      ) as HuddleFeatureDisabledResult;
      await connection.query("COMMIT");
    } else if (claimed?.idempotency_state === "completed") {
      if (claimed.stored_response_reference !== input.huddleSessionId) {
        throw new Error("Completed join-huddle outcome references another session");
      }
      const actorParticipant = beforeParticipants.find(
        (participant) => participant.user_id === options.actor.userId,
      );
      if (actorParticipant === undefined) {
        throw new Error("Completed join-huddle outcome has no durable participant");
      }
      if (actorParticipant.left_at !== null) {
        throw new JoinHuddleCommandError(
          "participant_rejoin_disallowed",
          "A participant that left this huddle cannot rejoin",
        );
      }
      if (previousState.status !== "active") {
        throw new Error("Completed join-huddle outcome is not active");
      }
      await connection.query("COMMIT");
      pending = {
        roomId: session.provider_room_reference,
        state: previousState,
        previousState,
        reconciliationStatus: "replayed",
      };
    } else if (
      previousState.status === "active" &&
      beforeParticipants.some(
        (participant) =>
          participant.user_id === options.actor.userId && participant.left_at === null,
      )
    ) {
      // A fresh key for an already-joined actor renews credentials only.
      await completeIdempotency(
        connection,
        prefix,
        options.actor,
        input,
        requestHash,
      );
      await connection.query("COMMIT");
      pending = {
        roomId: session.provider_room_reference,
        state: previousState,
        previousState,
        reconciliationStatus: "replayed",
      };
    } else {
      const actorParticipant = beforeParticipants.find(
        (participant) => participant.user_id === options.actor.userId,
      );
      if (actorParticipant !== undefined && actorParticipant.left_at === null) {
        throw new JoinHuddleCommandError("participant_already_joined", "The actor is already joined to this huddle");
      }

      const inserted = await connection.query<StoredParticipantRow>(
        `INSERT INTO ${prefix}.chat_huddle_participants (
           tenant_id, huddle_session_id, user_id
         ) VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, huddle_session_id, user_id) DO UPDATE
           SET joined_at = clock_timestamp(), left_at = NULL, leave_reason = NULL
         RETURNING user_id, joined_at, left_at`,
        [options.actor.tenantId, input.huddleSessionId, options.actor.userId],
      );
      const joined = inserted.rows[0];
      if (joined === undefined) throw new Error("Huddle participant was not persisted");
      if (session.status === "starting") {
        // Keep PostgreSQL's full timestamp precision for the durable transition.
        const activated = await connection.query<EligibleSessionRow>(
          `UPDATE ${prefix}.chat_huddle_sessions AS session
              SET status = 'active', activated_at = participant.joined_at,
                  updated_at = GREATEST(participant.joined_at, session.updated_at)
             FROM ${prefix}.chat_huddle_participants AS participant
            WHERE session.tenant_id = $1 AND session.id = $2 AND session.status = 'starting'
              AND participant.tenant_id = session.tenant_id
              AND participant.huddle_session_id = session.id
              AND participant.user_id = $3
          RETURNING session.id, session.conversation_id, session.provider_room_reference, session.status,
                    session.started_at, session.active_screen_share_owner_user_id,
                    NULL::text AS entity_type, NULL::text AS entity_id`,
          [options.actor.tenantId, input.huddleSessionId, options.actor.userId],
        );
        const activatedSession = activated.rows[0];
        if (activatedSession === undefined) {
          throw new JoinHuddleCommandError(
            "huddle_not_live",
            "The huddle session is not available to join",
          );
        }
        session = {
          ...activatedSession,
          entity_type: session.entity_type,
          entity_id: session.entity_id,
        };
      }

      const participants = [...beforeParticipants.filter((value) => value.user_id !== joined.user_id), joined];
      const state = stateFromRows(session, participants);
      if (state.status !== "active") {
        throw new Error("A joined huddle did not become active");
      }
      validateHuddleStateTransition(previousState, state, input);
      const participant = participantFromRow(joined);
      const joinedAt = toIsoTimestamp(joined.joined_at, "participant join timestamp");
      const outboxEventId = createId();
      await connection.query(
        `INSERT INTO ${prefix}.chat_outbox_events (
           event_id, protocol_version, tenant_id, stream_id, type,
           occurred_at, payload, expires_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7,
           $6::timestamptz + ($8::double precision * interval '1 millisecond')
         )`,
        [
          outboxEventId,
          CHAT_PROTOCOL_VERSION,
          options.actor.tenantId,
          session.conversation_id,
          JOIN_HUDDLE_OUTBOX_EVENT_TYPE,
          joinedAt,
          { operation: input.operation, participant, state },
          outboxRetentionMs,
        ],
      );
      await completeIdempotency(
        connection,
        prefix,
        options.actor,
        input,
        requestHash,
      );
      await connection.query("COMMIT");
      pending = {
        roomId: session.provider_room_reference,
        state,
        previousState,
        reconciliationStatus: "applied",
      };
    }
  } catch (error) {
    await rollback(connection);
    throw error;
  } finally {
    connection.release();
  }

  if (disabled !== undefined) return disabled;
  if (pending === undefined || options.media === undefined) {
    throw new Error("Join-huddle transaction produced no durable outcome");
  }
  const now = options.now?.() ?? new Date();
  if (!Number.isFinite(now.valueOf())) {
    throw new TypeError("now must return a valid Date");
  }
  return issueJoinDescriptor(options.media, options.actor, input, pending, now);
}
