import { createHash, randomUUID } from "node:crypto";

import type { IsoTimestamp } from "../contracts/identifiers.js";
import { CHAT_PROTOCOL_VERSION } from "../contracts/realtime.js";
import {
  parseSetThreadFollowInput,
  parseSetThreadFollowResult,
  type CanonicalThreadFollowState,
  type SetThreadFollowInput,
  type SetThreadFollowResult,
  type ThreadFollowSource,
} from "../contracts/thread-follow-mutation.js";
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
import { ensureThreadParticipant } from "./thread-participant.js";

export const SET_THREAD_FOLLOW_ENTITY_POLICY_ACTION =
  "thread.follow.set" as const;
export const SET_THREAD_FOLLOW_IDEMPOTENCY_OPERATION =
  "thread.follow.set" as const;
export const SET_THREAD_FOLLOW_AUDIT_ACTION = "thread.follow.set" as const;
export const SET_THREAD_FOLLOW_OUTBOX_EVENT_TYPE =
  "thread.follow.updated" as const;
export const DEFAULT_SET_THREAD_FOLLOW_IDEMPOTENCY_TTL_MS =
  24 * 60 * 60 * 1_000;
export const DEFAULT_SET_THREAD_FOLLOW_OUTBOX_RETENTION_MS =
  7 * 24 * 60 * 60 * 1_000;

export type SetThreadFollowCommandErrorCode =
  | "idempotency_conflict"
  | "idempotency_in_progress";

/** Stable command failure suitable for a future transport boundary. */
export class SetThreadFollowCommandError extends Error {
  public readonly statusCode = 409;

  public constructor(
    public readonly code: SetThreadFollowCommandErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SetThreadFollowCommandError";
  }
}

export interface SetThreadFollowCommandOptions {
  readonly database: PostgresMigrationDatabase;
  readonly permissions: Pick<
    ChatPermissionAdapter<string, typeof SET_THREAD_FOLLOW_ENTITY_POLICY_ACTION>,
    "authorizeEntity"
  >;
  /** Trusted host-session identity; caller input cannot override these values. */
  readonly actor: TrustedChatActorContext;
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

interface EligibleThreadRow {
  readonly entity_type: string | null;
  readonly entity_id: string | null;
  readonly occurred_at: Date | string;
}

interface StoredFollowRow {
  readonly is_following: boolean;
  readonly follow_source: string;
  readonly follow_revision: string | number;
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
      throw new TypeError("Thread-follow input must contain finite numbers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") {
    throw new TypeError("Thread-follow input must be JSON-compatible");
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
};

const hashRequest = (input: SetThreadFollowInput): string =>
  `sha256:${createHash("sha256")
    .update(
      canonicalJson({
        operation: input.operation,
        intent: input.intent,
        target: input.target,
        expectedFollowRevision: input.expectedFollowRevision,
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

const toFollowRevision = (value: string | number): number => {
  const revision = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error("PostgreSQL returned an invalid thread-follow revision");
  }
  return revision;
};

const toFollowSource = (value: string): ThreadFollowSource => {
  if (value !== "manual" && value !== "reply" && value !== "mention") {
    throw new Error("PostgreSQL returned an invalid thread-follow source");
  }
  return value;
};

const stateFromRow = (
  input: SetThreadFollowInput,
  row: StoredFollowRow,
): CanonicalThreadFollowState => {
  const source = toFollowSource(row.follow_source);
  const updatedAt = toIsoTimestamp(row.updated_at, "thread-follow timestamp");
  if (!row.is_following && source !== "manual") {
    throw new Error("PostgreSQL returned an invalid explicit unfollow state");
  }
  return row.is_following
    ? { target: input.target, isFollowing: true, source, updatedAt }
    : { target: input.target, isFollowing: false, source: "manual", updatedAt };
};

const replayStoredResult = (
  stored: unknown,
  input: SetThreadFollowInput,
): SetThreadFollowResult => {
  const canonical = parseSetThreadFollowResult(stored, input);
  if (canonical.reconciliationStatus !== "applied") return canonical;
  return parseSetThreadFollowResult(
    { ...canonical, reconciliationStatus: "replayed" },
    input,
  );
};

const persistOutcome = async (
  connection: PostgresMigrationConnection,
  prefix: string,
  actor: TrustedChatActorContext,
  input: SetThreadFollowInput,
  requestHash: string,
  result: SetThreadFollowResult,
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
      actor.tenantId,
      actor.userId,
      SET_THREAD_FOLLOW_IDEMPOTENCY_OPERATION,
      input.idempotencyKey,
      requestHash,
    ],
  );
  if (completed.rowCount !== 1) {
    throw new SetThreadFollowCommandError(
      "idempotency_in_progress",
      "The idempotent request is already in progress",
    );
  }
};

const authorizeParentEntity = async (
  row: EligibleThreadRow,
  options: SetThreadFollowCommandOptions,
): Promise<void> => {
  if (row.entity_type === null && row.entity_id === null) return;
  if (row.entity_type === null || row.entity_id === null) {
    throw new ChatAuthorizationError();
  }
  try {
    const allowed = await options.permissions.authorizeEntity({
      actor: options.actor,
      entity: { type: row.entity_type, id: row.entity_id },
      action: SET_THREAD_FOLLOW_ENTITY_POLICY_ACTION,
    });
    if (!allowed) throw new Error("denied");
  } catch {
    throw new ChatAuthorizationError();
  }
};

const rollback = async (
  connection: PostgresMigrationConnection,
): Promise<void> => {
  await connection.query("ROLLBACK").catch(() => undefined);
};

/** Atomically applies explicit manual follow intent to one eligible thread. */
export async function setThreadFollow(
  options: SetThreadFollowCommandOptions,
): Promise<SetThreadFollowResult> {
  validateActor(options.actor);
  const input = parseSetThreadFollowInput(options.input);
  const schema = validatePostgresSchema(
    options.schema ?? DEFAULT_POSTGRES_SCHEMA,
  );
  const prefix = quoteIdentifier(schema);
  const idempotencyTtlMs = positiveSafeInteger(
    options.idempotencyTtlMs ?? DEFAULT_SET_THREAD_FOLLOW_IDEMPOTENCY_TTL_MS,
    "idempotencyTtlMs",
  );
  const outboxRetentionMs = positiveSafeInteger(
    options.outboxRetentionMs ?? DEFAULT_SET_THREAD_FOLLOW_OUTBOX_RETENTION_MS,
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
        SET_THREAD_FOLLOW_IDEMPOTENCY_OPERATION,
        input.idempotencyKey,
        requestHash,
        idempotencyTtlMs,
      ],
    );
    const claimed = claim.rows[0];
    if (claimed === undefined) {
      throw new SetThreadFollowCommandError(
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

    // Resolve the parent from storage and lock in retained-setup order. A joined
    // FOR UPDATE does not guarantee parent-before-child acquisition. Lock the
    // parent membership before eligibility too, including on unfollow/replay.
    const parentResult = await connection.query<{ id: string }>(
      `SELECT parent.id FROM ${prefix}.chat_conversations AS parent
        WHERE parent.tenant_id = $1 AND parent.id = (
          SELECT parent_conversation_id FROM ${prefix}.chat_conversations
           WHERE tenant_id = $1 AND id = $2 AND type = 'thread'
        ) FOR UPDATE`,
      [options.actor.tenantId, input.target.id],
    );
    const parent = parentResult.rows[0];
    if (parent === undefined) throw new ChatAuthorizationError();
    const child = await connection.query(
      `SELECT id FROM ${prefix}.chat_conversations
        WHERE tenant_id = $1 AND id = $2 AND type = 'thread'
          AND parent_conversation_id = $3 FOR UPDATE`,
      [options.actor.tenantId, input.target.id, parent.id],
    );
    if (child.rows.length !== 1) throw new ChatAuthorizationError();
    await connection.query(
      `SELECT user_id FROM ${prefix}.chat_conversation_members
        WHERE tenant_id = $1 AND conversation_id = $2 AND user_id = $3 FOR UPDATE`,
      [options.actor.tenantId, parent.id, options.actor.userId],
    );

    const eligible = await connection.query<EligibleThreadRow>(
      `SELECT parent.entity_type, parent.entity_id,
              clock_timestamp() AS occurred_at
         FROM ${prefix}.chat_conversations AS thread
         INNER JOIN ${prefix}.chat_conversations AS parent
           ON parent.tenant_id = thread.tenant_id
          AND parent.id = thread.parent_conversation_id
         LEFT JOIN ${prefix}.chat_conversation_members AS parent_member
           ON parent_member.tenant_id = parent.tenant_id
          AND parent_member.conversation_id = parent.id
          AND parent_member.user_id = $3
        WHERE thread.tenant_id = $1
          AND thread.id = $2
          AND thread.type = 'thread'
          AND thread.archived_at IS NULL
          AND parent.type <> 'thread'
          AND parent.archived_at IS NULL
          AND (
            (parent.type = 'channel' AND parent.visibility = 'public')
            OR parent_member.state = 'active'
          )`,
      [options.actor.tenantId, input.target.id, options.actor.userId],
    );
    const thread = eligible.rows[0];
    if (thread === undefined) throw new ChatAuthorizationError();
    await authorizeParentEntity(thread, options);

    if (claimed.idempotency_state === "completed") {
      // Replay the authorized stored outcome without reapplying participation:
      // a later unfollow or membership change must not be undone by an old key.
      if (claimed.stored_response_body === null) {
        throw new Error("Completed set-thread-follow outcome has no response body");
      }
      const replay = replayStoredResult(claimed.stored_response_body, input);
      await connection.query("COMMIT");
      return replay;
    }

    const occurredAt = toIsoTimestamp(
      thread.occurred_at,
      "thread-follow command timestamp",
    );
    const storedResult = await connection.query<StoredFollowRow>(
      `SELECT is_following, follow_source, follow_revision, updated_at
         FROM ${prefix}.chat_thread_follows
        WHERE tenant_id = $1 AND conversation_id = $2 AND user_id = $3
        FOR UPDATE`,
      [options.actor.tenantId, input.target.id, options.actor.userId],
    );
    const stored = storedResult.rows[0];
    const followRevision =
      stored === undefined ? 0 : toFollowRevision(stored.follow_revision);
    const requestedFollowing = input.intent === "follow";

    if (followRevision !== input.expectedFollowRevision) {
      const follow =
        stored === undefined
          ? {
              target: input.target,
              isFollowing: false as const,
              source: "manual" as const,
              updatedAt: occurredAt,
            }
          : stateFromRow(input, stored);
      const result = parseSetThreadFollowResult(
        {
          operation: input.operation,
          intent: input.intent,
          reconciliationStatus: "follow_revision_conflict",
          target: input.target,
          expectedFollowRevision: input.expectedFollowRevision,
          idempotencyKey: input.idempotencyKey,
          followRevision,
          follow,
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

    // Conflicts never grant participation. A fresh, matching follow also repairs
    // legacy already-following rows, without advancing their follow revision.
    if (requestedFollowing) {
      await ensureThreadParticipant({
        connection,
        schema,
        actor: options.actor,
        threadId: input.target.id,
        parentConversationId: parent.id,
        entityAction: SET_THREAD_FOLLOW_ENTITY_POLICY_ACTION,
        permissions: options.permissions,
        occurredAt,
        initialRole: "member",
      });
    }

    const alreadyRequested =
      stored !== undefined &&
      stored.is_following === requestedFollowing &&
      stored.follow_source === "manual";
    if (alreadyRequested) {
      const result = parseSetThreadFollowResult(
        {
          operation: input.operation,
          intent: input.intent,
          reconciliationStatus: "already_requested_state",
          target: input.target,
          expectedFollowRevision: input.expectedFollowRevision,
          idempotencyKey: input.idempotencyKey,
          followRevision,
          follow: stateFromRow(input, stored),
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

    const nextFollowRevision = followRevision + 1;
    if (!Number.isSafeInteger(nextFollowRevision)) {
      throw new Error("Thread-follow revision cannot be advanced safely");
    }
    if (stored === undefined) {
      await connection.query(
        `INSERT INTO ${prefix}.chat_thread_follows (
           tenant_id, conversation_id, user_id, is_following, follow_source,
           follow_revision, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, 'manual', $5, $6, $6)`,
        [
          options.actor.tenantId,
          input.target.id,
          options.actor.userId,
          requestedFollowing,
          nextFollowRevision,
          occurredAt,
        ],
      );
    } else {
      const updated = await connection.query(
        `UPDATE ${prefix}.chat_thread_follows
            SET is_following = $1, follow_source = 'manual',
                follow_revision = $2, updated_at = $3
          WHERE tenant_id = $4 AND conversation_id = $5 AND user_id = $6
            AND follow_revision = $7`,
        [
          requestedFollowing,
          nextFollowRevision,
          occurredAt,
          options.actor.tenantId,
          input.target.id,
          options.actor.userId,
          followRevision,
        ],
      );
      if (updated.rowCount !== 1) throw new ChatAuthorizationError();
    }

    const follow: CanonicalThreadFollowState = requestedFollowing
      ? {
          target: input.target,
          isFollowing: true,
          source: "manual",
          updatedAt: occurredAt,
        }
      : {
          target: input.target,
          isFollowing: false,
          source: "manual",
          updatedAt: occurredAt,
        };
    const result = parseSetThreadFollowResult(
      {
        operation: input.operation,
        intent: input.intent,
        reconciliationStatus: "applied",
        target: input.target,
        expectedFollowRevision: input.expectedFollowRevision,
        idempotencyKey: input.idempotencyKey,
        followRevision: nextFollowRevision,
        follow,
      },
      input,
    );
    const metadata = {
      threadId: input.target.id,
      intent: input.intent,
      previousFollowing: stored?.is_following ?? null,
      currentFollowing: requestedFollowing,
      previousFollowRevision: followRevision,
      currentFollowRevision: nextFollowRevision,
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
        SET_THREAD_FOLLOW_AUDIT_ACTION,
        input.target.id,
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
        SET_THREAD_FOLLOW_OUTBOX_EVENT_TYPE,
        occurredAt,
        {
          operation: input.operation,
          target: input.target,
          followRevision: nextFollowRevision,
          follow,
        },
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
