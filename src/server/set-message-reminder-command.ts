import { createHash, randomUUID } from "node:crypto";

import type { IsoTimestamp } from "../contracts/identifiers.js";
import {
  MessageReminderParseError,
  parseMessageReminderInput,
  parseMessageReminderResult,
  type CanonicalMessageReminder,
  type MessageReminderInput,
  type MessageReminderResult,
} from "../contracts/generated/message-reminder.js";
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

export const SET_MESSAGE_REMINDER_ENTITY_POLICY_ACTION =
  "message_reminder.set" as const;
export const SET_MESSAGE_REMINDER_IDEMPOTENCY_OPERATION =
  "message_reminder.v1" as const;
export const SET_MESSAGE_REMINDER_AUDIT_ACTION =
  "message_reminder.set" as const;
export const SET_MESSAGE_REMINDER_OUTBOX_EVENT_TYPE =
  "message_reminder.updated" as const;
export const DEFAULT_SET_MESSAGE_REMINDER_IDEMPOTENCY_TTL_MS =
  24 * 60 * 60 * 1_000;
export const DEFAULT_SET_MESSAGE_REMINDER_OUTBOX_RETENTION_MS =
  7 * 24 * 60 * 60 * 1_000;

export type SetMessageReminderCommandErrorCode =
  | "idempotency_conflict"
  | "idempotency_in_progress";

/** Stable command failure suitable for the HTTP transport boundary. */
export class SetMessageReminderCommandError extends Error {
  public readonly statusCode = 409;

  public constructor(
    public readonly code: SetMessageReminderCommandErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SetMessageReminderCommandError";
  }
}

export interface SetMessageReminderCommandOptions {
  readonly database: PostgresMigrationDatabase;
  readonly permissions: Pick<
    ChatPermissionAdapter<
      string,
      typeof SET_MESSAGE_REMINDER_ENTITY_POLICY_ACTION
    >,
    "authorizeEntity"
  >;
  /** Trusted host-session identity; caller input cannot override these values. */
  readonly actor: TrustedChatActorContext;
  readonly input: unknown;
  readonly schema?: string;
  readonly idempotencyTtlMs?: number;
  readonly outboxRetentionMs?: number;
  /** Trusted transport correlation id used only by the existing audit record. */
  readonly requestId?: string;
  readonly createId?: () => string;
}

interface ClaimedIdempotencyRow {
  readonly idempotency_state: string;
  readonly stored_response_body: unknown | null;
}

interface DatabaseClockRow {
  readonly occurred_at: Date | string;
}

interface VisibleMessageRow {
  readonly entity_type: string | null;
  readonly entity_id: string | null;
}

interface StoredReminderRow {
  readonly remind_at: Date | string;
  readonly reminder_revision: string | number;
  readonly status: string;
  readonly created_at: Date | string;
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

const hashRequest = (input: MessageReminderInput): string =>
  `sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        operation: input.operation,
        intent: input.intent,
        conversationId: input.conversationId,
        messageId: input.messageId,
        expectedReminderRevision: input.expectedReminderRevision,
        dueAt: input.intent === "set" ? input.dueAt : null,
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

const toReminderRevision = (value: string | number): number => {
  const revision = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error("PostgreSQL returned an invalid reminder revision");
  }
  return revision;
};

const stateFromRow = (row: StoredReminderRow): CanonicalMessageReminder =>
  row.status === "active"
    ? {
        privacy: "affected_authenticated_actor",
        state: "scheduled",
        dueAt: toIsoTimestamp(row.remind_at, "reminder due timestamp"),
      }
    : {
        privacy: "affected_authenticated_actor",
        state: "cancelled",
      };

const requestedState = (
  input: MessageReminderInput,
): CanonicalMessageReminder =>
  input.intent === "set"
    ? {
        privacy: "affected_authenticated_actor",
        state: "scheduled",
        dueAt: input.dueAt,
      }
    : {
        privacy: "affected_authenticated_actor",
        state: "cancelled",
      };

const replayStoredResult = (
  stored: unknown,
  input: MessageReminderInput,
): MessageReminderResult => {
  const canonical = parseMessageReminderResult(stored, input);
  if (canonical.reconciliationStatus !== "applied") return canonical;
  return parseMessageReminderResult(
    { ...canonical, reconciliationStatus: "replayed" },
    input,
  );
};

const completeIdempotency = async (
  connection: PostgresMigrationConnection,
  prefix: string,
  actor: TrustedChatActorContext,
  input: MessageReminderInput,
  requestHash: string,
  result: MessageReminderResult,
  completedAt: IsoTimestamp,
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
      completedAt,
      actor.tenantId,
      actor.userId,
      SET_MESSAGE_REMINDER_IDEMPOTENCY_OPERATION,
      input.idempotencyKey,
      requestHash,
    ],
  );
  if (completed.rowCount !== 1) {
    throw new SetMessageReminderCommandError(
      "idempotency_in_progress",
      "The idempotent request is already in progress",
    );
  }
};

const unavailableResult = (
  input: MessageReminderInput,
): MessageReminderResult =>
  parseMessageReminderResult(
    {
      operation: input.operation,
      intent: input.intent,
      reconciliationStatus: "unavailable-source",
      conversationId: input.conversationId,
      messageId: input.messageId,
      expectedReminderRevision: input.expectedReminderRevision,
      idempotencyKey: input.idempotencyKey,
      reminderRevision: null,
      reminder: null,
    },
    input,
  );

const authorizeHostEntity = async (
  row: VisibleMessageRow,
  options: SetMessageReminderCommandOptions,
): Promise<boolean> => {
  if (row.entity_type === null && row.entity_id === null) return true;
  if (row.entity_type === null || row.entity_id === null) return false;
  try {
    return await options.permissions.authorizeEntity({
      actor: options.actor,
      entity: { type: row.entity_type, id: row.entity_id },
      action: SET_MESSAGE_REMINDER_ENTITY_POLICY_ACTION,
    });
  } catch {
    return false;
  }
};

const rollback = async (
  connection: PostgresMigrationConnection,
): Promise<void> => {
  await connection.query("ROLLBACK").catch(() => undefined);
};

/** Atomically sets, reschedules, or cancels one actor-private message reminder. */
export async function setMessageReminder(
  options: SetMessageReminderCommandOptions,
): Promise<MessageReminderResult> {
  validateActor(options.actor);
  const input = parseMessageReminderInput(options.input);
  const schema = validatePostgresSchema(
    options.schema ?? DEFAULT_POSTGRES_SCHEMA,
  );
  const prefix = quoteIdentifier(schema);
  const idempotencyTtlMs = positiveSafeInteger(
    options.idempotencyTtlMs ?? DEFAULT_SET_MESSAGE_REMINDER_IDEMPOTENCY_TTL_MS,
    "idempotencyTtlMs",
  );
  const outboxRetentionMs = positiveSafeInteger(
    options.outboxRetentionMs ?? DEFAULT_SET_MESSAGE_REMINDER_OUTBOX_RETENTION_MS,
    "outboxRetentionMs",
  );
  const createId = options.createId ?? randomUUID;
  const requestHash = hashRequest(input);

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
        SET_MESSAGE_REMINDER_IDEMPOTENCY_OPERATION,
        input.idempotencyKey,
        requestHash,
        idempotencyTtlMs,
      ],
    );
    const claimed = claim.rows[0];
    if (claimed === undefined) {
      throw new SetMessageReminderCommandError(
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

    const clock = await connection.query<DatabaseClockRow>(
      "SELECT clock_timestamp() AS occurred_at",
    );
    const occurredAt = toIsoTimestamp(
      clock.rows[0]?.occurred_at ?? "",
      "message-reminder command timestamp",
    );
    if (
      input.intent === "set" &&
      new Date(input.dueAt).valueOf() <= new Date(occurredAt).valueOf()
    ) {
      throw new MessageReminderParseError(
        "due_time_not_future",
        "input.dueAt must remain strictly in the future at transaction time",
      );
    }

    const visible = await connection.query<VisibleMessageRow>(
      `SELECT conversation.entity_type, conversation.entity_id
         FROM ${prefix}.chat_messages AS message
         INNER JOIN ${prefix}.chat_conversations AS conversation
           ON conversation.tenant_id = message.tenant_id
          AND conversation.id = message.conversation_id
         LEFT JOIN ${prefix}.chat_conversation_members AS member
           ON member.tenant_id = conversation.tenant_id
          AND member.conversation_id = conversation.id
          AND member.user_id = $3
        WHERE message.tenant_id = $1
          AND message.conversation_id = $2
          AND message.id = $4
          AND message.deleted_at IS NULL
          AND conversation.archived_at IS NULL
          AND (
            (conversation.type = 'channel' AND conversation.visibility = 'public')
            OR member.state = 'active'
          )
        FOR UPDATE OF message, conversation`,
      [
        options.actor.tenantId,
        input.conversationId,
        options.actor.userId,
        input.messageId,
      ],
    );
    const message = visible.rows[0];
    const sourceAvailable =
      message !== undefined && (await authorizeHostEntity(message, options));
    if (!sourceAvailable) {
      if (claimed.idempotency_state === "completed") {
        if (claimed.stored_response_body === null) {
          throw new Error("Completed message-reminder outcome has no response body");
        }
        const replay = replayStoredResult(claimed.stored_response_body, input);
        await connection.query("COMMIT");
        return replay;
      }
      const result = unavailableResult(input);
      await completeIdempotency(
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

    if (claimed.idempotency_state === "completed") {
      if (claimed.stored_response_body === null) {
        throw new Error("Completed message-reminder outcome has no response body");
      }
      const replay = replayStoredResult(claimed.stored_response_body, input);
      await connection.query("COMMIT");
      return replay;
    }

    const storedResult = await connection.query<StoredReminderRow>(
      `SELECT remind_at, reminder_revision, status, created_at
         FROM ${prefix}.chat_message_reminders
        WHERE tenant_id = $1 AND user_id = $2 AND message_id = $3
        FOR UPDATE`,
      [options.actor.tenantId, options.actor.userId, input.messageId],
    );
    const stored = storedResult.rows[0];
    const reminderRevision =
      stored === undefined ? 0 : toReminderRevision(stored.reminder_revision);
    const currentState =
      stored === undefined
        ? ({
            privacy: "affected_authenticated_actor",
            state: "cancelled",
          } as const)
        : stateFromRow(stored);

    if (reminderRevision !== input.expectedReminderRevision) {
      const result = parseMessageReminderResult(
        {
          operation: input.operation,
          intent: input.intent,
          reconciliationStatus: "revision-conflict",
          conversationId: input.conversationId,
          messageId: input.messageId,
          expectedReminderRevision: input.expectedReminderRevision,
          idempotencyKey: input.idempotencyKey,
          reminderRevision,
          reminder: currentState,
        },
        input,
      );
      await completeIdempotency(
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

    const alreadyRequested =
      input.intent === "cancel"
        ? currentState.state === "cancelled"
        : currentState.state === "scheduled" &&
          new Date(currentState.dueAt).valueOf() ===
            new Date(input.dueAt).valueOf();
    if (alreadyRequested) {
      const result = parseMessageReminderResult(
        {
          operation: input.operation,
          intent: input.intent,
          reconciliationStatus: "already-requested",
          conversationId: input.conversationId,
          messageId: input.messageId,
          expectedReminderRevision: input.expectedReminderRevision,
          idempotencyKey: input.idempotencyKey,
          reminderRevision,
          reminder: requestedState(input),
        },
        input,
      );
      await completeIdempotency(
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

    const nextReminderRevision = reminderRevision + 1;
    if (!Number.isSafeInteger(nextReminderRevision)) {
      throw new Error("Reminder revision cannot be advanced safely");
    }
    if (stored === undefined) {
      if (input.intent !== "set") {
        throw new Error("An absent reminder can only advance to scheduled state");
      }
      await connection.query(
        `INSERT INTO ${prefix}.chat_message_reminders (
           tenant_id, user_id, message_id, conversation_id, remind_at,
           reminder_revision, status, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $7)`,
        [
          options.actor.tenantId,
          options.actor.userId,
          input.messageId,
          input.conversationId,
          input.dueAt,
          nextReminderRevision,
          occurredAt,
        ],
      );
    } else if (input.intent === "cancel") {
      const updated = await connection.query(
        `UPDATE ${prefix}.chat_message_reminders
            SET status = 'cancelled', cancelled_at = $1,
                reminder_revision = $2, updated_at = $1
          WHERE tenant_id = $3 AND user_id = $4 AND message_id = $5
            AND reminder_revision = $6 AND status = 'active'`,
        [
          occurredAt,
          nextReminderRevision,
          options.actor.tenantId,
          options.actor.userId,
          input.messageId,
          reminderRevision,
        ],
      );
      if (updated.rowCount !== 1) throw new ChatAuthorizationError();
    } else if (stored.status === "active") {
      const updated = await connection.query(
        `UPDATE ${prefix}.chat_message_reminders
            SET remind_at = $1, reminder_revision = $2, updated_at = $3
          WHERE tenant_id = $4 AND user_id = $5 AND message_id = $6
            AND reminder_revision = $7 AND status = 'active'`,
        [
          input.dueAt,
          nextReminderRevision,
          occurredAt,
          options.actor.tenantId,
          options.actor.userId,
          input.messageId,
          reminderRevision,
        ],
      );
      if (updated.rowCount !== 1) throw new ChatAuthorizationError();
    } else {
      const deleted = await connection.query(
        `DELETE FROM ${prefix}.chat_message_reminders
          WHERE tenant_id = $1 AND user_id = $2 AND message_id = $3
            AND reminder_revision = $4 AND status <> 'active'`,
        [
          options.actor.tenantId,
          options.actor.userId,
          input.messageId,
          reminderRevision,
        ],
      );
      if (deleted.rowCount !== 1) throw new ChatAuthorizationError();
      await connection.query(
        `INSERT INTO ${prefix}.chat_message_reminders (
           tenant_id, user_id, message_id, conversation_id, remind_at,
           reminder_revision, status, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $7)`,
        [
          options.actor.tenantId,
          options.actor.userId,
          input.messageId,
          input.conversationId,
          input.dueAt,
          nextReminderRevision,
          occurredAt,
        ],
      );
    }

    const reminder = requestedState(input);
    const result = parseMessageReminderResult(
      {
        operation: input.operation,
        intent: input.intent,
        reconciliationStatus: "applied",
        conversationId: input.conversationId,
        messageId: input.messageId,
        expectedReminderRevision: input.expectedReminderRevision,
        idempotencyKey: input.idempotencyKey,
        reminderRevision: nextReminderRevision,
        reminder,
      },
      input,
    );
    const metadata = {
      conversationId: input.conversationId,
      messageId: input.messageId,
      intent: input.intent,
      previousStatus: stored?.status ?? null,
      currentStatus: input.intent === "set" ? "active" : "cancelled",
      previousReminderRevision: reminderRevision,
      currentReminderRevision: nextReminderRevision,
      previousDueAt:
        stored?.status === "active"
          ? toIsoTimestamp(stored.remind_at, "previous reminder due timestamp")
          : null,
      currentDueAt: input.intent === "set" ? input.dueAt : null,
    };

    const auditEventId = createId();
    await connection.query(
      `INSERT INTO ${prefix}.chat_audit_events (
         tenant_id, event_id, actor_user_id, action, target_type, target_id,
         occurred_at, metadata, request_id
       ) VALUES ($1, $2, $3, $4, 'message', $5, $6, $7, $8)`,
      [
        options.actor.tenantId,
        auditEventId,
        options.actor.userId,
        SET_MESSAGE_REMINDER_AUDIT_ACTION,
        input.messageId,
        occurredAt,
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
        `user:${options.actor.userId}`,
        SET_MESSAGE_REMINDER_OUTBOX_EVENT_TYPE,
        occurredAt,
        {
          operation: input.operation,
          conversationId: input.conversationId,
          messageId: input.messageId,
          reminderRevision: nextReminderRevision,
          reminder,
        },
        outboxRetentionMs,
      ],
    );

    await completeIdempotency(
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
    throw error;
  } finally {
    connection.release();
  }
}
