import { createHash, randomUUID } from "node:crypto";

import {
  parseSynchronizeDraftInput,
  parseSynchronizeDraftResult,
  type CanonicalDraftState,
  type SynchronizeDraftInput,
  type SynchronizeDraftResult,
} from "../contracts/draft-mutation.js";
import type { IsoTimestamp } from "../contracts/identifiers.js";
import { CHAT_PROTOCOL_VERSION } from "../contracts/realtime.js";
import type { ChatPermissionAdapter, TrustedChatActorContext } from "./contracts.js";
import {
  DEFAULT_POSTGRES_SCHEMA,
  validatePostgresSchema,
  type PostgresMigrationConnection,
  type PostgresMigrationDatabase,
} from "./postgres-migrations.js";
import { ChatAuthorizationError } from "./request-context.js";
import { authorizeThreadAccess } from "./thread-access.js";
import { ensureThreadParticipant } from "./thread-participant.js";

export const SYNCHRONIZE_DRAFT_IDEMPOTENCY_OPERATION =
  "conversation.draft.synchronize" as const;
export const SYNCHRONIZE_DRAFT_OUTBOX_EVENT_TYPE =
  "conversation.draft.updated" as const;
export const DEFAULT_SYNCHRONIZE_DRAFT_IDEMPOTENCY_TTL_MS =
  24 * 60 * 60 * 1_000;
export const DEFAULT_SYNCHRONIZE_DRAFT_OUTBOX_RETENTION_MS =
  7 * 24 * 60 * 60 * 1_000;

export type SynchronizeDraftCommandErrorCode =
  | "idempotency_conflict"
  | "idempotency_in_progress";

/** Stable command failure suitable for a future transport boundary. */
export class SynchronizeDraftCommandError extends Error {
  public readonly statusCode = 409;

  public constructor(
    public readonly code: SynchronizeDraftCommandErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SynchronizeDraftCommandError";
  }
}

export interface SynchronizeDraftCommandOptions {
  readonly database: PostgresMigrationDatabase;
  /** Required for entity-bound thread parents; absent authorization fails closed. */
  readonly permissions?: Pick<
    ChatPermissionAdapter<string, typeof SYNCHRONIZE_DRAFT_IDEMPOTENCY_OPERATION>,
    "authorizeEntity"
  >;
  /** Trusted host-session identity; caller input cannot override these values. */
  readonly actor: TrustedChatActorContext;
  /** JSON-decoded caller input, validated by the shared draft contract. */
  readonly input: unknown;
  readonly schema?: string;
  readonly idempotencyTtlMs?: number;
  readonly outboxRetentionMs?: number;
  /** Supplies opaque durable identifiers; defaults to cryptographic UUIDs. */
  readonly createId?: () => string;
}

interface ClaimedIdempotencyRow {
  readonly idempotency_state: string;
  readonly stored_response_body: unknown | null;
}

interface AuthorizedConversationRow {
  readonly observed_at: Date | string;
}

interface SynchronizedDraftRow {
  readonly did_apply: boolean;
  readonly stored_revision: string | number;
  readonly stored_content: unknown | null;
  readonly stored_updated_at: Date | string;
}

const quoteIdentifier = (identifier: string): string =>
  `"${identifier.replaceAll('"', '""')}"`;

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const positiveSafeInteger = (value: unknown, label: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value as number;
};

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

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Draft input must contain finite JSON numbers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value !== "object") {
    throw new TypeError("Draft input must be JSON-compatible");
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
};

const hashRequest = (input: SynchronizeDraftInput): string =>
  `sha256:${createHash("sha256")
    .update(canonicalJson(input))
    .digest("hex")}`;

const toIsoTimestamp = (value: Date | string): IsoTimestamp => {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.valueOf())) {
    throw new Error("PostgreSQL returned an invalid draft timestamp");
  }
  return date.toISOString() as IsoTimestamp;
};

const toRevision = (value: string | number): number => {
  const revision = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error("PostgreSQL returned an invalid draft revision");
  }
  return revision;
};

const replayStoredResult = (
  stored: unknown,
  input: SynchronizeDraftInput,
): SynchronizeDraftResult => {
  const canonical = parseSynchronizeDraftResult(stored, input);
  if (canonical.reconciliationStatus === "stale_base") {
    return canonical;
  }
  return parseSynchronizeDraftResult(
    { ...canonical, reconciliationStatus: "replayed" },
    input,
  );
};

const persistOutcome = async (
  connection: PostgresMigrationConnection,
  prefix: string,
  options: SynchronizeDraftCommandOptions,
  input: SynchronizeDraftInput,
  requestHash: string,
  result: SynchronizeDraftResult,
  completedAt: IsoTimestamp,
): Promise<void> => {
  const completed = await connection.query(
    `UPDATE ${prefix}.chat_idempotency_keys
     SET state = 'completed',
         response_status = 200,
         response_body = $1,
         completed_at = GREATEST($2::timestamptz, created_at),
         updated_at = GREATEST($2::timestamptz, created_at)
     WHERE tenant_id = $3
       AND user_id = $4
       AND operation_name = $5
       AND client_key = $6
       AND request_hash = $7
       AND state = 'pending'`,
    [
      result,
      completedAt,
      options.actor.tenantId,
      options.actor.userId,
      SYNCHRONIZE_DRAFT_IDEMPOTENCY_OPERATION,
      input.idempotencyKey,
      requestHash,
    ],
  );
  if (completed.rowCount !== 1) {
    throw new SynchronizeDraftCommandError(
      "idempotency_in_progress",
      "The idempotent request is already in progress",
    );
  }
};

const rollback = async (
  connection: PostgresMigrationConnection,
): Promise<void> => {
  await connection.query("ROLLBACK").catch(() => undefined);
};

/**
 * Synchronizes one actor-owned draft and its private durable event in one
 * PostgreSQL transaction. Draft state is never exposed to conversation streams.
 */
export async function synchronizeDraft(
  options: SynchronizeDraftCommandOptions,
): Promise<SynchronizeDraftResult> {
  validateActor(options.actor);
  const input = parseSynchronizeDraftInput(options.input);
  const schema = validatePostgresSchema(
    options.schema ?? DEFAULT_POSTGRES_SCHEMA,
  );
  const prefix = quoteIdentifier(schema);
  const idempotencyTtlMs = positiveSafeInteger(
    options.idempotencyTtlMs ?? DEFAULT_SYNCHRONIZE_DRAFT_IDEMPOTENCY_TTL_MS,
    "idempotencyTtlMs",
  );
  const outboxRetentionMs = positiveSafeInteger(
    options.outboxRetentionMs ?? DEFAULT_SYNCHRONIZE_DRAFT_OUTBOX_RETENTION_MS,
    "outboxRetentionMs",
  );
  const createId = options.createId ?? randomUUID;
  const requestHash = hashRequest(input);

  const connection = await options.database.connect();
  try {
    await connection.query("BEGIN");

    const claim = await connection.query<ClaimedIdempotencyRow>(
      `SELECT *
       FROM ${prefix}.claim_chat_idempotency_key(
         $1, $2, $3, $4, $5,
         clock_timestamp() + ($6::double precision * interval '1 millisecond')
       )`,
      [
        options.actor.tenantId,
        options.actor.userId,
        SYNCHRONIZE_DRAFT_IDEMPOTENCY_OPERATION,
        input.idempotencyKey,
        requestHash,
        idempotencyTtlMs,
      ],
    );
    const claimed = claim.rows[0];
    if (claimed === undefined) {
      throw new SynchronizeDraftCommandError(
        "idempotency_conflict",
        "The idempotency key was already used for a different request",
      );
    }
    if (
      claimed.idempotency_state !== "pending" &&
      claimed.idempotency_state !== "completed"
    ) {
      throw new Error("PostgreSQL returned an invalid idempotency state");
    }

    // Discover without locking the child: retained setup locks parent before child.
    const target = await connection.query<{
      readonly type: string;
      readonly parent_conversation_id: string | null;
    }>(
      `SELECT type, parent_conversation_id FROM ${prefix}.chat_conversations
       WHERE tenant_id = $1 AND id = $2`,
      [options.actor.tenantId, input.conversationId],
    );
    const thread = target.rows[0]?.type === "thread" ? target.rows[0] : undefined;
    let conversation: AuthorizedConversationRow | undefined;
    if (thread !== undefined) {
      const permissions = options.permissions ?? { authorizeEntity: async () => false };
      const clock = await connection.query<AuthorizedConversationRow>(
        "SELECT clock_timestamp() AS observed_at",
      );
      conversation = clock.rows[0];
      if (conversation === undefined || thread.parent_conversation_id === null) {
        throw new ChatAuthorizationError();
      }
      if (claimed.idempotency_state === "completed") {
        // Replays disclose private content, so refresh parent/host authority too.
        const access = await authorizeThreadAccess({
          database: connection, schema, actor: options.actor,
          threadId: input.conversationId, operation: "read",
          entityAction: SYNCHRONIZE_DRAFT_IDEMPOTENCY_OPERATION, permissions,
        });
        if (access.isArchived) throw new ChatAuthorizationError();
      } else {
        await ensureThreadParticipant({
          connection, schema, actor: options.actor, threadId: input.conversationId,
          parentConversationId: thread.parent_conversation_id,
          entityAction: SYNCHRONIZE_DRAFT_IDEMPOTENCY_OPERATION, permissions,
          occurredAt: toIsoTimestamp(conversation.observed_at), initialRole: "member",
        });
      }
    } else {
      const authorized = await connection.query<AuthorizedConversationRow>(
        `SELECT clock_timestamp() AS observed_at
         FROM ${prefix}.chat_conversations AS conversation
         INNER JOIN ${prefix}.chat_conversation_members AS member
           ON member.tenant_id = conversation.tenant_id
          AND member.conversation_id = conversation.id
          AND member.user_id = $3
          AND member.state = 'active'
         WHERE conversation.tenant_id = $1
           AND conversation.id = $2
         FOR UPDATE OF conversation, member`,
        [options.actor.tenantId, input.conversationId, options.actor.userId],
      );
      conversation = authorized.rows[0];
    }
    if (conversation === undefined) {
      throw new ChatAuthorizationError();
    }

    if (claimed.idempotency_state === "completed") {
      if (claimed.stored_response_body === null) {
        throw new Error("Completed synchronize-draft outcome has no response body");
      }
      const replay = replayStoredResult(claimed.stored_response_body, input);
      await connection.query("COMMIT");
      return replay;
    }

    const mutationTime = toIsoTimestamp(conversation.observed_at);
    const proposedRevision = input.baseRevision + 1;
    const synchronized = await connection.query<SynchronizedDraftRow>(
      `SELECT
         did_apply,
         stored_revision,
         stored_content,
         stored_updated_at
       FROM ${prefix}.synchronize_chat_draft($1, $2, $3, $4, $5, $6)`,
      [
        options.actor.tenantId,
        input.conversationId,
        options.actor.userId,
        input.intent === "replace" ? input.content : null,
        proposedRevision,
        mutationTime,
      ],
    );
    const stored = synchronized.rows[0];
    if (stored === undefined) {
      throw new Error("PostgreSQL did not return a synchronized draft");
    }

    const draft: CanonicalDraftState =
      stored.stored_content === null
        ? { kind: "clear_tombstone", content: null }
        : { kind: "replaced", content: stored.stored_content as never };
    const result = parseSynchronizeDraftResult(
      {
        operation: input.operation,
        intent: input.intent,
        reconciliationStatus: stored.did_apply ? "applied" : "stale_base",
        conversationId: input.conversationId,
        baseRevision: input.baseRevision,
        deviceMutationId: input.deviceMutationId,
        idempotencyKey: input.idempotencyKey,
        canonicalRevision: toRevision(stored.stored_revision),
        canonicalUpdatedAt: toIsoTimestamp(stored.stored_updated_at),
        draft,
      },
      input,
    );

    if (result.reconciliationStatus === "applied") {
      await connection.query(
        `INSERT INTO ${prefix}.chat_outbox_events (
           event_id, protocol_version, tenant_id, stream_id, type,
           occurred_at, payload, expires_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7,
           $6::timestamptz + ($8::double precision * interval '1 millisecond')
         )`,
        [
          createId(),
          CHAT_PROTOCOL_VERSION,
          options.actor.tenantId,
          `user:${options.actor.userId}`,
          SYNCHRONIZE_DRAFT_OUTBOX_EVENT_TYPE,
          result.canonicalUpdatedAt,
          { actorUserId: options.actor.userId, input, result },
          outboxRetentionMs,
        ],
      );
    }

    await persistOutcome(
      connection,
      prefix,
      options,
      input,
      requestHash,
      result,
      mutationTime,
    );
    await connection.query("COMMIT");
    return result;
  } catch (error) {
    await rollback(connection);
    throw error;
  } finally {
    connection.release();
  }
}
