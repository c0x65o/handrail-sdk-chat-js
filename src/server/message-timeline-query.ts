import {
  MessageTimelineContractError,
  createMessageTimelinePage,
  type MessageAttachmentMetadata,
  type MessageReactionAggregate,
  type MessageTimelineMessage,
  type MessageTimelinePage,
  type MessageTimelineRequest,
} from "../contracts/message-timeline.js";
import type {
  MessageBlock,
  MessageContent,
  ThreadSummary,
} from "../contracts/message.js";
import type {
  AttachmentId,
  ConversationId,
  IsoTimestamp,
  MessageId,
  MessageSequence,
  TenantId,
  UserId,
} from "../contracts/identifiers.js";
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

export const MESSAGE_TIMELINE_ENTITY_POLICY_ACTION =
  "conversation.timeline" as const;
export const MAX_MESSAGE_TIMELINE_LIMIT = 100 as const;

export interface MessageTimelineQueryOptions {
  readonly database: PostgresMigrationDatabase;
  readonly permissions: Pick<
    ChatPermissionAdapter<
      string,
      typeof MESSAGE_TIMELINE_ENTITY_POLICY_ACTION
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

interface StoredReactionAggregate {
  readonly reactionKey: string;
  readonly count: number;
  readonly reactedByCurrentUser: boolean;
}

interface StoredAttachmentMetadata {
  readonly attachmentId: string;
  readonly storageKey: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly sizeBytes: number;
}

interface StoredThreadSummary {
  readonly threadId: string;
  readonly replyCount: number;
  readonly participantIds: readonly string[];
  readonly unreadCount: number;
  readonly lastReplyAt?: string;
}

/** Message hydration fields shared by timeline and exact-source queries. */
export interface StoredMessageRow {
  readonly message_id: string | null;
  readonly sequence: string | number | null;
  readonly author_user_id: string | null;
  readonly reply_to_message_id: string | null;
  readonly reply_notify_author: boolean | null;
  readonly content: MessageContent<MessageBlock> | null;
  readonly current_revision: string | number | null;
  readonly created_at: Date | string | null;
  readonly updated_at: Date | string | null;
  readonly edited_at: Date | string | null;
  readonly edited_by_user_id: string | null;
  readonly deleted_at: Date | string | null;
  readonly deleted_by_user_id: string | null;
  readonly reactions: readonly StoredReactionAggregate[] | null;
  readonly attachments: readonly StoredAttachmentMetadata[] | null;
  readonly thread_summary: StoredThreadSummary | null;
}

interface StoredMessageTimelineRow extends StoredMessageRow {
  readonly conversation_type: string;
  readonly entity_type: string | null;
  readonly entity_id: string | null;
  readonly replay_event_id: string;
  readonly older_available: boolean;
  readonly newer_available: boolean;
}

const TRUSTED_IDENTITY_FIELDS = new Set([
  "tenant",
  "tenantId",
  "organizationId",
  "actor",
  "actorId",
  "actorContext",
  "userId",
  "currentUserId",
  "principal",
  "principalId",
  "subject",
  "subjectId",
  "authenticatedUser",
  "authenticatedUserId",
  "identity",
  "session",
  "auth",
  "roles",
]);

const quoteIdentifier = (identifier: string): string =>
  `"${identifier.replaceAll('"', '""')}"`;

const invalidRequest = (message: string): MessageTimelineContractError =>
  new MessageTimelineContractError("invalid_request", message);

const rejectTrustedIdentityFields = (value: unknown, path = "input"): void => {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      rejectTrustedIdentityFields(entry, `${path}[${index}]`),
    );
    return;
  }
  if (typeof value !== "object" || value === null) {
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (TRUSTED_IDENTITY_FIELDS.has(key)) {
      throw invalidRequest(`${path}.${key} is server-derived`);
    }
    rejectTrustedIdentityFields(nested, `${path}.${key}`);
  }
};

const parseRequest = (value: unknown): MessageTimelineRequest => {
  rejectTrustedIdentityFields(value);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidRequest("input must be an object");
  }

  const input = value as Record<string, unknown>;
  const allowed = new Set(["conversationId", "direction", "cursor", "limit"]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      throw invalidRequest(`input.${key} is not supported`);
    }
  }
  if (
    typeof input.conversationId !== "string" ||
    input.conversationId.trim().length === 0
  ) {
    throw invalidRequest("conversationId must be a non-empty string");
  }
  if (input.direction !== "backward" && input.direction !== "forward") {
    throw invalidRequest("direction must be backward or forward");
  }
  if (
    !Number.isSafeInteger(input.limit) ||
    (input.limit as number) < 1 ||
    (input.limit as number) > MAX_MESSAGE_TIMELINE_LIMIT
  ) {
    throw invalidRequest(
      `limit must be a safe integer between 1 and ${MAX_MESSAGE_TIMELINE_LIMIT}`,
    );
  }
  if (
    input.cursor !== undefined &&
    (!Number.isSafeInteger(input.cursor) || (input.cursor as number) < 0)
  ) {
    throw invalidRequest("cursor must be a non-negative safe integer");
  }

  return {
    conversationId: input.conversationId as ConversationId,
    direction: input.direction,
    ...(input.cursor === undefined
      ? {}
      : { cursor: input.cursor as MessageSequence }),
    limit: input.limit as number,
  };
};

const toIsoTimestamp = (value: Date | string, label: string): IsoTimestamp => {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.valueOf())) {
    throw new Error(`Invalid ${label} returned by PostgreSQL`);
  }
  return date.toISOString() as IsoTimestamp;
};

const toSequence = (
  value: string | number,
  label: string,
): MessageSequence => {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`Invalid ${label} returned by PostgreSQL`);
  }
  return number as MessageSequence;
};

const toCount = (value: number, label: string): number => {
  const count = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`Invalid ${label} returned by PostgreSQL`);
  }
  return count;
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
          sizeBytes: toCount(attachment.sizeBytes, "attachment size_bytes"),
          downloadUrl: download.url,
        });
      }),
    ),
  );

const createThreadSummary = (
  stored: StoredThreadSummary,
): ThreadSummary => ({
  threadId: stored.threadId as ConversationId,
  replyCount: toCount(stored.replyCount, "thread reply count"),
  participantIds: Object.freeze(
    stored.participantIds.map((userId) => userId as UserId),
  ),
  unreadCount: toCount(stored.unreadCount, "thread unread count"),
  ...(stored.lastReplyAt === undefined
    ? {}
    : {
        lastReplyAt: toIsoTimestamp(
          stored.lastReplyAt,
          "thread last reply time",
        ),
      }),
});

/** Hydrates an already-authorized row using trusted actor and storage context. */
export const rowToMessage = async (
  row: StoredMessageRow,
  request: Pick<MessageTimelineRequest, "conversationId">,
  actor: TrustedChatActorContext,
  storage: Pick<ChatStorageAdapter, "createDownloadUrl">,
): Promise<MessageTimelineMessage> => {
  if (
    row.message_id === null ||
    row.sequence === null ||
    row.author_user_id === null ||
    row.current_revision === null ||
    row.created_at === null ||
    row.updated_at === null
  ) {
    throw new Error("Incomplete message row returned by PostgreSQL");
  }

  const edited =
    row.edited_at === null || row.edited_by_user_id === null
      ? {}
      : {
          editedAt: toIsoTimestamp(row.edited_at, "message edited_at"),
          editedByUserId: row.edited_by_user_id as UserId,
        };
  const revision = {
    revision: toSequence(row.current_revision, "message current_revision"),
    ...edited,
  };
  const reactions: readonly MessageReactionAggregate[] = Object.freeze(
    (row.reactions ?? []).map((reaction) =>
      Object.freeze({
        reactionKey: reaction.reactionKey,
        count: toCount(reaction.count, "reaction count"),
        reactedByCurrentUser: reaction.reactedByCurrentUser,
      }),
    ),
  );
  const isDeleted = row.deleted_at !== null && row.deleted_by_user_id !== null;
  const attachmentMetadata = isDeleted
    ? Object.freeze([])
    : await createAttachmentMetadata(
        row.attachments ?? [],
        actor,
        storage,
      );
  const base = {
    id: row.message_id as MessageId,
    tenantId: actor.tenantId as TenantId,
    conversationId: request.conversationId,
    author: { type: "user" as const, userId: row.author_user_id as UserId },
    ...(row.reply_to_message_id === null
      ? {}
      : {
          replyTo: {
            messageId: row.reply_to_message_id as MessageId,
            notifyAuthor: row.reply_notify_author === true,
          },
        }),
    sequence: toSequence(row.sequence, "message sequence"),
    createdAt: toIsoTimestamp(row.created_at, "message created_at"),
    updatedAt: toIsoTimestamp(row.updated_at, "message updated_at"),
    revision,
    reactions,
    attachmentMetadata,
  };
  if (isDeleted) {
    const deleted = {
      ...base,
      content: null,
      deletedAt: toIsoTimestamp(row.deleted_at, "message deleted_at"),
      deletedByUserId: row.deleted_by_user_id as UserId,
    };
    return row.thread_summary === null
      ? { ...deleted, isThreadRoot: false }
      : {
          ...deleted,
          isThreadRoot: true,
          threadSummary: createThreadSummary(row.thread_summary),
        };
  }

  if (row.content === null) {
    throw new Error("Active message content is missing in PostgreSQL");
  }
  const active = { ...base, content: row.content };
  return row.thread_summary === null
    ? { ...active, isThreadRoot: false }
    : {
        ...active,
        isThreadRoot: true,
        threadSummary: createThreadSummary(row.thread_summary),
      };
};

/**
 * Loads an actor-visible, stable message page in one set-based PostgreSQL query.
 * Threads receive one additional current-parent access check before message
 * serialization, including empty pages and archived child history.
 * Attachment download URLs are resolved afterward through the host storage
 * boundary; no object-provider detail is persisted or inferred by this query.
 */
export async function queryMessageTimeline(
  options: MessageTimelineQueryOptions,
): Promise<MessageTimelinePage> {
  const request = parseRequest(options.input);
  if (!options.actor.tenantId || !options.actor.userId) {
    throw new TypeError("A trusted tenant and user are required");
  }

  const schema = validatePostgresSchema(
    options.schema ?? DEFAULT_POSTGRES_SCHEMA,
  );
  const prefix = quoteIdentifier(schema);
  const ordering = request.direction === "backward" ? "DESC" : "ASC";
  const cursorPredicate =
    request.direction === "backward"
      ? "($4::bigint IS NULL OR message.sequence < $4::bigint)"
      : "($4::bigint IS NULL OR message.sequence > $4::bigint)";
  const values = [
    options.actor.tenantId,
    options.actor.userId,
    request.conversationId,
    request.cursor ?? null,
    request.limit,
  ];

  const result = await options.database.query<StoredMessageTimelineRow>(
    `WITH admitted_conversation AS (
       SELECT
         conversation.tenant_id,
         conversation.id,
         conversation.type,
         conversation.entity_type,
         conversation.entity_id
       FROM ${prefix}.chat_conversations AS conversation
       LEFT JOIN ${prefix}.chat_conversation_members AS current_member
         ON current_member.tenant_id = conversation.tenant_id
        AND current_member.conversation_id = conversation.id
        AND current_member.user_id = $2
       WHERE conversation.tenant_id = $1
         AND conversation.id = $3
         AND (
           (conversation.type = 'channel' AND conversation.visibility = 'public')
           OR conversation.type = 'thread'
           OR current_member.state = 'active'
         )
       LIMIT 1
     ),
     snapshot AS (
       SELECT COALESCE(
         (
           SELECT event.event_id
           FROM ${prefix}.chat_outbox_events AS event
           WHERE event.tenant_id = $1
           ORDER BY event.replay_position DESC
           LIMIT 1
         ),
         'handrail-outbox:0'
       ) AS event_id
     ),
     candidate_messages AS (
       SELECT message.*
       FROM ${prefix}.chat_messages AS message
       JOIN admitted_conversation AS conversation
         ON conversation.tenant_id = message.tenant_id
        AND conversation.id = message.conversation_id
       WHERE ${cursorPredicate}
       ORDER BY message.sequence ${ordering}
       LIMIT $5::integer
     ),
     page_messages AS (
       SELECT *
       FROM candidate_messages
       ORDER BY sequence ASC
     ),
     page_edges AS (
       SELECT
         min(page.sequence) AS first_sequence,
         max(page.sequence) AS last_sequence
       FROM page_messages AS page
     ),
     page_bounds AS (
       SELECT
         CASE
           WHEN edges.first_sequence IS NULL THEN false
           ELSE EXISTS (
             SELECT 1
             FROM ${prefix}.chat_messages AS older
             JOIN admitted_conversation AS conversation
               ON conversation.tenant_id = older.tenant_id
              AND conversation.id = older.conversation_id
             WHERE older.sequence < edges.first_sequence
           )
         END AS older_available,
         CASE
           WHEN edges.last_sequence IS NULL THEN false
           ELSE EXISTS (
             SELECT 1
             FROM ${prefix}.chat_messages AS newer
             JOIN admitted_conversation AS conversation
               ON conversation.tenant_id = newer.tenant_id
              AND conversation.id = newer.conversation_id
             WHERE newer.sequence > edges.last_sequence
           )
         END AS newer_available
       FROM page_edges AS edges
     )
     SELECT
       conversation.type AS conversation_type,
       conversation.entity_type,
       conversation.entity_id,
       snapshot.event_id AS replay_event_id,
       bounds.older_available,
       bounds.newer_available,
       message.id AS message_id,
       message.sequence,
       message.author_user_id,
       message.reply_to_message_id,
       message.reply_notify_author,
       message.content,
       message.current_revision,
       message.created_at,
       message.updated_at,
       message.edited_at,
       message.edited_by_user_id,
       message.deleted_at,
       message.deleted_by_user_id,
       COALESCE(reaction_data.items, '[]'::jsonb) AS reactions,
       COALESCE(attachment_data.items, '[]'::jsonb) AS attachments,
       thread_data.summary AS thread_summary
     FROM admitted_conversation AS conversation
     CROSS JOIN snapshot
     CROSS JOIN page_bounds AS bounds
     LEFT JOIN page_messages AS message ON true
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(
         jsonb_build_object(
           'reactionKey', grouped.reaction_key,
           'count', grouped.reaction_count,
           'reactedByCurrentUser', grouped.reacted_by_current_user
         )
         ORDER BY grouped.reaction_key
       ) AS items
       FROM (
         SELECT
           reaction.reaction_key,
           count(*)::integer AS reaction_count,
           bool_or(reaction.user_id = $2) AS reacted_by_current_user
         FROM ${prefix}.chat_reactions AS reaction
         WHERE reaction.tenant_id = conversation.tenant_id
           AND reaction.message_id = message.id
         GROUP BY reaction.reaction_key
       ) AS grouped
     ) AS reaction_data ON message.id IS NOT NULL
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
         ON attachment.tenant_id = conversation.tenant_id
        AND attachment.id = reference.value ->> 'attachmentId'
        AND attachment.attached_message_id = message.id
        AND attachment.state = 'attached'
     ) AS attachment_data
       ON message.id IS NOT NULL AND message.deleted_at IS NULL
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
        AND thread_member.user_id = $2
       LEFT JOIN ${prefix}.chat_read_cursors AS read_cursor
         ON read_cursor.tenant_id = thread.tenant_id
        AND read_cursor.conversation_id = thread.id
        AND read_cursor.user_id = $2
       LEFT JOIN ${prefix}.chat_thread_follows AS thread_follow
         ON thread_follow.tenant_id = thread.tenant_id
        AND thread_follow.conversation_id = thread.id
        AND thread_follow.user_id = $2
       WHERE thread.tenant_id = conversation.tenant_id
         AND thread.type = 'thread'
         AND thread.parent_conversation_id = conversation.id
         AND thread.root_message_id = message.id
       GROUP BY
         thread.id,
         thread_member.state,
         thread_follow.is_following,
         read_cursor.last_read_sequence,
         read_cursor.manual_unread_from_sequence
       ORDER BY thread.id
       LIMIT 1
     ) AS thread_data ON message.id IS NOT NULL
     ORDER BY message.sequence ASC NULLS LAST`,
    values,
  );

  const firstRow = result.rows[0];
  if (firstRow === undefined) {
    throw new ChatAuthorizationError();
  }

  if (firstRow.conversation_type === "thread") {
    await authorizeThreadAccess({
      database: options.database,
      actor: options.actor,
      threadId: request.conversationId,
      schema,
      operation: "read",
      entityAction: MESSAGE_TIMELINE_ENTITY_POLICY_ACTION,
      permissions: options.permissions,
    });
  } else if (firstRow.entity_type !== null && firstRow.entity_id !== null) {
    let authorized = false;
    try {
      authorized = await options.permissions.authorizeEntity({
        actor: options.actor,
        entity: { type: firstRow.entity_type, id: firstRow.entity_id },
        action: MESSAGE_TIMELINE_ENTITY_POLICY_ACTION,
      });
    } catch {
      throw new ChatAuthorizationError();
    }
    if (!authorized) {
      throw new ChatAuthorizationError();
    }
  }

  const messageRows = result.rows.filter((row) => row.message_id !== null);
  const messages = await Promise.all(
    messageRows.map((row) =>
      rowToMessage(row, request, options.actor, options.storage),
    ),
  );
  const firstMessage = messages[0];
  const lastMessage = messages.at(-1);
  const pagination = {
    older:
      firstMessage !== undefined && firstRow.older_available
        ? { available: true as const, cursor: firstMessage.sequence }
        : { available: false as const },
    newer:
      lastMessage !== undefined && firstRow.newer_available
        ? { available: true as const, cursor: lastMessage.sequence }
        : { available: false as const },
  };

  return createMessageTimelinePage(request, {
    messages: Object.freeze(messages),
    pagination,
    replay: { resumeFrom: { eventId: firstRow.replay_event_id } },
  });
}
