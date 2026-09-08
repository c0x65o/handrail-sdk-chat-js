import {
  ACTOR_PRIVATE_USER_STATE_PRIVACY,
  decodeMessageReminderSnapshotCursor,
  encodeMessageReminderSnapshotCursor,
  parseMessageReminderListSnapshot,
  messageReminderSnapshotDueAt,
  parseMessageReminderListSnapshotInput,
  type MessageReminderListSnapshot,
  type MessageReminderListSnapshotInput,
  type MessageReminderSnapshotEntry,
} from "../contracts/private-user-state-snapshot.js";
import type {
  ConversationId,
  IsoTimestamp,
  MessageId,
} from "../contracts/identifiers.js";
import type {
  ChatPermissionAdapter,
  TrustedChatActorContext,
} from "./contracts.js";
import {
  DEFAULT_POSTGRES_SCHEMA,
  validatePostgresSchema,
  type PostgresMigrationDatabase,
} from "./postgres-migrations.js";

export const MESSAGE_REMINDER_LIST_ENTITY_POLICY_ACTION =
  "message_reminder.list" as const;

export interface MessageReminderListQueryOptions {
  readonly database: PostgresMigrationDatabase;
  readonly permissions: Pick<
    ChatPermissionAdapter<
      string,
      typeof MESSAGE_REMINDER_LIST_ENTITY_POLICY_ACTION
    >,
    "authorizeEntity"
  >;
  readonly actor: TrustedChatActorContext;
  readonly input: unknown;
  readonly schema?: string;
}

interface StoredReminderRow {
  readonly conversation_id: string;
  readonly message_id: string;
  /** Text retains PostgreSQL's full keyset precision. */
  readonly remind_at: string;
  readonly reminder_revision: string | number;
  readonly status: "active" | "cancelled";
  readonly entity_type: string | null;
  readonly entity_id: string | null;
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

const toIsoTimestamp = (value: string): IsoTimestamp => {
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) {
    throw new Error("PostgreSQL returned an invalid reminder timestamp");
  }
  return value as IsoTimestamp;
};

const toReminderRevision = (value: string | number): number => {
  const revision = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error("PostgreSQL returned an invalid reminder revision");
  }
  return revision;
};

const isEntityAuthorized = async (
  row: StoredReminderRow,
  options: MessageReminderListQueryOptions,
): Promise<boolean> => {
  if (row.entity_type === null && row.entity_id === null) return true;
  if (row.entity_type === null || row.entity_id === null) return false;
  try {
    return await options.permissions.authorizeEntity({
      actor: options.actor,
      entity: { type: row.entity_type, id: row.entity_id },
      action: MESSAGE_REMINDER_LIST_ENTITY_POLICY_ACTION,
    });
  } catch {
    return false;
  }
};

const rowToEntry = (row: StoredReminderRow): MessageReminderSnapshotEntry => ({
  conversationId: row.conversation_id as ConversationId,
  messageId: row.message_id as MessageId,
  reminderRevision: toReminderRevision(row.reminder_revision),
  ...(row.status === "cancelled"
    ? {
        lastScheduledDueAt: toIsoTimestamp(row.remind_at),
        reminder: { privacy: "affected_authenticated_actor", state: "cancelled" },
      }
    : {
        reminder: {
          privacy: "affected_authenticated_actor",
          state: "scheduled",
          dueAt: toIsoTimestamp(row.remind_at),
        },
      }),
});

/** Recovers currently visible reminder authority for the trusted actor. */
export async function queryMessageReminderList(
  options: MessageReminderListQueryOptions,
): Promise<MessageReminderListSnapshot> {
  validateActor(options.actor);
  const input: MessageReminderListSnapshotInput =
    parseMessageReminderListSnapshotInput(options.input);
  const schema = validatePostgresSchema(
    options.schema ?? DEFAULT_POSTGRES_SCHEMA,
  );
  const prefix = quoteIdentifier(schema);
  const requestedCursor = input.cursor
    ? decodeMessageReminderSnapshotCursor(input.cursor)
    : undefined;
  let scanDueAt = requestedCursor?.dueAt ?? null;
  let scanMessageId = requestedCursor?.messageId ?? null;
  const items: MessageReminderSnapshotEntry[] = [];
  let exhausted = false;

  while (items.length <= input.limit && !exhausted) {
    const result = await options.database.query<StoredReminderRow>(
      `SELECT reminder.conversation_id, reminder.message_id,
              to_char(
                reminder.remind_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
              ) AS remind_at,
              reminder.reminder_revision, reminder.status,
              conversation.entity_type, conversation.entity_id
         FROM ${prefix}.chat_message_reminders AS reminder
         INNER JOIN ${prefix}.chat_messages AS message
           ON message.tenant_id = reminder.tenant_id
          AND message.conversation_id = reminder.conversation_id
          AND message.id = reminder.message_id
         INNER JOIN ${prefix}.chat_conversations AS conversation
           ON conversation.tenant_id = reminder.tenant_id
          AND conversation.id = reminder.conversation_id
         LEFT JOIN ${prefix}.chat_conversation_members AS member
           ON member.tenant_id = conversation.tenant_id
          AND member.conversation_id = conversation.id
          AND member.user_id = reminder.user_id
        WHERE reminder.tenant_id = $1
          AND reminder.user_id = $2
          AND (reminder.status = 'active' OR ($6::boolean AND reminder.status = 'cancelled'))
          AND message.deleted_at IS NULL
          AND conversation.archived_at IS NULL
          AND (
            (conversation.type = 'channel' AND conversation.visibility = 'public')
            OR member.state = 'active'
          )
          AND (
            $3::timestamptz IS NULL
            OR (reminder.remind_at, reminder.message_id) > ($3::timestamptz, $4)
          )
        ORDER BY reminder.remind_at ASC, reminder.message_id ASC
        LIMIT $5`,
      [
        options.actor.tenantId,
        options.actor.userId,
        scanDueAt,
        scanMessageId,
        input.limit + 1,
        input.includeCancelled === true,
      ],
    );
    exhausted = result.rows.length < input.limit + 1;
    for (const row of result.rows) {
      scanDueAt = toIsoTimestamp(row.remind_at);
      scanMessageId = row.message_id as MessageId;
      if (await isEntityAuthorized(row, options)) {
        items.push(rowToEntry(row));
        if (items.length > input.limit) break;
      }
    }
    if (result.rows.length === 0) exhausted = true;
  }

  const hasNext = items.length > input.limit;
  const pageItems = items.slice(0, input.limit);
  const last = pageItems.at(-1);
  const nextCursor =
    hasNext && last !== undefined
      ? encodeMessageReminderSnapshotCursor({
          dueAt: messageReminderSnapshotDueAt(last),
          messageId: last.messageId,
        })
      : null;
  return parseMessageReminderListSnapshot(
    {
      kind: "message_reminder_list",
      privacy: ACTOR_PRIVATE_USER_STATE_PRIVACY,
      items: pageItems,
      page: { nextCursor },
    },
    input,
  );
}
