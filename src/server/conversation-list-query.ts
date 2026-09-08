import {
  CONVERSATION_NAVIGATION_RANK,
  MAX_CONVERSATION_LIST_ACTIVE_MEMBER_USER_IDS,
  decodeConversationSnapshotCursor,
  encodeConversationSnapshotCursor,
  encodeLegacyConversationSnapshotCursor,
  encodeStarredFirstLegacyConversationSnapshotCursor,
  parseConversationListSnapshotInput,
  type ConversationListSnapshotInput,
  type ConversationListSnapshotSummary,
  type ConversationNavigationRank,
} from "../contracts/conversation-snapshot.js";
import {
  validateThreadLifecycle,
  type ConversationType,
  type ConversationVisibility,
} from "../contracts/conversation.js";
import type {
  ConversationId,
  IsoTimestamp,
  MessageId,
  MessageSequence,
  TenantId,
  UserId,
} from "../contracts/identifiers.js";
import {
  deriveUnreadCount,
  type ConversationMemberPreference,
  type ConversationMemberRole,
  type ConversationMemberState,
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
import { unreadMentionPredicateSql } from "./unread-mention-sql.js";

export const CONVERSATION_LIST_ENTITY_POLICY_ACTION =
  "conversation.list" as const;
export const DEFAULT_CONVERSATION_LIST_LIMIT = 25 as const;

export type ConversationListQueryItem = ConversationListSnapshotSummary & {
  /** Derived from the latest sequence and the current actor's read cursor. */
  readonly unreadCount: number;
  /** Defaults to all notifications and unmuted when no preference row exists. */
  readonly currentPreference: ConversationMemberPreference;
};

export interface ConversationListQueryResult {
  readonly items: readonly ConversationListQueryItem[];
  readonly nextCursor?: ConversationListSnapshotInput["cursor"];
}

export interface ConversationListQueryOptions {
  readonly database: PostgresMigrationDatabase;
  readonly permissions: Pick<
    ChatPermissionAdapter<
      string,
      typeof CONVERSATION_LIST_ENTITY_POLICY_ACTION
    >,
    "authorizeEntity"
  >;
  /** Trusted host-session identity; caller input cannot override these values. */
  readonly actor: TrustedChatActorContext;
  /** JSON-decoded caller input, validated by the shared snapshot parser. */
  readonly input: unknown;
  readonly schema?: string;
}

interface StoredConversationListRow {
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
  readonly active_member_user_ids: readonly string[];
  readonly unread_mention_count: string | number;
  readonly has_active_huddle: boolean;
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
  // Keep PostgreSQL's six fractional digits: converting through Date would
  // truncate the keyset position to milliseconds and could skip adjacent rows.
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

const EMPTY_ACTIVE_MEMBER_USER_IDS = Object.freeze([]) as readonly UserId[];

const CONVERSATION_NAVIGATION_RANK_SQL = `CASE
         WHEN conversation.type = 'direct' THEN 0
         WHEN conversation.type = 'channel'
          AND conversation.visibility = 'public' THEN 1
         WHEN conversation.type = 'channel'
          AND conversation.visibility = 'private' THEN 2
         WHEN conversation.type = 'group_direct' THEN 3
         ELSE 4
       END`;

const conversationNavigationRank = (
  item: ConversationListQueryItem,
): ConversationNavigationRank => {
  switch (item.type) {
    case "direct":
      return CONVERSATION_NAVIGATION_RANK.direct;
    case "channel":
      return item.visibility === "public"
        ? CONVERSATION_NAVIGATION_RANK.publicChannel
        : CONVERSATION_NAVIGATION_RANK.privateChannel;
    case "group_direct":
      return CONVERSATION_NAVIGATION_RANK.groupDirect;
    case "thread":
      throw new Error("Thread cannot be a top-level conversation list item");
  }
};

const toActiveMemberUserIds = (
  value: readonly string[],
): readonly UserId[] => {
  if (
    !Array.isArray(value) ||
    value.length > MAX_CONVERSATION_LIST_ACTIVE_MEMBER_USER_IDS ||
    value.some((userId) => typeof userId !== "string" || userId.trim().length === 0) ||
    new Set(value).size !== value.length
  ) {
    throw new Error("Invalid active member user IDs returned by PostgreSQL");
  }
  return Object.freeze(value.map((userId) => userId as UserId));
};

const rowToItem = (
  row: StoredConversationListRow,
  actor: TrustedChatActorContext,
): ConversationListQueryItem => {
  if (!isConversationType(row.type) || !isVisibility(row.visibility)) {
    throw new Error("Invalid conversation discriminator returned by PostgreSQL");
  }
  if (typeof row.has_active_huddle !== "boolean") {
    throw new Error("Invalid conversation has_active_huddle returned by PostgreSQL");
  }

  const conversationId = row.id as ConversationId;
  const tenantId = actor.tenantId as TenantId;
  const userId = actor.userId as UserId;
  const createdAt = toIsoTimestamp(row.created_at, "conversation created_at");
  const updatedAt = toIsoTimestamp(row.updated_at, "conversation updated_at");
  const activityAt = toActivityTimestamp(row.activity_at);
  const latestSequence = toSequence(
    row.current_message_sequence,
    "conversation current_message_sequence",
  );

  // Public channels are organization-discoverable. Until a durable membership
  // is created, expose an active default member snapshot rooted at creation.
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

  const lastReadSequence =
    row.last_read_sequence === null
      ? (0 as MessageSequence)
      : toSequence(row.last_read_sequence, "read cursor last_read_sequence");
  const currentReadState = {
    conversationId,
    userId,
    lastReadSequence,
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

  const preferenceUpdatedAt =
    row.preference_updated_at === null
      ? currentMember.updatedAt
      : toIsoTimestamp(
          row.preference_updated_at,
          "conversation preference updated_at",
        );
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
    updatedAt: preferenceUpdatedAt,
  };
  // Public channels can be visible without membership. Never disclose their
  // member identities unless the trusted actor has an active stored row.
  const activeMemberUserIds =
    hasStoredMember && row.member_state === "active"
      ? toActiveMemberUserIds(row.active_member_user_ids)
      : EMPTY_ACTIVE_MEMBER_USER_IDS;

  const currentState = {
    latestSequence,
    activityAt,
    unreadMentionCount: toSequence(
      row.unread_mention_count,
      "conversation unread_mention_count",
    ),
    hasActiveHuddle: row.has_active_huddle,
    currentMember,
    currentReadState,
    activeMemberUserIds,
    unreadCount: deriveUnreadCount(latestSequence, currentReadState),
    currentPreference,
  };
  const base = {
    id: conversationId,
    tenantId,
    visibility: row.visibility,
    createdAt,
    updatedAt,
    ...currentState,
  };

  switch (row.type) {
    case "channel":
      if (row.name === null) {
        throw new Error("Invalid channel shape returned by PostgreSQL");
      }
      return {
        ...base,
        type: "channel",
        name: row.name,
        ...(row.entity_type === null || row.entity_id === null
          ? {}
          : { entity: { type: row.entity_type, id: row.entity_id } }),
      };
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
      };
  }
};

/**
 * Loads one actor-visible page with one set-based PostgreSQL query.
 *
 * New pages are ordered by the actor-private effective starred state, stable
 * navigation rank, `updated_at`, and ID. V2 and v1 cursors keep their complete
 * pagination chains on their original starred/activity and activity-only
 * orderings. Public channels are discoverable without membership; every other
 * stream requires the trusted actor's active tenant-scoped membership. Missing
 * read and preference rows default to sequence zero, all notifications,
 * unstarred, and unmuted.
 */
export async function queryConversationList(
  options: ConversationListQueryOptions,
): Promise<ConversationListQueryResult> {
  const input = parseConversationListSnapshotInput(options.input);
  if (!options.actor.tenantId || !options.actor.userId) {
    throw new TypeError("A trusted tenant and user are required");
  }

  if (input.scope.type === "entity") {
    let authorized = false;
    try {
      authorized = await options.permissions.authorizeEntity({
        actor: options.actor,
        entity: input.scope.entity,
        action: CONVERSATION_LIST_ENTITY_POLICY_ACTION,
      });
    } catch {
      throw new ChatAuthorizationError();
    }
    if (!authorized) {
      throw new ChatAuthorizationError();
    }
  }

  const schema = validatePostgresSchema(
    options.schema ?? DEFAULT_POSTGRES_SCHEMA,
  );
  const prefix = quoteIdentifier(schema);
  const values: unknown[] = [options.actor.tenantId, options.actor.userId];
  const predicates = [
    "conversation.tenant_id = $1",
    "conversation.archived_at IS NULL",
    // Threads are opened through their root-message summary and must not
    // become top-level entries in organization or entity conversation lists.
    "conversation.type <> 'thread'",
    `(\n       (conversation.type = 'channel' AND conversation.visibility = 'public')\n       OR current_member.state = 'active'\n     )`,
  ];

  if (input.scope.type === "entity") {
    values.push(input.scope.entity.type, input.scope.entity.id);
    predicates.push(
      `conversation.entity_type = $${values.length - 1}`,
      `conversation.entity_id = $${values.length}`,
    );
  }

  let cursorVersion: "v3" | "v2" | "v1" = "v3";
  if (input.cursor !== undefined) {
    const cursor = decodeConversationSnapshotCursor(input.cursor);
    if ("navigationRank" in cursor) {
      values.push(
        cursor.isStarred,
        cursor.navigationRank,
        cursor.activityAt,
        cursor.conversationId,
      );
      const isStarredParameter = values.length - 3;
      const navigationRankParameter = values.length - 2;
      const activityAtParameter = values.length - 1;
      const conversationIdParameter = values.length;
      predicates.push(
        `(COALESCE(preference.is_starred, false) < $${isStarredParameter}::boolean
       OR (
         COALESCE(preference.is_starred, false) = $${isStarredParameter}::boolean
         AND (
           ${CONVERSATION_NAVIGATION_RANK_SQL} > $${navigationRankParameter}::integer
           OR (
             ${CONVERSATION_NAVIGATION_RANK_SQL} = $${navigationRankParameter}::integer
             AND (conversation.updated_at, conversation.id) <
               ($${activityAtParameter}::timestamptz, $${conversationIdParameter}::text)
           )
         )
       ))`,
      );
    } else if ("isStarred" in cursor) {
      cursorVersion = "v2";
      values.push(cursor.isStarred, cursor.activityAt, cursor.conversationId);
      predicates.push(
        `(COALESCE(preference.is_starred, false), conversation.updated_at, conversation.id) <\n       ($${values.length - 2}::boolean, $${values.length - 1}::timestamptz, $${values.length}::text)`,
      );
    } else {
      cursorVersion = "v1";
      values.push(cursor.activityAt, cursor.conversationId);
      predicates.push(
        `(conversation.updated_at, conversation.id) <\n       ($${values.length - 1}::timestamptz, $${values.length}::text)`,
      );
    }
  }

  const limit = input.limit ?? DEFAULT_CONVERSATION_LIST_LIMIT;
  const orderBy =
    cursorVersion === "v1"
      ? "conversation.updated_at DESC, conversation.id DESC"
      : cursorVersion === "v2"
        ? "COALESCE(preference.is_starred, false) DESC, conversation.updated_at DESC, conversation.id DESC"
        : `COALESCE(preference.is_starred, false) DESC, ${CONVERSATION_NAVIGATION_RANK_SQL} ASC, conversation.updated_at DESC, conversation.id DESC`;
  values.push(limit + 1);
  const result = await options.database.query<StoredConversationListRow>(
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
       COALESCE(
         active_members.active_member_user_ids,
         ARRAY[]::text[]
       ) AS active_member_user_ids,
       unread_mentions.unread_mention_count,
       EXISTS (
         SELECT 1
         FROM ${prefix}.chat_huddle_sessions AS huddle_session
         WHERE huddle_session.tenant_id = conversation.tenant_id
           AND huddle_session.conversation_id = conversation.id
           AND huddle_session.status IN ('starting', 'active')
       ) AS has_active_huddle
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
     LEFT JOIN LATERAL (
       SELECT ARRAY(
         SELECT member.user_id
         FROM ${prefix}.chat_conversation_members AS member
         WHERE member.tenant_id = conversation.tenant_id
           AND member.conversation_id = conversation.id
           AND member.state = 'active'
         ORDER BY member.user_id
         LIMIT ${MAX_CONVERSATION_LIST_ACTIVE_MEMBER_USER_IDS}
       ) AS active_member_user_ids
     ) AS active_members ON current_member.state = 'active'
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
     WHERE ${predicates.join("\n       AND ")}
     ORDER BY ${orderBy}
     LIMIT $${values.length}`,
    values,
  );

  const hasNextPage = result.rows.length > limit;
  const items = result.rows
    .slice(0, limit)
    .map((row) => rowToItem(row, options.actor));
  const lastItem = items.at(-1);
  const nextCursor =
    hasNextPage && lastItem !== undefined
      ? cursorVersion === "v1"
        ? encodeLegacyConversationSnapshotCursor({
            activityAt: lastItem.activityAt,
            conversationId: lastItem.id,
          })
        : cursorVersion === "v2"
          ? encodeStarredFirstLegacyConversationSnapshotCursor({
              isStarred: lastItem.currentPreference.isStarred,
              activityAt: lastItem.activityAt,
              conversationId: lastItem.id,
            })
          : encodeConversationSnapshotCursor({
              isStarred: lastItem.currentPreference.isStarred,
              navigationRank: conversationNavigationRank(lastItem),
              activityAt: lastItem.activityAt,
              conversationId: lastItem.id,
            })
      : undefined;

  return {
    items: Object.freeze(items),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}
