import { createHash, randomUUID } from "node:crypto";

import {
  MAX_ATTACHMENT_SIZE_BYTES,
  SUPPORTED_ATTACHMENT_CONTENT_TYPES,
  parseAbortAttachmentInput,
  parseAbortAttachmentResult,
  type AbortAttachmentInput,
  type AbortAttachmentResult,
  type AbandonedAttachmentState,
  type AttachmentMetadata,
} from "../contracts/attachment-transport.js";
import type { AttachmentId, IsoTimestamp } from "../contracts/identifiers.js";
import { CHAT_PROTOCOL_VERSION } from "../contracts/realtime.js";
import type {
  ChatStorageAdapter,
  TrustedChatActorContext,
} from "./contracts.js";
import {
  DEFAULT_POSTGRES_SCHEMA,
  validatePostgresSchema,
  type PostgresMigrationConnection,
  type PostgresMigrationDatabase,
} from "./postgres-migrations.js";

export const ABORT_ATTACHMENT_IDEMPOTENCY_OPERATION =
  "attachment.abort" as const;
export const DEFAULT_ABORT_ATTACHMENT_IDEMPOTENCY_TTL_MS =
  24 * 60 * 60 * 1_000;
export const DEFAULT_ABORT_ATTACHMENT_OUTBOX_RETENTION_MS =
  7 * 24 * 60 * 60 * 1_000;

export type AbortAttachmentCommandErrorCode =
  | "attachment_unavailable"
  | "idempotency_conflict"
  | "idempotency_in_progress"
  | "storage_unavailable";

/** Stable provider-neutral failure suitable for a future transport boundary. */
export class AbortAttachmentCommandError extends Error {
  public readonly statusCode: number;

  public constructor(
    public readonly code: AbortAttachmentCommandErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AbortAttachmentCommandError";
    this.statusCode = code.startsWith("idempotency_")
      ? 409
      : code === "attachment_unavailable"
        ? 404
        : 503;
  }
}

export interface AbortAttachmentCommandOptions {
  readonly database: PostgresMigrationDatabase;
  readonly storage: Pick<ChatStorageAdapter, "deleteObject">;
  /** Trusted host-session identity; caller input cannot override these values. */
  readonly actor: TrustedChatActorContext;
  /** JSON-decoded caller input containing only attachment id and idempotency key. */
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

interface StoredAttachmentRow {
  readonly id: string;
  readonly storage_key: string;
  readonly file_name: string;
  readonly content_type: string;
  readonly size_bytes: string | number;
  readonly checksum: string | null;
  readonly state: string;
  readonly attached_message_id: string | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly expires_at: Date | string;
  readonly abandoned_at: Date | string | null;
}

interface PendingAbort {
  readonly result: AbortAttachmentResult;
  readonly objectKey: string;
  readonly appliedHere: boolean;
}

const quoteIdentifier = (identifier: string): string =>
  `"${identifier.replaceAll('"', '""')}"`;

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

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

const positiveSafeInteger = (value: unknown, label: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value as number;
};

const toIsoTimestamp = (value: Date | string, label: string): IsoTimestamp => {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.valueOf())) {
    throw new Error(`PostgreSQL returned an invalid ${label}`);
  }
  return date.toISOString() as IsoTimestamp;
};

const toSizeBytes = (value: string | number): number => {
  const size = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ATTACHMENT_SIZE_BYTES) {
    throw new Error("PostgreSQL returned an invalid attachment size");
  }
  return size;
};

const metadataFromRow = (row: StoredAttachmentRow): AttachmentMetadata => {
  if (
    !nonEmptyString(row.file_name) ||
    !SUPPORTED_ATTACHMENT_CONTENT_TYPES.includes(
      row.content_type as (typeof SUPPORTED_ATTACHMENT_CONTENT_TYPES)[number],
    )
  ) {
    throw new Error("PostgreSQL returned invalid attachment metadata");
  }
  return {
    fileName: row.file_name,
    contentType: row.content_type as AttachmentMetadata["contentType"],
    sizeBytes: toSizeBytes(row.size_bytes),
  };
};

const hashRequest = (input: AbortAttachmentInput): string =>
  `sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        operation: input.operation,
        attachmentId: input.attachmentId,
      }),
    )
    .digest("hex")}`;

/**
 * An opaque correlation marker distinguishes cleanup recovery for this exact
 * actor/key from a new abort attempt against an already-terminal row.
 */
const cleanupMarker = (
  actor: TrustedChatActorContext,
  input: AbortAttachmentInput,
  requestHash: string,
): string =>
  `attachment-abort:${createHash("sha256")
    .update(
      JSON.stringify({
        tenantId: actor.tenantId,
        userId: actor.userId,
        operation: ABORT_ATTACHMENT_IDEMPOTENCY_OPERATION,
        idempotencyKey: input.idempotencyKey,
        requestHash,
      }),
    )
    .digest("hex")}`;

const abandonedStateFromRow = (
  row: StoredAttachmentRow,
  input: AbortAttachmentInput,
): AbandonedAttachmentState => {
  if (
    row.id !== input.attachmentId ||
    row.state !== "abandoned" ||
    row.checksum !== null ||
    row.attached_message_id !== null ||
    row.abandoned_at === null
  ) {
    throw new Error("Stored attachment does not match its abort outcome");
  }
  return {
    status: "abandoned",
    attachmentId: input.attachmentId,
    metadata: metadataFromRow(row),
    createdAt: toIsoTimestamp(row.created_at, "attachment creation timestamp"),
    expiresAt: toIsoTimestamp(row.expires_at, "attachment expiry timestamp"),
    abandonedAt: toIsoTimestamp(row.abandoned_at, "attachment abandonment timestamp"),
  };
};

const appliedResultFromRow = (
  row: StoredAttachmentRow,
  input: AbortAttachmentInput,
): AbortAttachmentResult =>
  parseAbortAttachmentResult(
    {
      operation: "abort_attachment",
      reconciliationStatus: "applied",
      idempotencyKey: input.idempotencyKey,
      attachmentId: input.attachmentId,
      attachment: abandonedStateFromRow(row, input),
    },
    input,
  );

const replayStoredResult = (
  stored: unknown,
  input: AbortAttachmentInput,
): AbortAttachmentResult => {
  const canonical = parseAbortAttachmentResult(stored, input);
  return parseAbortAttachmentResult(
    { ...canonical, reconciliationStatus: "replayed" },
    input,
  );
};

const rollback = async (connection: PostgresMigrationConnection): Promise<void> => {
  await connection.query("ROLLBACK").catch(() => undefined);
};

const unavailable = (): AbortAttachmentCommandError =>
  new AbortAttachmentCommandError(
    "attachment_unavailable",
    "Attachment is unavailable",
  );

/**
 * Commits the terminal transition before provider cleanup. The pending
 * idempotency row, cleanup delivery, and terminal audit record form a durable
 * cleanup checkpoint.
 */
const abandonOrResume = async (
  options: AbortAttachmentCommandOptions,
  input: AbortAttachmentInput,
  prefix: string,
  requestHash: string,
  recoveryMarker: string,
  auditRequestId: string,
  idempotencyTtlMs: number,
  outboxRetentionMs: number,
  createId: () => string,
): Promise<AbortAttachmentResult | PendingAbort> => {
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
        ABORT_ATTACHMENT_IDEMPOTENCY_OPERATION,
        input.idempotencyKey,
        requestHash,
        idempotencyTtlMs,
      ],
    );
    const claimed = claim.rows[0];
    if (claimed === undefined) {
      throw new AbortAttachmentCommandError(
        "idempotency_conflict",
        "The idempotency key was already used for a different request",
      );
    }
    if (claimed.idempotency_state === "completed") {
      if (claimed.stored_response_body === null) {
        throw new Error("Completed abort-attachment outcome has no response body");
      }
      const replay = replayStoredResult(claimed.stored_response_body, input);
      await connection.query(
        `INSERT INTO ${prefix}.chat_attachment_cleanup_deliveries (
           tenant_id, attachment_id, storage_key
         )
         SELECT tenant_id, id, storage_key
           FROM ${prefix}.chat_attachments
          WHERE tenant_id = $1 AND id = $2 AND uploader_user_id = $3
            AND state = 'abandoned' AND checksum IS NULL
            AND attached_message_id IS NULL
         ON CONFLICT (tenant_id, attachment_id) DO NOTHING`,
        [options.actor.tenantId, input.attachmentId, options.actor.userId],
      );
      await connection.query("COMMIT");
      return replay;
    }
    if (claimed.idempotency_state !== "pending") {
      throw new Error("PostgreSQL returned an invalid idempotency state");
    }

    const selected = await connection.query<StoredAttachmentRow>(
      `SELECT id, storage_key, file_name, content_type, size_bytes, checksum,
              state, attached_message_id, created_at, updated_at, expires_at,
              abandoned_at
         FROM ${prefix}.chat_attachments
        WHERE tenant_id = $1 AND id = $2 AND uploader_user_id = $3
          AND state = 'pending' AND checksum IS NULL
          AND attached_message_id IS NULL
          AND expires_at > clock_timestamp()
        FOR UPDATE`,
      [options.actor.tenantId, input.attachmentId, options.actor.userId],
    );

    let row: StoredAttachmentRow;
    let appliedHere = false;
    if (selected.rows[0] !== undefined) {
      const updated = await connection.query<StoredAttachmentRow>(
        `WITH timestamp AS (SELECT clock_timestamp() AS value)
         UPDATE ${prefix}.chat_attachments
            SET state = 'abandoned', checksum = NULL,
                attached_message_id = NULL, attached_at = NULL,
                abandoned_at = timestamp.value, updated_at = timestamp.value
           FROM timestamp
          WHERE tenant_id = $1 AND id = $2 AND uploader_user_id = $3
            AND state = 'pending' AND checksum IS NULL
            AND attached_message_id IS NULL
            AND expires_at > clock_timestamp()
        RETURNING id, storage_key, file_name, content_type, size_bytes,
                  checksum, state, attached_message_id, created_at, updated_at,
                  expires_at, abandoned_at`,
        [options.actor.tenantId, input.attachmentId, options.actor.userId],
      );
      const persisted = updated.rows[0];
      if (persisted === undefined) throw unavailable();
      row = persisted;
      appliedHere = true;
    } else {
      const recovery = await connection.query<StoredAttachmentRow>(
        `SELECT attachment.id, attachment.storage_key, attachment.file_name,
                attachment.content_type, attachment.size_bytes,
                attachment.checksum, attachment.state,
                attachment.attached_message_id, attachment.created_at,
                attachment.updated_at, attachment.expires_at,
                attachment.abandoned_at
           FROM ${prefix}.chat_attachments AS attachment
           INNER JOIN ${prefix}.chat_audit_events AS audit
             ON audit.tenant_id = attachment.tenant_id
            AND audit.target_type = 'attachment'
            AND audit.target_id = attachment.id
            AND audit.action = 'attachment.abandoned'
            AND audit.metadata ->> 'cleanupMarker' = $4
          WHERE attachment.tenant_id = $1 AND attachment.id = $2
            AND attachment.uploader_user_id = $3
            AND attachment.state = 'abandoned'
            AND attachment.checksum IS NULL
            AND attachment.attached_message_id IS NULL
          FOR UPDATE OF attachment`,
        [
          options.actor.tenantId,
          input.attachmentId,
          options.actor.userId,
          recoveryMarker,
        ],
      );
      const recovered = recovery.rows[0];
      if (recovered === undefined) throw unavailable();
      row = recovered;
    }

    await connection.query(
      `INSERT INTO ${prefix}.chat_attachment_cleanup_deliveries (
         tenant_id, attachment_id, storage_key
       ) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, attachment_id) DO NOTHING`,
      [options.actor.tenantId, row.id, row.storage_key],
    );

    const applied = appliedResultFromRow(row, input);
    if (appliedHere) {
      const occurredAt = applied.attachment.abandonedAt;
      await connection.query(
        `INSERT INTO ${prefix}.chat_audit_events (
           tenant_id, event_id, actor_user_id, action, target_type, target_id,
           occurred_at, metadata, request_id
         ) VALUES ($1, $2, $3, 'attachment.abandoned', 'attachment', $4, $5, $6, $7)`,
        [
          options.actor.tenantId,
          createId(),
          options.actor.userId,
          input.attachmentId,
          occurredAt,
          { outcome: "abandoned", cleanupMarker: recoveryMarker },
          auditRequestId,
        ],
      );
      await connection.query(
        `INSERT INTO ${prefix}.chat_outbox_events (
           event_id, protocol_version, tenant_id, stream_id, type,
           occurred_at, payload, expires_at
         ) VALUES ($1, $2, $3, $4, 'attachment.abandoned', $5, $6,
                   $5::timestamptz + ($7::double precision * interval '1 millisecond'))`,
        [
          createId(),
          CHAT_PROTOCOL_VERSION,
          options.actor.tenantId,
          `user:${options.actor.userId}`,
          occurredAt,
          { attachment: applied.attachment },
          outboxRetentionMs,
        ],
      );
    }

    await connection.query("COMMIT");
    return { result: applied, objectKey: row.storage_key, appliedHere };
  } catch (error) {
    await rollback(connection);
    throw error;
  } finally {
    connection.release();
  }
};

const completeAbort = async (
  options: AbortAttachmentCommandOptions,
  input: AbortAttachmentInput,
  prefix: string,
  requestHash: string,
  pending: PendingAbort,
  cleanupLeaseOwner: string,
): Promise<AbortAttachmentResult> => {
  const connection = await options.database.connect();
  try {
    await connection.query("BEGIN");
    await connection.query(
      `WITH timestamp AS (SELECT clock_timestamp() AS value)
       UPDATE ${prefix}.chat_attachment_cleanup_deliveries
          SET state = 'leased', attempt_count = attempt_count + 1,
              lease_owner = $4,
              lease_expires_at = timestamp.value + interval '5 minutes',
              last_error_code = NULL, updated_at = timestamp.value
         FROM timestamp
        WHERE tenant_id = $1 AND attachment_id = $2 AND storage_key = $3
          AND (
            (state IN ('pending', 'failed')
             AND next_attempt_at <= timestamp.value)
            OR
            (state = 'leased' AND lease_expires_at <= timestamp.value
             AND lease_owner IS DISTINCT FROM $4)
          )`,
      [
        options.actor.tenantId,
        input.attachmentId,
        pending.objectKey,
        cleanupLeaseOwner,
      ],
    );
    await connection.query(
      `WITH timestamp AS (SELECT clock_timestamp() AS value)
       UPDATE ${prefix}.chat_attachment_cleanup_deliveries
          SET state = 'delivered', lease_owner = NULL,
              lease_expires_at = NULL, last_error_code = NULL,
              updated_at = timestamp.value, delivered_at = timestamp.value
         FROM timestamp
        WHERE tenant_id = $1 AND attachment_id = $2 AND storage_key = $3
          AND state = 'leased' AND lease_owner = $4`,
      [
        options.actor.tenantId,
        input.attachmentId,
        pending.objectKey,
        cleanupLeaseOwner,
      ],
    );
    const completed = await connection.query(
      `UPDATE ${prefix}.chat_idempotency_keys
          SET state = 'completed', response_status = 200,
              response_body = $1,
              completed_at = GREATEST($2::timestamptz, created_at),
              updated_at = GREATEST($2::timestamptz, created_at)
        WHERE tenant_id = $3 AND user_id = $4 AND operation_name = $5
          AND client_key = $6 AND request_hash = $7 AND state = 'pending'`,
      [
        pending.result,
        pending.result.attachment.abandonedAt,
        options.actor.tenantId,
        options.actor.userId,
        ABORT_ATTACHMENT_IDEMPOTENCY_OPERATION,
        input.idempotencyKey,
        requestHash,
      ],
    );
    if (completed.rowCount === 1) {
      await connection.query("COMMIT");
      return pending.appliedHere
        ? pending.result
        : replayStoredResult(pending.result, input);
    }

    const existing = await connection.query<ClaimedIdempotencyRow>(
      `SELECT state AS idempotency_state,
              response_body AS stored_response_body
         FROM ${prefix}.chat_idempotency_keys
        WHERE tenant_id = $1 AND user_id = $2 AND operation_name = $3
          AND client_key = $4 AND request_hash = $5
        FOR UPDATE`,
      [
        options.actor.tenantId,
        options.actor.userId,
        ABORT_ATTACHMENT_IDEMPOTENCY_OPERATION,
        input.idempotencyKey,
        requestHash,
      ],
    );
    const outcome = existing.rows[0];
    if (
      outcome?.idempotency_state !== "completed" ||
      outcome.stored_response_body === null
    ) {
      throw new AbortAttachmentCommandError(
        "idempotency_in_progress",
        "The idempotent request is already in progress",
      );
    }
    const replay = replayStoredResult(outcome.stored_response_body, input);
    await connection.query("COMMIT");
    return pending.appliedHere ? pending.result : replay;
  } catch (error) {
    await rollback(connection);
    throw error;
  } finally {
    connection.release();
  }
};

/**
 * Makes one actor-owned pending reservation permanently unclaimable, then asks
 * the host adapter to idempotently discard its private storage object.
 */
export async function abortAttachment(
  options: AbortAttachmentCommandOptions,
): Promise<AbortAttachmentResult> {
  validateActor(options.actor);
  const input = parseAbortAttachmentInput(options.input);
  if (
    typeof options.storage !== "object" ||
    options.storage === null ||
    typeof options.storage.deleteObject !== "function"
  ) {
    throw new TypeError("A storage deletion adapter is required");
  }
  const schema = validatePostgresSchema(options.schema ?? DEFAULT_POSTGRES_SCHEMA);
  const prefix = quoteIdentifier(schema);
  const idempotencyTtlMs = positiveSafeInteger(
    options.idempotencyTtlMs ?? DEFAULT_ABORT_ATTACHMENT_IDEMPOTENCY_TTL_MS,
    "idempotencyTtlMs",
  );
  const outboxRetentionMs = positiveSafeInteger(
    options.outboxRetentionMs ?? DEFAULT_ABORT_ATTACHMENT_OUTBOX_RETENTION_MS,
    "outboxRetentionMs",
  );
  const requestHash = hashRequest(input);
  const recoveryMarker = cleanupMarker(options.actor, input, requestHash);
  const phase = await abandonOrResume(
    options,
    input,
    prefix,
    requestHash,
    recoveryMarker,
    options.requestId ?? recoveryMarker,
    idempotencyTtlMs,
    outboxRetentionMs,
    options.createId ?? randomUUID,
  );
  if (!("result" in phase)) return phase;

  try {
    await options.storage.deleteObject({
      actor: options.actor,
      attachmentId: input.attachmentId as AttachmentId,
      objectKey: phase.objectKey,
    });
  } catch {
    throw new AbortAttachmentCommandError(
      "storage_unavailable",
      "Attachment storage cleanup is temporarily unavailable",
    );
  }

  return completeAbort(
    options,
    input,
    prefix,
    requestHash,
    phase,
    `attachment-abort:${randomUUID()}`,
  );
}
