import {
  ACTOR_PRIVATE_USER_STATE_PRIVACY,
  parseConversationDraftSnapshot,
  parseConversationDraftSnapshotInput,
  type ConversationDraftSnapshot,
  type ConversationDraftSnapshotInput,
} from "../contracts/private-user-state-snapshot.js";
import type { IsoTimestamp } from "../contracts/identifiers.js";
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

export const CONVERSATION_DRAFT_SNAPSHOT_ENTITY_POLICY_ACTION =
  "conversation.draft.snapshot" as const;

export interface ConversationDraftSnapshotQueryOptions {
  readonly database: PostgresMigrationDatabase;
  readonly permissions: Pick<
    ChatPermissionAdapter<
      string,
      typeof CONVERSATION_DRAFT_SNAPSHOT_ENTITY_POLICY_ACTION
    >,
    "authorizeEntity"
  >;
  /** Trusted host-session identity; caller input cannot override these values. */
  readonly actor: TrustedChatActorContext;
  /** JSON-decoded caller input, validated by the shared private-state parser. */
  readonly input: unknown;
  readonly schema?: string;
}

interface StoredConversationDraftSnapshotRow {
  readonly conversation_type: string;
  readonly entity_type: string | null;
  readonly entity_id: string | null;
  readonly draft_content: unknown | null;
  readonly draft_revision: string | number | null;
  readonly draft_updated_at: Date | string | null;
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

const toPositiveRevision = (value: string | number): number => {
  const revision = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error("Invalid draft revision returned by PostgreSQL");
  }
  return revision;
};

const toIsoTimestamp = (value: Date | string): IsoTimestamp => {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.valueOf())) {
    throw new Error("Invalid draft updated_at returned by PostgreSQL");
  }
  return date.toISOString() as IsoTimestamp;
};

const snapshotFromRow = (
  row: StoredConversationDraftSnapshotRow,
  input: ConversationDraftSnapshotInput,
): ConversationDraftSnapshot => {
  const base = {
    kind: "conversation_draft" as const,
    privacy: ACTOR_PRIVATE_USER_STATE_PRIVACY,
    conversationId: input.conversationId,
  };

  if (row.draft_revision === null) {
    if (row.draft_content !== null || row.draft_updated_at !== null) {
      throw new Error("Invalid absent draft row returned by PostgreSQL");
    }
    return parseConversationDraftSnapshot(
      {
        ...base,
        state: "absent",
        canonicalRevision: 0,
        canonicalUpdatedAt: null,
        content: null,
      },
      input,
    );
  }

  if (row.draft_updated_at === null) {
    throw new Error("Invalid stored draft row returned by PostgreSQL");
  }
  const canonicalRevision = toPositiveRevision(row.draft_revision);
  const canonicalUpdatedAt = toIsoTimestamp(row.draft_updated_at);
  if (row.draft_content === null) {
    return parseConversationDraftSnapshot(
      {
        ...base,
        state: "absent",
        canonicalRevision,
        canonicalUpdatedAt,
        content: null,
      },
      input,
    );
  }

  return parseConversationDraftSnapshot(
    {
      ...base,
      state: "present",
      canonicalRevision,
      canonicalUpdatedAt,
      content: {
        privacy: ACTOR_PRIVATE_USER_STATE_PRIVACY,
        value: row.draft_content,
      },
    },
    input,
  );
};

/**
 * Loads the trusted actor's canonical private draft for one conversation.
 *
 * Public channels are visible tenant-wide; every other conversation requires
 * active membership, except threads which require current parent access.
 * The query projects only validated draft content and
 * attachment identifiers; it never reads attachment metadata, storage state,
 * audit data, or another user's row.
 */
export async function queryConversationDraftSnapshot(
  options: ConversationDraftSnapshotQueryOptions,
): Promise<ConversationDraftSnapshot> {
  const input = parseConversationDraftSnapshotInput(options.input);
  validateActor(options.actor);

  const schema = validatePostgresSchema(
    options.schema ?? DEFAULT_POSTGRES_SCHEMA,
  );
  const prefix = quoteIdentifier(schema);
  const result = await options.database.query<StoredConversationDraftSnapshotRow>(
    `WITH authorized_conversation AS (
       SELECT
         conversation.tenant_id,
         conversation.id,
         conversation.type AS conversation_type,
         COALESCE(conversation.entity_type, parent.entity_type) AS entity_type,
         COALESCE(conversation.entity_id, parent.entity_id) AS entity_id
       FROM ${prefix}.chat_conversations AS conversation
       LEFT JOIN ${prefix}.chat_conversation_members AS current_member
         ON current_member.tenant_id = conversation.tenant_id
        AND current_member.conversation_id = conversation.id
        AND current_member.user_id = $2
       LEFT JOIN ${prefix}.chat_conversations AS parent
         ON parent.tenant_id = conversation.tenant_id
        AND parent.id = conversation.parent_conversation_id
       LEFT JOIN ${prefix}.chat_conversation_members AS parent_member
         ON parent_member.tenant_id = parent.tenant_id
        AND parent_member.conversation_id = parent.id
        AND parent_member.user_id = $2
       WHERE conversation.tenant_id = $1
         AND conversation.id = $3
         AND (
           (conversation.type <> 'thread' AND (
             (conversation.type = 'channel' AND conversation.visibility = 'public')
             OR current_member.state = 'active'
           ))
           OR (conversation.type = 'thread'
             AND parent.type IN ('channel', 'direct', 'group_direct')
             AND parent.archived_at IS NULL
             AND ((parent.type = 'channel' AND parent.visibility = 'public')
                  OR parent_member.state = 'active'))
         )
       LIMIT 1
     )
     SELECT
       conversation.conversation_type,
       conversation.entity_type,
       conversation.entity_id,
       draft.content AS draft_content,
       draft.revision AS draft_revision,
       draft.updated_at AS draft_updated_at
     FROM authorized_conversation AS conversation
     LEFT JOIN ${prefix}.chat_drafts AS draft
       ON draft.tenant_id = conversation.tenant_id
      AND draft.conversation_id = conversation.id
      AND draft.user_id = $2
     LIMIT 1`,
    [options.actor.tenantId, options.actor.userId, input.conversationId],
  );

  const row = result.rows[0];
  if (row === undefined) {
    throw new ChatAuthorizationError();
  }

  if (row.conversation_type === "thread") {
    await authorizeThreadAccess({
      database: options.database, schema, actor: options.actor,
      threadId: input.conversationId, operation: "read",
      entityAction: CONVERSATION_DRAFT_SNAPSHOT_ENTITY_POLICY_ACTION,
      permissions: options.permissions,
    });
    return snapshotFromRow(row, input);
  }

  if ((row.entity_type === null) !== (row.entity_id === null)) {
    throw new ChatAuthorizationError();
  }
  if (row.entity_type !== null && row.entity_id !== null) {
    let authorized = false;
    try {
      authorized = await options.permissions.authorizeEntity({
        actor: options.actor,
        entity: { type: row.entity_type, id: row.entity_id },
        action: CONVERSATION_DRAFT_SNAPSHOT_ENTITY_POLICY_ACTION,
      });
    } catch {
      throw new ChatAuthorizationError();
    }
    if (!authorized) {
      throw new ChatAuthorizationError();
    }
  }

  return snapshotFromRow(row, input);
}
