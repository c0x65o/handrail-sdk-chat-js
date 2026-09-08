import {
  MAX_ATTACHMENT_OPAQUE_DESCRIPTOR_UTF8_BYTES,
  parseAttachmentLifecycleState,
  parseGetAttachmentDownloadInput,
  parseGetAttachmentDownloadResult,
  type AttachedAttachmentState,
  type GetAttachmentDownloadInput,
  type GetAttachmentDownloadResult,
} from "../contracts/attachment-transport.js";
import type {
  AttachmentId,
  IsoTimestamp,
  MessageId,
} from "../contracts/identifiers.js";
import type {
  ChatPermissionAdapter,
  ChatStorageAdapter,
  ChatStorageUrl,
  TrustedChatActorContext,
} from "./contracts.js";
import {
  DEFAULT_POSTGRES_SCHEMA,
  validatePostgresSchema,
  type PostgresMigrationDatabase,
} from "./postgres-migrations.js";
import { ChatAuthorizationError } from "./request-context.js";
import { authorizeThreadAccess } from "./thread-access.js";

export const ATTACHMENT_DOWNLOAD_ENTITY_POLICY_ACTION =
  "attachment.download" as const;

export type AttachmentDownloadQueryErrorCode = "storage_unavailable";

/** Stable provider-neutral failure for download descriptor generation. */
export class AttachmentDownloadQueryError extends Error {
  public readonly statusCode = 503;

  public constructor(
    public readonly code: AttachmentDownloadQueryErrorCode,
    message = "Attachment download is temporarily unavailable",
  ) {
    super(message);
    this.name = "AttachmentDownloadQueryError";
  }
}

export interface AttachmentDownloadQueryOptions {
  readonly database: PostgresMigrationDatabase;
  readonly permissions: Pick<
    ChatPermissionAdapter<
      string,
      typeof ATTACHMENT_DOWNLOAD_ENTITY_POLICY_ACTION
    >,
    "authorizeEntity"
  >;
  readonly storage: Pick<ChatStorageAdapter, "createDownloadUrl">;
  /** Trusted host-session identity; caller input cannot override these values. */
  readonly actor: TrustedChatActorContext;
  /** JSON-decoded caller input, validated before database or provider access. */
  readonly input: unknown;
  readonly schema?: string;
  /** Deterministic descriptor-validation clock for focused tests. */
  readonly now?: () => Date;
}

interface AuthorizedAttachmentRow {
  readonly id: string;
  readonly storage_key: string;
  readonly file_name: string;
  readonly content_type: string;
  readonly size_bytes: string | number;
  readonly checksum: string;
  readonly attached_message_id: string;
  readonly created_at: Date | string;
  readonly expires_at: Date | string;
  readonly attached_at: Date | string;
  readonly conversation_id: string;
  readonly conversation_type: string;
  readonly entity_type: string | null;
  readonly entity_id: string | null;
}

const MAX_DOWNLOAD_URL_UTF8_BYTES = 2_048;
const MAX_DOWNLOAD_HEADER_COUNT = 32;
const MAX_DOWNLOAD_HEADER_NAME_BYTES = 128;
const MAX_DOWNLOAD_HEADER_VALUE_BYTES = 2_048;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

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

const validNow = (now: () => Date): Date => {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) {
    throw new TypeError("now must return a valid Date");
  }
  return value;
};

const toIsoTimestamp = (value: Date | string): IsoTimestamp => {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.valueOf())) throw new Error("invalid timestamp");
  return date.toISOString() as IsoTimestamp;
};

const toSizeBytes = (value: string | number): number => {
  const size = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("invalid size");
  return size;
};

const attachmentFromRow = (
  row: AuthorizedAttachmentRow,
  input: GetAttachmentDownloadInput,
): AttachedAttachmentState => {
  try {
    const attachment = parseAttachmentLifecycleState({
      status: "attached",
      attachmentId: row.id,
      messageId: row.attached_message_id,
      metadata: {
        fileName: row.file_name,
        contentType: row.content_type,
        sizeBytes: toSizeBytes(row.size_bytes),
      },
      checksum: row.checksum,
      createdAt: toIsoTimestamp(row.created_at),
      expiresAt: toIsoTimestamp(row.expires_at),
      attachedAt: toIsoTimestamp(row.attached_at),
    });
    if (
      attachment.status !== "attached" ||
      attachment.attachmentId !== input.attachmentId ||
      attachment.messageId !== input.messageId
    ) {
      throw new Error("incoherent attachment");
    }
    return attachment;
  } catch {
    throw new ChatAuthorizationError();
  }
};

const encodeRfc5987Value = (value: string): string =>
  encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

const contentDispositionFor = (fileName: string): string => {
  const fallback = [...fileName]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 0x20 && codePoint <= 0x7e ? character : "_";
    })
    .join("")
    .replace(/["\\]/g, "_");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987Value(fileName)}`;
};

const validatedHeaders = (
  value: unknown,
  contentDisposition: string,
): Readonly<Record<string, string>> => {
  if (value !== undefined) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("invalid headers");
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("invalid headers");
    }
  }

  const entries = value === undefined
    ? []
    : Object.entries(value as Record<string, unknown>);
  if (entries.length >= MAX_DOWNLOAD_HEADER_COUNT) {
    throw new Error("invalid headers");
  }
  const headers: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  const normalizedNames = new Set<string>();
  for (const [name, headerValue] of entries) {
    const normalizedName = name.toLowerCase();
    if (
      Buffer.byteLength(name, "utf8") > MAX_DOWNLOAD_HEADER_NAME_BYTES ||
      !HEADER_NAME_PATTERN.test(name) ||
      normalizedNames.has(normalizedName) ||
      typeof headerValue !== "string" ||
      Buffer.byteLength(headerValue, "utf8") > MAX_DOWNLOAD_HEADER_VALUE_BYTES ||
      /[\r\n]/.test(headerValue) ||
      (normalizedName === "content-disposition" &&
        headerValue !== contentDisposition)
    ) {
      throw new Error("invalid headers");
    }
    normalizedNames.add(normalizedName);
    if (normalizedName !== "content-disposition") {
      headers[name] = headerValue;
    }
  }
  headers["content-disposition"] = contentDisposition;
  return Object.freeze(headers);
};

const descriptorFromStorage = (
  response: ChatStorageUrl,
  fileName: string,
  now: Date,
): GetAttachmentDownloadResult["download"] => {
  if (typeof response !== "object" || response === null || Array.isArray(response)) {
    throw new Error("invalid response");
  }
  const record = response as unknown as Record<string, unknown>;
  const prototype = Object.getPrototypeOf(record);
  const allowedKeys = new Set(["url", "expiresAt", "headers"]);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    Object.keys(record).some((key) => !allowedKeys.has(key)) ||
    !nonEmptyString(record.url) ||
    Buffer.byteLength(record.url, "utf8") > MAX_DOWNLOAD_URL_UTF8_BYTES ||
    /[\p{Cc}\p{Cf}]/u.test(record.url)
  ) {
    throw new Error("invalid response");
  }
  let url: URL;
  try {
    url = new URL(record.url);
  } catch {
    throw new Error("invalid response");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname === "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error("invalid response");
  }
  const headers = validatedHeaders(
    record.headers,
    contentDispositionFor(fileName),
  );
  const descriptor = Buffer.from(
    JSON.stringify({ url: record.url, headers }),
    "utf8",
  ).toString("base64url");
  if (Buffer.byteLength(descriptor, "utf8") > MAX_ATTACHMENT_OPAQUE_DESCRIPTOR_UTF8_BYTES) {
    throw new Error("invalid response");
  }
  return {
    kind: "opaque_attachment_download",
    descriptor,
    expiresAt: record.expiresAt as IsoTimestamp,
  };
};

const unavailable = (): AttachmentDownloadQueryError =>
  new AttachmentDownloadQueryError("storage_unavailable");

/**
 * Authorizes one finalized attached object and returns an in-memory, short-lived
 * opaque download descriptor without exposing or persisting storage internals.
 */
export async function queryAttachmentDownload(
  options: AttachmentDownloadQueryOptions,
): Promise<GetAttachmentDownloadResult> {
  const input = parseGetAttachmentDownloadInput(options.input);
  validateActor(options.actor);
  const now = validNow(options.now ?? (() => new Date()));
  const schema = validatePostgresSchema(options.schema ?? DEFAULT_POSTGRES_SCHEMA);
  const prefix = quoteIdentifier(schema);

  const selected = await options.database.query<AuthorizedAttachmentRow>(
    `SELECT
       attachment.id,
       attachment.storage_key,
       attachment.file_name,
       attachment.content_type,
       attachment.size_bytes,
       attachment.checksum,
       attachment.attached_message_id,
       attachment.created_at,
       attachment.expires_at,
       attachment.attached_at,
       conversation.id AS conversation_id,
       conversation.type AS conversation_type,
       conversation.entity_type,
       conversation.entity_id
     FROM ${prefix}.chat_attachments AS attachment
     INNER JOIN ${prefix}.chat_messages AS message
       ON message.tenant_id = attachment.tenant_id
      AND message.id = attachment.attached_message_id
      AND message.id = $3
      AND message.deleted_at IS NULL
      AND message.deleted_by_user_id IS NULL
     INNER JOIN ${prefix}.chat_conversations AS conversation
       ON conversation.tenant_id = message.tenant_id
      AND conversation.id = message.conversation_id
     LEFT JOIN ${prefix}.chat_conversation_members AS current_member
       ON current_member.tenant_id = conversation.tenant_id
      AND current_member.conversation_id = conversation.id
      AND current_member.user_id = $4
     WHERE attachment.tenant_id = $1
       AND attachment.id = $2
       AND attachment.state = 'attached'
       AND attachment.checksum ~ '^sha256:[0-9a-f]{64}$'
       AND attachment.attached_message_id = $3
       AND attachment.attached_at IS NOT NULL
       AND (
         (conversation.type = 'channel' AND conversation.visibility = 'public')
         OR conversation.type = 'thread'
         OR current_member.state = 'active'
       )
     LIMIT 1`,
    [
      options.actor.tenantId,
      input.attachmentId,
      input.messageId,
      options.actor.userId,
    ],
  );
  const row = selected.rows[0];
  if (row === undefined) throw new ChatAuthorizationError();
  const attachment = attachmentFromRow(row, input);

  if (row.conversation_type === "thread") {
    const access = await authorizeThreadAccess({
      database: options.database,
      actor: options.actor,
      threadId: row.conversation_id,
      schema,
      operation: "read",
      entityAction: ATTACHMENT_DOWNLOAD_ENTITY_POLICY_ACTION,
      permissions: options.permissions,
    });
    // The shared read guard exposes archived history metadata. Downloads must
    // still deny administrative archive, independently of closed/locked state.
    if (access.isArchived) throw new ChatAuthorizationError();
  }

  if (row.entity_type !== null || row.entity_id !== null) {
    if (row.entity_type === null || row.entity_id === null) {
      throw new ChatAuthorizationError();
    }
    try {
      const allowed = await options.permissions.authorizeEntity({
        actor: options.actor,
        entity: { type: row.entity_type, id: row.entity_id },
        action: ATTACHMENT_DOWNLOAD_ENTITY_POLICY_ACTION,
      });
      if (!allowed) throw new Error("denied");
    } catch {
      throw new ChatAuthorizationError();
    }
  }

  try {
    const response = await options.storage.createDownloadUrl({
      actor: options.actor,
      attachmentId: input.attachmentId as AttachmentId,
      objectKey: row.storage_key,
      fileName: attachment.metadata.fileName,
      contentDisposition: "attachment",
    });
    const download = descriptorFromStorage(response, attachment.metadata.fileName, now);
    return parseGetAttachmentDownloadResult(
      {
        operation: "get_attachment_download",
        attachmentId: input.attachmentId as AttachmentId,
        messageId: input.messageId as MessageId,
        attachment,
        download,
      },
      input,
      { now },
    );
  } catch (error) {
    if (error instanceof AttachmentDownloadQueryError) throw error;
    throw unavailable();
  }
}
