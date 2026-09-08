import type { IsoTimestamp } from "../contracts/identifiers.js";
import type { ChatPermissionAdapter, TrustedChatActorContext } from "./contracts.js";
import {
  DEFAULT_POSTGRES_SCHEMA,
  validatePostgresSchema,
  type PostgresMigrationConnection,
} from "./postgres-migrations.js";
import { ChatAuthorizationError } from "./request-context.js";
import { authorizeThreadAccess } from "./thread-access.js";

export interface ThreadParticipantOptions<Action extends string = string> {
  /** Checked-out connection in the caller's active transaction. */
  readonly connection: PostgresMigrationConnection;
  readonly schema?: string;
  readonly actor: TrustedChatActorContext;
  readonly threadId: string;
  readonly parentConversationId: string;
  /** The trusted consumer's existing entity action; never request input. */
  readonly entityAction: Action;
  readonly permissions: Pick<ChatPermissionAdapter<string, Action>, "authorizeEntity">;
  readonly occurredAt: IsoTimestamp;
  /** Used only for a new participant. Existing role/joined_at are retained. */
  readonly initialRole: "owner" | "member";
}

/**
 * Retained storage setup for an otherwise authorized write, never read authority
 * or a subscription change. The caller owns BEGIN/COMMIT/ROLLBACK/release and
 * operation capability, root and lifecycle checks.
 *
 * Locks parent, then child, then the actor's parent membership before checking
 * current access on this very connection. Callers must use compatible lock order
 * and retry their whole transaction on serialization/deadlock failures. Existing
 * membership rows are locked too so direct membership revocations serialize.
 * Host authorization is refreshed here but cannot be locked by PostgreSQL.
 *
 * No access result is accepted from a caller: the freshly checked result remains
 * local and is bound to this actor, tenant, parent and child for these writes.
 * Call again on reconciliation/retry. Never creates or changes follows or drafts.
 */
export async function ensureThreadParticipant<Action extends string>(
  options: ThreadParticipantOptions<Action>,
): Promise<void> {
  const { connection, threadId, parentConversationId, occurredAt, initialRole } = options;
  const actor = { ...options.actor, roles: [...options.actor.roles] };
  const schema = validatePostgresSchema(options.schema ?? DEFAULT_POSTGRES_SCHEMA);
  const prefix = `"${schema}"`;
  await connection.query(
    `SELECT id FROM ${prefix}.chat_conversations
      WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [actor.tenantId, parentConversationId],
  );
  const child = await connection.query(
    `SELECT id FROM ${prefix}.chat_conversations
      WHERE tenant_id = $1 AND id = $2 AND type = 'thread'
        AND parent_conversation_id = $3 AND archived_at IS NULL FOR UPDATE`,
    [actor.tenantId, threadId, parentConversationId],
  );
  if (child.rows.length !== 1) throw new ChatAuthorizationError();
  await connection.query(
    `SELECT user_id FROM ${prefix}.chat_conversation_members
      WHERE tenant_id = $1 AND conversation_id = $2 AND user_id = $3 FOR UPDATE`,
    [actor.tenantId, parentConversationId, actor.userId],
  );
  const access = await authorizeThreadAccess({
    database: connection, schema, actor, threadId, operation: "read",
    entityAction: options.entityAction, permissions: options.permissions,
  });
  if (access.threadId !== threadId || access.parentConversationId !== parentConversationId || access.isArchived) {
    throw new ChatAuthorizationError();
  }

  await connection.query(
    `INSERT INTO ${prefix}.chat_conversation_members (
       tenant_id, conversation_id, user_id, role, state, joined_at, updated_at
     ) VALUES ($1, $2, $3, $4, 'active', $5, $5)
     ON CONFLICT (tenant_id, conversation_id, user_id)
     DO UPDATE SET state = 'active', updated_at = EXCLUDED.updated_at`,
    [actor.tenantId, threadId, actor.userId, initialRole, occurredAt],
  );
  await connection.query(
    `INSERT INTO ${prefix}.chat_read_cursors (
       tenant_id, conversation_id, user_id, last_read_sequence, updated_at
     ) VALUES ($1, $2, $3, 0, $4)
     ON CONFLICT (tenant_id, conversation_id, user_id) DO NOTHING`,
    [actor.tenantId, threadId, actor.userId, occurredAt],
  );
  await connection.query(
    `INSERT INTO ${prefix}.chat_conversation_preferences (
       tenant_id, conversation_id, user_id, notification_level,
       muted, created_at, updated_at
     ) VALUES ($1, $2, $3, 'all', false, $4, $4)
     ON CONFLICT (tenant_id, conversation_id, user_id) DO NOTHING`,
    [actor.tenantId, threadId, actor.userId, occurredAt],
  );
}
