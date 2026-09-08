import { createHash, randomUUID } from "node:crypto";

import {
  MAX_ATTACHMENT_SIZE_BYTES,
  SUPPORTED_ATTACHMENT_CONTENT_TYPES,
  parseFinalizeAttachmentInput,
  parseFinalizeAttachmentResult,
  type AttachmentMetadata,
  type AttachmentRejectionReason,
  type FinalizeAttachmentInput,
  type FinalizeAttachmentResult,
} from "../contracts/attachment-transport.js";
import { CHAT_PROTOCOL_VERSION } from "../contracts/realtime.js";
import type { AttachmentId, IsoTimestamp } from "../contracts/identifiers.js";
import type {
  ChatStorageAdapter,
  ChatStorageObjectVerification,
  TrustedChatActorContext,
} from "./contracts.js";
import {
  DEFAULT_POSTGRES_SCHEMA,
  validatePostgresSchema,
  type PostgresMigrationConnection,
  type PostgresMigrationDatabase,
} from "./postgres-migrations.js";

export const FINALIZE_ATTACHMENT_IDEMPOTENCY_OPERATION =
  "attachment.finalize" as const;
export const DEFAULT_FINALIZE_ATTACHMENT_IDEMPOTENCY_TTL_MS =
  24 * 60 * 60 * 1_000;
export const DEFAULT_FINALIZE_ATTACHMENT_OUTBOX_RETENTION_MS =
  7 * 24 * 60 * 60 * 1_000;

export type FinalizeAttachmentCommandErrorCode =
  | "attachment_unavailable"
  | "idempotency_conflict"
  | "idempotency_in_progress"
  | "storage_unavailable";

/** Stable provider-neutral failure suitable for a future HTTP boundary. */
export class FinalizeAttachmentCommandError extends Error {
  public readonly statusCode: number;

  public constructor(
    public readonly code: FinalizeAttachmentCommandErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "FinalizeAttachmentCommandError";
    this.statusCode = code.startsWith("idempotency_")
      ? 409
      : code === "attachment_unavailable"
        ? 404
        : 503;
  }
}

export interface FinalizeAttachmentCommandOptions {
  readonly database: PostgresMigrationDatabase;
  readonly storage: Pick<ChatStorageAdapter, "verifyObject">;
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

const CHECKSUM_PATTERN = /^sha256:[0-9a-f]{64}$/;
const REJECTION_REASONS = new Set<AttachmentRejectionReason>([
  "missing_object",
  "size_mismatch",
  "checksum_mismatch",
  "content_type_mismatch",
  "unsafe",
  "scan_failed",
  "invalid_metadata",
]);

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

const hashRequest = (input: FinalizeAttachmentInput): string =>
  `sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        operation: input.operation,
        attachmentId: input.attachmentId,
      }),
    )
    .digest("hex")}`;

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

const exactRecord = (
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
};

const validateVerification = (
  value: ChatStorageObjectVerification,
  expected: AttachmentMetadata,
):
  | { readonly outcome: "finalized"; readonly checksum: string }
  | { readonly outcome: "rejected"; readonly reason: AttachmentRejectionReason } => {
  if (exactRecord(value, ["status", "reason"]) && value.status === "rejected") {
    if (!REJECTION_REASONS.has(value.reason as AttachmentRejectionReason)) {
      throw new Error("invalid verification response");
    }
    return {
      outcome: "rejected",
      reason: value.reason as AttachmentRejectionReason,
    };
  }
  if (
    !exactRecord(value, [
      "status",
      "exists",
      "sizeBytes",
      "checksum",
      "contentType",
      "safetyDisposition",
    ]) ||
    value.status !== "verified" ||
    value.exists !== true ||
    value.safetyDisposition !== "accepted" ||
    !Number.isSafeInteger(value.sizeBytes) ||
    value.sizeBytes < 0 ||
    value.sizeBytes > MAX_ATTACHMENT_SIZE_BYTES ||
    typeof value.contentType !== "string" ||
    !CHECKSUM_PATTERN.test(value.checksum)
  ) {
    throw new Error("invalid verification response");
  }
  if (value.sizeBytes !== expected.sizeBytes) {
    return { outcome: "rejected", reason: "size_mismatch" };
  }
  if (value.contentType !== expected.contentType) {
    return { outcome: "rejected", reason: "content_type_mismatch" };
  }
  return { outcome: "finalized", checksum: value.checksum };
};

const inspectObject = async (
  storage: FinalizeAttachmentCommandOptions["storage"],
  actor: TrustedChatActorContext,
  row: StoredAttachmentRow,
  metadata: AttachmentMetadata,
): Promise<ReturnType<typeof validateVerification>> => {
  try {
    const value = await storage.verifyObject({
      actor,
      attachmentId: row.id as AttachmentId,
      objectKey: row.storage_key,
    });
    return validateVerification(value, metadata);
  } catch {
    throw new FinalizeAttachmentCommandError(
      "storage_unavailable",
      "Attachment storage verification is temporarily unavailable",
    );
  }
};

const replayStoredResult = (
  stored: unknown,
  input: FinalizeAttachmentInput,
): FinalizeAttachmentResult => {
  const canonical = parseFinalizeAttachmentResult(stored, input);
  return parseFinalizeAttachmentResult(
    { ...canonical, reconciliationStatus: "replayed" },
    input,
  );
};

const rollback = async (connection: PostgresMigrationConnection): Promise<void> => {
  await connection.query("ROLLBACK").catch(() => undefined);
};

/**
 * Verifies one actor-owned prepared object and atomically makes it usable or
 * terminally rejected without claiming a message.
 */
export async function finalizeAttachment(
  options: FinalizeAttachmentCommandOptions,
): Promise<FinalizeAttachmentResult> {
  validateActor(options.actor);
  const input = parseFinalizeAttachmentInput(options.input);
  if (
    typeof options.storage !== "object" ||
    options.storage === null ||
    typeof options.storage.verifyObject !== "function"
  ) {
    throw new TypeError("A storage verification adapter is required");
  }
  const schema = validatePostgresSchema(options.schema ?? DEFAULT_POSTGRES_SCHEMA);
  const prefix = quoteIdentifier(schema);
  const idempotencyTtlMs = positiveSafeInteger(
    options.idempotencyTtlMs ?? DEFAULT_FINALIZE_ATTACHMENT_IDEMPOTENCY_TTL_MS,
    "idempotencyTtlMs",
  );
  const outboxRetentionMs = positiveSafeInteger(
    options.outboxRetentionMs ?? DEFAULT_FINALIZE_ATTACHMENT_OUTBOX_RETENTION_MS,
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
        FINALIZE_ATTACHMENT_IDEMPOTENCY_OPERATION,
        input.idempotencyKey,
        requestHash,
        idempotencyTtlMs,
      ],
    );
    const claimed = claim.rows[0];
    if (claimed === undefined) {
      throw new FinalizeAttachmentCommandError(
        "idempotency_conflict",
        "The idempotency key was already used for a different request",
      );
    }
    if (claimed.idempotency_state === "completed") {
      if (claimed.stored_response_body === null) {
        throw new Error("Completed finalize-attachment outcome has no response body");
      }
      const replay = replayStoredResult(claimed.stored_response_body, input);
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
        WHERE tenant_id = $1
          AND id = $2
          AND uploader_user_id = $3
          AND state = 'pending'
          AND checksum IS NULL
          AND attached_message_id IS NULL
          AND expires_at > clock_timestamp()
        FOR UPDATE`,
      [options.actor.tenantId, input.attachmentId, options.actor.userId],
    );
    const row = selected.rows[0];
    if (row === undefined) {
      throw new FinalizeAttachmentCommandError(
        "attachment_unavailable",
        "Attachment is unavailable",
      );
    }
    const metadata = metadataFromRow(row);
    const verification = await inspectObject(
      options.storage,
      options.actor,
      row,
      metadata,
    );

    const updated = verification.outcome === "finalized"
      ? await connection.query<StoredAttachmentRow>(
          `UPDATE ${prefix}.chat_attachments
              SET checksum = $1,
                  updated_at = clock_timestamp()
            WHERE tenant_id = $2 AND id = $3 AND uploader_user_id = $4
              AND state = 'pending' AND checksum IS NULL
              AND attached_message_id IS NULL
              AND expires_at > clock_timestamp()
          RETURNING id, storage_key, file_name, content_type, size_bytes,
                    checksum, state, attached_message_id, created_at,
                    updated_at, expires_at, abandoned_at`,
          [
            verification.checksum,
            options.actor.tenantId,
            input.attachmentId,
            options.actor.userId,
          ],
        )
      : await connection.query<StoredAttachmentRow>(
          `WITH timestamp AS (SELECT clock_timestamp() AS value)
           UPDATE ${prefix}.chat_attachments
              SET state = 'abandoned',
                  abandoned_at = timestamp.value,
                  updated_at = timestamp.value
             FROM timestamp
            WHERE tenant_id = $1 AND id = $2 AND uploader_user_id = $3
              AND state = 'pending' AND checksum IS NULL
              AND attached_message_id IS NULL
              AND expires_at > clock_timestamp()
          RETURNING id, storage_key, file_name, content_type, size_bytes,
                    checksum, state, attached_message_id, created_at,
                    updated_at, expires_at, abandoned_at`,
          [options.actor.tenantId, input.attachmentId, options.actor.userId],
        );
    const persisted = updated.rows[0];
    if (persisted === undefined) {
      throw new FinalizeAttachmentCommandError(
        "attachment_unavailable",
        "Attachment is unavailable",
      );
    }
    if (verification.outcome === "rejected") {
      await connection.query(
        `INSERT INTO ${prefix}.chat_attachment_cleanup_deliveries (
           tenant_id, attachment_id, storage_key
         ) VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, attachment_id) DO NOTHING`,
        [options.actor.tenantId, persisted.id, persisted.storage_key],
      );
    }
    const occurredAt = toIsoTimestamp(persisted.updated_at, "attachment update timestamp");
    const attachment = verification.outcome === "finalized"
      ? {
          status: "finalized" as const,
          attachmentId: input.attachmentId,
          metadata,
          createdAt: toIsoTimestamp(persisted.created_at, "attachment creation timestamp"),
          expiresAt: toIsoTimestamp(persisted.expires_at, "attachment expiry timestamp"),
          checksum: verification.checksum,
          finalizedAt: occurredAt,
        }
      : {
          status: "rejected" as const,
          attachmentId: input.attachmentId,
          metadata,
          createdAt: toIsoTimestamp(persisted.created_at, "attachment creation timestamp"),
          expiresAt: toIsoTimestamp(persisted.expires_at, "attachment expiry timestamp"),
          rejectionReason: verification.reason,
          rejectedAt: occurredAt,
        };
    const applied = parseFinalizeAttachmentResult(
      {
        operation: "finalize_attachment",
        reconciliationStatus: "applied",
        idempotencyKey: input.idempotencyKey,
        attachmentId: input.attachmentId,
        outcome: verification.outcome,
        attachment,
      },
      input,
    );

    const auditEventId = createId();
    await connection.query(
      `INSERT INTO ${prefix}.chat_audit_events (
         tenant_id, event_id, actor_user_id, action, target_type, target_id,
         occurred_at, metadata, request_id
       ) VALUES ($1, $2, $3, $4, 'attachment', $5, $6, $7, $8)`,
      [
        options.actor.tenantId,
        auditEventId,
        options.actor.userId,
        `attachment.${verification.outcome}`,
        input.attachmentId,
        occurredAt,
        verification.outcome === "finalized"
          ? { outcome: "finalized" }
          : { outcome: "rejected", reason: verification.reason },
        options.requestId ?? auditEventId,
      ],
    );

    const outboxEventId = createId();
    await connection.query(
      `INSERT INTO ${prefix}.chat_outbox_events (
         event_id, protocol_version, tenant_id, stream_id, type,
         occurred_at, payload, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7,
                 $6::timestamptz + ($8::double precision * interval '1 millisecond'))`,
      [
        outboxEventId,
        CHAT_PROTOCOL_VERSION,
        options.actor.tenantId,
        `user:${options.actor.userId}`,
        `attachment.${verification.outcome}`,
        occurredAt,
        { attachment: applied.attachment, outcome: applied.outcome },
        outboxRetentionMs,
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
        applied,
        occurredAt,
        options.actor.tenantId,
        options.actor.userId,
        FINALIZE_ATTACHMENT_IDEMPOTENCY_OPERATION,
        input.idempotencyKey,
        requestHash,
      ],
    );
    if (completed.rowCount !== 1) {
      throw new FinalizeAttachmentCommandError(
        "idempotency_in_progress",
        "The idempotent request is already in progress",
      );
    }

    await connection.query("COMMIT");
    return applied;
  } catch (error) {
    await rollback(connection);
    throw error;
  } finally {
    connection.release();
  }
}
