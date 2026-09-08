import { parseCanonicalThreadFollowState } from "../contracts/thread-follow-mutation.js";
import {
  MAX_CONVERSATION_LIST_ACTIVE_MEMBER_USER_IDS,
  parseConversationDetailSnapshotInput,
  type ConversationDetailSnapshotConversation,
} from "../contracts/conversation-snapshot.js";
import {
  validateThreadLifecycle,
  type ConversationType,
  type ConversationVisibility,
  type HostEntityReference,
} from "../contracts/conversation.js";
import type {
  ConversationId,
  IsoTimestamp,
  MessageId,
  MessageSequence,
  TenantId,
  UserId,
} from "../contracts/identifiers.js";
import type {
  ConversationMemberPreference,
  ConversationMemberRole,
  ConversationMemberState,
} from "../contracts/member-read-state.js";
import type {
  ChatPermissionAdapter,
  TrustedChatActorContext,
} from "./contracts.js";
import {
  DEFAULT_POSTGRES_SCHEMA,
  validatePostgresSchema,
  type PostgresMigrationDatabase,
} from "./postgres-migrations.js";
import { ChatAuthorizationError } from "./request-context.js";
import { authorizeThreadAccess } from "./thread-access.js";
import { unreadMentionPredicateSql } from "./unread-mention-sql.js";

export const CONVERSATION_DETAIL_ENTITY_POLICY_ACTION =
  "conversation.detail" as const;

export interface ConversationDetailQueryOptions {
  readonly database: PostgresMigrationDatabase;
  readonly permissions: Pick<
    ChatPermissionAdapter<
      string,
      typeof CONVERSATION_DETAIL_ENTITY_POLICY_ACTION
    >,
    "authorizeEntity"
  >;
  /** Trusted host-session identity; caller input cannot override these values. */
  readonly actor: TrustedChatActorContext;
  /** JSON-decoded caller input, validated by the shared detail parser. */
  readonly input: unknown;
  readonly schema?: string;
}

interface StoredConversationDetailRow {
  readonly id: string;
  readonly type: string;
  readonly visibility: string;
  readonly name: string | null;
  readonly entity_type: string | null;
  readonly entity_id: string | null;
  readonly parent_conversation_id: string | null;
  readonly root_message_id: string | null;
  readonly lifecycle_revision: string | number;
  readonly closed_at: Date | string | null;
  readonly closed_by_user_id: string | null;
  readonly locked: boolean;
  readonly current_message_sequence: string | number;
  readonly member_list_revision: string | number;
  readonly archived_at: Date | string | null;
  readonly archived_by_user_id: string | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly activity_at: string;
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

const quoteIdentifier = (identifier: string): string =>
  `"${identifier.replaceAll('"', '""')}"`;

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

const toActivityTimestamp = (value: string): IsoTimestamp => {
  if (!Number.isFinite(new Date(value).valueOf())) {
    throw new Error("Invalid conversation activity_at returned by PostgreSQL");
  }
  return value as IsoTimestamp;
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

const isConversationType = (value: string): value is ConversationType =>
  value === "channel" ||
  value === "direct" ||
  value === "group_direct" ||
  value === "thread";

const isVisibility = (value: string): value is ConversationVisibility =>
  value === "public" || value === "private";

const isMemberRole = (value: string | null): value is ConversationMemberRole =>
  value === "owner" || value === "moderator" || value === "member";

const isMemberState = (
  value: string | null,
): value is ConversationMemberState =>
  value === "active" || value === "left" || value === "removed";

const entityFromRow = (
  row: StoredConversationDetailRow,
): HostEntityReference | undefined =>
  row.entity_type === null || row.entity_id === null
    ? undefined
    : { type: row.entity_type, id: row.entity_id };

const rowToDetail = (
  row: StoredConversationDetailRow,
  actor: TrustedChatActorContext,
): ConversationDetailSnapshotConversation => {
  if (!isConversationType(row.type) || !isVisibility(row.visibility)) {
    throw new Error("Invalid conversation discriminator returned by PostgreSQL");
  }

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
  const memberUserIds = Object.freeze(
    row.member_user_ids.map((memberUserId) => memberUserId as UserId),
  );
  const activeMemberUserIds = Object.freeze(
    memberUserIds.slice(0, MAX_CONVERSATION_LIST_ACTIVE_MEMBER_USER_IDS),
  );
  const archiveState =
    row.archived_at === null || row.archived_by_user_id === null
      ? {}
      : {
          archivedAt: toIsoTimestamp(
            row.archived_at,
            "conversation archived_at",
          ),
          archivedByUserId: row.archived_by_user_id as UserId,
        };
  const base = {
    id: conversationId,
    tenantId,
    visibility: row.visibility,
    createdAt,
    updatedAt,
    ...archiveState,
    latestSequence,
    activityAt: toActivityTimestamp(row.activity_at),
    unreadMentionCount: toSequence(
      row.unread_mention_count,
      "conversation unread_mention_count",
    ),
    currentMember,
    currentReadState,
    activeMemberUserIds,
    memberUserIds,
    memberListRevision: toSequence(
      row.member_list_revision,
      "conversation member_list_revision",
    ),
    currentPreference,
  };

  switch (row.type) {
    case "channel": {
      if (row.name === null) {
        throw new Error("Invalid channel shape returned by PostgreSQL");
      }
      const entity = entityFromRow(row);
      return {
        ...base,
        type: "channel",
        name: row.name,
        ...(entity === undefined ? {} : { entity }),
      };
    }
    case "direct":
      return { ...base, type: "direct", visibility: "private" };
    case "group_direct":
      return { ...base, type: "group_direct", visibility: "private" };
    case "thread":
      if (
        row.parent_conversation_id === null ||
        row.root_message_id === null
      ) {
        throw new Error("Invalid thread shape returned by PostgreSQL");
      }
      return {
        ...base,
        type: "thread",
        ...(row.name === null ? {} : { name: row.name }),
        threadLifecycle: validateThreadLifecycle({
          revision: toSequence(row.lifecycle_revision, "conversation lifecycle_revision"),
          locked: row.locked,
          ...(row.closed_at === null ? {} : {
            closedAt: toIsoTimestamp(row.closed_at, "conversation closed_at"),
          }),
          ...(row.closed_by_user_id === null ? {} : {
            closedByUserId: row.closed_by_user_id,
          }),
        }),
        parentConversationId: row.parent_conversation_id as ConversationId,
        rootMessageId: row.root_message_id as MessageId,
        currentThreadFollow: {
          followRevision: row.follow_revision === null
            ? 0
            : toSequence(row.follow_revision, "follow revision"),
          follow: row.follow_revision === null ? null : parseCanonicalThreadFollowState({
            target: { type: "thread", id: conversationId },
            isFollowing: row.is_following,
            source: row.follow_source,
            updatedAt: toIsoTimestamp(row.follow_updated_at!, "follow updated_at"),
          }),
        },
      };
  }
};

/**
 * Loads one actor-visible conversation and its active member IDs set-wise.
 *
 * Public channels are discoverable without membership; threads require current
 * parent access, checked in one additional query before serialization. Other
 * streams require active tenant-scoped membership. Every missing,
 * cross-tenant, membership-denied, or entity-denied lookup has the same
 * sanitized authorization outcome.
 */
export async function queryConversationDetail(
  options: ConversationDetailQueryOptions,
): Promise<ConversationDetailSnapshotConversation> {
  const input = parseConversationDetailSnapshotInput(options.input);
  if (!options.actor.tenantId || !options.actor.userId) {
    throw new TypeError("A trusted tenant and user are required");
  }

  const schema = validatePostgresSchema(
    options.schema ?? DEFAULT_POSTGRES_SCHEMA,
  );
  const prefix = quoteIdentifier(schema);
  const result = await options.database.query<StoredConversationDetailRow>(
    `SELECT
       conversation.id,
       conversation.type,
       conversation.visibility,
       conversation.name,
       conversation.entity_type,
       conversation.entity_id,
       conversation.parent_conversation_id,
       conversation.root_message_id,
       conversation.lifecycle_revision,
       conversation.closed_at,
       conversation.closed_by_user_id,
       conversation.locked,
       conversation.current_message_sequence,
       conversation.member_list_revision,
       conversation.archived_at,
       conversation.archived_by_user_id,
       conversation.created_at,
       conversation.updated_at,
       to_char(
         conversation.updated_at AT TIME ZONE 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
       ) AS activity_at,
       current_member.role AS member_role,
       current_member.state AS member_state,
       current_member.joined_at AS member_joined_at,
       current_member.updated_at AS member_updated_at,
       read_cursor.last_read_sequence,
       read_cursor.manual_unread_from_sequence,
       read_cursor.updated_at AS read_updated_at,
       preference.notification_level,
       preference.is_starred,
       preference.muted,
       preference.muted_until,
       preference.preference_revision, preference.updated_at AS preference_updated_at,
       thread_follow.follow_revision,
       thread_follow.is_following,
       thread_follow.follow_source,
       thread_follow.updated_at AS follow_updated_at,
       ARRAY(
         SELECT member.user_id
         FROM ${prefix}.chat_conversation_members AS member
         WHERE member.tenant_id = conversation.tenant_id
           AND member.conversation_id = conversation.id
           AND member.state = 'active'
         ORDER BY member.user_id
       ) AS member_user_ids,
       unread_mentions.unread_mention_count
     FROM ${prefix}.chat_conversations AS conversation
     LEFT JOIN ${prefix}.chat_conversation_members AS current_member
       ON current_member.tenant_id = conversation.tenant_id
      AND current_member.conversation_id = conversation.id
      AND current_member.user_id = $2
     LEFT JOIN ${prefix}.chat_read_cursors AS read_cursor
       ON read_cursor.tenant_id = conversation.tenant_id
      AND read_cursor.conversation_id = conversation.id
      AND read_cursor.user_id = $2
     LEFT JOIN ${prefix}.chat_conversation_preferences AS preference
       ON preference.tenant_id = conversation.tenant_id
      AND preference.conversation_id = conversation.id
      AND preference.user_id = $2
     LEFT JOIN ${prefix}.chat_thread_follows AS thread_follow
       ON thread_follow.tenant_id = conversation.tenant_id
      AND thread_follow.conversation_id = conversation.id
      AND thread_follow.user_id = $2
     LEFT JOIN LATERAL (
       SELECT count(*)::bigint AS unread_mention_count
       FROM ${prefix}.chat_messages AS message
       WHERE message.tenant_id = conversation.tenant_id
         AND message.conversation_id = conversation.id
         AND message.deleted_at IS NULL
         AND message.sequence > CASE
           WHEN read_cursor.manual_unread_from_sequence IS NULL
             THEN COALESCE(read_cursor.last_read_sequence, 0)
           ELSE LEAST(
             COALESCE(read_cursor.last_read_sequence, 0),
             read_cursor.manual_unread_from_sequence - 1
           )
         END
         AND ${unreadMentionPredicateSql(prefix)}
     ) AS unread_mentions ON TRUE
     WHERE conversation.tenant_id = $1
       AND conversation.id = $3
       AND (
         (conversation.type = 'channel' AND conversation.visibility = 'public')
         OR conversation.type = 'thread'
         OR current_member.state = 'active'
       )
     LIMIT 1`,
    [options.actor.tenantId, options.actor.userId, input.conversationId],
  );

  const row = result.rows[0];
  if (row === undefined) {
    throw new ChatAuthorizationError();
  }

  if (row.type === "thread") {
    await authorizeThreadAccess({
      database: options.database,
      actor: options.actor,
      threadId: input.conversationId,
      schema,
      operation: "read",
      entityAction: CONVERSATION_DETAIL_ENTITY_POLICY_ACTION,
      permissions: options.permissions,
    });
    return rowToDetail(row, options.actor);
  }

  const entity = entityFromRow(row);
  if (entity !== undefined) {
    let authorized = false;
    try {
      authorized = await options.permissions.authorizeEntity({
        actor: options.actor,
        entity,
        action: CONVERSATION_DETAIL_ENTITY_POLICY_ACTION,
      });
    } catch {
      throw new ChatAuthorizationError();
    }
    if (!authorized) {
      throw new ChatAuthorizationError();
    }
  }

  return rowToDetail(row, options.actor);
}
