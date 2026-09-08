import { createHash, randomUUID } from "node:crypto";

import {
  parseUpdateConversationPreferenceInput,
  parseUpdateConversationPreferenceResult,
  type CanonicalConversationPreferenceState,
  type ConversationPreferenceDesiredState,
  type UpdateConversationPreferenceInput,
  type UpdateConversationPreferenceResult,
} from "../contracts/conversation-preference-mutation.js";
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

export const UPDATE_CONVERSATION_PREFERENCE_IDEMPOTENCY_OPERATION =
  "conversation.preference.update" as const;
export const UPDATE_CONVERSATION_PREFERENCE_AUDIT_ACTION =
  "conversation.preference.update" as const;
export const UPDATE_CONVERSATION_PREFERENCE_OUTBOX_EVENT_TYPE =
  "conversation.preference.updated" as const;
export const DEFAULT_UPDATE_CONVERSATION_PREFERENCE_IDEMPOTENCY_TTL_MS =
  24 * 60 * 60 * 1_000;
export const DEFAULT_UPDATE_CONVERSATION_PREFERENCE_OUTBOX_RETENTION_MS =
  7 * 24 * 60 * 60 * 1_000;

export type UpdateConversationPreferenceCommandErrorCode =
  | "idempotency_conflict"
  | "idempotency_in_progress";

/** Stable command failure suitable for a future transport boundary. */
export class UpdateConversationPreferenceCommandError extends Error {
  public readonly statusCode = 409;

  public constructor(
    public readonly code: UpdateConversationPreferenceCommandErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "UpdateConversationPreferenceCommandError";
  }
}

export interface UpdateConversationPreferenceCommandOptions {
  readonly database: PostgresMigrationDatabase;
  /** Trusted host-session identity; caller input cannot override these values. */
  readonly actor: TrustedChatActorContext;
  /** Required for entity-bound thread parents; omitted adapters fail closed. */
  readonly permissions?: Pick<
    ChatPermissionAdapter<string, "conversation.preference.update">,
    "authorizeEntity"
  >;
  /** JSON-decoded caller input, validated by the shared mutation contract. */
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

interface AuthorizedConversationRow {
  readonly occurred_at: Date | string;
}

interface StoredPreferenceRow {
  readonly notification_level: string;
  readonly is_starred: boolean;
  readonly muted: boolean;
  readonly muted_until: Date | string | null;
  readonly preference_revision: string | number;
  readonly updated_at: Date | string;
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
      throw new TypeError("Conversation-preference input must contain finite numbers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") {
    throw new TypeError("Conversation-preference input must be JSON-compatible");
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
};

const hashRequest = (input: UpdateConversationPreferenceInput): string =>
  `sha256:${createHash("sha256")
    .update(
      canonicalJson({
        operation: input.operation,
        conversationId: input.conversationId,
        expectedPreferenceRevision: input.expectedPreferenceRevision,
        notificationPreference: input.notificationPreference,
        isStarred: input.isStarred,
        mute: input.mute,
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

const toPreferenceRevision = (value: string | number): number => {
  const revision = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error("PostgreSQL returned an invalid preference revision");
  }
  return revision;
};

const desiredState = (
  input: UpdateConversationPreferenceInput,
): ConversationPreferenceDesiredState => ({
  notificationPreference: input.notificationPreference,
  isStarred: input.isStarred,
  mute: input.mute,
});

const preferenceFromRow = (
  row: StoredPreferenceRow,
): CanonicalConversationPreferenceState => {
  if (
    row.notification_level !== "all" &&
    row.notification_level !== "mentions" &&
    row.notification_level !== "none"
  ) {
    throw new Error("PostgreSQL returned an invalid notification preference");
  }
  if (typeof row.is_starred !== "boolean") {
    throw new Error("PostgreSQL returned an invalid starred preference");
  }
  const mute = row.muted
    ? row.muted_until === null
      ? ({ muted: true } as const)
      : ({
          muted: true,
          mutedUntil: toIsoTimestamp(row.muted_until, "muted_until"),
        } as const)
    : ({ muted: false } as const);
  if (!row.muted && row.muted_until !== null) {
    throw new Error("PostgreSQL returned an invalid mute state");
  }
  return {
    notificationPreference: row.notification_level,
    isStarred: row.is_starred,
    mute,
    updatedAt: toIsoTimestamp(row.updated_at, "preference updated_at"),
  };
};

const muteEquals = (
  left: ConversationPreferenceDesiredState["mute"],
  right: ConversationPreferenceDesiredState["mute"],
): boolean => {
  if (left.muted !== right.muted) return false;
  if (!left.muted || !right.muted) return true;
  if (left.mutedUntil === undefined || right.mutedUntil === undefined) {
    return left.mutedUntil === right.mutedUntil;
  }
  return Date.parse(left.mutedUntil) === Date.parse(right.mutedUntil);
};

const preferenceEquals = (
  left: ConversationPreferenceDesiredState,
  right: ConversationPreferenceDesiredState,
): boolean =>
  left.notificationPreference === right.notificationPreference &&
  left.isStarred === right.isStarred &&
  muteEquals(left.mute, right.mute);

const replayStoredResult = (
  stored: unknown,
  input: UpdateConversationPreferenceInput,
): UpdateConversationPreferenceResult => {
  const canonical = parseUpdateConversationPreferenceResult(stored, input);
  if (canonical.reconciliationStatus !== "applied") return canonical;
  return parseUpdateConversationPreferenceResult(
    { ...canonical, reconciliationStatus: "replayed" },
    input,
  );
};

const persistOutcome = async (
  connection: PostgresMigrationConnection,
  prefix: string,
  options: UpdateConversationPreferenceCommandOptions,
  input: UpdateConversationPreferenceInput,
  requestHash: string,
  result: UpdateConversationPreferenceResult,
  completedAt: IsoTimestamp,
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
      completedAt,
      options.actor.tenantId,
      options.actor.userId,
      UPDATE_CONVERSATION_PREFERENCE_IDEMPOTENCY_OPERATION,
      input.idempotencyKey,
      requestHash,
    ],
  );
  if (completed.rowCount !== 1) {
    throw new UpdateConversationPreferenceCommandError(
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
 * Atomically updates an active member's (or eligible parent user's) preference and
 * durable side effects. No host notification capability is required or called.
 */
export async function updateConversationPreference(
  options: UpdateConversationPreferenceCommandOptions,
): Promise<UpdateConversationPreferenceResult> {
  validateActor(options.actor);
  const input = parseUpdateConversationPreferenceInput(options.input);
  const schema = validatePostgresSchema(
    options.schema ?? DEFAULT_POSTGRES_SCHEMA,
  );
  const prefix = quoteIdentifier(schema);
  const idempotencyTtlMs = positiveSafeInteger(
    options.idempotencyTtlMs ??
      DEFAULT_UPDATE_CONVERSATION_PREFERENCE_IDEMPOTENCY_TTL_MS,
    "idempotencyTtlMs",
  );
  const outboxRetentionMs = positiveSafeInteger(
    options.outboxRetentionMs ??
      DEFAULT_UPDATE_CONVERSATION_PREFERENCE_OUTBOX_RETENTION_MS,
    "outboxRetentionMs",
  );
  const createId = options.createId ?? randomUUID;
  const requestHash = hashRequest(input);
  const requestedPreference = desiredState(input);

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
        UPDATE_CONVERSATION_PREFERENCE_IDEMPOTENCY_OPERATION,
        input.idempotencyKey,
        requestHash,
        idempotencyTtlMs,
      ],
    );
    const claimed = claim.rows[0];
    if (claimed === undefined) {
      throw new UpdateConversationPreferenceCommandError(
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

    // Discover without locking the child first: all thread writes lock parent
    // before child. Revalidate the discovered relationship under those locks.
    const target = (await connection.query<{
      readonly type: string;
      readonly parent_conversation_id: string | null;
    }>(
      `SELECT type, parent_conversation_id FROM ${prefix}.chat_conversations
        WHERE tenant_id = $1 AND id = $2`,
      [options.actor.tenantId, input.conversationId],
    )).rows[0];
    const isThread = target?.type === "thread";
    const permissions = options.permissions ?? { authorizeEntity: async () => false };
    let conversation: AuthorizedConversationRow | undefined;
    if (isThread) {
      await connection.query(
        `SELECT id FROM ${prefix}.chat_conversations
          WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [options.actor.tenantId, target.parent_conversation_id],
      );
      conversation = (await connection.query<AuthorizedConversationRow>(
        `SELECT clock_timestamp() AS occurred_at FROM ${prefix}.chat_conversations
          WHERE tenant_id = $1 AND id = $2 AND type = 'thread'
            AND parent_conversation_id = $3 AND archived_at IS NULL FOR UPDATE`,
        [options.actor.tenantId, input.conversationId, target.parent_conversation_id],
      )).rows[0];
      if (conversation === undefined) throw new ChatAuthorizationError();
      await connection.query(
        `SELECT user_id FROM ${prefix}.chat_conversation_members
          WHERE tenant_id = $1 AND conversation_id = $2 AND user_id = $3 FOR UPDATE`,
        [options.actor.tenantId, target.parent_conversation_id, options.actor.userId],
      );
      await authorizeThreadAccess({
        database: connection, schema, actor: options.actor,
        threadId: input.conversationId, operation: "read",
        entityAction: UPDATE_CONVERSATION_PREFERENCE_AUDIT_ACTION, permissions,
      });
    } else {
      const authorized = await connection.query<AuthorizedConversationRow>(
        `SELECT clock_timestamp() AS occurred_at
         FROM ${prefix}.chat_conversations AS conversation
         INNER JOIN ${prefix}.chat_conversation_members AS member
           ON member.tenant_id = conversation.tenant_id
          AND member.conversation_id = conversation.id
          AND member.user_id = $3
          AND member.state = 'active'
        WHERE conversation.tenant_id = $1
          AND conversation.id = $2
          AND conversation.type <> 'thread'
        FOR UPDATE OF conversation, member`,
        [options.actor.tenantId, input.conversationId, options.actor.userId],
      );
      conversation = authorized.rows[0];
    }
    if (conversation === undefined) throw new ChatAuthorizationError();

    if (claimed.idempotency_state === "completed") {
      if (claimed.stored_response_body === null) {
        throw new Error(
          "Completed update-conversation-preference outcome has no response body",
        );
      }
      const replay = replayStoredResult(claimed.stored_response_body, input);
      await connection.query("COMMIT");
      return replay;
    }

    const occurredAt = toIsoTimestamp(
      conversation.occurred_at,
      "conversation-preference command timestamp",
    );
    const storedResult = await connection.query<StoredPreferenceRow>(
      `SELECT notification_level, is_starred, muted, muted_until,
              preference_revision, updated_at
         FROM ${prefix}.chat_conversation_preferences
        WHERE tenant_id = $1 AND conversation_id = $2 AND user_id = $3
        FOR UPDATE`,
      [options.actor.tenantId, input.conversationId, options.actor.userId],
    );
    const stored = storedResult.rows[0];
    const preferenceRevision =
      stored === undefined ? 0 : toPreferenceRevision(stored.preference_revision);
    const currentPreference =
      stored === undefined
        ? ({
            notificationPreference: "all",
            isStarred: false,
            mute: { muted: false },
            updatedAt: occurredAt,
          } as const)
        : preferenceFromRow(stored);

    if (preferenceRevision !== input.expectedPreferenceRevision) {
      const result = parseUpdateConversationPreferenceResult(
        {
          operation: input.operation,
          reconciliationStatus: "preference_revision_conflict",
          conversationId: input.conversationId,
          expectedPreferenceRevision: input.expectedPreferenceRevision,
          idempotencyKey: input.idempotencyKey,
          requestedPreference,
          preferenceRevision,
          preference: currentPreference,
        },
        input,
      );
      await persistOutcome(
        connection,
        prefix,
        options,
        input,
        requestHash,
        result,
        occurredAt,
      );
      await connection.query("COMMIT");
      return result;
    }

    if (stored !== undefined && preferenceEquals(requestedPreference, currentPreference)) {
      const result = parseUpdateConversationPreferenceResult(
        {
          operation: input.operation,
          reconciliationStatus: "already_requested_state",
          conversationId: input.conversationId,
          expectedPreferenceRevision: input.expectedPreferenceRevision,
          idempotencyKey: input.idempotencyKey,
          requestedPreference,
          preferenceRevision,
          preference: {
            ...requestedPreference,
            updatedAt: currentPreference.updatedAt,
          },
        },
        input,
      );
      await persistOutcome(
        connection,
        prefix,
        options,
        input,
        requestHash,
        result,
        occurredAt,
      );
      await connection.query("COMMIT");
      return result;
    }

    const nextPreferenceRevision = preferenceRevision + 1;
    if (!Number.isSafeInteger(nextPreferenceRevision)) {
      throw new Error("Preference revision cannot be advanced safely");
    }
    const mutedUntil = input.mute.muted
      ? (input.mute.mutedUntil ?? null)
      : null;
    if (isThread) {
      // Reconciliation used the original row (or revision zero), before the
      // helper seeds defaults. No-op, stale and replay paths do no setup.
      await ensureThreadParticipant({
        connection, schema, actor: options.actor, threadId: input.conversationId,
        parentConversationId: target.parent_conversation_id!,
        entityAction: UPDATE_CONVERSATION_PREFERENCE_AUDIT_ACTION, permissions,
        occurredAt, initialRole: "member",
      });
    }
    if (stored === undefined && !isThread) {
      await connection.query(
        `INSERT INTO ${prefix}.chat_conversation_preferences (
           tenant_id, conversation_id, user_id, notification_level,
           is_starred, muted, muted_until, preference_revision, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
        [
          options.actor.tenantId,
          input.conversationId,
          options.actor.userId,
          input.notificationPreference,
          input.isStarred,
          input.mute.muted,
          mutedUntil,
          nextPreferenceRevision,
          occurredAt,
        ],
      );
    } else {
      const updated = await connection.query(
        `UPDATE ${prefix}.chat_conversation_preferences
            SET notification_level = $1, is_starred = $2,
                muted = $3, muted_until = $4,
                preference_revision = $5, updated_at = $6
          WHERE tenant_id = $7 AND conversation_id = $8 AND user_id = $9
            AND preference_revision = $10`,
        [
          input.notificationPreference,
          input.isStarred,
          input.mute.muted,
          mutedUntil,
          nextPreferenceRevision,
          occurredAt,
          options.actor.tenantId,
          input.conversationId,
          options.actor.userId,
          stored === undefined ? 1 : preferenceRevision,
        ],
      );
      if (updated.rowCount !== 1) throw new ChatAuthorizationError();
    }

    const preference: CanonicalConversationPreferenceState = {
      ...requestedPreference,
      updatedAt: occurredAt,
    };
    const result = parseUpdateConversationPreferenceResult(
      {
        operation: input.operation,
        reconciliationStatus: "applied",
        conversationId: input.conversationId,
        expectedPreferenceRevision: input.expectedPreferenceRevision,
        idempotencyKey: input.idempotencyKey,
        requestedPreference,
        preferenceRevision: nextPreferenceRevision,
        preference,
      },
      input,
    );
    const metadata = {
      notificationPreference: input.notificationPreference,
      isStarred: input.isStarred,
      muted: input.mute.muted,
      finiteMute: input.mute.muted && input.mute.mutedUntil !== undefined,
      previousPreferenceRevision: preferenceRevision,
      currentPreferenceRevision: nextPreferenceRevision,
    };

    const auditEventId = createId();
    await connection.query(
      `INSERT INTO ${prefix}.chat_audit_events (
         tenant_id, event_id, actor_user_id, action, target_type, target_id,
         occurred_at, metadata, request_id
       ) VALUES ($1, $2, $3, $4, 'conversation', $5, $6, $7, $8)`,
      [
        options.actor.tenantId,
        auditEventId,
        options.actor.userId,
        UPDATE_CONVERSATION_PREFERENCE_AUDIT_ACTION,
        input.conversationId,
        occurredAt,
        metadata,
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
        `user:${options.actor.userId}`,
        UPDATE_CONVERSATION_PREFERENCE_OUTBOX_EVENT_TYPE,
        occurredAt,
        { actorUserId: options.actor.userId, input, result },
        outboxRetentionMs,
      ],
    );

    await persistOutcome(
      connection,
      prefix,
      options,
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
