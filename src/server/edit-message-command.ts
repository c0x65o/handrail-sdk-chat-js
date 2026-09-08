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
  parseEditMessageInput,
  parseEditMessageResult,
  type EditMessageInput,
  type EditMessageResult,
} from "../contracts/message-mutations.js";
import type {
  Message,
  MessageBlock,
  MessageContent,
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

export const EDIT_MESSAGE_CAPABILITY = "message.edit" as const;
export const EDIT_MESSAGE_IDEMPOTENCY_OPERATION = "message.edit" as const;
export const DEFAULT_EDIT_MESSAGE_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_EDIT_MESSAGE_OUTBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export type EditMessageCommandErrorCode =
  | "idempotency_conflict"
  | "idempotency_in_progress";

/** Stable command failure that is safe to translate at a future HTTP boundary. */
export class EditMessageCommandError extends Error {
  public readonly statusCode = 409;

  public constructor(
    public readonly code: EditMessageCommandErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "EditMessageCommandError";
  }
}

export interface EditMessageCommandOptions<
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

interface MessageAuthorRow {
  readonly author_user_id: string;
}

interface StoredMessageRow extends MessageAuthorRow {
  readonly id: string;
  readonly conversation_id: string;
  readonly sequence: string | number;
  readonly client_message_id: string;
  readonly reply_to_message_id: string | null;
  readonly reply_notify_author: boolean;
  readonly content: unknown;
  readonly current_revision: string | number;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly edited_at: Date | string | null;
  readonly edited_by_user_id: string | null;
  readonly observed_at: Date | string;
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

const authorizeEditor = async (
  authorUserId: string,
  options: EditMessageCommandOptions,
): Promise<void> => {
  if (authorUserId === options.actor.userId) {
    return;
  }

  let capabilities: readonly string[];
  try {
    capabilities = validateCapabilities(
      await options.permissions.getCapabilities({ actor: options.actor }),
    );
  } catch {
    throw new ChatAuthorizationError();
  }
  if (!capabilities.includes(EDIT_MESSAGE_CAPABILITY)) {
    throw new ChatAuthorizationError();
  }
};

const canonicalJson = (value: unknown, ancestors = new Set<object>()): string => {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Message content must contain finite JSON numbers");
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new TypeError("Message content must be JSON-compatible");
  }
  if (ancestors.has(value)) {
    throw new TypeError("Message content must not contain cycles");
  }
  const prototype = Object.getPrototypeOf(value);
  if (
    !Array.isArray(value) &&
    prototype !== Object.prototype &&
    prototype !== null
  ) {
    throw new TypeError("Message content must contain only JSON objects and arrays");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => canonicalJson(entry, ancestors)).join(",")}]`;
    }
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(object[key], ancestors)}`,
      )
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
};

const hashRequest = <Block extends MessageBlock>(
  input: EditMessageInput<Block>,
): string => {
  const canonical = canonicalJson({
    operation: input.operation,
    messageId: input.messageId,
    expectedRevision: input.expectedRevision,
    content: input.content,
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

const toPositiveSafeInteger = (value: string | number, label: string): number => {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(`PostgreSQL returned an invalid ${label}`);
  }
  return number;
};

const toMessage = <Block extends MessageBlock>(
  row: StoredMessageRow,
  tenantId: TenantId,
): Message<Block> => {
  if (row.content === null) {
    throw new Error("PostgreSQL returned an active message without content");
  }
  const revision = toPositiveSafeInteger(
    row.current_revision,
    "message revision",
  );
  const edited =
    row.edited_at === null || row.edited_by_user_id === null
      ? {}
      : {
          editedAt: toIsoTimestamp(row.edited_at, "message edited_at"),
          editedByUserId: row.edited_by_user_id as UserId,
        };

  return {
    id: row.id as MessageId,
    tenantId,
    conversationId: row.conversation_id as ConversationId,
    author: { type: "user", userId: row.author_user_id as UserId },
    ...(row.reply_to_message_id === null
      ? {}
      : {
          replyTo: {
            messageId: row.reply_to_message_id as MessageId,
            notifyAuthor: row.reply_notify_author === true,
          },
        }),
    sequence: toPositiveSafeInteger(
      row.sequence,
      "message sequence",
    ) as MessageSequence,
    createdAt: toIsoTimestamp(row.created_at, "message created_at"),
    updatedAt: toIsoTimestamp(row.updated_at, "message updated_at"),
    revision: { revision, ...edited },
    content: row.content as MessageContent<Block>,
  };
};

const replayStoredResult = <Block extends MessageBlock>(
  stored: unknown,
): EditMessageResult<Block> => {
  const canonical = parseEditMessageResult<Block>(stored);
  if (canonical.reconciliationStatus === "revision_conflict") {
    return canonical;
  }
  return parseEditMessageResult<Block>({
    ...canonical,
    reconciliationStatus: "replayed",
  });
};

const completeIdempotency = async (
  connection: PostgresMigrationConnection,
  prefix: string,
  options: EditMessageCommandOptions,
  input: EditMessageInput,
  requestHash: string,
  result: EditMessageResult,
  responseStatus: number,
  completedAt: IsoTimestamp,
): Promise<void> => {
  const completed = await connection.query(
    `UPDATE ${prefix}.chat_idempotency_keys
     SET state = 'completed',
         response_status = $1,
         response_body = $2,
         completed_at = GREATEST($3::timestamptz, created_at),
         updated_at = GREATEST($3::timestamptz, created_at)
     WHERE tenant_id = $4
       AND user_id = $5
       AND operation_name = $6
       AND client_key = $7
       AND request_hash = $8
       AND state = 'pending'`,
    [
      responseStatus,
      result,
      completedAt,
      options.actor.tenantId,
      options.actor.userId,
      EDIT_MESSAGE_IDEMPOTENCY_OPERATION,
      input.idempotencyKey,
      requestHash,
    ],
  );
  if (completed.rowCount !== 1) {
    throw new EditMessageCommandError(
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
 * Authorizes and atomically replaces one message's canonical content while
 * retaining its immutable sequence/read position and appending one revision.
 */
export async function editMessage<Block extends MessageBlock = MessageBlock>(
  options: EditMessageCommandOptions<Block>,
): Promise<EditMessageResult<Block>> {
  validateActor(options.actor);
  const input = parseEditMessageInput<Block>(options.input);
  const schema = validatePostgresSchema(
    options.schema ?? DEFAULT_POSTGRES_SCHEMA,
  );
  const prefix = quoteIdentifier(schema);
  const idempotencyTtlMs = positiveSafeInteger(
    options.idempotencyTtlMs ?? DEFAULT_EDIT_MESSAGE_IDEMPOTENCY_TTL_MS,
    "idempotencyTtlMs",
  );
  const outboxRetentionMs = positiveSafeInteger(
    options.outboxRetentionMs ?? DEFAULT_EDIT_MESSAGE_OUTBOX_RETENTION_MS,
    "outboxRetentionMs",
  );
  const createId = options.createId ?? randomUUID;
  const requestHash = hashRequest(input);

  const author = await options.database.query<MessageAuthorRow>(
    `SELECT author_user_id
     FROM ${prefix}.chat_messages
     WHERE tenant_id = $1
       AND id = $2`,
    [options.actor.tenantId, input.messageId],
  );
  const authorRow = author.rows[0];
  if (authorRow === undefined) {
    throw new ChatAuthorizationError();
  }
  await authorizeEditor(authorRow.author_user_id, options);

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
        EDIT_MESSAGE_IDEMPOTENCY_OPERATION,
        input.idempotencyKey,
        requestHash,
        idempotencyTtlMs,
      ],
    );
    const claimed = claim.rows[0];
    if (claimed === undefined) {
      throw new EditMessageCommandError(
        "idempotency_conflict",
        "The idempotency key was already used for a different request",
      );
    }
    if (claimed.idempotency_state === "completed") {
      if (claimed.stored_response_body === null) {
        throw new Error("Completed edit-message outcome has no response body");
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
         id, conversation_id, sequence, author_user_id, client_message_id,
         reply_to_message_id, reply_notify_author,
         content, current_revision, created_at, updated_at, edited_at,
         edited_by_user_id, clock_timestamp() AS observed_at
       FROM ${prefix}.chat_messages
       WHERE tenant_id = $1
         AND id = $2
         AND deleted_at IS NULL
       FOR UPDATE`,
      [options.actor.tenantId, input.messageId],
    );
    const current = locked.rows[0];
    if (current === undefined || current.author_user_id !== authorRow.author_user_id) {
      throw new ChatAuthorizationError();
    }

    const canonicalMessage = toMessage<Block>(
      current,
      options.actor.tenantId as TenantId,
    );
    if (canonicalMessage.revision.revision !== input.expectedRevision) {
      const conflict = parseEditMessageResult<Block>({
        operation: "edit",
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
       SET content = $1,
           current_revision = message.current_revision + 1,
           updated_at = occurred.occurred_at,
           edited_at = occurred.occurred_at,
           edited_by_user_id = $2
       FROM occurred
       WHERE message.tenant_id = $3
         AND message.id = $4
         AND message.current_revision = $5
         AND message.current_revision < 9007199254740991
         AND message.deleted_at IS NULL
       RETURNING
         message.id, message.conversation_id, message.sequence,
         message.author_user_id, message.client_message_id, message.content,
         message.reply_to_message_id, message.reply_notify_author,
         message.current_revision, message.created_at, message.updated_at,
         message.edited_at, message.edited_by_user_id,
         occurred.occurred_at AS observed_at`,
      [
        input.content,
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
      "message edit time",
    );
    const message = toMessage<Block>(
      updatedRow,
      options.actor.tenantId as TenantId,
    );
    const applied = parseEditMessageResult<Block>({
      operation: "edit",
      reconciliationStatus: "applied",
      expectedRevision: input.expectedRevision,
      message,
      canonicalRevision: message.revision.revision,
    });

    await connection.query(
      `INSERT INTO ${prefix}.chat_message_revisions (
         tenant_id, message_id, revision_number, content,
         created_at, created_by_user_id
       )
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        options.actor.tenantId,
        input.messageId,
        applied.canonicalRevision,
        input.content,
        occurredAt,
        options.actor.userId,
      ],
    );

    const auditEventId = createId();
    await connection.query(
      `INSERT INTO ${prefix}.chat_audit_events (
         tenant_id, event_id, actor_user_id, action, target_type, target_id,
         occurred_at, metadata, request_id
       )
       VALUES ($1, $2, $3, 'message.updated', 'message', $4, $5, $6, $7)`,
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
         $1, $2, $3, $4, 'message.updated', $5, $6,
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
