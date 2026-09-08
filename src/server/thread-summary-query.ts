import type {
  ConversationId,
  IsoTimestamp,
  UserId,
} from "../contracts/identifiers.js";
import type { ThreadSummary, ThreadSummaryFacts } from "../contracts/message.js";
import type { TrustedChatActorContext } from "./contracts.js";
import type { PostgresMigrationConnection } from "./postgres-migrations.js";

interface StoredThreadFactsRow {
  readonly reply_count: string | number;
  readonly participant_ids: readonly string[];
  readonly last_reply_at: Date | string | null;
}

const toCount = (value: string | number, label: string): number => {
  const count = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`PostgreSQL returned an invalid ${label}`);
  }
  return count;
};

const toIsoTimestamp = (value: Date | string, label: string): IsoTimestamp => {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.valueOf())) {
    throw new Error(`PostgreSQL returned an invalid ${label}`);
  }
  return date.toISOString() as IsoTimestamp;
};

/** Loads persisted facts, including soft-deleted replies to keep counts monotone.
 * `prefix` is the caller's already-quoted schema identifier.
 */
export const selectRootThreadFacts = async (
  connection: PostgresMigrationConnection,
  prefix: string,
  tenantId: string,
  conversationId: string,
): Promise<ThreadSummaryFacts> => {
  const result = await connection.query<StoredThreadFactsRow>(
    `SELECT count(reply.id)::integer AS reply_count,
            COALESCE(
              array_agg(DISTINCT reply.author_user_id ORDER BY reply.author_user_id)
                FILTER (WHERE reply.author_user_id IS NOT NULL),
              ARRAY[]::text[]
            ) AS participant_ids,
            max(reply.created_at) AS last_reply_at
       FROM ${prefix}.chat_conversations AS thread
       LEFT JOIN ${prefix}.chat_messages AS reply
         ON reply.tenant_id = thread.tenant_id
        AND reply.conversation_id = thread.id
       WHERE thread.tenant_id = $1 AND thread.id = $2 AND thread.type = 'thread'
       GROUP BY thread.tenant_id, thread.id`,
    [tenantId, conversationId],
  );
  const row = result.rows[0];
  // Grouping by the thread prevents a missing/invalid thread from becoming an
  // empty aggregate success, while the left join preserves existing empty threads.
  if (row === undefined) throw new Error("Thread facts could not be loaded");
  return {
    threadId: conversationId as ConversationId,
    replyCount: toCount(row.reply_count, "thread reply count"),
    participantIds: row.participant_ids.map((userId) => userId as UserId),
    ...(row.last_reply_at === null
      ? {}
      : { lastReplyAt: toIsoTimestamp(row.last_reply_at, "thread reply timestamp") }),
  };
};

/**
 * The caller must supply its locked thread transaction connection and an
 * already-quoted schema prefix. Holding the thread lock through these statements
 * and commit keeps shared facts and viewer unread in one coherent combined view.
 */
export const selectRootThreadSummary = async (
  connection: PostgresMigrationConnection,
  prefix: string,
  actor: TrustedChatActorContext,
  conversationId: string,
): Promise<ThreadSummary> => {
  const facts = await selectRootThreadFacts(
    connection,
    prefix,
    actor.tenantId,
    conversationId,
  );
  const result = await connection.query<{ readonly unread_count: string | number }>(
    `SELECT (CASE
              WHEN thread_member.state = 'active'
                OR thread_follow.is_following IS TRUE
              THEN count(reply.id) FILTER (
                WHERE reply.sequence > CASE
                  WHEN cursor.manual_unread_from_sequence IS NULL
                    THEN COALESCE(cursor.last_read_sequence, 0)
                  ELSE LEAST(
                    COALESCE(cursor.last_read_sequence, 0),
                    cursor.manual_unread_from_sequence - 1
                  )
                END
              )
              ELSE 0
            END)::integer AS unread_count
       FROM ${prefix}.chat_conversations AS thread
       LEFT JOIN ${prefix}.chat_conversation_members AS thread_member
         ON thread_member.tenant_id = thread.tenant_id
        AND thread_member.conversation_id = thread.id
        AND thread_member.user_id = $2
       LEFT JOIN ${prefix}.chat_thread_follows AS thread_follow
         ON thread_follow.tenant_id = thread.tenant_id
        AND thread_follow.conversation_id = thread.id
        AND thread_follow.user_id = $2
       LEFT JOIN ${prefix}.chat_read_cursors AS cursor
         ON cursor.tenant_id = thread.tenant_id
        AND cursor.conversation_id = thread.id
        AND cursor.user_id = $2
       LEFT JOIN ${prefix}.chat_messages AS reply
         ON reply.tenant_id = thread.tenant_id
        AND reply.conversation_id = thread.id
       WHERE thread.tenant_id = $1 AND thread.id = $3
       GROUP BY thread_member.state, thread_follow.is_following,
                cursor.last_read_sequence, cursor.manual_unread_from_sequence`,
    [actor.tenantId, actor.userId, conversationId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("Thread summary could not be loaded");
  return {
    ...facts,
    unreadCount: toCount(row.unread_count, "thread unread count"),
  };
};
