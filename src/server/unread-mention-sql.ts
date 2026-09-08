/**
 * Read-time mention eligibility for a chat_messages row aliased as `message`.
 * Arguments are trusted SQL: a validated, quoted schema and a viewer binding.
 * Callers retain their unread-boundary and deleted-message filters.
 *
 * Source eligibility matches notification dispatch, but uses current source
 * state: deleting a source removes its synthetic contribution on the next read.
 * Explicit mentions and historical notification deliveries remain unchanged.
 * Preferences, follows and reply style do not affect this read fact.
 */
export const unreadMentionPredicateSql = (
  schemaPrefix: string,
  viewerUserIdSql = "$2",
): string => `(
  EXISTS (
    SELECT 1
    FROM jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(message.content -> 'mentions') = 'array'
          THEN message.content -> 'mentions'
        ELSE '[]'::jsonb
      END
    ) AS mention(value)
    WHERE mention.value ->> 'type' = 'user'
      AND mention.value ->> 'userId' = ${viewerUserIdSql}
  )
  OR (
    message.reply_notify_author = true
    AND message.author_user_id <> ${viewerUserIdSql}
    AND EXISTS (
      SELECT 1
      FROM ${schemaPrefix}.chat_messages AS reply_source
      WHERE reply_source.tenant_id = message.tenant_id
        AND reply_source.conversation_id = message.conversation_id
        AND reply_source.id = message.reply_to_message_id
        AND reply_source.deleted_at IS NULL
        AND reply_source.author_user_id = ${viewerUserIdSql}
    )
  )
)`;
