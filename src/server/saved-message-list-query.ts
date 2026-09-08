import {
  ACTOR_PRIVATE_USER_STATE_PRIVACY,
  decodeSavedMessageSnapshotCursor,
  encodeSavedMessageSnapshotCursor,
  parseSavedMessageListSnapshot,
  parseSavedMessageListSnapshotInput,
  type SavedMessageListSnapshot,
  type SavedMessageListSnapshotInput,
  type SavedMessageSnapshotEntry,
  type SavedMessageCurrentProjection,
} from "../contracts/private-user-state-snapshot.js";
import type {
  AttachmentId,
  ConversationId,
  IsoTimestamp,
  MessageId,
  MessageSequence,
  UserId,
} from "../contracts/identifiers.js";
import type {
  MessageBlock,
  MessageContent,
  MessageRevisionMetadata,
} from "../contracts/message.js";
import type { MessageAttachmentMetadata } from "../contracts/message-timeline.js";
import type {
  ChatPermissionAdapter,
  ChatStorageAdapter,
  TrustedChatActorContext,
} from "./contracts.js";
import {
  DEFAULT_POSTGRES_SCHEMA,
  validatePostgresSchema,
  type PostgresMigrationDatabase,
} from "./postgres-migrations.js";
import { ChatAuthorizationError } from "./request-context.js";
import { authorizeThreadAccess } from "./thread-access.js";

export const SAVED_MESSAGE_LIST_ENTITY_POLICY_ACTION =
  "saved_message.list" as const;

export interface SavedMessageListQueryOptions {
  readonly database: PostgresMigrationDatabase;
  readonly permissions: Pick<
    ChatPermissionAdapter<
      string,
      typeof SAVED_MESSAGE_LIST_ENTITY_POLICY_ACTION
    >,
    "authorizeEntity"
  >;
  readonly storage: Pick<ChatStorageAdapter, "createDownloadUrl">;
  /** Trusted host-session identity; caller input cannot override these values. */
  readonly actor: TrustedChatActorContext;
  /** JSON-decoded caller input, validated before database access. */
  readonly input: unknown;
  readonly schema?: string;
}

interface StoredAttachmentMetadata {
  readonly attachmentId: string;
  readonly storageKey: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly sizeBytes: string | number;
}

interface StoredSavedMessageRow {
  readonly message_id: string;
  /** Six fractional digits are retained for lossless keyset pagination. */
  readonly saved_at: string;
  readonly updated_at: Date | string;
  readonly saved_message_revision: string | number;
  readonly private_note: string | null;
  readonly conversation_id: string;
  readonly conversation_type: string;
  readonly entity_type: string | null;
  readonly entity_id: string | null;
  readonly conversation_visible: boolean;
  readonly sequence: string | number;
  readonly author_user_id: string;
  readonly reply_to_message_id: string | null;
  readonly reply_notify_author: boolean;
  readonly content: MessageContent<MessageBlock> | null;
  readonly current_revision: string | number;
  readonly message_created_at: Date | string;
  readonly message_updated_at: Date | string;
  readonly edited_at: Date | string | null;
  readonly edited_by_user_id: string | null;
  readonly deleted_at: Date | string | null;
  readonly deleted_by_user_id: string | null;
  readonly attachments: readonly StoredAttachmentMetadata[] | null;
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

const toIsoTimestamp = (
  value: Date | string,
  label: string,
): IsoTimestamp => {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.valueOf())) {
    throw new Error(`Invalid ${label} returned by PostgreSQL`);
  }
  return date.toISOString() as IsoTimestamp;
};

const toCursorTimestamp = (value: string): IsoTimestamp => {
  if (!Number.isFinite(new Date(value).valueOf())) {
    throw new Error("Invalid saved_at returned by PostgreSQL");
  }
  return value as IsoTimestamp;
};

const toSafeInteger = (
  value: string | number,
  label: string,
  minimum: number,
): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`Invalid ${label} returned by PostgreSQL`);
  }
  return parsed;
};

const createAttachmentMetadata = async (
  stored: readonly StoredAttachmentMetadata[],
  actor: TrustedChatActorContext,
  storage: Pick<ChatStorageAdapter, "createDownloadUrl">,
): Promise<readonly MessageAttachmentMetadata[]> =>
  Object.freeze(
    await Promise.all(
      stored.map(async (attachment) => {
        const download = await storage.createDownloadUrl({
          actor,
          attachmentId: attachment.attachmentId as AttachmentId,
          objectKey: attachment.storageKey,
          fileName: attachment.fileName,
          contentDisposition: "attachment",
        });
        return Object.freeze({
          attachmentId: attachment.attachmentId as AttachmentId,
          fileName: attachment.fileName,
          contentType: attachment.contentType,
          sizeBytes: toSafeInteger(
            attachment.sizeBytes,
            "attachment size_bytes",
            0,
          ),
          downloadUrl: download.url,
        });
      }),
    ),
  );

const entityAuthorizationKey = (row: StoredSavedMessageRow): string | null =>
  row.entity_type === null || row.entity_id === null
    ? null
    : JSON.stringify([row.entity_type, row.entity_id]);

const authorizeEntities = async (
  rows: readonly StoredSavedMessageRow[],
  options: SavedMessageListQueryOptions,
): Promise<ReadonlyMap<string, boolean>> => {
  const entities = new Map<
    string,
    { readonly type: string; readonly id: string }
  >();
  for (const row of rows) {
    const key = entityAuthorizationKey(row);
    if (
      row.conversation_visible &&
      row.conversation_type !== "thread" &&
      key !== null &&
      row.entity_type !== null &&
      row.entity_id !== null
    ) {
      entities.set(key, { type: row.entity_type, id: row.entity_id });
    }
  }

  const results = await Promise.all(
    [...entities].map(async ([key, entity]) => {
      try {
        const allowed = await options.permissions.authorizeEntity({
          actor: options.actor,
          entity,
          action: SAVED_MESSAGE_LIST_ENTITY_POLICY_ACTION,
        });
        return [key, allowed === true] as const;
      } catch {
        return [key, false] as const;
      }
    }),
  );
  return new Map(results);
};

const authorizeThreads = async (
  rows: readonly StoredSavedMessageRow[],
  options: SavedMessageListQueryOptions,
): Promise<ReadonlyMap<string, boolean>> => {
  const results = new Map<string, boolean>();
  // Sequential checks bound database concurrency; repeated saves in a thread
  // reuse only this request's result. The lookahead row is never authorized.
  for (const row of rows) {
    if (
      row.conversation_type !== "thread" || !row.conversation_visible ||
      results.has(row.conversation_id)
    ) continue;
    try {
      const access = await authorizeThreadAccess({
        database: options.database,
        actor: options.actor,
        threadId: row.conversation_id,
        ...(options.schema === undefined ? {} : { schema: options.schema }),
        operation: "read",
        entityAction: SAVED_MESSAGE_LIST_ENTITY_POLICY_ACTION,
        permissions: options.permissions,
      });
      // The shared helper permits archived-child reads; saved lists do not.
      results.set(row.conversation_id, !access.isArchived);
    } catch (error) {
      if (!(error instanceof ChatAuthorizationError)) throw error;
      results.set(row.conversation_id, false);
    }
  }
  return results;
};

const isCurrentlyAuthorized = (
  row: StoredSavedMessageRow,
  entityAuthorizations: ReadonlyMap<string, boolean>,
  threadAuthorizations: ReadonlyMap<string, boolean>,
): boolean => {
  if (!row.conversation_visible) return false;
  if (row.conversation_type === "thread") {
    return threadAuthorizations.get(row.conversation_id) === true;
  }
  if ((row.entity_type === null) !== (row.entity_id === null)) return false;
  const key = entityAuthorizationKey(row);
  return key === null || entityAuthorizations.get(key) === true;
};

const createCurrentProjection = async (
  row: StoredSavedMessageRow,
  options: SavedMessageListQueryOptions,
): Promise<SavedMessageCurrentProjection> => {
  if (row.content === null) {
    throw new Error("Active saved message content is missing in PostgreSQL");
  }
  const revision: MessageRevisionMetadata = {
    revision: toSafeInteger(
      row.current_revision,
      "message current_revision",
      1,
    ),
    ...(row.edited_at === null
      ? {}
      : { editedAt: toIsoTimestamp(row.edited_at, "message edited_at") }),
    ...(row.edited_by_user_id === null
      ? {}
      : { editedByUserId: row.edited_by_user_id as UserId }),
  };
  return {
    id: row.message_id as MessageId,
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
    sequence: toSafeInteger(
      row.sequence,
      "message sequence",
      1,
    ) as MessageSequence,
    createdAt: toIsoTimestamp(row.message_created_at, "message created_at"),
    updatedAt: toIsoTimestamp(row.message_updated_at, "message updated_at"),
    revision,
    content: row.content,
    attachmentMetadata: await createAttachmentMetadata(
      row.attachments ?? [],
      options.actor,
      options.storage,
    ),
  };
};

const rowToEntry = async (
  row: StoredSavedMessageRow,
  entityAuthorizations: ReadonlyMap<string, boolean>,
  threadAuthorizations: ReadonlyMap<string, boolean>,
  options: SavedMessageListQueryOptions,
): Promise<SavedMessageSnapshotEntry> => {
  const entry = {
    messageId: row.message_id as MessageId,
    savedMessageRevision: toSafeInteger(
      row.saved_message_revision,
      "saved_message_revision",
      1,
    ),
    savedAt: toCursorTimestamp(row.saved_at),
    updatedAt: toIsoTimestamp(row.updated_at, "saved-message updated_at"),
    ...(row.private_note === null
      ? {}
      : {
          privateNote: {
            privacy: ACTOR_PRIVATE_USER_STATE_PRIVACY,
            text: row.private_note,
          },
        }),
  };

  if (!isCurrentlyAuthorized(row, entityAuthorizations, threadAuthorizations)) {
    return {
      ...entry,
      message: { availability: "unavailable", reason: "inaccessible" },
    };
  }
  if (row.deleted_at !== null || row.deleted_by_user_id !== null) {
    return {
      ...entry,
      message: { availability: "unavailable", reason: "deleted" },
    };
  }
  return {
    ...entry,
    message: {
      availability: "available",
      current: await createCurrentProjection(row, options),
    },
  };
};

/**
 * Loads one stable page of the trusted actor's saved rows with one set-based
 * PostgreSQL query plus at most one parent-access query per distinct unarchived
 * thread on the page. Current chat and host-entity visibility is rechecked before
 * attachment URLs are resolved or any message projection is returned.
 */
export async function querySavedMessageList(
  options: SavedMessageListQueryOptions,
): Promise<SavedMessageListSnapshot> {
  validateActor(options.actor);
  const input: SavedMessageListSnapshotInput =
    parseSavedMessageListSnapshotInput(options.input);
  const cursor =
    input.cursor === undefined
      ? undefined
      : decodeSavedMessageSnapshotCursor(input.cursor);
  const schema = validatePostgresSchema(
    options.schema ?? DEFAULT_POSTGRES_SCHEMA,
  );
  const prefix = quoteIdentifier(schema);

  const result = await options.database.query<StoredSavedMessageRow>(
    `WITH saved_page AS (
       SELECT saved.*
       FROM ${prefix}.chat_saved_messages AS saved
       WHERE saved.tenant_id = $1
         AND saved.user_id = $2
         AND saved.is_saved IS TRUE
         AND (
           $3::timestamptz IS NULL
           OR (saved.created_at, saved.message_id) < ($3::timestamptz, $4::text)
         )
       ORDER BY saved.created_at DESC, saved.message_id DESC
       LIMIT $5
     )
     SELECT
       saved.message_id,
       to_char(
         saved.created_at AT TIME ZONE 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
       ) AS saved_at,
       saved.updated_at,
       saved.saved_message_revision,
       saved.private_note,
       saved.conversation_id,
       conversation.type AS conversation_type,
       conversation.entity_type,
       conversation.entity_id,
       (
         conversation.archived_at IS NULL
         AND (
           conversation.type = 'thread'
           OR (conversation.type = 'channel' AND conversation.visibility = 'public')
           OR current_member.state = 'active'
         )
       ) AS conversation_visible,
       message.sequence,
       message.author_user_id,
       message.reply_to_message_id,
       message.reply_notify_author,
       message.content,
       message.current_revision,
       message.created_at AS message_created_at,
       message.updated_at AS message_updated_at,
       message.edited_at,
       message.edited_by_user_id,
       message.deleted_at,
       message.deleted_by_user_id,
       attachment_data.items AS attachments
     FROM saved_page AS saved
     JOIN ${prefix}.chat_conversations AS conversation
       ON conversation.tenant_id = saved.tenant_id
      AND conversation.id = saved.conversation_id
     JOIN ${prefix}.chat_messages AS message
       ON message.tenant_id = saved.tenant_id
      AND message.id = saved.message_id
      AND message.conversation_id = saved.conversation_id
     LEFT JOIN ${prefix}.chat_conversation_members AS current_member
       ON current_member.tenant_id = conversation.tenant_id
      AND current_member.conversation_id = conversation.id
      AND current_member.user_id = $2
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(
         jsonb_build_object(
           'attachmentId', attachment.id,
           'storageKey', attachment.storage_key,
           'fileName', attachment.file_name,
           'contentType', attachment.content_type,
           'sizeBytes', attachment.size_bytes
         )
         ORDER BY reference.ordinality
       ) AS items
       FROM jsonb_array_elements(
         COALESCE(message.content -> 'attachments', '[]'::jsonb)
       ) WITH ORDINALITY AS reference(value, ordinality)
       JOIN ${prefix}.chat_attachments AS attachment
         ON attachment.tenant_id = saved.tenant_id
        AND attachment.id = reference.value ->> 'attachmentId'
        AND attachment.attached_message_id = message.id
        AND attachment.state = 'attached'
     ) AS attachment_data ON message.deleted_at IS NULL
     ORDER BY saved.created_at DESC, saved.message_id DESC`,
    [
      options.actor.tenantId,
      options.actor.userId,
      cursor?.savedAt ?? null,
      cursor?.messageId ?? null,
      input.limit + 1,
    ],
  );

  const pageRows = result.rows.slice(0, input.limit);
  const entityAuthorizations = await authorizeEntities(pageRows, options);
  const threadAuthorizations = await authorizeThreads(pageRows, options);
  const items = await Promise.all(
    pageRows.map((row) =>
      rowToEntry(row, entityAuthorizations, threadAuthorizations, options)),
  );
  const last = items.at(-1);
  const nextCursor =
    result.rows.length > input.limit && last !== undefined
      ? encodeSavedMessageSnapshotCursor({
          savedAt: last.savedAt,
          messageId: last.messageId,
        })
      : null;

  return parseSavedMessageListSnapshot(
    {
      kind: "saved_message_list",
      privacy: ACTOR_PRIVATE_USER_STATE_PRIVACY,
      items,
      page: { nextCursor },
    },
    input,
  );
}
