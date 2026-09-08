import { createHash, randomUUID } from "node:crypto";

import {
  MAX_ATTACHMENT_OPAQUE_DESCRIPTOR_UTF8_BYTES,
  MAX_ATTACHMENT_PENDING_TTL_MS,
  parseAttachmentUploadDescriptor,
  parsePrepareAttachmentInput,
  parsePrepareAttachmentResult,
  type AttachmentUploadDescriptor,
  type PendingAttachmentState,
  type PrepareAttachmentInput,
  type PrepareAttachmentResult,
} from "../contracts/attachment-transport.js";
import type {
  AttachmentId,
  IsoTimestamp,
} from "../contracts/identifiers.js";
import type {
  ChatPermissionAdapter,
  ChatStorageAdapter,
  ChatStorageUploadUrl,
  TrustedChatActorContext,
} from "./contracts.js";
import {
  DEFAULT_POSTGRES_SCHEMA,
  validatePostgresSchema,
  type PostgresMigrationConnection,
  type PostgresMigrationDatabase,
} from "./postgres-migrations.js";
import { ChatAuthorizationError } from "./request-context.js";
import { authorizeThreadAccess } from "./thread-access.js";
import { ensureThreadParticipant } from "./thread-participant.js";

export const PREPARE_ATTACHMENT_CAPABILITY = "attachment.prepare" as const;
export const PREPARE_ATTACHMENT_ENTITY_POLICY_ACTION =
  "attachment.prepare" as const;
export const PREPARE_ATTACHMENT_IDEMPOTENCY_OPERATION =
  "attachment.prepare" as const;
export const DEFAULT_PREPARE_ATTACHMENT_IDEMPOTENCY_TTL_MS =
  24 * 60 * 60 * 1_000;
export const DEFAULT_PREPARE_ATTACHMENT_PENDING_TTL_MS = 60 * 60 * 1_000;

export type PrepareAttachmentCommandErrorCode =
  | "feature_disabled"
  | "idempotency_conflict"
  | "idempotency_in_progress"
  | "storage_unavailable";

/** Stable, provider-neutral failure suitable for a future transport boundary. */
export class PrepareAttachmentCommandError extends Error {
  public readonly statusCode: number;

  public constructor(
    public readonly code: PrepareAttachmentCommandErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PrepareAttachmentCommandError";
    this.statusCode = code.startsWith("idempotency_") ? 409 : 503;
  }
}

export interface PrepareAttachmentCommandOptions {
  readonly database: PostgresMigrationDatabase;
  readonly permissions: Pick<
    ChatPermissionAdapter<
      string,
      typeof PREPARE_ATTACHMENT_ENTITY_POLICY_ACTION | "message.send"
    >,
    "getCapabilities" | "authorizeEntity" | "authorizeThreadSend"
  >;
  readonly storage?: Pick<ChatStorageAdapter, "createUploadUrl">;
  /** Must reflect the embedding server's normalized attachment feature value. */
  readonly attachmentsEnabled: boolean;
  /** Trusted host-session identity; caller input cannot override these values. */
  readonly actor: TrustedChatActorContext;
  /** Trusted route/conversation context, intentionally absent from public input. */
  readonly conversationId: string;
  /** JSON-decoded caller input, validated by the shared attachment contract. */
  readonly input: unknown;
  readonly schema?: string;
  readonly idempotencyTtlMs?: number;
  readonly pendingTtlMs?: number;
  /** Supplies opaque durable identifiers; defaults to cryptographic UUIDs. */
  readonly createId?: () => string;
  /** Deterministic public-descriptor validation clock for focused tests. */
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

interface StoredAttachmentRow {
  readonly id: string;
  readonly uploader_user_id: string;
  readonly storage_key: string;
  readonly file_name: string;
  readonly content_type: string;
  readonly size_bytes: string | number;
  readonly state: string;
  readonly created_at: Date | string;
  readonly expires_at: Date | string;
}

interface PreparedUpload {
  readonly attachment: PendingAttachmentState;
  readonly upload: AttachmentUploadDescriptor;
  readonly reconciliationStatus: "applied" | "replayed";
}

const quoteIdentifier = (identifier: string): string =>
  `"${identifier.replaceAll('"', '""')}"`;

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const boundedIdentifier = (value: unknown, label: string): string => {
  if (
    !nonEmptyString(value) ||
    Buffer.byteLength(value, "utf8") > 255 ||
    /\p{Cc}/u.test(value)
  ) {
    throw new TypeError(`${label} must be a valid chat identifier`);
  }
  return value;
};

const positiveSafeInteger = (
  value: unknown,
  label: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number => {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > maximum
  ) {
    throw new TypeError(`${label} must be a positive safe integer at most ${maximum}`);
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

const validateNow = (now: () => Date): Date => {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) {
    throw new TypeError("now must return a valid Date");
  }
  return value;
};

const hashRequest = (
  conversationId: string,
  input: PrepareAttachmentInput,
): string =>
  `sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        operation: input.operation,
        conversationId,
        metadata: {
          fileName: input.metadata.fileName,
          contentType: input.metadata.contentType,
          sizeBytes: input.metadata.sizeBytes,
        },
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

const toSizeBytes = (value: string | number): number => {
  const size = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error("PostgreSQL returned an invalid attachment size");
  }
  return size;
};

const requirePrepareCapability = async (
  options: PrepareAttachmentCommandOptions,
): Promise<readonly string[]> => {
  try {
    const capabilities = await options.permissions.getCapabilities({
      actor: options.actor,
    });
    if (
      !Array.isArray(capabilities) ||
      !capabilities.every(nonEmptyString) ||
      !capabilities.includes(PREPARE_ATTACHMENT_CAPABILITY)
    ) {
      throw new Error("denied");
    }
    return capabilities;
  } catch {
    throw new ChatAuthorizationError();
  }
};

const authorizeEntity = async (
  conversation: EligibleConversationRow,
  options: PrepareAttachmentCommandOptions,
): Promise<void> => {
  if (conversation.entity_type === null && conversation.entity_id === null) return;
  if (conversation.entity_type === null || conversation.entity_id === null) {
    throw new ChatAuthorizationError();
  }
  try {
    const allowed = await options.permissions.authorizeEntity({
      actor: options.actor,
      entity: {
        type: conversation.entity_type,
        id: conversation.entity_id,
      },
      action: PREPARE_ATTACHMENT_ENTITY_POLICY_ACTION,
    });
    if (!allowed) throw new Error("denied");
  } catch {
    throw new ChatAuthorizationError();
  }
};

const lockPreparationAccess = async (
  connection: PostgresMigrationConnection,
  prefix: string,
  schema: string,
  options: PrepareAttachmentCommandOptions,
  conversationId: string,
): Promise<(() => Promise<void>) | undefined> => {
  // Match send's parent-before-child, then parent/child membership write locks.
  // Refresh authorization after waits, including reconciliation: renewed upload
  // instructions require current write authority, not just a past reservation.
  const parents = await connection.query<{ id: string }>(
    `SELECT id FROM ${prefix}.chat_conversations
     WHERE tenant_id = $1 AND id = (
       SELECT parent_conversation_id FROM ${prefix}.chat_conversations
       WHERE tenant_id = $1 AND id = $2
     ) FOR UPDATE`,
    [options.actor.tenantId, conversationId],
  );
  const locked = await connection.query<{
    type: string; parent_conversation_id: string | null; locked: boolean;
    occurred_at: Date | string;
  }>(
    `SELECT type, parent_conversation_id, locked, clock_timestamp() AS occurred_at
     FROM ${prefix}.chat_conversations WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [options.actor.tenantId, conversationId],
  );
  const destination = locked.rows[0];
  if (destination === undefined) throw new ChatAuthorizationError();
  if (destination.type === "thread") {
    if (destination.parent_conversation_id !== parents.rows[0]?.id || destination.locked) {
      throw new ChatAuthorizationError();
    }
    const memberships = await connection.query<{ conversation_id: string; state: string }>(
      `SELECT conversation_id, state FROM ${prefix}.chat_conversation_members
       WHERE tenant_id = $1 AND conversation_id = ANY($2::text[]) AND user_id = $3
       ORDER BY (conversation_id = $4), conversation_id FOR UPDATE`,
      [options.actor.tenantId, [destination.parent_conversation_id, conversationId],
        options.actor.userId, conversationId],
    );
    const authorize = async () => {
      const common = {
        database: connection, schema, actor: options.actor,
        threadId: conversationId, permissions: options.permissions,
      };
      const access = await authorizeThreadAccess({
        ...common, operation: "send",
        permissions: {
          getCapabilities: (request) => options.permissions.getCapabilities(request),
          // The shared helper also types management actions; this consumer only
          // authorizes send and never delegates a management operation to the host.
          authorizeEntity: (request) => request.action === "message.send"
            ? options.permissions.authorizeEntity({ ...request, action: "message.send" })
            : Promise.resolve(false),
        },
      });
      const capabilities = await requirePrepareCapability(options);
      // A host restriction can narrow ordinary send authority; absence retains
      // the legacy message.send fallback. No authority is stored with the upload.
      try {
        if (!capabilities.includes("message.send") ||
            (options.permissions.authorizeThreadSend !== undefined &&
             await options.permissions.authorizeThreadSend({
               actor: options.actor, threadId: conversationId,
               parentConversationId: access.parentConversationId, capabilities,
             }) !== true)) throw new ChatAuthorizationError();
      } catch {
        throw new ChatAuthorizationError();
      }
      await authorizeThreadAccess({
        ...common, operation: "read", entityAction: PREPARE_ATTACHMENT_ENTITY_POLICY_ACTION,
      });
      return access;
    };
    const access = await authorize();
    if (!memberships.rows.some((row) => row.conversation_id === conversationId && row.state === "active")) {
      await ensureThreadParticipant({
        connection, schema, actor: options.actor, threadId: conversationId,
        parentConversationId: access.parentConversationId,
        entityAction: PREPARE_ATTACHMENT_ENTITY_POLICY_ACTION, permissions: options.permissions,
        occurredAt: toIsoTimestamp(destination.occurred_at, "participation timestamp"), initialRole: "member",
      });
    }
    // Closed/unlocked threads can prepare without reopening or changing activity.
    // Actual send independently authorizes its original destination and reopens.
    return async () => { await authorize(); };
  }

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
      FOR UPDATE OF conversation, member`,
    [options.actor.tenantId, conversationId, options.actor.userId],
  );
  const conversation = eligible.rows[0];
  if (conversation === undefined) throw new ChatAuthorizationError();
  await authorizeEntity(conversation, options);
};

const validateHeaders = (
  value: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid headers");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("invalid headers");
  }
  const entries = Object.entries(value);
  if (entries.length > 32) throw new Error("invalid headers");
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of entries) {
    if (
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name) ||
      typeof headerValue !== "string" ||
      Buffer.byteLength(headerValue, "utf8") > 2_048 ||
      /[\r\n]/.test(headerValue)
    ) {
      throw new Error("invalid headers");
    }
    headers[name] = headerValue;
  }
  return Object.freeze(headers);
};

const validateStorageResponse = (
  value: ChatStorageUploadUrl,
  now: Date,
): { readonly objectKey: string; readonly upload: AttachmentUploadDescriptor } => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid storage response");
  }
  const record = value as unknown as Record<string, unknown>;
  const prototype = Object.getPrototypeOf(record);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("invalid storage response");
  }
  const allowedKeys = new Set(["objectKey", "method", "url", "expiresAt", "headers"]);
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
    throw new Error("invalid storage response");
  }
  if (
    !nonEmptyString(record.objectKey) ||
    Buffer.byteLength(record.objectKey, "utf8") > 2_048 ||
    /\p{Cc}/u.test(record.objectKey) ||
    /[?#]/.test(record.objectKey) ||
    record.objectKey.includes("://") ||
    (record.method !== "PUT" && record.method !== "POST") ||
    !nonEmptyString(record.url)
  ) {
    throw new Error("invalid storage response");
  }
  let url: URL;
  try {
    url = new URL(record.url);
  } catch {
    throw new Error("invalid storage response");
  }
  const loopbackHttp = url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" ||
      url.hostname === "localhost" ||
      url.hostname === "[::1]");
  if (
    (url.protocol !== "https:" && !loopbackHttp) ||
    url.hostname === "" ||
    url.username !== "" ||
    url.password !== "" ||
    Buffer.byteLength(record.url, "utf8") > MAX_ATTACHMENT_OPAQUE_DESCRIPTOR_UTF8_BYTES
  ) {
    throw new Error("invalid storage response");
  }
  const headers = validateHeaders(
    record.headers as Readonly<Record<string, string>> | undefined,
  );
  // Keep credential-shaped provider instructions opaque to the public
  // attachment contract, which intentionally rejects serialized secret fields.
  const descriptor = Buffer.from(
    JSON.stringify({
      url: record.url,
      method: record.method,
      ...(headers === undefined ? {} : { headers }),
    }),
    "utf8",
  ).toString("base64url");
  const upload = parseAttachmentUploadDescriptor(
    {
      kind: "opaque_attachment_upload",
      descriptor,
      expiresAt: record.expiresAt,
    },
    { now },
  );
  return { objectKey: record.objectKey, upload };
};

const attachmentFromRow = (
  row: StoredAttachmentRow,
  options: PrepareAttachmentCommandOptions,
  input: PrepareAttachmentInput,
): PendingAttachmentState => {
  if (
    row.state !== "pending" ||
    row.uploader_user_id !== options.actor.userId ||
    row.file_name !== input.metadata.fileName ||
    row.content_type !== input.metadata.contentType ||
    toSizeBytes(row.size_bytes) !== input.metadata.sizeBytes
  ) {
    throw new Error("Stored attachment does not match its prepare outcome");
  }
  return {
    status: "pending",
    attachmentId: boundedIdentifier(row.id, "attachmentId") as AttachmentId,
    metadata: input.metadata,
    createdAt: toIsoTimestamp(row.created_at, "attachment creation timestamp"),
    expiresAt: toIsoTimestamp(row.expires_at, "attachment expiry timestamp"),
  };
};

const createUpload = async (
  storage: Pick<ChatStorageAdapter, "createUploadUrl">,
  options: PrepareAttachmentCommandOptions,
  input: PrepareAttachmentInput,
  attachmentId: AttachmentId,
  now: Date,
): Promise<{ readonly objectKey: string; readonly upload: AttachmentUploadDescriptor }> => {
  try {
    const response = await storage.createUploadUrl({
      actor: options.actor,
      attachmentId,
      fileName: input.metadata.fileName,
      contentType: input.metadata.contentType,
      contentLengthBytes: input.metadata.sizeBytes,
    });
    return validateStorageResponse(response, now);
  } catch {
    throw new PrepareAttachmentCommandError(
      "storage_unavailable",
      "Attachment upload preparation is temporarily unavailable",
    );
  }
};

const completeIdempotency = async (
  connection: PostgresMigrationConnection,
  prefix: string,
  options: PrepareAttachmentCommandOptions,
  input: PrepareAttachmentInput,
  requestHash: string,
  attachmentId: AttachmentId,
): Promise<void> => {
  const completed = await connection.query(
    `UPDATE ${prefix}.chat_idempotency_keys
        SET state = 'completed', response_status = 200,
            response_reference = $1, completed_at = statement_timestamp(),
            updated_at = statement_timestamp()
      WHERE tenant_id = $2 AND user_id = $3 AND operation_name = $4
        AND client_key = $5 AND request_hash = $6 AND state = 'pending'`,
    [
      attachmentId,
      options.actor.tenantId,
      options.actor.userId,
      PREPARE_ATTACHMENT_IDEMPOTENCY_OPERATION,
      input.idempotencyKey,
      requestHash,
    ],
  );
  if (completed.rowCount !== 1) {
    throw new PrepareAttachmentCommandError(
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
 * Reserves one pending attachment and returns short-lived upload instructions.
 * Provider credentials are validated in memory and never written to PostgreSQL.
 */
export async function prepareAttachment(
  options: PrepareAttachmentCommandOptions,
): Promise<PrepareAttachmentResult> {
  validateActor(options.actor);
  const conversationId = boundedIdentifier(
    options.conversationId,
    "conversationId",
  );
  const input = parsePrepareAttachmentInput(options.input);
  if (typeof options.attachmentsEnabled !== "boolean") {
    throw new TypeError("attachmentsEnabled must be a boolean");
  }
  if (!options.attachmentsEnabled || options.storage === undefined) {
    throw new PrepareAttachmentCommandError(
      "feature_disabled",
      "Attachment storage is not enabled",
    );
  }

  const schema = validatePostgresSchema(options.schema ?? DEFAULT_POSTGRES_SCHEMA);
  const prefix = quoteIdentifier(schema);
  const idempotencyTtlMs = positiveSafeInteger(
    options.idempotencyTtlMs ?? DEFAULT_PREPARE_ATTACHMENT_IDEMPOTENCY_TTL_MS,
    "idempotencyTtlMs",
  );
  const pendingTtlMs = positiveSafeInteger(
    options.pendingTtlMs ?? DEFAULT_PREPARE_ATTACHMENT_PENDING_TTL_MS,
    "pendingTtlMs",
    MAX_ATTACHMENT_PENDING_TTL_MS,
  );
  const createId = options.createId ?? randomUUID;
  const now = options.now ?? (() => new Date());
  const requestHash = hashRequest(conversationId, input);
  const storage = options.storage;

  await requirePrepareCapability(options);

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
        PREPARE_ATTACHMENT_IDEMPOTENCY_OPERATION,
        input.idempotencyKey,
        requestHash,
        idempotencyTtlMs,
      ],
    );
    const claimed = claim.rows[0];
    if (claimed === undefined) {
      throw new PrepareAttachmentCommandError(
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

    const refreshThreadAuthorization = await lockPreparationAccess(
      connection, prefix, schema, options, conversationId,
    );

    let prepared: PreparedUpload;
    if (claimed.idempotency_state === "completed") {
      if (!nonEmptyString(claimed.stored_response_reference)) {
        throw new Error("Completed prepare-attachment outcome has no attachment reference");
      }
      const replay = await connection.query<StoredAttachmentRow>(
        `SELECT id, uploader_user_id, storage_key, file_name, content_type,
                size_bytes, state, created_at, expires_at
           FROM ${prefix}.chat_attachments
          WHERE tenant_id = $1 AND id = $2 AND uploader_user_id = $3
            AND state = 'pending' AND expires_at > clock_timestamp()
          FOR UPDATE`,
        [
          options.actor.tenantId,
          claimed.stored_response_reference,
          options.actor.userId,
        ],
      );
      const row = replay.rows[0];
      if (row === undefined) {
        throw new PrepareAttachmentCommandError(
          "storage_unavailable",
          "The prepared attachment is no longer available",
        );
      }
      // Destination locks still protect SQL authority; host policy can change
      // while reconciliation waits for the attachment, so resolve it afresh.
      await refreshThreadAuthorization?.();
      const attachment = attachmentFromRow(row, options, input);
      const upload = await createUpload(
        storage,
        options,
        input,
        attachment.attachmentId,
        validateNow(now),
      );
      if (upload.objectKey !== row.storage_key) {
        throw new PrepareAttachmentCommandError(
          "storage_unavailable",
          "Attachment upload preparation is temporarily unavailable",
        );
      }
      if (Date.parse(upload.upload.expiresAt) > Date.parse(attachment.expiresAt)) {
        throw new PrepareAttachmentCommandError(
          "storage_unavailable",
          "Attachment upload preparation is temporarily unavailable",
        );
      }
      prepared = {
        attachment,
        upload: upload.upload,
        reconciliationStatus: "replayed",
      };
    } else {
      const attachmentId = boundedIdentifier(
        createId(),
        "attachmentId",
      ) as AttachmentId;
      const upload = await createUpload(
        storage,
        options,
        input,
        attachmentId,
        validateNow(now),
      );
      const inserted = await connection.query<StoredAttachmentRow>(
        `WITH timestamp AS (SELECT clock_timestamp() AS value)
         INSERT INTO ${prefix}.chat_attachments (
           tenant_id, id, uploader_user_id, storage_key, file_name,
           content_type, size_bytes, created_at, updated_at, expires_at
         )
         SELECT $1, $2, $3, $4, $5, $6, $7, timestamp.value,
                timestamp.value,
                timestamp.value + ($8::double precision * interval '1 millisecond')
           FROM timestamp
         RETURNING id, uploader_user_id, storage_key, file_name, content_type,
                   size_bytes, state, created_at, expires_at`,
        [
          options.actor.tenantId,
          attachmentId,
          options.actor.userId,
          upload.objectKey,
          input.metadata.fileName,
          input.metadata.contentType,
          input.metadata.sizeBytes,
          pendingTtlMs,
        ],
      );
      const row = inserted.rows[0];
      if (row === undefined) throw new Error("Attachment reservation was not persisted");
      const attachment = attachmentFromRow(row, options, input);
      if (Date.parse(upload.upload.expiresAt) > Date.parse(attachment.expiresAt)) {
        throw new PrepareAttachmentCommandError(
          "storage_unavailable",
          "Attachment upload preparation is temporarily unavailable",
        );
      }
      await completeIdempotency(
        connection,
        prefix,
        options,
        input,
        requestHash,
        attachmentId,
      );
      prepared = {
        attachment,
        upload: upload.upload,
        reconciliationStatus: "applied",
      };
    }

    const result = parsePrepareAttachmentResult(
      {
        operation: input.operation,
        reconciliationStatus: prepared.reconciliationStatus,
        idempotencyKey: input.idempotencyKey,
        attachment: prepared.attachment,
        upload: prepared.upload,
      },
      input,
      { now: validateNow(now) },
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
