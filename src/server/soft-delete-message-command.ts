import { createHash, randomUUID } from "node:crypto";

import type {
  ConversationId,
  IsoTimestamp,
  MessageId,
  MessageSequence,
  TenantId,
  UserId,
} from "../contracts/identifiers.js";
import {
  parseSoftDeleteMessageInput,
  parseSoftDeleteMessageResult,
  type SoftDeleteMessageInput,
  type SoftDeleteMessageResult,
} from "../contracts/message-mutations.js";
import type {
  Message,
  MessageBlock,
  MessageContent,
  ThreadSummary,
} from "../contracts/message.js";
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

/** Host capability that permits moderation deletion of another user's message. */
export const SOFT_DELETE_MESSAGE_MODERATION_CAPABILITY =
  "message.delete" as const;
export const SOFT_DELETE_MESSAGE_IDEMPOTENCY_OPERATION =
  "message.soft_delete" as const;
export const DEFAULT_SOFT_DELETE_MESSAGE_IDEMPOTENCY_TTL_MS =
  24 * 60 * 60 * 1_000;
export const DEFAULT_SOFT_DELETE_MESSAGE_OUTBOX_RETENTION_MS =
  7 * 24 * 60 * 60 * 1_000;

export type SoftDeleteMessageCommandErrorCode =
  | "idempotency_conflict"
  | "idempotency_in_progress";

/** Stable command failure that is safe to translate at a future HTTP boundary. */
export class SoftDeleteMessageCommandError extends Error {
  public readonly statusCode = 409;

  public constructor(
    public readonly code: SoftDeleteMessageCommandErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SoftDeleteMessageCommandError";
  }
}

export interface SoftDeleteMessageCommandOptions<
  Block extends MessageBlock = MessageBlock,
> {
  readonly database: PostgresMigrationDatabase;
  readonly permissions: Pick<
    ChatPermissionAdapter<string>,
    "getCapabilities"
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

interface StoredThreadSummary {
  readonly threadId: string;
  readonly replyCount: number;
  readonly participantIds: readonly string[];
  readonly unreadCount: number;
  readonly lastReplyAt?: string;
}

interface StoredMessageRow {
  readonly id: string;
  readonly conversation_id: string;
  readonly sequence: string | number;
  readonly author_user_id: string;
  readonly client_message_id: string;
  readonly reply_to_message_id: string | null;
  readonly reply_notify_author: boolean;
  readonly content: unknown;
  readonly current_revision: string | number;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly edited_at: Date | string | null;
  readonly edited_by_user_id: string | null;
  readonly deleted_at: Date | string | null;
  readonly deleted_by_user_id: string | null;
  readonly observed_at: Date | string;
  readonly thread_summary: StoredThreadSummary | null;
}

interface ClaimedIdempotencyRow {
  readonly idempotency_state: string;
  readonly stored_response_body: unknown | null;
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

const authorizeDeletion = async (
  authorUserId: string,
  options: SoftDeleteMessageCommandOptions,
): Promise<void> => {
  if (authorUserId === options.actor.userId) return;

  let capabilities: readonly string[];
  try {
    capabilities = validateCapabilities(
      await options.permissions.getCapabilities({ actor: options.actor }),
    );
  } catch {
    throw new ChatAuthorizationError();
  }
  if (!capabilities.includes(SOFT_DELETE_MESSAGE_MODERATION_CAPABILITY)) {
    throw new ChatAuthorizationError();
  }
};

const hashRequest = (input: SoftDeleteMessageInput): string => {
  const canonical = JSON.stringify({
    operation: input.operation,
    messageId: input.messageId,
    expectedRevision: input.expectedRevision,
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

const toSafeInteger = (
  value: string | number,
  label: string,
  minimum: number,
): number => {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) {
    throw new Error(`PostgreSQL returned an invalid ${label}`);
  }
  return number;
};

const toThreadSummary = (stored: StoredThreadSummary): ThreadSummary => ({
  threadId: stored.threadId as ConversationId,
  replyCount: toSafeInteger(stored.replyCount, "thread reply count", 0),
  participantIds: Object.freeze(
    stored.participantIds.map((userId) => userId as UserId),
  ),
  unreadCount: toSafeInteger(stored.unreadCount, "thread unread count", 0),
  ...(stored.lastReplyAt === undefined
    ? {}
    : {
        lastReplyAt: toIsoTimestamp(
          stored.lastReplyAt,
          "thread last reply time",
        ),
      }),
});

const toMessage = <Block extends MessageBlock>(
  row: StoredMessageRow,
  tenantId: TenantId,
): Message<Block> => {
  const edited =
    row.edited_at === null || row.edited_by_user_id === null
      ? {}
      : {
          editedAt: toIsoTimestamp(row.edited_at, "message edited_at"),
          editedByUserId: row.edited_by_user_id as UserId,
        };
  const base = {
    id: row.id as MessageId,
    tenantId,
    conversationId: row.conversation_id as ConversationId,
    author: { type: "user" as const, userId: row.author_user_id as UserId },
    ...(row.reply_to_message_id === null
      ? {}
      : {
          replyTo: {
            messageId: row.reply_to_message_id as MessageId,
            notifyAuthor: row.reply_notify_author === true,
          },
        }),
    sequence: toSafeInteger(
      row.sequence,
      "message sequence",
      1,
    ) as MessageSequence,
    createdAt: toIsoTimestamp(row.created_at, "message created_at"),
    updatedAt: toIsoTimestamp(row.updated_at, "message updated_at"),
    revision: {
      revision: toSafeInteger(
        row.current_revision,
        "message revision",
        1,
      ),
      ...edited,
    },
    ...(row.thread_summary === null
      ? {}
      : { threadSummary: toThreadSummary(row.thread_summary) }),
  };
  const isDeleted =
    row.deleted_at !== null && row.deleted_by_user_id !== null;
  if (isDeleted) {
    return {
      ...base,
      content: null,
      deletedAt: toIsoTimestamp(row.deleted_at, "message deleted_at"),
      deletedByUserId: row.deleted_by_user_id as UserId,
    };
  }
  if (
    row.content === null ||
    row.deleted_at !== null ||
    row.deleted_by_user_id !== null
  ) {
    throw new Error("PostgreSQL returned an inconsistent active message");
  }
  return { ...base, content: row.content as MessageContent<Block> };
};

const replayStoredResult = <Block extends MessageBlock>(
  stored: unknown,
): SoftDeleteMessageResult<Block> => {
  const canonical = parseSoftDeleteMessageResult<Block>(stored);
  if (canonical.reconciliationStatus === "revision_conflict") return canonical;
  return parseSoftDeleteMessageResult<Block>({
    ...canonical,
    reconciliationStatus: "replayed",
  });
};

const completeIdempotency = async (
  connection: PostgresMigrationConnection,
  prefix: string,
  options: SoftDeleteMessageCommandOptions,
  input: SoftDeleteMessageInput,
  requestHash: string,
  result: SoftDeleteMessageResult,
  responseStatus: number,
  completedAt: IsoTimestamp,
): Promise<void> => {
  const completed = await connection.query(
    `UPDATE ${prefix}.chat_idempotency_keys
     SET state = 'completed', response_status = $1, response_body = $2,
         completed_at = GREATEST($3::timestamptz, created_at),
         updated_at = GREATEST($3::timestamptz, created_at)
     WHERE tenant_id = $4 AND user_id = $5 AND operation_name = $6
       AND client_key = $7 AND request_hash = $8 AND state = 'pending'`,
    [
      responseStatus,
      result,
      completedAt,
      options.actor.tenantId,
      options.actor.userId,
      SOFT_DELETE_MESSAGE_IDEMPOTENCY_OPERATION,
      input.idempotencyKey,
      requestHash,
    ],
  );
  if (completed.rowCount !== 1) {
    throw new SoftDeleteMessageCommandError(
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
 * Authorizes and atomically redacts one active message while retaining its
 * immutable identity, sequence, edited metadata, revisions, and thread state.
 */
export async function softDeleteMessage<
  Block extends MessageBlock = MessageBlock,
>(
  options: SoftDeleteMessageCommandOptions<Block>,
): Promise<SoftDeleteMessageResult<Block>> {
  validateActor(options.actor);
  const input = parseSoftDeleteMessageInput(options.input);
  const schema = validatePostgresSchema(
    options.schema ?? DEFAULT_POSTGRES_SCHEMA,
  );
  const prefix = quoteIdentifier(schema);
  const idempotencyTtlMs = positiveSafeInteger(
    options.idempotencyTtlMs ??
      DEFAULT_SOFT_DELETE_MESSAGE_IDEMPOTENCY_TTL_MS,
    "idempotencyTtlMs",
  );
  const outboxRetentionMs = positiveSafeInteger(
    options.outboxRetentionMs ??
      DEFAULT_SOFT_DELETE_MESSAGE_OUTBOX_RETENTION_MS,
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
        SOFT_DELETE_MESSAGE_IDEMPOTENCY_OPERATION,
        input.idempotencyKey,
        requestHash,
        idempotencyTtlMs,
      ],
    );
    const claimed = claim.rows[0];
    if (claimed === undefined) {
      throw new SoftDeleteMessageCommandError(
        "idempotency_conflict",
        "The idempotency key was already used for a different request",
      );
    }
    if (claimed.idempotency_state === "completed") {
      if (claimed.stored_response_body === null) {
        throw new Error("Completed soft-delete outcome has no response body");
      }
      const replay = replayStoredResult<Block>(claimed.stored_response_body);
      await connection.query("COMMIT");
      return replay;
    }
    if (claimed.idempotency_state !== "pending") {
      throw new Error("PostgreSQL returned an invalid idempotency state");
    }

    const locked = await connection.query<StoredMessageRow>(
      `SELECT
         message.id, message.conversation_id, message.sequence,
         message.author_user_id, message.client_message_id, message.content,
         message.reply_to_message_id, message.reply_notify_author,
         message.current_revision, message.created_at, message.updated_at,
         message.edited_at, message.edited_by_user_id, message.deleted_at,
         message.deleted_by_user_id, clock_timestamp() AS observed_at,
         thread_data.summary AS thread_summary
       FROM ${prefix}.chat_messages AS message
       LEFT JOIN LATERAL (
         SELECT jsonb_strip_nulls(jsonb_build_object(
           'threadId', thread.id,
           'replyCount', count(reply.id)::integer,
           'participantIds', COALESCE(
             array_agg(DISTINCT reply.author_user_id ORDER BY reply.author_user_id)
               FILTER (WHERE reply.author_user_id IS NOT NULL),
             ARRAY[]::text[]
           ),
           'unreadCount', (
             CASE
               WHEN thread_member.state = 'active'
                 OR thread_follow.is_following IS TRUE
               THEN count(reply.id) FILTER (
                 WHERE reply.sequence > CASE
                   WHEN read_cursor.manual_unread_from_sequence IS NULL
                     THEN COALESCE(read_cursor.last_read_sequence, 0)
                   ELSE LEAST(
                     COALESCE(read_cursor.last_read_sequence, 0),
                     read_cursor.manual_unread_from_sequence - 1
                   )
                 END
               )
               ELSE 0
             END
           )::integer,
           'lastReplyAt', to_char(
             max(reply.created_at) AT TIME ZONE 'UTC',
             'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
           )
         )) AS summary
         FROM ${prefix}.chat_conversations AS thread
         LEFT JOIN ${prefix}.chat_messages AS reply
           ON reply.tenant_id = thread.tenant_id
          AND reply.conversation_id = thread.id
         LEFT JOIN ${prefix}.chat_conversation_members AS thread_member
           ON thread_member.tenant_id = thread.tenant_id
          AND thread_member.conversation_id = thread.id
          AND thread_member.user_id = $3
         LEFT JOIN ${prefix}.chat_read_cursors AS read_cursor
           ON read_cursor.tenant_id = thread.tenant_id
          AND read_cursor.conversation_id = thread.id
          AND read_cursor.user_id = $3
         LEFT JOIN ${prefix}.chat_thread_follows AS thread_follow
           ON thread_follow.tenant_id = thread.tenant_id
          AND thread_follow.conversation_id = thread.id
          AND thread_follow.user_id = $3
         WHERE thread.tenant_id = message.tenant_id
           AND thread.type = 'thread'
           AND thread.parent_conversation_id = message.conversation_id
           AND thread.root_message_id = message.id
         GROUP BY
           thread.id,
           thread_member.state,
           thread_follow.is_following,
           read_cursor.last_read_sequence,
           read_cursor.manual_unread_from_sequence
         ORDER BY thread.id
         LIMIT 1
       ) AS thread_data ON true
       WHERE message.tenant_id = $1
         AND message.id = $2
         AND message.deleted_at IS NULL
       FOR UPDATE OF message`,
      [options.actor.tenantId, input.messageId, options.actor.userId],
    );
    const current = locked.rows[0];
    if (current === undefined) {
      throw new ChatAuthorizationError();
    }
    await authorizeDeletion(current.author_user_id, options);

    const canonicalMessage = toMessage<Block>(
      current,
      options.actor.tenantId as TenantId,
    );
    if (canonicalMessage.revision.revision !== input.expectedRevision) {
      const conflict = parseSoftDeleteMessageResult<Block>({
        operation: "soft_delete",
        reconciliationStatus: "revision_conflict",
        expectedRevision: input.expectedRevision,
        message: canonicalMessage,
        canonicalRevision: canonicalMessage.revision.revision,
      });
      await completeIdempotency(
        connection,
        prefix,
        options,
        input,
        requestHash,
        conflict,
        409,
        toIsoTimestamp(current.observed_at, "message observation time"),
      );
      await connection.query("COMMIT");
      return conflict;
    }

    const updated = await connection.query<StoredMessageRow>(
      `WITH occurred AS (
         SELECT clock_timestamp() AS occurred_at
       )
       UPDATE ${prefix}.chat_messages AS message
       SET content = NULL,
           current_revision = message.current_revision + 1,
           updated_at = occurred.occurred_at,
           deleted_at = occurred.occurred_at,
           deleted_by_user_id = $1
       FROM occurred
       WHERE message.tenant_id = $2
         AND message.id = $3
         AND message.current_revision = $4
         AND message.current_revision < 9007199254740991
         AND message.deleted_at IS NULL
       RETURNING
         message.id, message.conversation_id, message.sequence,
         message.author_user_id, message.client_message_id, message.content,
         message.reply_to_message_id, message.reply_notify_author,
         message.current_revision, message.created_at, message.updated_at,
         message.edited_at, message.edited_by_user_id, message.deleted_at,
         message.deleted_by_user_id, occurred.occurred_at AS observed_at,
         NULL::jsonb AS thread_summary`,
      [
        options.actor.userId,
        options.actor.tenantId,
        input.messageId,
        input.expectedRevision,
      ],
    );
    const updatedRow = updated.rows[0];
    if (updatedRow === undefined) {
      throw new Error("The message revision could not be advanced");
    }
    const occurredAt = toIsoTimestamp(
      updatedRow.observed_at,
      "message deletion time",
    );
    const message = toMessage<Block>(
      { ...updatedRow, thread_summary: current.thread_summary },
      options.actor.tenantId as TenantId,
    );
    const applied = parseSoftDeleteMessageResult<Block>({
      operation: "soft_delete",
      reconciliationStatus: "applied",
      expectedRevision: input.expectedRevision,
      message,
      canonicalRevision: message.revision.revision,
    });

    const auditEventId = createId();
    await connection.query(
      `INSERT INTO ${prefix}.chat_audit_events (
         tenant_id, event_id, actor_user_id, action, target_type, target_id,
         occurred_at, metadata, request_id
       )
       VALUES ($1, $2, $3, 'message.deleted', 'message', $4, $5, $6, $7)`,
      [
        options.actor.tenantId,
        auditEventId,
        options.actor.userId,
        input.messageId,
        occurredAt,
        {
          conversationId: message.conversationId,
          previousRevision: input.expectedRevision,
          currentRevision: applied.canonicalRevision,
        },
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
         $1, $2, $3, $4, 'message.deleted', $5, $6,
         $5::timestamptz + ($7::double precision * interval '1 millisecond')
       )`,
      [
        outboxEventId,
        CHAT_PROTOCOL_VERSION,
        options.actor.tenantId,
        message.conversationId,
        occurredAt,
        { message: applied.message },
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
      200,
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
