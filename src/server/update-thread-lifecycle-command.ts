import { createHash, randomUUID } from "node:crypto";

import { validateThreadLifecycle, type ThreadLifecycle } from "../contracts/conversation.js";
import {
  parseThreadLifecycleInput,
  parseThreadLifecycleResult,
  type ThreadLifecycleResult,
} from "../contracts/thread-lifecycle.js";
import { CHAT_PROTOCOL_VERSION } from "../contracts/realtime.js";
import type { ChatPermissionAdapter, TrustedChatActorContext } from "./contracts.js";
import {
  DEFAULT_POSTGRES_SCHEMA,
  validatePostgresSchema,
  type PostgresMigrationDatabase,
} from "./postgres-migrations.js";
import { ChatAuthorizationError } from "./request-context.js";
import { authorizeThreadAccess } from "./thread-access.js";

export const UPDATE_THREAD_LIFECYCLE_IDEMPOTENCY_OPERATION = "thread.lifecycle.update";
export const DEFAULT_UPDATE_THREAD_LIFECYCLE_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_UPDATE_THREAD_LIFECYCLE_OUTBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export type UpdateThreadLifecycleCommandErrorCode =
  | "idempotency_key_reuse"
  | "idempotency_in_progress"
  | "revision_exhausted";

export class UpdateThreadLifecycleCommandError extends Error {
  public readonly statusCode = 409;

  public constructor(
    public readonly code: UpdateThreadLifecycleCommandErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "UpdateThreadLifecycleCommandError";
  }
}

export interface UpdateThreadLifecycleCommandOptions {
  readonly database: PostgresMigrationDatabase;
  readonly permissions: ChatPermissionAdapter<string, "message.send" | "thread.manage">;
  /** Trusted host-session identity, never derived from input. */
  readonly actor: TrustedChatActorContext;
  readonly input: unknown;
  readonly schema?: string;
  readonly idempotencyTtlMs?: number;
  readonly outboxRetentionMs?: number;
  readonly createId?: () => string;
}

interface LockedThreadRow {
  readonly lifecycle_revision: string | number;
  readonly closed_at: Date | string | null;
  readonly closed_by_user_id: string | null;
  readonly locked: boolean;
  readonly occurred_at: Date | string;
}

const nonblank = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const positiveSafeInteger = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
};

const toIso = (value: Date | string): string => {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.valueOf())) throw new Error("Invalid PostgreSQL lifecycle timestamp");
  return date.toISOString();
};

/** Atomically reconciles shared thread state, its durable events and retry result. */
export async function updateThreadLifecycle(
  options: UpdateThreadLifecycleCommandOptions,
): Promise<ThreadLifecycleResult> {
  const { actor } = options;
  if (!nonblank(actor.tenantId) || !nonblank(actor.userId) ||
      !Array.isArray(actor.roles) || !actor.roles.every(nonblank)) {
    throw new TypeError("A valid trusted chat actor is required");
  }
  // The parser emits all scalar fields in a fixed order and preserves strings
  // exactly, so this hash binds the complete normalized request, including key.
  const input = parseThreadLifecycleInput(options.input);
  const requestHash = `sha256:${createHash("sha256").update(JSON.stringify(input)).digest("hex")}`;
  const schema = validatePostgresSchema(options.schema ?? DEFAULT_POSTGRES_SCHEMA);
  const prefix = `"${schema}"`;
  const ttl = positiveSafeInteger(options.idempotencyTtlMs ??
    DEFAULT_UPDATE_THREAD_LIFECYCLE_IDEMPOTENCY_TTL_MS, "idempotencyTtlMs");
  const retention = positiveSafeInteger(options.outboxRetentionMs ??
    DEFAULT_UPDATE_THREAD_LIFECYCLE_OUTBOX_RETENTION_MS, "outboxRetentionMs");
  const createId = options.createId ?? randomUUID;
  const connection = await options.database.connect();
  try {
    await connection.query("BEGIN");
    const claim = await connection.query<{
      idempotency_state: string;
      stored_response_body: unknown | null;
    }>(
      `SELECT * FROM ${prefix}.claim_chat_idempotency_key(
        $1, $2, $3, $4, $5,
        clock_timestamp() + ($6::double precision * interval '1 millisecond'))`,
      [actor.tenantId, actor.userId, UPDATE_THREAD_LIFECYCLE_IDEMPOTENCY_OPERATION,
        input.idempotencyKey, requestHash, ttl],
    );

    // Match creation/follow/send lock order: parent, child, then memberships.
    // Revalidate the stored relationship after waiting for the parent lock.
    const parents = await connection.query<{ id: string }>(
      `SELECT parent.id FROM ${prefix}.chat_conversations AS parent
       WHERE parent.tenant_id = $1 AND parent.id = (
         SELECT parent_conversation_id FROM ${prefix}.chat_conversations
         WHERE tenant_id = $1 AND id = $2 AND type = 'thread'
       ) FOR UPDATE`,
      [actor.tenantId, input.threadId],
    );
    const parent = parents.rows[0];
    if (parent === undefined) throw new ChatAuthorizationError();
    const threads = await connection.query<LockedThreadRow>(
      `SELECT lifecycle_revision, closed_at, closed_by_user_id, locked,
              clock_timestamp() AS occurred_at
       FROM ${prefix}.chat_conversations
       WHERE tenant_id = $1 AND id = $2 AND type = 'thread'
         AND parent_conversation_id = $3 FOR UPDATE`,
      [actor.tenantId, input.threadId, parent.id],
    );
    const thread = threads.rows[0];
    if (thread === undefined) throw new ChatAuthorizationError();
    await connection.query(
      `SELECT conversation_id FROM ${prefix}.chat_conversation_members
       WHERE tenant_id = $1 AND conversation_id = ANY($2::text[]) AND user_id = $3
       ORDER BY conversation_id FOR SHARE`,
      [actor.tenantId, [parent.id, input.threadId], actor.userId],
    );
    await authorizeThreadAccess({
      database: connection, schema, actor, threadId: input.threadId,
      operation: input.intent === "reopen" ? "send" : "manage",
      permissions: options.permissions,
    });

    const claimed = claim.rows[0];
    if (claimed === undefined) {
      throw new UpdateThreadLifecycleCommandError("idempotency_key_reuse",
        "The idempotency key was already used for a different request");
    }
    if (claimed.idempotency_state === "completed") {
      const stored = parseThreadLifecycleResult(claimed.stored_response_body, input);
      const replay = parseThreadLifecycleResult({ ...stored,
        reconciliationStatus: stored.reconciliationStatus === "applied"
          ? "replayed" : stored.reconciliationStatus,
      }, input);
      await connection.query("COMMIT");
      return replay;
    }
    if (claimed.idempotency_state !== "pending") {
      throw new Error("PostgreSQL returned an invalid idempotency state");
    }

    const occurredAt = toIso(thread.occurred_at);
    const before = validateThreadLifecycle({
      revision: Number(thread.lifecycle_revision), locked: thread.locked,
      ...(thread.closed_at === null && thread.closed_by_user_id === null ? {} : {
        closedAt: thread.closed_at === null ? null : toIso(thread.closed_at),
        closedByUserId: thread.closed_by_user_id,
      }),
    });
    let after: ThreadLifecycle = before;
    let status: ThreadLifecycleResult["reconciliationStatus"];
    if (before.revision !== input.expectedLifecycleRevision ||
        (input.intent === "reopen" && before.locked)) {
      status = "lifecycle_conflict";
    } else {
      const closed = input.intent === "reopen" ? false :
        input.intent === "close" || input.intent === "lock" || before.closedAt !== undefined;
      const locked = input.intent === "lock" || (input.intent !== "unlock" && before.locked);
      if (closed === (before.closedAt !== undefined) && locked === before.locked) {
        status = "already_requested_state";
      } else {
        if (before.revision === Number.MAX_SAFE_INTEGER) {
          throw new UpdateThreadLifecycleCommandError("revision_exhausted",
            "Thread lifecycle revision cannot be advanced safely");
        }
        status = "applied";
        after = validateThreadLifecycle({
          revision: before.revision + 1, locked,
          ...(closed ? {
            closedAt: before.closedAt ?? occurredAt,
            closedByUserId: before.closedByUserId ?? actor.userId,
          } : {}),
        });
      }
    }
    const result = parseThreadLifecycleResult({
      ...input, reconciliationStatus: status, previousLifecycle: before, threadLifecycle: after,
    }, input);
    if (status === "applied") {
      const updated = await connection.query(
        `UPDATE ${prefix}.chat_conversations
         SET closed_at = CASE WHEN $1::boolean THEN COALESCE(closed_at, $2::timestamptz) ELSE NULL END,
             closed_by_user_id = CASE WHEN $1::boolean THEN COALESCE(closed_by_user_id, $3) ELSE NULL END,
             locked = $4, lifecycle_revision = $5, updated_at = GREATEST(updated_at, $2::timestamptz)
         WHERE tenant_id = $6 AND id = $7 AND lifecycle_revision = $8`,
        [after.closedAt !== undefined, occurredAt, actor.userId, after.locked,
          after.revision, actor.tenantId, input.threadId, before.revision],
      );
      if (updated.rowCount !== 1) throw new Error("Locked thread lifecycle update failed");
      // Use the existing outbox replay-position allocator; neither message
      // sequences nor message activity advance for a lifecycle transition.
      for (const event of [
        { streamId: input.threadId, type: "thread.lifecycle.updated",
          payload: { threadId: input.threadId, parentConversationId: parent.id, threadLifecycle: after } },
        { streamId: parent.id, type: "thread.lifecycle.changed",
          payload: { threadId: input.threadId, parentConversationId: parent.id, revision: after.revision } },
      ]) {
        await connection.query(
          `INSERT INTO ${prefix}.chat_outbox_events
             (event_id, protocol_version, tenant_id, stream_id, type, occurred_at, payload, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7,
             $6::timestamptz + ($8::double precision * interval '1 millisecond'))`,
          [createId(), CHAT_PROTOCOL_VERSION, actor.tenantId, event.streamId,
            event.type, occurredAt, event.payload, retention],
        );
      }
    }
    const completed = await connection.query(
      `UPDATE ${prefix}.chat_idempotency_keys
       SET state = 'completed', response_status = $1, response_body = $2,
           completed_at = GREATEST($3::timestamptz, created_at),
           updated_at = GREATEST($3::timestamptz, created_at)
       WHERE tenant_id = $4 AND user_id = $5 AND operation_name = $6
         AND client_key = $7 AND request_hash = $8 AND state = 'pending'`,
      [status === "lifecycle_conflict" ? 409 : 200, result, occurredAt,
        actor.tenantId, actor.userId, UPDATE_THREAD_LIFECYCLE_IDEMPOTENCY_OPERATION,
        input.idempotencyKey, requestHash],
    );
    if (completed.rowCount !== 1) {
      throw new UpdateThreadLifecycleCommandError("idempotency_in_progress",
        "The idempotent request is already in progress");
    }
    await connection.query("COMMIT");
    return result;
  } catch (error) {
    await connection.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}
