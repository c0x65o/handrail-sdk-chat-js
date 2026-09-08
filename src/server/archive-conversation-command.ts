import { createHash, randomUUID } from "node:crypto";

import {
  parseConversationArchiveInput,
  parseConversationArchiveResult,
  type ConversationArchiveInput,
  type ConversationArchiveResult,
  type ConversationArchiveState,
} from "../contracts/conversation-archive.js";
import type { IsoTimestamp, UserId } from "../contracts/identifiers.js";
import { CHAT_PROTOCOL_VERSION } from "../contracts/realtime.js";
import type {
  ChatPermissionAdapter,
  TrustedChatActorContext,
} from "./contracts.js";
import {
  DEFAULT_POSTGRES_SCHEMA,
  validatePostgresSchema,
  type PostgresMigrationConnection,
  type PostgresMigrationDatabase,
} from "./postgres-migrations.js";
import { ChatAuthorizationError } from "./request-context.js";

export const ARCHIVE_CONVERSATION_ADMIN_CAPABILITY =
  "conversation.archive" as const;
export const ARCHIVE_CONVERSATION_ENTITY_POLICY_ACTION =
  "conversation.archive" as const;
export const ARCHIVE_CONVERSATION_IDEMPOTENCY_OPERATION =
  "conversation.archive" as const;
export const DEFAULT_ARCHIVE_CONVERSATION_IDEMPOTENCY_TTL_MS =
  24 * 60 * 60 * 1_000;
export const DEFAULT_ARCHIVE_CONVERSATION_OUTBOX_RETENTION_MS =
  7 * 24 * 60 * 60 * 1_000;

export type ArchiveConversationCommandErrorCode =
  | "idempotency_conflict"
  | "idempotency_in_progress";

/** Stable command failure suitable for a future transport boundary. */
export class ArchiveConversationCommandError extends Error {
  public readonly statusCode = 409;

  public constructor(
    public readonly code: ArchiveConversationCommandErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ArchiveConversationCommandError";
  }
}

export interface ArchiveConversationCommandOptions {
  readonly database: PostgresMigrationDatabase;
  readonly permissions: Pick<
    ChatPermissionAdapter<
      string,
      typeof ARCHIVE_CONVERSATION_ENTITY_POLICY_ACTION
    >,
    "getCapabilities" | "authorizeEntity"
  >;
  /** Trusted host-session identity; caller input cannot override these values. */
  readonly actor: TrustedChatActorContext;
  /** JSON-decoded caller input, validated by the shared archive contract. */
  readonly input: unknown;
  readonly schema?: string;
  readonly idempotencyTtlMs?: number;
  readonly outboxRetentionMs?: number;
  /** Trusted transport correlation id used only by the existing audit record. */
  readonly requestId?: string;
  /** Supplies opaque durable identifiers; defaults to cryptographic UUIDs. */
  readonly createId?: () => string;
}

interface ClaimedIdempotencyRow {
  readonly idempotency_state: string;
  readonly stored_response_body: unknown | null;
}

interface LockedConversationRow {
  readonly lifecycle_revision: string | number;
  readonly archived_at: Date | string | null;
  readonly archived_by_user_id: string | null;
  readonly member_role: string | null;
  readonly member_state: string | null;
  readonly entity_type: string | null;
  readonly entity_id: string | null;
  readonly occurred_at: Date | string;
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
      throw new TypeError("Conversation archive input must contain finite numbers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") {
    throw new TypeError("Conversation archive input must be JSON-compatible");
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
};

const hashRequest = (input: ConversationArchiveInput): string =>
  `sha256:${createHash("sha256")
    .update(
      canonicalJson({
        operation: input.operation,
        intent: input.intent,
        conversationId: input.conversationId,
        expectedLifecycleRevision: input.expectedLifecycleRevision,
      }),
    )
    .digest("hex")}`;

const toIsoTimestamp = (value: Date | string, label: string): IsoTimestamp => {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.valueOf())) {
    throw new Error(`PostgreSQL returned an invalid ${label}`);
  }
  return date.toISOString() as IsoTimestamp;
};

const toLifecycleRevision = (value: string | number): number => {
  const revision = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error("PostgreSQL returned an invalid conversation lifecycle revision");
  }
  return revision;
};

const stateFromRow = (
  row: LockedConversationRow,
): ConversationArchiveState => {
  if (row.archived_at === null && row.archived_by_user_id === null) {
    return { status: "active" };
  }
  if (row.archived_at === null || !nonEmptyString(row.archived_by_user_id)) {
    throw new Error("PostgreSQL returned an invalid conversation archive state");
  }
  return {
    status: "archived",
    archivedAt: toIsoTimestamp(row.archived_at, "conversation archived_at"),
    archivedByUserId: row.archived_by_user_id as UserId,
  };
};

const replayStoredResult = (
  stored: unknown,
  input: ConversationArchiveInput,
): ConversationArchiveResult => {
  const canonical = parseConversationArchiveResult(stored, input);
  if (canonical.reconciliationStatus === "lifecycle_conflict") {
    return canonical;
  }
  return parseConversationArchiveResult(
    { ...canonical, reconciliationStatus: "replayed" },
    input,
  );
};

const authorizeConversation = async (
  row: LockedConversationRow,
  actor: TrustedChatActorContext,
  permissions: ArchiveConversationCommandOptions["permissions"],
): Promise<void> => {
  const isActiveOwner =
    row.member_role === "owner" && row.member_state === "active";
  if (!isActiveOwner) {
    try {
      const capabilities = await permissions.getCapabilities({ actor });
      if (
        !Array.isArray(capabilities) ||
        !capabilities.every(nonEmptyString) ||
        !capabilities.includes(ARCHIVE_CONVERSATION_ADMIN_CAPABILITY)
      ) {
        throw new Error("denied");
      }
    } catch {
      throw new ChatAuthorizationError();
    }
  }

  if (row.entity_type === null && row.entity_id === null) return;
  if (row.entity_type === null || row.entity_id === null) {
    throw new ChatAuthorizationError();
  }
  try {
    const allowed = await permissions.authorizeEntity({
      actor,
      entity: { type: row.entity_type, id: row.entity_id },
      action: ARCHIVE_CONVERSATION_ENTITY_POLICY_ACTION,
    });
    if (!allowed) throw new Error("denied");
  } catch {
    throw new ChatAuthorizationError();
  }
};

const persistOutcome = async (
  connection: PostgresMigrationConnection,
  prefix: string,
  actor: TrustedChatActorContext,
  input: ConversationArchiveInput,
  requestHash: string,
  result: ConversationArchiveResult,
  occurredAt: IsoTimestamp,
): Promise<void> => {
  const completed = await connection.query(
    `UPDATE ${prefix}.chat_idempotency_keys
       SET state = 'completed', response_status = 200, response_body = $1,
           completed_at = GREATEST($2::timestamptz, created_at),
           updated_at = GREATEST($2::timestamptz, created_at)
     WHERE tenant_id = $3 AND user_id = $4 AND operation_name = $5
       AND client_key = $6 AND request_hash = $7 AND state = 'pending'`,
    [
      result,
      occurredAt,
      actor.tenantId,
      actor.userId,
      ARCHIVE_CONVERSATION_IDEMPOTENCY_OPERATION,
      input.idempotencyKey,
      requestHash,
    ],
  );
  if (completed.rowCount !== 1) {
    throw new ArchiveConversationCommandError(
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

/** Atomically archives or restores one tenant-scoped conversation. */
export async function archiveConversation(
  options: ArchiveConversationCommandOptions,
): Promise<ConversationArchiveResult> {
  validateActor(options.actor);
  const input = parseConversationArchiveInput(options.input);
  const schema = validatePostgresSchema(
    options.schema ?? DEFAULT_POSTGRES_SCHEMA,
  );
  const prefix = quoteIdentifier(schema);
  const idempotencyTtlMs = positiveSafeInteger(
    options.idempotencyTtlMs ??
      DEFAULT_ARCHIVE_CONVERSATION_IDEMPOTENCY_TTL_MS,
    "idempotencyTtlMs",
  );
  const outboxRetentionMs = positiveSafeInteger(
    options.outboxRetentionMs ??
      DEFAULT_ARCHIVE_CONVERSATION_OUTBOX_RETENTION_MS,
    "outboxRetentionMs",
  );
  const createId = options.createId ?? randomUUID;
  const requestHash = hashRequest(input);

  const connection = await options.database.connect();
  try {
    await connection.query("BEGIN");
    const claim = await connection.query<ClaimedIdempotencyRow>(
      `SELECT * FROM ${prefix}.claim_chat_idempotency_key(
         $1, $2, $3, $4, $5,
         clock_timestamp() + ($6::double precision * interval '1 millisecond')
       )`,
      [
        options.actor.tenantId,
        options.actor.userId,
        ARCHIVE_CONVERSATION_IDEMPOTENCY_OPERATION,
        input.idempotencyKey,
        requestHash,
        idempotencyTtlMs,
      ],
    );
    const claimed = claim.rows[0];
    if (claimed === undefined) {
      throw new ArchiveConversationCommandError(
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

    const locked = await connection.query<LockedConversationRow>(
      `SELECT
         conversation.lifecycle_revision,
         conversation.archived_at,
         conversation.archived_by_user_id,
         member.role AS member_role,
         member.state AS member_state,
         COALESCE(conversation.entity_type, parent.entity_type) AS entity_type,
         COALESCE(conversation.entity_id, parent.entity_id) AS entity_id,
         clock_timestamp() AS occurred_at
       FROM ${prefix}.chat_conversations AS conversation
       LEFT JOIN ${prefix}.chat_conversation_members AS member
         ON member.tenant_id = conversation.tenant_id
        AND member.conversation_id = conversation.id
        AND member.user_id = $3
       LEFT JOIN ${prefix}.chat_conversations AS parent
         ON parent.tenant_id = conversation.tenant_id
        AND parent.id = conversation.parent_conversation_id
       WHERE conversation.tenant_id = $1
         AND conversation.id = $2
       FOR UPDATE OF conversation`,
      [options.actor.tenantId, input.conversationId, options.actor.userId],
    );
    const conversation = locked.rows[0];
    if (conversation === undefined) {
      throw new ChatAuthorizationError();
    }
    await authorizeConversation(conversation, options.actor, options.permissions);

    if (claimed.idempotency_state === "completed") {
      if (claimed.stored_response_body === null) {
        throw new Error("Completed archive-conversation outcome has no response body");
      }
      const replay = replayStoredResult(claimed.stored_response_body, input);
      await connection.query("COMMIT");
      return replay;
    }

    const occurredAt = toIsoTimestamp(
      conversation.occurred_at,
      "conversation archive command timestamp",
    );
    const lifecycleRevision = toLifecycleRevision(
      conversation.lifecycle_revision,
    );
    const previousState = stateFromRow(conversation);
    const requestedStatus = input.intent === "archive" ? "archived" : "active";

    if (previousState.status === requestedStatus) {
      const result = parseConversationArchiveResult(
        {
          operation: input.operation,
          intent: input.intent,
          reconciliationStatus: "already_requested_state",
          conversationId: input.conversationId,
          expectedLifecycleRevision: input.expectedLifecycleRevision,
          lifecycleRevision,
          archiveState: previousState,
        },
        input,
      );
      await persistOutcome(
        connection,
        prefix,
        options.actor,
        input,
        requestHash,
        result,
        occurredAt,
      );
      await connection.query("COMMIT");
      return result;
    }

    if (lifecycleRevision !== input.expectedLifecycleRevision) {
      const result = parseConversationArchiveResult(
        {
          operation: input.operation,
          intent: input.intent,
          reconciliationStatus: "lifecycle_conflict",
          conversationId: input.conversationId,
          expectedLifecycleRevision: input.expectedLifecycleRevision,
          lifecycleRevision,
          archiveState: previousState,
        },
        input,
      );
      await persistOutcome(
        connection,
        prefix,
        options.actor,
        input,
        requestHash,
        result,
        occurredAt,
      );
      await connection.query("COMMIT");
      return result;
    }

    const nextLifecycleRevision = lifecycleRevision + 1;
    if (!Number.isSafeInteger(nextLifecycleRevision)) {
      throw new Error("Conversation lifecycle revision cannot be advanced safely");
    }
    const updated =
      input.intent === "archive"
        ? await connection.query(
            `UPDATE ${prefix}.chat_conversations
             SET archived_at = $1, archived_by_user_id = $2,
                 lifecycle_revision = $3, updated_at = $1
           WHERE tenant_id = $4 AND id = $5 AND lifecycle_revision = $6`,
            [
              occurredAt,
              options.actor.userId,
              nextLifecycleRevision,
              options.actor.tenantId,
              input.conversationId,
              lifecycleRevision,
            ],
          )
        : await connection.query(
            `UPDATE ${prefix}.chat_conversations
             SET archived_at = NULL, archived_by_user_id = NULL,
                 lifecycle_revision = $2, updated_at = $1
           WHERE tenant_id = $3 AND id = $4 AND lifecycle_revision = $5`,
            [
              occurredAt,
              nextLifecycleRevision,
              options.actor.tenantId,
              input.conversationId,
              lifecycleRevision,
            ],
          );
    if (updated.rowCount !== 1) {
      throw new ChatAuthorizationError();
    }

    const archiveState: ConversationArchiveState =
      input.intent === "archive"
        ? {
            status: "archived",
            archivedAt: occurredAt,
            archivedByUserId: options.actor.userId as UserId,
          }
        : { status: "active" };
    const result = parseConversationArchiveResult(
      {
        operation: input.operation,
        intent: input.intent,
        reconciliationStatus: "applied",
        conversationId: input.conversationId,
        expectedLifecycleRevision: input.expectedLifecycleRevision,
        lifecycleRevision: nextLifecycleRevision,
        archiveState,
      },
      input,
    );
    const transition = {
      conversationId: input.conversationId,
      intent: input.intent,
      previousState: previousState.status,
      currentState: archiveState.status,
      previousLifecycleRevision: lifecycleRevision,
      currentLifecycleRevision: nextLifecycleRevision,
    };

    const auditEventId = createId();
    const eventType =
      input.intent === "archive"
        ? "conversation.archived"
        : "conversation.restored";
    await connection.query(
      `INSERT INTO ${prefix}.chat_audit_events (
         tenant_id, event_id, actor_user_id, action, target_type, target_id,
         occurred_at, metadata, request_id
       ) VALUES ($1, $2, $3, $4, 'conversation', $5, $6, $7, $8)`,
      [
        options.actor.tenantId,
        auditEventId,
        options.actor.userId,
        eventType,
        input.conversationId,
        occurredAt,
        transition,
        options.requestId ?? auditEventId,
      ],
    );

    const outboxEventId = createId();
    await connection.query(
      `INSERT INTO ${prefix}.chat_outbox_events (
         event_id, protocol_version, tenant_id, stream_id, type,
         occurred_at, payload, expires_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         $6::timestamptz + ($8::double precision * interval '1 millisecond')
       )`,
      [
        outboxEventId,
        CHAT_PROTOCOL_VERSION,
        options.actor.tenantId,
        input.conversationId,
        eventType,
        occurredAt,
        transition,
        outboxRetentionMs,
      ],
    );

    await persistOutcome(
      connection,
      prefix,
      options.actor,
      input,
      requestHash,
      result,
      occurredAt,
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
