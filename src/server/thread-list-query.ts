import { MAX_CONVERSATION_LIST_ACTIVE_MEMBER_USER_IDS } from "../contracts/conversation-snapshot.js";
import { validateThreadLifecycle, type ConversationVisibility } from "../contracts/conversation.js";
import type { ConversationId, IsoTimestamp, MessageSequence, TenantId, UserId } from "../contracts/identifiers.js";
import type { ConversationMemberPreference, ConversationMemberRole, ConversationMemberState } from "../contracts/member-read-state.js";
import { parseCanonicalThreadFollowState } from "../contracts/thread-follow-mutation.js";
import { decodeThreadListCursor, encodeThreadListCursor, parseThreadListRequest, parseThreadListResult,
  type ThreadListResult } from "../contracts/thread-list.js";
import type { ChatPermissionAdapter, TrustedChatActorContext } from "./contracts.js";
import { DEFAULT_POSTGRES_SCHEMA, validatePostgresSchema, type PostgresMigrationConnection } from "./postgres-migrations.js";
import { ChatAuthorizationError } from "./request-context.js";
import { authorizeThreadAccess } from "./thread-access.js";
import { createThreadListHandlerOptions, type ChatThreadListHandlerOptions } from "./thread-list-handler-options.js";
import { unreadMentionPredicateSql } from "./unread-mention-sql.js";

export const THREAD_LIST_ENTITY_POLICY_ACTION = "thread.list" as const;

export interface ThreadListQueryOptions extends Partial<ChatThreadListHandlerOptions> {
  readonly database: Pick<PostgresMigrationConnection, "query">;
  readonly permissions: Pick<ChatPermissionAdapter<string, typeof THREAD_LIST_ENTITY_POLICY_ACTION>, "authorizeEntity">;
  /** Trusted host-session identity, independent of the decoded request. */
  readonly actor: TrustedChatActorContext;
  readonly input: unknown;
  readonly schema?: string;
  /** Trusted integration decision: persistence, hydration AND enforcement are ready. */
  readonly lifecycleSupported: boolean;
  readonly now?: () => Date;
}

interface StoredThreadRow {
  readonly id: string;
  readonly visibility: string;
  readonly name: string | null;
  readonly parent_conversation_id: string | null;
  readonly root_message_id: string | null;
  readonly lifecycle_revision: string | number;
  readonly closed_at: Date | string | null;
  readonly closed_by_user_id: string | null;
  readonly locked: boolean;
  readonly current_message_sequence: string | number;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly activity_at: Date | string;
  readonly member_role: string | null;
  readonly member_state: string | null;
  readonly member_joined_at: Date | string | null;
  readonly member_updated_at: Date | string | null;
  readonly last_read_sequence: string | number | null;
  readonly manual_unread_from_sequence: string | number | null;
  readonly read_updated_at: Date | string | null;
  readonly notification_level: string | null;
  readonly is_starred: boolean | null;
  readonly muted: boolean | null;
  readonly muted_until: Date | string | null;
  readonly preference_revision: string | number | null;
  readonly preference_updated_at: Date | string | null;
  readonly follow_revision: string | number | null;
  readonly is_following: boolean | null;
  readonly follow_source: string | null;
  readonly follow_updated_at: Date | string | null;
  readonly member_user_ids: readonly string[];
  readonly unread_mention_count: string | number;
}

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

const isVisibility = (value: string): value is ConversationVisibility =>
  value === "public" || value === "private";

const isMemberRole = (value: string | null): value is ConversationMemberRole =>
  value === "owner" || value === "moderator" || value === "member";

const isMemberState = (
  value: string | null,
): value is ConversationMemberState =>
  value === "active" || value === "left" || value === "removed";

// Keep defaults aligned with conversation-detail-query; these are projections only.
const rowToItem = (row: StoredThreadRow, actor: TrustedChatActorContext,
  lifecycleSupported: boolean, hideAfterMs: number | null) => {
  if (!isVisibility(row.visibility)) throw new Error("Invalid thread visibility");
  const conversationId = row.id as ConversationId;
  const tenantId = actor.tenantId as TenantId;
  const userId = actor.userId as UserId;
  const createdAt = toIsoTimestamp(row.created_at, "conversation created_at");
  const updatedAt = toIsoTimestamp(row.updated_at, "conversation updated_at");
  const latestSequence = toSequence(
    row.current_message_sequence,
    "conversation current_message_sequence",
  );
  const hasStoredMember =
    isMemberRole(row.member_role) &&
    isMemberState(row.member_state) &&
    row.member_joined_at !== null &&
    row.member_updated_at !== null;
  const currentMember = hasStoredMember
    ? {
        tenantId,
        conversationId,
        userId,
        role: row.member_role,
        state: row.member_state,
        joinedAt: toIsoTimestamp(row.member_joined_at, "member joined_at"),
        updatedAt: toIsoTimestamp(row.member_updated_at, "member updated_at"),
      }
    : {
        tenantId,
        conversationId,
        userId,
        role: "member" as const,
        state: "active" as const,
        joinedAt: createdAt,
        updatedAt: createdAt,
      };
  const currentReadState = {
    conversationId,
    userId,
    lastReadSequence:
      row.last_read_sequence === null
        ? (0 as MessageSequence)
        : toSequence(
            row.last_read_sequence,
            "read cursor last_read_sequence",
          ),
    ...(row.manual_unread_from_sequence === null
      ? {}
      : {
          manualUnreadFromSequence: toSequence(
            row.manual_unread_from_sequence,
            "read cursor manual_unread_from_sequence",
          ),
        }),
    updatedAt:
      row.read_updated_at === null
        ? currentMember.updatedAt
        : toIsoTimestamp(row.read_updated_at, "read cursor updated_at"),
  };
  const currentPreference: ConversationMemberPreference = {
    preferenceRevision: row.preference_revision === null
      ? 0
      : toSequence(row.preference_revision, "preference revision"),
    conversationId,
    userId,
    isStarred: row.is_starred === true,
    notificationPreference:
      row.notification_level === "mentions" || row.notification_level === "none"
        ? row.notification_level
        : "all",
    mute:
      row.muted === true
        ? {
            muted: true,
            ...(row.muted_until === null
              ? {}
              : {
                  mutedUntil: toIsoTimestamp(
                    row.muted_until,
                    "conversation preference muted_until",
                  ),
                }),
          }
        : { muted: false },
    updatedAt:
      row.preference_updated_at === null
        ? currentMember.updatedAt
        : toIsoTimestamp(
            row.preference_updated_at,
            "conversation preference updated_at",
          ),
  };
  const activeMemberUserIds = row.member_user_ids.map(id => id as UserId);
  const lastActivityAt = toIsoTimestamp(row.activity_at, "thread message activity");
  return {
    thread: {
      type: "thread", id: conversationId, tenantId, visibility: row.visibility,
      parentConversationId: row.parent_conversation_id,
      rootMessageId: row.root_message_id,
      ...(row.name === null ? {} : { name: row.name }),
      createdAt, updatedAt, latestSequence, activityAt: lastActivityAt,
      unreadMentionCount: toSequence(row.unread_mention_count, "unread mention count"),
      currentMember, currentReadState, currentPreference, activeMemberUserIds,
      ...(lifecycleSupported ? { threadLifecycle: validateThreadLifecycle({
        revision: toSequence(row.lifecycle_revision, "lifecycle revision"), locked: row.locked,
        ...(row.closed_at === null ? {} : { closedAt: toIsoTimestamp(row.closed_at, "closed_at") }),
        ...(row.closed_by_user_id === null ? {} : { closedByUserId: row.closed_by_user_id }),
      }) } : {}),
    },
    currentThreadFollow: {
      followRevision: row.follow_revision === null ? 0 : toSequence(row.follow_revision, "follow revision"),
      follow: row.follow_revision === null ? null : parseCanonicalThreadFollowState({
        target: { type: "thread", id: conversationId }, isFollowing: row.is_following,
        source: row.follow_source, updatedAt: toIsoTimestamp(row.follow_updated_at!, "follow updated_at"),
      }),
    },
    lastActivityAt,
    hideAt: hideAfterMs === null ? null : Date.parse(lastActivityAt) + hideAfterMs,
  };
};
/**
 * Live, read-only discovery. Parent checks also apply to empty pages; retained
 * child participation never grants access. The caller owns any transaction.
 */
export async function queryThreadList(options: ThreadListQueryOptions): Promise<ThreadListResult> {
  const input = parseThreadListRequest(options.input);
  const { actor } = options;
  const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
  if (!nonEmpty(actor.tenantId) || !nonEmpty(actor.userId) ||
      !Array.isArray(actor.roles) || !actor.roles.every(nonEmpty)) {
    throw new TypeError("A valid trusted chat actor is required");
  }
  if (typeof options.lifecycleSupported !== "boolean") {
    throw new TypeError("A trusted lifecycleSupported decision is required");
  }
  const schema = validatePostgresSchema(options.schema ?? DEFAULT_POSTGRES_SCHEMA);
  const prefix = `"${schema}"`;
  // authorizeThreadAccess requires a child ID. This equivalent parent-only
  // check authorizes even an empty channel, with the narrower channel list scope.
  const parent = await options.database.query<{ entity_type: string | null; entity_id: string | null }>(
    `SELECT parent.entity_type, parent.entity_id
       FROM ${prefix}.chat_conversations AS parent
       LEFT JOIN ${prefix}.chat_conversation_members AS parent_member
         ON parent_member.tenant_id = parent.tenant_id
        AND parent_member.conversation_id = parent.id AND parent_member.user_id = $2
      WHERE parent.tenant_id = $1 AND parent.id = $3 AND parent.type = 'channel'
        AND parent.archived_at IS NULL
        AND (parent.visibility = 'public' OR parent_member.state = 'active')`,
    [actor.tenantId, actor.userId, input.parentConversationId],
  );
  const parentRow = parent.rows[0];
  if (parentRow === undefined) throw new ChatAuthorizationError();
  if (parentRow.entity_type !== null || parentRow.entity_id !== null) {
    try {
      if (parentRow.entity_type === null || parentRow.entity_id === null ||
          !await options.permissions.authorizeEntity({
            actor, entity: { type: parentRow.entity_type, id: parentRow.entity_id },
            action: THREAD_LIST_ENTITY_POLICY_ACTION,
          })) throw new ChatAuthorizationError();
    } catch { throw new ChatAuthorizationError(); }
  }
  // Normalize at this boundary too: callers can supply failing/invalid JS hooks.
  const inactivityPolicy = await createThreadListHandlerOptions(options.resolveInactivityPolicy)
    .resolveInactivityPolicy({ tenantId: actor.tenantId, parentConversationId: input.parentConversationId });
  const hideAfterMs = inactivityPolicy === false ? null : inactivityPolicy.hideAfterMs;
  const evaluatedAt = toIsoTimestamp((options.now ?? (() => new Date()))(), "evaluation clock");
  const cursor = input.cursor === undefined ? undefined : decodeThreadListCursor(input.cursor, input);
  const result = await options.database.query<StoredThreadRow>(
    `WITH candidates AS (
       SELECT conversation.*,
         date_trunc('milliseconds', conversation.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS creation_key,
         date_trunc('milliseconds', COALESCE((
           SELECT max(message.created_at) FROM ${prefix}.chat_messages AS message
            WHERE message.tenant_id = conversation.tenant_id AND message.conversation_id = conversation.id
         ), conversation.created_at) AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS activity_at
       FROM ${prefix}.chat_conversations AS conversation
       INNER JOIN ${prefix}.chat_conversations AS parent
         ON parent.tenant_id = conversation.tenant_id AND parent.id = conversation.parent_conversation_id
       WHERE conversation.tenant_id = $1 AND conversation.parent_conversation_id = $3
         AND conversation.type = 'thread' AND conversation.archived_at IS NULL
         AND parent.type = 'channel' AND parent.archived_at IS NULL
         AND (parent.visibility = 'public' OR EXISTS (
           SELECT 1 FROM ${prefix}.chat_conversation_members AS parent_member
            WHERE parent_member.tenant_id = parent.tenant_id AND parent_member.conversation_id = parent.id
              AND parent_member.user_id = $2 AND parent_member.state = 'active'
         ))
     ), page AS (
       SELECT * FROM candidates
        WHERE ($4::timestamptz IS NULL OR creation_key < $4::timestamptz
          OR (creation_key = $4::timestamptz AND id COLLATE "C" > $5::text COLLATE "C"))
          AND (NOT $6::boolean OR (
            (NOT $7::boolean OR closed_at IS NULL)
            AND ($9::double precision IS NULL OR
              $8::double precision - (extract(epoch FROM activity_at) * 1000)::double precision < $9::double precision)
          ))
        ORDER BY creation_key DESC, id COLLATE "C" ASC LIMIT $10
     )
     SELECT conversation.id, conversation.visibility, conversation.name,
       conversation.parent_conversation_id, conversation.root_message_id,
       conversation.lifecycle_revision, conversation.closed_at, conversation.closed_by_user_id, conversation.locked,
       conversation.current_message_sequence, conversation.creation_key AS created_at,
       conversation.updated_at, conversation.activity_at,
       current_member.role AS member_role, current_member.state AS member_state,
       current_member.joined_at AS member_joined_at, current_member.updated_at AS member_updated_at,
       read_cursor.last_read_sequence, read_cursor.manual_unread_from_sequence,
       read_cursor.updated_at AS read_updated_at,
       preference.notification_level, preference.is_starred, preference.muted, preference.muted_until,
       preference.preference_revision, preference.updated_at AS preference_updated_at,
       thread_follow.follow_revision, thread_follow.is_following, thread_follow.follow_source,
       thread_follow.updated_at AS follow_updated_at,
       ARRAY(SELECT member.user_id FROM ${prefix}.chat_conversation_members AS member
         WHERE member.tenant_id = conversation.tenant_id AND member.conversation_id = conversation.id
           AND member.state = 'active' ORDER BY member.user_id
         LIMIT ${MAX_CONVERSATION_LIST_ACTIVE_MEMBER_USER_IDS}) AS member_user_ids,
       unread_mentions.unread_mention_count
     FROM page AS conversation
     LEFT JOIN ${prefix}.chat_conversation_members AS current_member
       ON current_member.tenant_id = conversation.tenant_id AND current_member.conversation_id = conversation.id
      AND current_member.user_id = $2
     LEFT JOIN ${prefix}.chat_read_cursors AS read_cursor
       ON read_cursor.tenant_id = conversation.tenant_id AND read_cursor.conversation_id = conversation.id
      AND read_cursor.user_id = $2
     LEFT JOIN ${prefix}.chat_conversation_preferences AS preference
       ON preference.tenant_id = conversation.tenant_id AND preference.conversation_id = conversation.id
      AND preference.user_id = $2
     LEFT JOIN ${prefix}.chat_thread_follows AS thread_follow
       ON thread_follow.tenant_id = conversation.tenant_id AND thread_follow.conversation_id = conversation.id
      AND thread_follow.user_id = $2
     LEFT JOIN LATERAL (
       SELECT count(*)::bigint AS unread_mention_count FROM ${prefix}.chat_messages AS message
        WHERE message.tenant_id = conversation.tenant_id AND message.conversation_id = conversation.id
          AND message.deleted_at IS NULL
          AND message.sequence > CASE WHEN read_cursor.manual_unread_from_sequence IS NULL
            THEN COALESCE(read_cursor.last_read_sequence, 0)
            ELSE LEAST(COALESCE(read_cursor.last_read_sequence, 0), read_cursor.manual_unread_from_sequence - 1) END
          AND ${unreadMentionPredicateSql(prefix)}
     ) AS unread_mentions ON TRUE
     ORDER BY conversation.creation_key DESC, conversation.id COLLATE "C" ASC`,
    [actor.tenantId, actor.userId, input.parentConversationId, cursor?.createdAt ?? null,
      cursor?.threadId ?? null, input.view === "active", options.lifecycleSupported,
      Date.parse(evaluatedAt), hideAfterMs, input.limit + 1],
  );
  const rows = result.rows.slice(0, input.limit);
  // The shared guard has a child-only API. Keep its authoritative checks for
  // each bounded result, including host entity changes during policy resolution.
  for (const row of rows) {
    const access = await authorizeThreadAccess({
      database: options.database, actor, schema, threadId: row.id, operation: "read",
      entityAction: THREAD_LIST_ENTITY_POLICY_ACTION, permissions: options.permissions,
    });
    if (access.parentConversationId !== input.parentConversationId || access.isArchived) {
      throw new ChatAuthorizationError();
    }
  }
  const last = rows.at(-1);
  return parseThreadListResult({
    parentConversationId: input.parentConversationId, view: input.view,
    evaluatedAt, lifecycleSupported: options.lifecycleSupported, inactivityPolicy,
    items: rows.map(row => rowToItem(row, actor, options.lifecycleSupported, hideAfterMs)),
    ...(result.rows.length > input.limit && last !== undefined ? {
      nextCursor: encodeThreadListCursor({ parentConversationId: input.parentConversationId, view: input.view,
        createdAt: toIsoTimestamp(last.created_at, "cursor creation"), threadId: last.id as ConversationId }),
    } : {}),
  }, input);
}
