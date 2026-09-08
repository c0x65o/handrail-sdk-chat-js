import { createHash, randomUUID } from "node:crypto";

import {
  parseHuddleCommandResult,
  parseStartHuddleInput,
  type HuddleFeatureDisabledResult,
  type HuddleSessionId,
  type StartHuddleInput,
  type StartHuddleResult,
  type StartingHuddleState,
} from "../contracts/huddle-session.js";
import type { IsoTimestamp } from "../contracts/identifiers.js";
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

export const START_HUDDLE_CAPABILITY = "huddle.start" as const;
export const START_HUDDLE_ENTITY_POLICY_ACTION = "huddle.start" as const;
export const START_HUDDLE_IDEMPOTENCY_OPERATION = "huddle.start" as const;
export const START_HUDDLE_AUDIT_ACTION = "huddle.started" as const;
export const START_HUDDLE_OUTBOX_EVENT_TYPE = "huddle.updated" as const;
export const DEFAULT_START_HUDDLE_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_START_HUDDLE_OUTBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export type StartHuddleCommandErrorCode =
  | "idempotency_conflict"
  | "idempotency_in_progress"
  | "huddle_already_active"
  | "media_room_creation_failed"
  | "media_join_unavailable"
  | "media_compensation_failed"
  | "commit_outcome_uncertain";

/** Stable, provider-neutral failure suitable for a future transport boundary. */
export class StartHuddleCommandError extends Error {
  public readonly statusCode: number;

  public constructor(
    public readonly code: StartHuddleCommandErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "StartHuddleCommandError";
    this.statusCode = code.startsWith("idempotency_") || code === "huddle_already_active"
      ? 409
      : 503;
  }
}

export interface StartHuddleCommandOptions {
  readonly database: PostgresMigrationDatabase;
  readonly permissions: Pick<
    ChatPermissionAdapter<string, typeof START_HUDDLE_ENTITY_POLICY_ACTION>,
    "getCapabilities" | "authorizeEntity"
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
  /** Trusted transport correlation id used only by the existing audit record. */
  readonly requestId?: string;
  /** Supplies opaque durable identifiers; defaults to cryptographic UUIDs. */
  readonly createId?: () => string;
  /** Deterministic contract-validation clock for focused tests. */
  readonly now?: () => Date;
}

interface ClaimedIdempotencyRow {
  readonly idempotency_state: string;
  readonly stored_response_reference: string | null;
}

interface EligibleConversationRow {
  readonly entity_type: string | null;
  readonly entity_id: string | null;
}

interface StoredSessionRow {
  readonly id: string;
  readonly conversation_id: string;
  readonly provider_room_reference: string;
  readonly status: string;
  readonly started_at: Date | string;
}

interface PendingResult {
  readonly session: StoredSessionRow;
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

const hashRequest = (input: StartHuddleInput): string =>
  `sha256:${createHash("sha256")
    .update(JSON.stringify({
      operation: input.operation,
      conversationId: input.conversationId,
    }))
    .digest("hex")}`;

const toIsoTimestamp = (value: Date | string, label: string): IsoTimestamp => {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.valueOf())) {
    throw new Error(`PostgreSQL returned an invalid ${label}`);
  }
  return date.toISOString() as IsoTimestamp;
};

const validateRoomReference = (value: unknown): string => {
  if (
    !nonEmptyString(value) ||
    Buffer.byteLength(value, "utf8") > 2_048
  ) {
    throw new StartHuddleCommandError(
      "media_room_creation_failed",
      "The media provider returned an invalid room reference",
    );
  }
  return value;
};

const requireStartCapability = async (
  actor: TrustedChatActorContext,
  permissions: StartHuddleCommandOptions["permissions"],
): Promise<void> => {
  try {
    const capabilities = await permissions.getCapabilities({ actor });
    if (
      !Array.isArray(capabilities) ||
      !capabilities.every(nonEmptyString) ||
      !capabilities.includes(START_HUDDLE_CAPABILITY)
    ) {
      throw new Error("denied");
    }
  } catch {
    throw new ChatAuthorizationError();
  }
};

const authorizeEntity = async (
  conversation: EligibleConversationRow,
  actor: TrustedChatActorContext,
  permissions: StartHuddleCommandOptions["permissions"],
): Promise<void> => {
  if (conversation.entity_type === null && conversation.entity_id === null) return;
  if (conversation.entity_type === null || conversation.entity_id === null) {
    throw new ChatAuthorizationError();
  }
  try {
    const allowed = await permissions.authorizeEntity({
      actor,
      entity: {
        type: conversation.entity_type,
        id: conversation.entity_id,
      },
      action: START_HUDDLE_ENTITY_POLICY_ACTION,
    });
    if (!allowed) throw new Error("denied");
  } catch {
    throw new ChatAuthorizationError();
  }
};

const inactiveFeatureResult = (
  input: StartHuddleInput,
): HuddleFeatureDisabledResult =>
  parseHuddleCommandResult(
    {
      operation: input.operation,
      outcome: "feature_disabled",
      reconciliationStatus: "applied",
      feature: "huddles",
      reason: "media_unavailable",
      state: { status: "inactive", conversationId: input.conversationId },
    },
    input,
  ) as HuddleFeatureDisabledResult;

const stateFromSession = (
  row: StoredSessionRow,
  expectedConversationId: string,
): StartingHuddleState => {
  if (
    row.status !== "starting" ||
    row.conversation_id !== expectedConversationId ||
    !nonEmptyString(row.id) ||
    !nonEmptyString(row.provider_room_reference)
  ) {
    throw new StartHuddleCommandError(
      "huddle_already_active",
      "The conversation already has a live huddle",
    );
  }
  return {
    status: "starting",
    conversationId: row.conversation_id as StartingHuddleState["conversationId"],
    huddleSessionId: row.id as HuddleSessionId,
    startedAt: toIsoTimestamp(row.started_at, "huddle start timestamp"),
    participants: [],
    screenShareOwnerUserId: null,
  };
};

const persistOutcome = async (
  connection: PostgresMigrationConnection,
  prefix: string,
  actor: TrustedChatActorContext,
  input: StartHuddleInput,
  requestHash: string,
  sessionId: string,
): Promise<void> => {
  const completed = await connection.query(
    `UPDATE ${prefix}.chat_idempotency_keys
        SET state = 'completed', response_status = 200,
            response_reference = $1, completed_at = statement_timestamp(),
            updated_at = statement_timestamp()
      WHERE tenant_id = $2 AND user_id = $3 AND operation_name = $4
        AND client_key = $5 AND request_hash = $6 AND state = 'pending'`,
    [
      sessionId,
      actor.tenantId,
      actor.userId,
      START_HUDDLE_IDEMPOTENCY_OPERATION,
      input.idempotencyKey,
      requestHash,
    ],
  );
  if (completed.rowCount !== 1) {
    throw new StartHuddleCommandError(
      "idempotency_in_progress",
      "The idempotent request is already in progress",
    );
  }
};

const rollback = async (
  connection: PostgresMigrationConnection,
): Promise<boolean> => {
  try {
    await connection.query("ROLLBACK");
    return true;
  } catch {
    return false;
  }
};

const terminateOrphan = async (
  media: ChatMediaAdapter,
  actor: TrustedChatActorContext,
  roomId: string,
  cause: unknown,
): Promise<never> => {
  try {
    await media.terminateRoom({ actor, roomId });
  } catch (compensationError) {
    throw new StartHuddleCommandError(
      "media_compensation_failed",
      "A rolled-back media room could not be terminated",
      { cause: compensationError },
    );
  }
  throw cause;
};

const reconcileCommittedRoom = async (
  database: PostgresMigrationDatabase,
  prefix: string,
  actor: TrustedChatActorContext,
  sessionId: string,
  roomId: string,
): Promise<StoredSessionRow | undefined> => {
  const result = await database.query<StoredSessionRow>(
    `SELECT id, conversation_id, provider_room_reference, status, started_at
       FROM ${prefix}.chat_huddle_sessions
      WHERE tenant_id = $1 AND id = $2 AND provider_room_reference = $3`,
    [actor.tenantId, sessionId, roomId],
  );
  return result.rows[0];
};

const issueJoinMaterial = async (
  media: ChatMediaAdapter,
  actor: TrustedChatActorContext,
  input: StartHuddleInput,
  pending: PendingResult,
  now: Date,
): Promise<StartHuddleResult> => {
  const state = stateFromSession(pending.session, input.conversationId);
  try {
    const material = await media.createParticipantToken({
      actor,
      roomId: pending.session.provider_room_reference,
      permissions: { audio: true, video: true, screenShare: true },
    });
    return parseHuddleCommandResult(
      {
        operation: input.operation,
        outcome: "ok",
        reconciliationStatus: pending.reconciliationStatus,
        state,
        mediaJoin: {
          kind: "opaque_media_join",
          descriptor: material.token,
          expiresAt: material.expiresAt,
        },
      },
      input,
      { now },
    ) as StartHuddleResult;
  } catch (error) {
    throw new StartHuddleCommandError(
      "media_join_unavailable",
      "Huddle start was retained, but media join material is temporarily unavailable",
      { cause: error },
    );
  }
};

/**
 * Reserves one tenant-conversation huddle and crosses the provider boundary
 * exactly once. The initiator is not joined and provider credentials are never
 * written to PostgreSQL.
 */
export async function startHuddle(
  options: StartHuddleCommandOptions,
): Promise<StartHuddleResult | HuddleFeatureDisabledResult> {
  validateActor(options.actor);
  const input = parseStartHuddleInput(options.input);
  const mediaEnabled = validateMediaFeature(options.mediaEnabled);
  if (!mediaEnabled || options.media === undefined) {
    return inactiveFeatureResult(input);
  }

  await requireStartCapability(options.actor, options.permissions);

  const schema = validatePostgresSchema(options.schema ?? DEFAULT_POSTGRES_SCHEMA);
  const prefix = quoteIdentifier(schema);
  const idempotencyTtlMs = positiveSafeInteger(
    options.idempotencyTtlMs ?? DEFAULT_START_HUDDLE_IDEMPOTENCY_TTL_MS,
    "idempotencyTtlMs",
  );
  const outboxRetentionMs = positiveSafeInteger(
    options.outboxRetentionMs ?? DEFAULT_START_HUDDLE_OUTBOX_RETENTION_MS,
    "outboxRetentionMs",
  );
  const requestHash = hashRequest(input);
  const createId = options.createId ?? randomUUID;
  const media = options.media;
  const connection = await options.database.connect();
  let createdRoomId: string | undefined;
  let createdSessionId: string | undefined;
  let commitAttempted = false;
  let pending: PendingResult | undefined;

  try {
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
          START_HUDDLE_IDEMPOTENCY_OPERATION,
          input.idempotencyKey,
          requestHash,
          idempotencyTtlMs,
        ],
      );
      const claimed = claim.rows[0];
      if (claimed === undefined) {
        throw new StartHuddleCommandError(
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
        [JSON.stringify([options.actor.tenantId, input.conversationId, "huddle"])],
      );
      const eligible = await connection.query<EligibleConversationRow>(
        `SELECT COALESCE(conversation.entity_type, parent.entity_type) AS entity_type,
                COALESCE(conversation.entity_id, parent.entity_id) AS entity_id
           FROM ${prefix}.chat_conversations AS conversation
           INNER JOIN ${prefix}.chat_conversation_members AS member
             ON member.tenant_id = conversation.tenant_id
            AND member.conversation_id = conversation.id
            AND member.user_id = $3
            AND member.state = 'active'
           LEFT JOIN ${prefix}.chat_conversations AS parent
             ON parent.tenant_id = conversation.tenant_id
            AND parent.id = conversation.parent_conversation_id
          WHERE conversation.tenant_id = $1
            AND conversation.id = $2
            AND conversation.archived_at IS NULL
          FOR UPDATE OF conversation`,
        [options.actor.tenantId, input.conversationId, options.actor.userId],
      );
      const conversation = eligible.rows[0];
      if (conversation === undefined) throw new ChatAuthorizationError();
      await authorizeEntity(conversation, options.actor, options.permissions);

      let session: StoredSessionRow | undefined;
      let reconciliationStatus: PendingResult["reconciliationStatus"] = "applied";
      if (claimed.idempotency_state === "completed") {
        if (!nonEmptyString(claimed.stored_response_reference)) {
          throw new Error("Completed start-huddle outcome has no session reference");
        }
        const replay = await connection.query<StoredSessionRow>(
          `SELECT id, conversation_id, provider_room_reference, status, started_at
             FROM ${prefix}.chat_huddle_sessions
            WHERE tenant_id = $1 AND id = $2 AND conversation_id = $3`,
          [
            options.actor.tenantId,
            claimed.stored_response_reference,
            input.conversationId,
          ],
        );
        session = replay.rows[0];
        if (session !== undefined && session.status !== "starting") {
          // A replay preserves the originally accepted start result even if a
          // later lifecycle command has advanced the durable session.
          session = { ...session, status: "starting" };
        }
        reconciliationStatus = "replayed";
      } else {
        const live = await connection.query<StoredSessionRow>(
          `SELECT id, conversation_id, provider_room_reference, status, started_at
             FROM ${prefix}.chat_huddle_sessions
            WHERE tenant_id = $1 AND conversation_id = $2
              AND status IN ('starting', 'active', 'ending')
            LIMIT 1`,
          [options.actor.tenantId, input.conversationId],
        );
        session = live.rows[0];
      }

      if (session !== undefined) {
        const state = stateFromSession(session, input.conversationId);
        if (claimed.idempotency_state === "pending") {
          await persistOutcome(
            connection,
            prefix,
            options.actor,
            input,
            requestHash,
            state.huddleSessionId,
          );
        }
        commitAttempted = true;
        await connection.query("COMMIT");
        pending = { session, reconciliationStatus };
      } else if (claimed.idempotency_state === "completed") {
        throw new Error("Completed start-huddle outcome references no durable session");
      } else {
        createdSessionId = createId();
        let room;
        try {
          room = await media.createRoom({
            actor: options.actor,
            conversationId: input.conversationId,
          });
        } catch (error) {
          throw new StartHuddleCommandError(
            "media_room_creation_failed",
            "The media provider could not create a huddle room",
            { cause: error },
          );
        }
        createdRoomId = validateRoomReference(room.roomId);
        const inserted = await connection.query<StoredSessionRow>(
          `INSERT INTO ${prefix}.chat_huddle_sessions (
             tenant_id, id, conversation_id, provider_room_reference,
             status, initiated_by_user_id
           ) VALUES ($1, $2, $3, $4, 'starting', $5)
           RETURNING id, conversation_id, provider_room_reference, status, started_at`,
          [
            options.actor.tenantId,
            createdSessionId,
            input.conversationId,
            createdRoomId,
            options.actor.userId,
          ],
        );
        session = inserted.rows[0];
        if (session === undefined) throw new Error("Huddle session was not persisted");
        const state = stateFromSession(session, input.conversationId);
        const metadata = {
          conversationId: input.conversationId,
          huddleSessionId: state.huddleSessionId,
          status: state.status,
          startedAt: state.startedAt,
          initiatedByUserId: options.actor.userId,
        };

        const auditEventId = createId();
        await connection.query(
          `INSERT INTO ${prefix}.chat_audit_events (
             tenant_id, event_id, actor_user_id, action, target_type, target_id,
             occurred_at, metadata, request_id
           ) VALUES ($1, $2, $3, $4, 'conversation', $5, $6, $7, $8)`,
          [
            options.actor.tenantId,
            auditEventId,
            options.actor.userId,
            START_HUDDLE_AUDIT_ACTION,
            input.conversationId,
            state.startedAt,
            metadata,
            options.requestId ?? auditEventId,
          ],
        );

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
            input.conversationId,
            START_HUDDLE_OUTBOX_EVENT_TYPE,
            state.startedAt,
            { operation: input.operation, state },
            outboxRetentionMs,
          ],
        );
        await persistOutcome(
          connection,
          prefix,
          options.actor,
          input,
          requestHash,
          state.huddleSessionId,
        );

        commitAttempted = true;
        await connection.query("COMMIT");
        pending = { session, reconciliationStatus: "applied" };
      }
    } catch (error) {
      const rolledBack = await rollback(connection);
      if (createdRoomId === undefined || createdSessionId === undefined) {
        throw error;
      }
      if (!rolledBack) {
        throw new StartHuddleCommandError(
          "commit_outcome_uncertain",
          "The huddle database outcome could not be reconciled safely",
          { cause: error },
        );
      }
      if (commitAttempted) {
        let durable: StoredSessionRow | undefined;
        try {
          durable = await reconcileCommittedRoom(
            options.database,
            prefix,
            options.actor,
            createdSessionId,
            createdRoomId,
          );
        } catch (reconciliationError) {
          throw new StartHuddleCommandError(
            "commit_outcome_uncertain",
            "The huddle database outcome could not be reconciled safely",
            { cause: reconciliationError },
          );
        }
        if (durable !== undefined) {
          pending = { session: durable, reconciliationStatus: "applied" };
        } else {
          await terminateOrphan(media, options.actor, createdRoomId, error);
        }
      } else {
        await terminateOrphan(media, options.actor, createdRoomId, error);
      }
    }
  } finally {
    connection.release();
  }

  if (pending === undefined) {
    throw new Error("Start-huddle transaction produced no durable outcome");
  }
  const now = options.now?.() ?? new Date();
  if (!Number.isFinite(now.valueOf())) {
    throw new TypeError("now must return a valid Date");
  }
  return issueJoinMaterial(media, options.actor, input, pending, now);
}
