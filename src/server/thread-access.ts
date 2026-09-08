import type { ChatPermissionAdapter, TrustedChatActorContext } from "./contracts.js";
import {
  DEFAULT_POSTGRES_SCHEMA,
  validatePostgresSchema,
  type PostgresMigrationConnection,
} from "./postgres-migrations.js";
import { ChatAuthorizationError } from "./request-context.js";

interface ThreadAccessBaseOptions {
  /** A pool for reads, or the caller's checked-out transaction connection. */
  readonly database: Pick<PostgresMigrationConnection, "query">;
  /** Trusted host identity; never take tenant/user/roles from request input. */
  readonly actor: TrustedChatActorContext;
  readonly threadId: string;
  readonly schema?: string;
}

export type ThreadAccessOptions<Action extends string = string> =
  ThreadAccessBaseOptions & (
    | {
        readonly operation: "read";
        /** The consumer's existing action, e.g. conversation.detail/subscribe. */
        readonly entityAction: Action;
        readonly permissions: Pick<ChatPermissionAdapter<string, Action>, "authorizeEntity">;
      }
    | {
        readonly operation: "send" | "manage";
        readonly permissions: ChatPermissionAdapter<string, "message.send" | "thread.manage">;
      }
  );

export interface AuthorizedThreadAccess {
  readonly threadId: string;
  readonly parentConversationId: string;
  /** Reads retain archive metadata; writes always require an unarchived child. */
  readonly isArchived: boolean;
}

interface ThreadAccessRow {
  readonly id: string;
  readonly parent_conversation_id: string;
  readonly is_archived: boolean;
  readonly entity_type: string | null;
  readonly entity_id: string | null;
  readonly can_manage: boolean;
}

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

/**
 * The operation and entity action are selected by the trusted server consumer,
 * not by request input. Evaluates current parent access without writing or
 * acquiring row locks. Never connects, begins, commits, rolls back or releases
 * the supplied executor.
 *
 * Write consumers must lock the thread and parent in their transaction BEFORE
 * calling this helper, and serialize membership/role changes on those same rows
 * (or lock the relevant membership rows too). Call again on retries, including
 * idempotent reconciliation; this result is not a reusable access token. Host
 * authorization is evaluated afresh but cannot be locked by PostgreSQL.
 *
 * This is an access foundation, not lifecycle or administrative authorization.
 * Consumers still enforce lock/close rules, explicit host thread-send narrowing,
 * and existing archive read/list or administrative archive restrictions. A read
 * can inspect an archived child under an unarchived accessible parent; send and
 * manage cannot. No follow, reply style, retained setup or cursor is consulted.
 */
export async function authorizeThreadAccess<Action extends string = string>(
  options: ThreadAccessOptions<Action>,
): Promise<AuthorizedThreadAccess> {
  const { actor } = options;
  if (
    !nonEmptyString(actor.tenantId) || !nonEmptyString(actor.userId) ||
    !Array.isArray(actor.roles) || !actor.roles.every(nonEmptyString)
  ) {
    throw new TypeError("A valid trusted chat actor is required");
  }
  if (!nonEmptyString(options.threadId)) throw new TypeError("threadId is required");
  if (
    options.operation !== "read" && options.operation !== "send" &&
    options.operation !== "manage"
  ) throw new TypeError("A valid thread access operation is required");
  const action = options.operation === "read" ? options.entityAction
    : options.operation === "send" ? "message.send" : "thread.manage";
  if (!nonEmptyString(action)) throw new TypeError("entityAction is required");
  const schema = validatePostgresSchema(options.schema ?? DEFAULT_POSTGRES_SCHEMA);
  const prefix = `"${schema}"`;
  const result = await options.database.query<ThreadAccessRow>(
    `SELECT thread.id, thread.parent_conversation_id,
            thread.archived_at IS NOT NULL AS is_archived,
            parent.entity_type, parent.entity_id,
            EXISTS (
              SELECT 1 FROM ${prefix}.chat_conversation_members AS thread_member
               WHERE thread_member.tenant_id = thread.tenant_id
                 AND thread_member.conversation_id = thread.id
                 AND thread_member.user_id = $3
                 AND thread_member.state = 'active'
                 AND thread_member.role IN ('owner', 'moderator')
            ) AS can_manage
       FROM ${prefix}.chat_conversations AS thread
       INNER JOIN ${prefix}.chat_conversations AS parent
         ON parent.tenant_id = thread.tenant_id
        AND parent.id = thread.parent_conversation_id
       LEFT JOIN ${prefix}.chat_conversation_members AS parent_member
         ON parent_member.tenant_id = parent.tenant_id
        AND parent_member.conversation_id = parent.id
        AND parent_member.user_id = $3
      WHERE thread.tenant_id = $1 AND thread.id = $2
        AND thread.type = 'thread'
        AND parent.type IN ('channel', 'direct', 'group_direct')
        AND parent.archived_at IS NULL
        AND ($4::boolean OR thread.archived_at IS NULL)
        AND ((parent.type = 'channel' AND parent.visibility = 'public')
             OR parent_member.state = 'active')`,
    [actor.tenantId, options.threadId, actor.userId, options.operation === "read"],
  );
  const row = result.rows[0];
  if (row === undefined) throw new ChatAuthorizationError();

  // Only stored, active THREAD roles confer management authority. Host roles
  // are opaque inputs to getCapabilities, and parent roles do not transfer.
  try {
    if (options.operation === "send" ||
        (options.operation === "manage" && !row.can_manage)) {
      const capabilities = await options.permissions.getCapabilities({ actor });
      if (!Array.isArray(capabilities) || !capabilities.every(nonEmptyString) ||
          !capabilities.includes(options.operation === "send" ? "message.send" : "thread.manage")) {
        throw new ChatAuthorizationError();
      }
    }
    if (row.entity_type !== null || row.entity_id !== null) {
      if (row.entity_type === null || row.entity_id === null) throw new ChatAuthorizationError();
      const entity = { type: row.entity_type, id: row.entity_id };
      const allowed = options.operation === "read"
        ? await options.permissions.authorizeEntity({ actor, entity, action: options.entityAction })
        : await options.permissions.authorizeEntity({
            actor, entity,
            action: options.operation === "send" ? "message.send" : "thread.manage",
          });
      if (!allowed) throw new ChatAuthorizationError();
    }
  } catch {
    throw new ChatAuthorizationError();
  }
  return {
    threadId: row.id,
    parentConversationId: row.parent_conversation_id,
    isArchived: row.is_archived,
  };
}
