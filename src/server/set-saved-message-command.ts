import { createHash, randomUUID } from "node:crypto";

import type { IsoTimestamp } from "../contracts/identifiers.js";
import { CHAT_PROTOCOL_VERSION } from "../contracts/realtime.js";
import {
  parseSetSavedMessageInput,
  parseSetSavedMessageResult,
  type CanonicalActorPrivateSavedMessageState,
  type SetSavedMessageInput,
  type SetSavedMessageResult,
} from "../contracts/saved-message-mutation.js";
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

export const SET_SAVED_MESSAGE_ENTITY_POLICY_ACTION =
  "saved_message.set" as const;
export const SET_SAVED_MESSAGE_IDEMPOTENCY_OPERATION =
  "saved_message.set" as const;
export const SET_SAVED_MESSAGE_AUDIT_ACTION = "saved_message.set" as const;
export const SET_SAVED_MESSAGE_OUTBOX_EVENT_TYPE =
  "saved_message.updated" as const;
export const DEFAULT_SET_SAVED_MESSAGE_IDEMPOTENCY_TTL_MS =
  24 * 60 * 60 * 1_000;
export const DEFAULT_SET_SAVED_MESSAGE_OUTBOX_RETENTION_MS =
  7 * 24 * 60 * 60 * 1_000;

export type SetSavedMessageCommandErrorCode =
  | "idempotency_conflict"
  | "idempotency_in_progress";

/** Stable command failure suitable for a future transport boundary. */
export class SetSavedMessageCommandError extends Error {
  public readonly statusCode = 409;

  public constructor(
    public readonly code: SetSavedMessageCommandErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SetSavedMessageCommandError";
  }
}

export interface SetSavedMessageCommandOptions {
  readonly database: PostgresMigrationDatabase;
  readonly permissions: Pick<
    ChatPermissionAdapter<
      string,
      typeof SET_SAVED_MESSAGE_ENTITY_POLICY_ACTION
    >,
    "authorizeEntity"
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

interface VisibleMessageRow {
  readonly conversation_id: string;
  readonly entity_type: string | null;
  readonly entity_id: string | null;
  readonly occurred_at: Date | string;
}

interface StoredSavedMessageRow {
  readonly is_saved: boolean;
  readonly private_note: string | null;
  readonly saved_message_revision: string | number;
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

const hashRequest = (input: SetSavedMessageInput): string =>
  `sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        operation: input.operation,
        intent: input.intent,
        messageId: input.messageId,
        expectedSavedMessageRevision: input.expectedSavedMessageRevision,
        privateNote: input.intent === "save" ? (input.privateNote ?? null) : null,
      }),
    )
    .digest("hex")}`;

const toIsoTimestamp = (value: Date | string): IsoTimestamp => {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.valueOf())) {
    throw new Error("PostgreSQL returned an invalid saved-message timestamp");
  }
  return date.toISOString() as IsoTimestamp;
};

const toSavedMessageRevision = (value: string | number): number => {
  const revision = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error("PostgreSQL returned an invalid saved-message revision");
  }
  return revision;
};

const stateFromRow = (
  input: SetSavedMessageInput,
  row: StoredSavedMessageRow,
): CanonicalActorPrivateSavedMessageState => ({
  messageId: input.messageId,
  isSaved: row.is_saved,
  ...(row.private_note === null ? {} : { privateNote: row.private_note }),
});

const replayStoredResult = (
  stored: unknown,
  input: SetSavedMessageInput,
): SetSavedMessageResult => {
  const canonical = parseSetSavedMessageResult(stored, input);
  if (canonical.reconciliationStatus !== "applied") return canonical;
  return parseSetSavedMessageResult(
    { ...canonical, reconciliationStatus: "replayed" },
    input,
  );
};

const completeIdempotency = async (
  connection: PostgresMigrationConnection,
  prefix: string,
  actor: TrustedChatActorContext,
  input: SetSavedMessageInput,
  requestHash: string,
  result: SetSavedMessageResult,
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
      SET_SAVED_MESSAGE_IDEMPOTENCY_OPERATION,
      input.idempotencyKey,
      requestHash,
    ],
  );
  if (completed.rowCount !== 1) {
    throw new SetSavedMessageCommandError(
      "idempotency_in_progress",
      "The idempotent request is already in progress",
    );
  }
};

const authorizeHostEntity = async (
  row: VisibleMessageRow,
  options: SetSavedMessageCommandOptions,
): Promise<void> => {
  if (row.entity_type === null && row.entity_id === null) return;
  if (row.entity_type === null || row.entity_id === null) {
    throw new ChatAuthorizationError();
  }
  try {
    const allowed = await options.permissions.authorizeEntity({
      actor: options.actor,
      entity: { type: row.entity_type, id: row.entity_id },
      action: SET_SAVED_MESSAGE_ENTITY_POLICY_ACTION,
    });
    if (!allowed) throw new Error("denied");
  } catch {
    throw new ChatAuthorizationError();
  }
};

const rollback = async (
  connection: PostgresMigrationConnection,
): Promise<void> => {
  await connection.query("ROLLBACK").catch(() => undefined);
};

/** Atomically applies explicit saved state to one currently visible live message. */
export async function setSavedMessage(
  options: SetSavedMessageCommandOptions,
): Promise<SetSavedMessageResult> {
  validateActor(options.actor);
  const input = parseSetSavedMessageInput(options.input);
  const schema = validatePostgresSchema(
    options.schema ?? DEFAULT_POSTGRES_SCHEMA,
  );
  const prefix = quoteIdentifier(schema);
  const idempotencyTtlMs = positiveSafeInteger(
    options.idempotencyTtlMs ?? DEFAULT_SET_SAVED_MESSAGE_IDEMPOTENCY_TTL_MS,
    "idempotencyTtlMs",
  );
  const outboxRetentionMs = positiveSafeInteger(
    options.outboxRetentionMs ?? DEFAULT_SET_SAVED_MESSAGE_OUTBOX_RETENTION_MS,
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
        SET_SAVED_MESSAGE_IDEMPOTENCY_OPERATION,
        input.idempotencyKey,
        requestHash,
        idempotencyTtlMs,
      ],
    );
    const claimed = claim.rows[0];
    if (claimed === undefined) {
      throw new SetSavedMessageCommandError(
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

    const visible = await connection.query<VisibleMessageRow>(
      `SELECT message.conversation_id, conversation.entity_type,
              conversation.entity_id, clock_timestamp() AS occurred_at
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
    const message = visible.rows[0];
    if (message === undefined) throw new ChatAuthorizationError();
    await authorizeHostEntity(message, options);

    if (claimed.idempotency_state === "completed") {
      if (claimed.stored_response_body === null) {
        throw new Error("Completed set-saved-message outcome has no response body");
      }
      const replay = replayStoredResult(claimed.stored_response_body, input);
      await connection.query("COMMIT");
      return replay;
    }

    const occurredAt = toIsoTimestamp(message.occurred_at);
    const storedResult = await connection.query<StoredSavedMessageRow>(
      `SELECT is_saved, private_note, saved_message_revision
         FROM ${prefix}.chat_saved_messages
        WHERE tenant_id = $1 AND user_id = $2 AND message_id = $3
        FOR UPDATE`,
      [options.actor.tenantId, options.actor.userId, input.messageId],
    );
    const stored = storedResult.rows[0];
    const savedMessageRevision =
      stored === undefined
        ? 0
        : toSavedMessageRevision(stored.saved_message_revision);
    const requestedSaved = input.intent === "save";
    const requestedPrivateNote =
      input.intent === "save" ? (input.privateNote ?? null) : null;

    if (savedMessageRevision !== input.expectedSavedMessageRevision) {
      const savedMessage: CanonicalActorPrivateSavedMessageState =
        stored === undefined
          ? { messageId: input.messageId, isSaved: false }
          : stateFromRow(input, stored);
      const result = parseSetSavedMessageResult(
        {
          operation: input.operation,
          intent: input.intent,
          reconciliationStatus: "saved_message_revision_conflict",
          messageId: input.messageId,
          expectedSavedMessageRevision: input.expectedSavedMessageRevision,
          idempotencyKey: input.idempotencyKey,
          savedMessageRevision,
          savedMessage,
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
      stored !== undefined &&
      stored.is_saved === requestedSaved &&
      stored.private_note === requestedPrivateNote;
    if (alreadyRequested) {
      const result = parseSetSavedMessageResult(
        {
          operation: input.operation,
          intent: input.intent,
          reconciliationStatus: "already_requested_state",
          messageId: input.messageId,
          expectedSavedMessageRevision: input.expectedSavedMessageRevision,
          idempotencyKey: input.idempotencyKey,
          savedMessageRevision,
          savedMessage: stateFromRow(input, stored),
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

    const nextSavedMessageRevision = savedMessageRevision + 1;
    if (!Number.isSafeInteger(nextSavedMessageRevision)) {
      throw new Error("Saved-message revision cannot be advanced safely");
    }
    if (stored === undefined) {
      await connection.query(
        `INSERT INTO ${prefix}.chat_saved_messages (
           tenant_id, user_id, message_id, conversation_id, is_saved,
           private_note, saved_message_revision, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
        [
          options.actor.tenantId,
          options.actor.userId,
          input.messageId,
          message.conversation_id,
          requestedSaved,
          requestedPrivateNote,
          nextSavedMessageRevision,
          occurredAt,
        ],
      );
    } else {
      const updated = await connection.query(
        `UPDATE ${prefix}.chat_saved_messages
            SET is_saved = $1, private_note = $2,
                saved_message_revision = $3, updated_at = $4
          WHERE tenant_id = $5 AND user_id = $6 AND message_id = $7
            AND saved_message_revision = $8`,
        [
          requestedSaved,
          requestedPrivateNote,
          nextSavedMessageRevision,
          occurredAt,
          options.actor.tenantId,
          options.actor.userId,
          input.messageId,
          savedMessageRevision,
        ],
      );
      if (updated.rowCount !== 1) throw new ChatAuthorizationError();
    }

    const savedMessage: CanonicalActorPrivateSavedMessageState = {
      messageId: input.messageId,
      isSaved: requestedSaved,
      ...(requestedPrivateNote === null
        ? {}
        : { privateNote: requestedPrivateNote }),
    };
    const result = parseSetSavedMessageResult(
      {
        operation: input.operation,
        intent: input.intent,
        reconciliationStatus: "applied",
        messageId: input.messageId,
        expectedSavedMessageRevision: input.expectedSavedMessageRevision,
        idempotencyKey: input.idempotencyKey,
        savedMessageRevision: nextSavedMessageRevision,
        savedMessage,
      },
      input,
    );
    const metadata = {
      messageId: input.messageId,
      conversationId: message.conversation_id,
      intent: input.intent,
      previousSaved: stored?.is_saved ?? null,
      currentSaved: requestedSaved,
      privateNoteChanged: (stored?.private_note ?? null) !== requestedPrivateNote,
      previousSavedMessageRevision: savedMessageRevision,
      currentSavedMessageRevision: nextSavedMessageRevision,
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
        SET_SAVED_MESSAGE_AUDIT_ACTION,
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
        SET_SAVED_MESSAGE_OUTBOX_EVENT_TYPE,
        occurredAt,
        {
          operation: input.operation,
          messageId: input.messageId,
          savedMessageRevision: nextSavedMessageRevision,
          savedMessage,
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
