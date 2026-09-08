import { createHash, randomUUID } from "node:crypto";

import type {
  ConversationId,
  IsoTimestamp,
  MessageSequence,
  UserId,
} from "../contracts/identifiers.js";
import type { ConversationReadState } from "../contracts/member-read-state.js";
import {
  applyReadCursorMutation,
  createReadCursorUpdatedEvent,
  parseReadCursorMutationInput,
  parseReadCursorMutationResult,
  type ReadCursorMutationInput,
  type ReadCursorMutationResult,
} from "../contracts/read-cursor-mutation.js";
import { CHAT_PROTOCOL_VERSION } from "../contracts/realtime.js";
import type { ChatPermissionAdapter, TrustedChatActorContext } from "./contracts.js";
import {
  DEFAULT_POSTGRES_SCHEMA,
  validatePostgresSchema,
  type PostgresMigrationConnection,
  type PostgresMigrationDatabase,
} from "./postgres-migrations.js";
import { ChatAuthorizationError } from "./request-context.js";
import { authorizeThreadAccess } from "./thread-access.js";
import { ensureThreadParticipant } from "./thread-participant.js";

export const UPDATE_READ_CURSOR_IDEMPOTENCY_OPERATION =
  "conversation.read_cursor.update" as const;
export const DEFAULT_UPDATE_READ_CURSOR_IDEMPOTENCY_TTL_MS =
  24 * 60 * 60 * 1_000;
export const DEFAULT_UPDATE_READ_CURSOR_OUTBOX_RETENTION_MS =
  7 * 24 * 60 * 60 * 1_000;

export type UpdateReadCursorCommandErrorCode =
  | "idempotency_conflict"
  | "idempotency_in_progress";

/** Stable command failure that is safe to translate at a future HTTP boundary. */
export class UpdateReadCursorCommandError extends Error {
  public readonly statusCode = 409;

  public constructor(
    public readonly code: UpdateReadCursorCommandErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "UpdateReadCursorCommandError";
  }
}

export interface UpdateReadCursorCommandOptions {
  readonly database: PostgresMigrationDatabase;
  /** Trusted host-session identity; caller input cannot override these values. */
  readonly actor: TrustedChatActorContext;
  /** Required for entity-bound thread parents; omitted adapters fail closed. */
  readonly permissions?: Pick<
    ChatPermissionAdapter<string, "conversation.read_cursor.update">,
    "authorizeEntity"
  >;
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

interface LockedConversationRow {
  readonly current_message_sequence: string | number;
  readonly occurred_at: Date | string;
}

interface StoredCursorRow {
  readonly last_read_sequence: string | number;
  readonly manual_unread_from_sequence: string | number | null;
  readonly updated_at: Date | string;
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

const canonicalJson = (value: unknown): string => {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Read-cursor input must contain finite JSON numbers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value !== "object") {
    throw new TypeError("Read-cursor input must be JSON-compatible");
  }

  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
};

const hashRequest = (input: ReadCursorMutationInput): string => {
  const sequence =
    input.operation === "mark_read"
      ? { throughSequence: input.throughSequence }
      : { fromSequence: input.fromSequence };
  const canonical = canonicalJson({
    operation: input.operation,
    conversationId: input.conversationId,
    ...sequence,
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
};

const toIsoTimestamp = (value: Date | string, label: string): IsoTimestamp => {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.valueOf())) {
    throw new Error(`PostgreSQL returned an invalid ${label}`);
  }
  return date.toISOString() as IsoTimestamp;
};

const toSequence = (
  value: string | number,
  label: string,
): MessageSequence => {
  const sequence = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error(`PostgreSQL returned an invalid ${label}`);
  }
  return sequence as MessageSequence;
};

const toCurrentReadState = (
  row: StoredCursorRow | undefined,
  conversationId: ConversationId,
  userId: UserId,
  occurredAt: IsoTimestamp,
): ConversationReadState => {
  if (row === undefined) {
    return {
      conversationId,
      userId,
      lastReadSequence: 0,
      updatedAt: occurredAt,
    };
  }

  const base = {
    conversationId,
    userId,
    lastReadSequence: toSequence(
      row.last_read_sequence,
      "last_read_sequence",
    ),
    updatedAt: toIsoTimestamp(row.updated_at, "cursor updated_at"),
  };
  return row.manual_unread_from_sequence === null
    ? base
    : {
        ...base,
        manualUnreadFromSequence: toSequence(
          row.manual_unread_from_sequence,
          "manual_unread_from_sequence",
        ),
      };
};

const rollback = async (
  connection: PostgresMigrationConnection,
): Promise<void> => {
  await connection.query("ROLLBACK").catch(() => undefined);
};

/**
 * Atomically updates the trusted actor's durable cursor and all consistency
 * side effects. Thread access follows current parent/entity authority, while
 * child membership is retained storage and never implies following.
 */
export async function updateReadCursor(
  options: UpdateReadCursorCommandOptions,
): Promise<ReadCursorMutationResult> {
  validateActor(options.actor);
  const input = parseReadCursorMutationInput(options.input);
  const schema = validatePostgresSchema(
    options.schema ?? DEFAULT_POSTGRES_SCHEMA,
  );
  const prefix = quoteIdentifier(schema);
  const idempotencyTtlMs = positiveSafeInteger(
    options.idempotencyTtlMs ?? DEFAULT_UPDATE_READ_CURSOR_IDEMPOTENCY_TTL_MS,
    "idempotencyTtlMs",
  );
  const outboxRetentionMs = positiveSafeInteger(
    options.outboxRetentionMs ?? DEFAULT_UPDATE_READ_CURSOR_OUTBOX_RETENTION_MS,
    "outboxRetentionMs",
  );
  const createId = options.createId ?? randomUUID;
  const requestHash = hashRequest(input);

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
        UPDATE_READ_CURSOR_IDEMPOTENCY_OPERATION,
        input.idempotencyKey,
        requestHash,
        idempotencyTtlMs,
      ],
    );
    const claimed = claim.rows[0];
    if (claimed === undefined) {
      throw new UpdateReadCursorCommandError(
        "idempotency_conflict",
        "The idempotency key was already used for a different request",
      );
    }
    // Discover without locking the child first; revalidate the relationship
    // under parent-before-child locks before exposing even a completed result.
    const target = (await connection.query<{
      readonly type: string;
      readonly parent_conversation_id: string | null;
    }>(
      `SELECT type, parent_conversation_id FROM ${prefix}.chat_conversations
        WHERE tenant_id = $1 AND id = $2`,
      [options.actor.tenantId, input.conversationId],
    )).rows[0];
    const permissions = options.permissions ?? { authorizeEntity: async () => false };
    let conversation: LockedConversationRow | undefined;
    if (target?.type === "thread") {
      await connection.query(
        `SELECT id FROM ${prefix}.chat_conversations
          WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [options.actor.tenantId, target.parent_conversation_id],
      );
      conversation = (await connection.query<LockedConversationRow>(
        `SELECT current_message_sequence, clock_timestamp() AS occurred_at
           FROM ${prefix}.chat_conversations
          WHERE tenant_id = $1 AND id = $2 AND type = 'thread'
            AND parent_conversation_id = $3 AND archived_at IS NULL FOR UPDATE`,
        [options.actor.tenantId, input.conversationId, target.parent_conversation_id],
      )).rows[0];
      if (conversation === undefined) throw new ChatAuthorizationError();
      await connection.query(
        `SELECT user_id FROM ${prefix}.chat_conversation_members
          WHERE tenant_id = $1 AND conversation_id = $2 AND user_id = $3 FOR UPDATE`,
        [options.actor.tenantId, target.parent_conversation_id, options.actor.userId],
      );
      await authorizeThreadAccess({
        database: connection, schema, actor: options.actor,
        threadId: input.conversationId, operation: "read",
        entityAction: UPDATE_READ_CURSOR_IDEMPOTENCY_OPERATION, permissions,
      });
    }

    if (claimed.idempotency_state === "completed") {
      if (claimed.stored_response_body === null) {
        throw new Error("Completed update-read-cursor outcome has no response body");
      }
      const replay = parseReadCursorMutationResult(claimed.stored_response_body);
      await connection.query("COMMIT");
      return replay;
    }
    if (claimed.idempotency_state !== "pending") {
      throw new Error("PostgreSQL returned an invalid idempotency state");
    }

    if (target?.type === "thread") {
      if (conversation === undefined || target.parent_conversation_id === null) {
        throw new ChatAuthorizationError();
      }
      await ensureThreadParticipant({
        connection, schema, actor: options.actor, threadId: input.conversationId,
        parentConversationId: target.parent_conversation_id,
        entityAction: UPDATE_READ_CURSOR_IDEMPOTENCY_OPERATION, permissions,
        occurredAt: toIsoTimestamp(conversation.occurred_at, "participant setup time"),
        initialRole: "member",
      });
    } else {
      const lockedConversation = await connection.query<LockedConversationRow>(
        `SELECT
           conversation.current_message_sequence,
           clock_timestamp() AS occurred_at
         FROM ${prefix}.chat_conversations AS conversation
         INNER JOIN ${prefix}.chat_conversation_members AS member
           ON member.tenant_id = conversation.tenant_id
          AND member.conversation_id = conversation.id
          AND member.user_id = $3
          AND member.state = 'active'
         WHERE conversation.tenant_id = $1
           AND conversation.id = $2
           AND conversation.type <> 'thread'
         FOR UPDATE OF conversation, member`,
        [options.actor.tenantId, input.conversationId, options.actor.userId],
      );
      conversation = lockedConversation.rows[0];
    }
    if (conversation === undefined) {
      throw new ChatAuthorizationError();
    }

    const lockedCursor = await connection.query<StoredCursorRow>(
      `SELECT
         last_read_sequence,
         manual_unread_from_sequence,
         updated_at
       FROM ${prefix}.chat_read_cursors
       WHERE tenant_id = $1
         AND conversation_id = $2
         AND user_id = $3
       FOR UPDATE`,
      [options.actor.tenantId, input.conversationId, options.actor.userId],
    );
    const occurredAt = toIsoTimestamp(
      conversation.occurred_at,
      "cursor mutation time",
    );
    const latestSequence = toSequence(
      conversation.current_message_sequence,
      "current_message_sequence",
    );
    const currentReadState = toCurrentReadState(
      lockedCursor.rows[0],
      input.conversationId,
      options.actor.userId as UserId,
      occurredAt,
    );
    // updatedAt is the existing ordering token for equal-sequence cursor changes.
    // Advance at serialized millisecond precision, even if the cursor is ahead of
    // database time. Keep occurredAt as wall-clock time for events and TTLs.
    const updatedAt = lockedCursor.rows[0] === undefined
      ? occurredAt
      : toIsoTimestamp(
          new Date(Math.max(
            Date.parse(occurredAt),
            Date.parse(currentReadState.updatedAt) + 1,
          )),
          "next cursor updated_at",
        );
    const result = parseReadCursorMutationResult(
      applyReadCursorMutation(input, {
        currentReadState,
        latestSequence,
        updatedAt,
      }),
    );
    const marker = result.readState.manualUnreadFromSequence ?? null;

    if (lockedCursor.rows[0] === undefined) {
      await connection.query(
        `INSERT INTO ${prefix}.chat_read_cursors (
           tenant_id, conversation_id, user_id, last_read_sequence,
           manual_unread_from_sequence, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          options.actor.tenantId,
          input.conversationId,
          options.actor.userId,
          result.readState.lastReadSequence,
          marker,
          result.readState.updatedAt,
        ],
      );
    } else {
      const updated = await connection.query(
        `UPDATE ${prefix}.chat_read_cursors
         SET last_read_sequence = $1,
             manual_unread_from_sequence = $2,
             updated_at = $3
         WHERE tenant_id = $4
           AND conversation_id = $5
           AND user_id = $6`,
        [
          result.readState.lastReadSequence,
          marker,
          result.readState.updatedAt,
          options.actor.tenantId,
          input.conversationId,
          options.actor.userId,
        ],
      );
      if (updated.rowCount !== 1) {
        throw new ChatAuthorizationError();
      }
    }

    const auditEventId = createId();
    await connection.query(
      `INSERT INTO ${prefix}.chat_audit_events (
         tenant_id, event_id, actor_user_id, action, target_type, target_id,
         occurred_at, metadata, request_id
       )
       VALUES (
         $1, $2, $3, 'conversation.read_cursor_updated',
         'conversation', $4, $5, $6, $7
       )`,
      [
        options.actor.tenantId,
        auditEventId,
        options.actor.userId,
        input.conversationId,
        occurredAt,
        {
          operation: result.operation,
          previousLastReadSequence: currentReadState.lastReadSequence,
          lastReadSequence: result.readState.lastReadSequence,
          manualUnreadFromSequence: marker,
          latestSequence: result.latestSequence,
          unreadCount: result.unreadCount,
        },
        options.requestId ?? auditEventId,
      ],
    );

    const outboxEventId = createId();
    const event = createReadCursorUpdatedEvent({
      eventId: outboxEventId,
      protocolVersion: CHAT_PROTOCOL_VERSION,
      tenantId: options.actor.tenantId,
      occurredAt,
      result,
    });
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
        event.eventId,
        event.protocolVersion,
        event.tenantId,
        event.streamId,
        event.type,
        event.occurredAt,
        event.payload,
        outboxRetentionMs,
      ],
    );

    // occurredAt loses PostgreSQL's submillisecond precision when serialized.
    // Completion must not precede the claim; retain its original expiry.
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
        occurredAt,
        options.actor.tenantId,
        options.actor.userId,
        UPDATE_READ_CURSOR_IDEMPOTENCY_OPERATION,
        input.idempotencyKey,
        requestHash,
      ],
    );
    if (completed.rowCount !== 1) {
      throw new UpdateReadCursorCommandError(
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
