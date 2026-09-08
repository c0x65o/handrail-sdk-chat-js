import {
  parseMessageContextRequest,
  parseMessageContextResult,
  type MessageContextResult,
} from "../contracts/message-context.js";
import type {
  ChatPermissionAdapter,
  ChatStorageAdapter,
  TrustedChatActorContext,
} from "./contracts.js";
import {
  MESSAGE_TIMELINE_ENTITY_POLICY_ACTION,
  rowToMessage,
  type StoredMessageRow,
} from "./message-timeline-query.js";
import {
  DEFAULT_POSTGRES_SCHEMA,
  validatePostgresSchema,
  type PostgresMigrationDatabase,
} from "./postgres-migrations.js";
import { ChatAuthorizationError } from "./request-context.js";
import { authorizeThreadAccess } from "./thread-access.js";

export interface MessageContextQueryOptions {
  readonly database: Pick<PostgresMigrationDatabase, "query">;
  readonly permissions: Pick<
    ChatPermissionAdapter<string, typeof MESSAGE_TIMELINE_ENTITY_POLICY_ACTION>,
    "authorizeEntity"
  >;
  readonly storage: Pick<ChatStorageAdapter, "createDownloadUrl">;
  /** Trusted host-session identity; never derived from input. */
  readonly actor: TrustedChatActorContext;
  /** JSON-decoded caller input, validated before database access. */
  readonly input: unknown;
  readonly schema?: string;
}

interface AdmittedConversation {
  readonly type: string;
  readonly entity_type: string | null;
  readonly entity_id: string | null;
}

/** Resolves one exact source without pagination, replay reads or state writes. */
export async function queryMessageContext(
  options: MessageContextQueryOptions,
): Promise<MessageContextResult> {
  const request = parseMessageContextRequest(options.input);
  const { actor } = options;
  const nonEmptyString = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  if (!nonEmptyString(actor.tenantId) || !nonEmptyString(actor.userId) ||
      !Array.isArray(actor.roles) || !actor.roles.every(nonEmptyString)) {
    throw new TypeError("A valid trusted chat actor is required");
  }
  const schema = validatePostgresSchema(options.schema ?? DEFAULT_POSTGRES_SCHEMA);
  const prefix = `"${schema}"`;
  const unavailable = (): MessageContextResult =>
    parseMessageContextResult({ ...request, status: "unavailable" }, request);

  // Match timeline admission. Thread visibility is decided only by the shared
  // current-parent policy below, never by retained child membership.
  const admission = await options.database.query<AdmittedConversation>(
    `SELECT conversation.type, conversation.entity_type, conversation.entity_id
       FROM ${prefix}.chat_conversations AS conversation
       LEFT JOIN ${prefix}.chat_conversation_members AS current_member
         ON current_member.tenant_id = conversation.tenant_id
        AND current_member.conversation_id = conversation.id
        AND current_member.user_id = $2
      WHERE conversation.tenant_id = $1 AND conversation.id = $3
        AND ((conversation.type = 'channel' AND conversation.visibility = 'public')
             OR conversation.type = 'thread' OR current_member.state = 'active')
      LIMIT 1`,
    [actor.tenantId, actor.userId, request.conversationId],
  );
  const conversation = admission.rows[0];
  if (conversation === undefined) return unavailable();

  // The shared helper deliberately normalizes permission exceptions to denial.
  // Retain infrastructure failures separately so context reads remain retryable.
  let permissionFailure: { readonly error: unknown } | undefined;
  try {
    if (conversation.type === "thread") {
      await authorizeThreadAccess({
        database: options.database, actor, schema,
        threadId: request.conversationId,
        operation: "read",
        entityAction: MESSAGE_TIMELINE_ENTITY_POLICY_ACTION,
        permissions: {
          async authorizeEntity(input) {
            try {
              return await options.permissions.authorizeEntity(input);
            } catch (error) {
              if (!(error instanceof ChatAuthorizationError)) permissionFailure = { error };
              throw error;
            }
          },
        },
      });
    } else if (conversation.entity_type !== null || conversation.entity_id !== null) {
      if (conversation.entity_type === null || conversation.entity_id === null) return unavailable();
      const allowed = await options.permissions.authorizeEntity({
        actor,
        entity: { type: conversation.entity_type, id: conversation.entity_id },
        action: MESSAGE_TIMELINE_ENTITY_POLICY_ACTION,
      });
      if (!allowed) return unavailable();
    }
  } catch (error) {
    if (permissionFailure !== undefined) throw permissionFailure.error;
    if (error instanceof ChatAuthorizationError) return unavailable();
    throw error;
  }

  const result = await options.database.query<StoredMessageRow>(
    `SELECT message.id AS message_id, message.sequence, message.author_user_id,
            message.reply_to_message_id, message.reply_notify_author,
            message.content, message.current_revision,
            message.created_at, message.updated_at,
            message.edited_at, message.edited_by_user_id,
            message.deleted_at, message.deleted_by_user_id,
            NULL::jsonb AS reactions, NULL::jsonb AS attachments,
            thread_data.summary AS thread_summary
       FROM ${prefix}.chat_messages AS message
       LEFT JOIN LATERAL (
         SELECT jsonb_strip_nulls(jsonb_build_object(
           'threadId', thread.id,
           'replyCount', count(reply.id)::integer,
           'participantIds', COALESCE(
             array_agg(DISTINCT reply.author_user_id ORDER BY reply.author_user_id)
               FILTER (WHERE reply.author_user_id IS NOT NULL), ARRAY[]::text[]
           ),
           'unreadCount', (CASE
             WHEN thread_member.state = 'active' OR thread_follow.is_following IS TRUE
             THEN count(reply.id) FILTER (
               WHERE reply.sequence > CASE
                 WHEN read_cursor.manual_unread_from_sequence IS NULL
                   THEN COALESCE(read_cursor.last_read_sequence, 0)
                 ELSE LEAST(COALESCE(read_cursor.last_read_sequence, 0),
                            read_cursor.manual_unread_from_sequence - 1)
               END
             ) ELSE 0 END)::integer,
           'lastReplyAt', to_char(max(reply.created_at) AT TIME ZONE 'UTC',
                                 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
         )) AS summary
         FROM ${prefix}.chat_conversations AS thread
         LEFT JOIN ${prefix}.chat_messages AS reply
           ON reply.tenant_id = thread.tenant_id AND reply.conversation_id = thread.id
         LEFT JOIN ${prefix}.chat_conversation_members AS thread_member
           ON thread_member.tenant_id = thread.tenant_id
          AND thread_member.conversation_id = thread.id AND thread_member.user_id = $2
         LEFT JOIN ${prefix}.chat_read_cursors AS read_cursor
           ON read_cursor.tenant_id = thread.tenant_id
          AND read_cursor.conversation_id = thread.id AND read_cursor.user_id = $2
         LEFT JOIN ${prefix}.chat_thread_follows AS thread_follow
           ON thread_follow.tenant_id = thread.tenant_id
          AND thread_follow.conversation_id = thread.id AND thread_follow.user_id = $2
         WHERE thread.tenant_id = message.tenant_id AND thread.type = 'thread'
           AND thread.parent_conversation_id = message.conversation_id
           AND thread.root_message_id = message.id
         GROUP BY thread.id, thread_member.state, thread_follow.is_following,
                  read_cursor.last_read_sequence, read_cursor.manual_unread_from_sequence
         ORDER BY thread.id LIMIT 1
       ) AS thread_data ON true
      WHERE message.tenant_id = $1 AND message.conversation_id = $3 AND message.id = $4
      LIMIT 1`,
    [actor.tenantId, actor.userId, request.conversationId, request.messageId],
  );
  const row = result.rows[0];
  if (row === undefined) return unavailable();

  // Context's canonical Message contract excludes timeline-only enrichment.
  // Do not load reactions or generate download URLs that cannot be returned.
  const { isThreadRoot, reactions, attachmentMetadata, ...message } =
    await rowToMessage(row, request, actor, options.storage);
  return parseMessageContextResult({
    ...request,
    status: message.deletedAt === undefined ? "available" : "deleted",
    sequence: message.sequence,
    message,
  }, request);
}
