import { createHash, randomUUID } from "node:crypto";

import type { IsoTimestamp } from "../contracts/identifiers.js";
import {
  parseReactionMutationInput,
  parseReactionMutationResult,
  type ReactionMutationInput,
  type ReactionMutationResult,
} from "../contracts/reaction-mutations.js";
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

export const SET_REACTION_CAPABILITY = "reaction.set" as const;
export const SET_REACTION_ENTITY_POLICY_ACTION = "reaction.set" as const;
export const SET_REACTION_IDEMPOTENCY_OPERATION = "reaction.set" as const;
export const SET_REACTION_AUDIT_ACTION = "reaction.set" as const;
export const SET_REACTION_OUTBOX_EVENT_TYPE = "reaction.updated" as const;
export const DEFAULT_SET_REACTION_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_SET_REACTION_OUTBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export type SetReactionCommandErrorCode =
  | "idempotency_conflict"
  | "idempotency_in_progress";

/** Stable command failure that is safe to translate at a future HTTP boundary. */
export class SetReactionCommandError extends Error {
  public readonly statusCode = 409;

  public constructor(
    public readonly code: SetReactionCommandErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SetReactionCommandError";
  }
}

export interface SetReactionCommandOptions {
  readonly database: PostgresMigrationDatabase;
  readonly permissions: Pick<
    ChatPermissionAdapter<
      string,
      typeof SET_REACTION_ENTITY_POLICY_ACTION
    >,
    "getCapabilities" | "authorizeEntity"
  >;
  /** Trusted host-session identity; caller input cannot override these values. */
  readonly actor: TrustedChatActorContext;
  /** JSON-decoded caller input, validated by the shared mutation contract. */
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

interface StoredMessageAccessRow {
  readonly conversation_id: string;
  readonly entity_type: string | null;
  readonly entity_id: string | null;
  readonly observed_at: Date | string;
}

interface ReactionAggregateRow {
  readonly reaction_count: string | number;
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

const validateCapabilities = (value: unknown): readonly string[] => {
  if (!Array.isArray(value) || !value.every(nonEmptyString)) {
    throw new ChatAuthorizationError();
  }
  return value;
};

const requireSetReactionCapability = async (
  options: SetReactionCommandOptions,
): Promise<void> => {
  let capabilities: readonly string[];
  try {
    capabilities = validateCapabilities(
      await options.permissions.getCapabilities({ actor: options.actor }),
    );
  } catch {
    throw new ChatAuthorizationError();
  }
  if (!capabilities.includes(SET_REACTION_CAPABILITY)) {
    throw new ChatAuthorizationError();
  }
};

const hashRequest = (input: ReactionMutationInput): string => {
  const canonical = JSON.stringify({
    operation: input.operation,
    messageId: input.messageId,
    reactionKey: input.reactionKey,
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
};

const toIsoTimestamp = (value: Date | string): IsoTimestamp => {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.valueOf())) {
    throw new Error("PostgreSQL returned an invalid reaction timestamp");
  }
  return date.toISOString() as IsoTimestamp;
};

const toNonNegativeSafeInteger = (
  value: string | number,
  label: string,
): number => {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`PostgreSQL returned an invalid ${label}`);
  }
  return number;
};

const replayStoredResult = (stored: unknown): ReactionMutationResult => {
  const canonical = parseReactionMutationResult(stored);
  return parseReactionMutationResult({
    ...canonical,
    reconciliationStatus: "replayed",
  });
};

const completeIdempotency = async (
  connection: PostgresMigrationConnection,
  prefix: string,
  options: SetReactionCommandOptions,
  input: ReactionMutationInput,
  requestHash: string,
  result: ReactionMutationResult,
  completedAt: IsoTimestamp,
): Promise<void> => {
  const completed = await connection.query(
    `UPDATE ${prefix}.chat_idempotency_keys
     SET state = 'completed',
         response_status = 200,
         response_body = $1,
         completed_at = GREATEST($2::timestamptz, created_at),
         updated_at = GREATEST($2::timestamptz, created_at)
     WHERE tenant_id = $3
       AND user_id = $4
       AND operation_name = $5
       AND client_key = $6
       AND request_hash = $7
       AND state = 'pending'`,
    [
      result,
      completedAt,
      options.actor.tenantId,
      options.actor.userId,
      SET_REACTION_IDEMPOTENCY_OPERATION,
      input.idempotencyKey,
      requestHash,
    ],
  );
  if (completed.rowCount !== 1) {
    throw new SetReactionCommandError(
      "idempotency_in_progress",
      "The idempotent request is already in progress",
    );
  }
};

const rollback = async (
  connection: PostgresMigrationConnection,
): Promise<void> => {
  await connection.query("ROLLBACK").catch(() => undefined);
};

/**
 * Ensures an actor reaction is explicitly present or absent and persists its
 * canonical aggregate plus consistency side effects in one PostgreSQL transaction.
 */
export async function setReaction(
  options: SetReactionCommandOptions,
): Promise<ReactionMutationResult> {
  validateActor(options.actor);
  const input = parseReactionMutationInput(options.input);
  const schema = validatePostgresSchema(
    options.schema ?? DEFAULT_POSTGRES_SCHEMA,
  );
  const prefix = quoteIdentifier(schema);
  const idempotencyTtlMs = positiveSafeInteger(
    options.idempotencyTtlMs ?? DEFAULT_SET_REACTION_IDEMPOTENCY_TTL_MS,
    "idempotencyTtlMs",
  );
  const outboxRetentionMs = positiveSafeInteger(
    options.outboxRetentionMs ?? DEFAULT_SET_REACTION_OUTBOX_RETENTION_MS,
    "outboxRetentionMs",
  );
  const createId = options.createId ?? randomUUID;
  const requestHash = hashRequest(input);

  await requireSetReactionCapability(options);

  const connection = await options.database.connect();
  try {
    await connection.query("BEGIN");

    const claim = await connection.query<ClaimedIdempotencyRow>(
      `SELECT *
       FROM ${prefix}.claim_chat_idempotency_key(
         $1, $2, $3, $4, $5,
         clock_timestamp() + ($6::double precision * interval '1 millisecond')
       )`,
      [
        options.actor.tenantId,
        options.actor.userId,
        SET_REACTION_IDEMPOTENCY_OPERATION,
        input.idempotencyKey,
        requestHash,
        idempotencyTtlMs,
      ],
    );
    const claimed = claim.rows[0];
    if (claimed === undefined) {
      throw new SetReactionCommandError(
        "idempotency_conflict",
        "The idempotency key was already used for a different request",
      );
    }
    if (claimed.idempotency_state === "completed") {
      if (claimed.stored_response_body === null) {
        throw new Error("Completed set-reaction outcome has no response body");
      }
      const replay = replayStoredResult(claimed.stored_response_body);
      await connection.query("COMMIT");
      return replay;
    }
    if (claimed.idempotency_state !== "pending") {
      throw new Error("PostgreSQL returned an invalid idempotency state");
    }

    const access = await connection.query<StoredMessageAccessRow>(
      `SELECT
         message.conversation_id,
         conversation.entity_type,
         conversation.entity_id,
         clock_timestamp() AS observed_at
       FROM ${prefix}.chat_messages AS message
       INNER JOIN ${prefix}.chat_conversations AS conversation
         ON conversation.tenant_id = message.tenant_id
        AND conversation.id = message.conversation_id
       LEFT JOIN ${prefix}.chat_conversation_members AS member
         ON member.tenant_id = conversation.tenant_id
        AND member.conversation_id = conversation.id
        AND member.user_id = $2
       WHERE message.tenant_id = $1
         AND message.id = $3
         AND message.deleted_at IS NULL
         AND conversation.archived_at IS NULL
         AND (
           (conversation.type = 'channel' AND conversation.visibility = 'public')
           OR member.state = 'active'
         )
       FOR UPDATE OF message, conversation`,
      [options.actor.tenantId, options.actor.userId, input.messageId],
    );
    const message = access.rows[0];
    if (message === undefined) {
      throw new ChatAuthorizationError();
    }

    if (message.entity_type !== null && message.entity_id !== null) {
      let allowed = false;
      try {
        allowed = await options.permissions.authorizeEntity({
          actor: options.actor,
          entity: { type: message.entity_type, id: message.entity_id },
          action: SET_REACTION_ENTITY_POLICY_ACTION,
        });
      } catch {
        throw new ChatAuthorizationError();
      }
      if (!allowed) {
        throw new ChatAuthorizationError();
      }
    }

    const occurredAt = toIsoTimestamp(message.observed_at);
    if (input.operation === "add_reaction") {
      await connection.query(
        `INSERT INTO ${prefix}.chat_reactions (
           tenant_id, message_id, user_id, reaction_key, created_at, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $5)
         ON CONFLICT ON CONSTRAINT chat_reactions_pkey DO NOTHING`,
        [
          options.actor.tenantId,
          input.messageId,
          options.actor.userId,
          input.reactionKey,
          occurredAt,
        ],
      );
    } else {
      await connection.query(
        `DELETE FROM ${prefix}.chat_reactions
         WHERE tenant_id = $1
           AND message_id = $2
           AND user_id = $3
           AND reaction_key = $4`,
        [
          options.actor.tenantId,
          input.messageId,
          options.actor.userId,
          input.reactionKey,
        ],
      );
    }

    const aggregate = await connection.query<ReactionAggregateRow>(
      `SELECT count(*) AS reaction_count
       FROM ${prefix}.chat_reactions
       WHERE tenant_id = $1
         AND message_id = $2
         AND reaction_key = $3`,
      [options.actor.tenantId, input.messageId, input.reactionKey],
    );
    const aggregateRow = aggregate.rows[0];
    if (aggregateRow === undefined) {
      throw new Error("PostgreSQL returned no reaction aggregate");
    }
    const count = toNonNegativeSafeInteger(
      aggregateRow.reaction_count,
      "reaction count",
    );
    const applied = parseReactionMutationResult({
      operation: input.operation,
      reconciliationStatus: "applied",
      messageId: input.messageId,
      reactionKey: input.reactionKey,
      count,
      reactedByCurrentUser: input.operation === "add_reaction",
    });

    const eventPayload = {
      ...applied,
      conversationId: message.conversation_id,
    };
    const auditMetadata = {
      conversationId: message.conversation_id,
      operation: applied.operation,
      messageId: applied.messageId,
      reactionKey: applied.reactionKey,
      count: applied.count,
      reactedByCurrentUser: applied.reactedByCurrentUser,
    };
    const auditEventId = createId();
    await connection.query(
      `INSERT INTO ${prefix}.chat_audit_events (
         tenant_id, event_id, actor_user_id, action, target_type, target_id,
         occurred_at, metadata, request_id
       )
       VALUES ($1, $2, $3, $4, 'message', $5, $6, $7, $8)`,
      [
        options.actor.tenantId,
        auditEventId,
        options.actor.userId,
        SET_REACTION_AUDIT_ACTION,
        input.messageId,
        occurredAt,
        auditMetadata,
        options.requestId ?? auditEventId,
      ],
    );

    const outboxEventId = createId();
    await connection.query(
      `INSERT INTO ${prefix}.chat_outbox_events (
         event_id, protocol_version, tenant_id, stream_id, type,
         occurred_at, payload, expires_at
       )
       VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         $6::timestamptz + ($8::double precision * interval '1 millisecond')
       )`,
      [
        outboxEventId,
        CHAT_PROTOCOL_VERSION,
        options.actor.tenantId,
        message.conversation_id,
        SET_REACTION_OUTBOX_EVENT_TYPE,
        occurredAt,
        eventPayload,
        outboxRetentionMs,
      ],
    );

    await completeIdempotency(
      connection,
      prefix,
      options,
      input,
      requestHash,
      applied,
      occurredAt,
    );

    await connection.query("COMMIT");
    return applied;
  } catch (error) {
    await rollback(connection);
    throw error;
  } finally {
    connection.release();
  }
}
