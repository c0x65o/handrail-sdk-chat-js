import { createHash, randomUUID } from "node:crypto";

import {
  parseUpdateReplyStylePreferenceInput,
  parseUpdateReplyStylePreferenceResult,
  parseReplyStylePreferenceState,
  type ReplyStylePreferenceState,
  type UpdateReplyStylePreferenceInput,
  type UpdateReplyStylePreferenceResult,
} from "../contracts/reply-style-preference.js";
import type { IsoTimestamp } from "../contracts/identifiers.js";
import { CHAT_PROTOCOL_VERSION } from "../contracts/realtime.js";
import type { TrustedChatActorContext } from "./contracts.js";
import {
  DEFAULT_POSTGRES_SCHEMA,
  validatePostgresSchema,
  type PostgresMigrationConnection,
  type PostgresMigrationDatabase,
} from "./postgres-migrations.js";

export const UPDATE_REPLY_STYLE_PREFERENCE_IDEMPOTENCY_OPERATION =
  "reply.style.update" as const;
export const UPDATE_REPLY_STYLE_PREFERENCE_AUDIT_ACTION =
  "reply.style.update" as const;
export const UPDATE_REPLY_STYLE_PREFERENCE_OUTBOX_EVENT_TYPE =
  "reply.style.updated" as const;
export const DEFAULT_UPDATE_REPLY_STYLE_PREFERENCE_IDEMPOTENCY_TTL_MS =
  24 * 60 * 60 * 1_000;
export const DEFAULT_UPDATE_REPLY_STYLE_PREFERENCE_OUTBOX_RETENTION_MS =
  7 * 24 * 60 * 60 * 1_000;

export type UpdateReplyStylePreferenceCommandErrorCode =
  | "idempotency_conflict"
  | "idempotency_in_progress";

/** Stable command failure suitable for a future transport boundary. */
export class UpdateReplyStylePreferenceCommandError extends Error {
  public readonly statusCode = 409;

  public constructor(
    public readonly code: UpdateReplyStylePreferenceCommandErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "UpdateReplyStylePreferenceCommandError";
  }
}

export interface UpdateReplyStylePreferenceCommandOptions {
  readonly database: PostgresMigrationDatabase;
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
      throw new TypeError("Reply-style preference input must contain finite numbers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") {
    throw new TypeError("Reply-style preference input must be JSON-compatible");
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
};

const hashRequest = (input: UpdateReplyStylePreferenceInput): string =>
  `sha256:${createHash("sha256")
    .update(
      canonicalJson({
        operation: input.operation,
        style: input.style,
        baseRevision: input.baseRevision,
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

const replayStoredResult = (
  stored: unknown,
  input: UpdateReplyStylePreferenceInput,
): UpdateReplyStylePreferenceResult => {
  const canonical = parseUpdateReplyStylePreferenceResult(stored, input);
  if (canonical.reconciliationStatus !== "applied") return canonical;
  return parseUpdateReplyStylePreferenceResult(
    { ...canonical, reconciliationStatus: "replayed" },
    input,
  );
};

const persistOutcome = async (
  connection: PostgresMigrationConnection,
  prefix: string,
  options: UpdateReplyStylePreferenceCommandOptions,
  input: UpdateReplyStylePreferenceInput,
  requestHash: string,
  result: UpdateReplyStylePreferenceResult,
  completedAt: IsoTimestamp,
): Promise<void> => {
  const completed = await connection.query(
    `UPDATE ${prefix}.chat_idempotency_keys
        SET state = 'completed', response_status = $8, response_body = $1,
            completed_at = GREATEST($2::timestamptz, created_at),
            updated_at = GREATEST($2::timestamptz, created_at)
      WHERE tenant_id = $3 AND user_id = $4 AND operation_name = $5
        AND client_key = $6 AND request_hash = $7 AND state = 'pending'`,
    [
      result,
      completedAt,
      options.actor.tenantId,
      options.actor.userId,
      UPDATE_REPLY_STYLE_PREFERENCE_IDEMPOTENCY_OPERATION,
      input.idempotencyKey,
      requestHash,
      result.reconciliationStatus === "preference_revision_conflict" ? 409 : 200,
    ],
  );
  if (completed.rowCount !== 1) {
    throw new UpdateReplyStylePreferenceCommandError(
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

interface StoredPreferenceRow {
  readonly style: string;
  readonly revision: string | number;
  readonly updated_at: Date | string;
}

const preferenceFromRow = (row: StoredPreferenceRow): ReplyStylePreferenceState =>
  parseReplyStylePreferenceState({
    state: "saved",
    revision: Number(row.revision),
    style: row.style,
  });

/** Saves only the trusted actor's private presentation preference and its durable effects. */
export async function updateReplyStylePreference(
  options: UpdateReplyStylePreferenceCommandOptions,
): Promise<UpdateReplyStylePreferenceResult> {
  validateActor(options.actor);
  const input = parseUpdateReplyStylePreferenceInput(options.input);
  const schema = validatePostgresSchema(options.schema ?? DEFAULT_POSTGRES_SCHEMA);
  const prefix = quoteIdentifier(schema);
  const idempotencyTtlMs = positiveSafeInteger(
    options.idempotencyTtlMs ?? DEFAULT_UPDATE_REPLY_STYLE_PREFERENCE_IDEMPOTENCY_TTL_MS,
    "idempotencyTtlMs",
  );
  const outboxRetentionMs = positiveSafeInteger(
    options.outboxRetentionMs ?? DEFAULT_UPDATE_REPLY_STYLE_PREFERENCE_OUTBOX_RETENTION_MS,
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
      [options.actor.tenantId, options.actor.userId,
        UPDATE_REPLY_STYLE_PREFERENCE_IDEMPOTENCY_OPERATION,
        input.idempotencyKey, requestHash, idempotencyTtlMs],
    );
    const claimed = claim.rows[0];
    if (claimed === undefined) {
      throw new UpdateReplyStylePreferenceCommandError(
        "idempotency_conflict", "The idempotency key was already used for a different request",
      );
    }
    if (claimed.idempotency_state === "completed") {
      if (claimed.stored_response_body === null) {
        throw new Error("Completed update-reply-style-preference outcome has no response body");
      }
      const replay = replayStoredResult(claimed.stored_response_body, input);
      await connection.query("COMMIT");
      return replay;
    }
    if (claimed.idempotency_state !== "pending") {
      throw new Error("PostgreSQL returned an invalid idempotency state");
    }

    // A row lock cannot protect absence. Serialize all keys for this private
    // preference before reading it; never insert a default row just to lock it.
    // Namespacing and JSON tuple encoding avoid ambiguous identity boundaries.
    await connection.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      JSON.stringify([schema, "reply.style.preference", options.actor.tenantId, options.actor.userId]),
    ]);
    const stored = (await connection.query<StoredPreferenceRow>(
      `SELECT style, revision, updated_at FROM ${prefix}.chat_user_reply_style_preferences
        WHERE tenant_id = $1 AND user_id = $2 FOR UPDATE`,
      [options.actor.tenantId, options.actor.userId],
    )).rows[0];
    const current: ReplyStylePreferenceState = stored === undefined
      ? { state: "absent", revision: 0 } : preferenceFromRow(stored);
    const clock = (await connection.query<{ occurred_at: Date | string }>(
      "SELECT clock_timestamp() AS occurred_at",
    )).rows[0];
    if (clock === undefined) throw new Error("PostgreSQL returned no command timestamp");
    const occurredAt = toIsoTimestamp(clock.occurred_at, "reply-style preference timestamp");
    const resultBase = {
      operation: input.operation, baseRevision: input.baseRevision,
      idempotencyKey: input.idempotencyKey, requestedStyle: input.style,
    };

    // Revision comparison must precede equality, even for a matching style.
    if (current.revision !== input.baseRevision ||
        (current.state === "saved" && current.style === input.style)) {
      const result = parseUpdateReplyStylePreferenceResult({
        ...resultBase,
        reconciliationStatus: current.revision !== input.baseRevision
          ? "preference_revision_conflict" : "already_requested_state",
        preference: current,
      }, input);
      await persistOutcome(connection, prefix, options, input, requestHash, result, occurredAt);
      await connection.query("COMMIT");
      return result;
    }

    const nextRevision = current.revision + 1;
    const saved = (await connection.query<StoredPreferenceRow>(
      `INSERT INTO ${prefix}.chat_user_reply_style_preferences
         (tenant_id, user_id, style, revision, updated_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, user_id) DO UPDATE
         SET style = EXCLUDED.style, revision = EXCLUDED.revision, updated_at = EXCLUDED.updated_at
       WHERE chat_user_reply_style_preferences.revision = $6
       RETURNING style, revision, updated_at`,
      [options.actor.tenantId, options.actor.userId, input.style, nextRevision, occurredAt, current.revision],
    )).rows[0];
    if (saved === undefined) throw new Error("Reply-style preference changed outside command serialization");
    const updatedAt = toIsoTimestamp(saved.updated_at, "preference updated_at");
    const result = parseUpdateReplyStylePreferenceResult({
      ...resultBase, reconciliationStatus: "applied", preference: preferenceFromRow(saved),
    }, input);
    const auditEventId = createId();
    await connection.query(
      `INSERT INTO ${prefix}.chat_audit_events (
         tenant_id, event_id, actor_user_id, action, target_type, target_id,
         occurred_at, metadata, request_id
       ) VALUES ($1, $2, $3, $4, 'user', $3, $5, $6, $7)`,
      [options.actor.tenantId, auditEventId, options.actor.userId,
        UPDATE_REPLY_STYLE_PREFERENCE_AUDIT_ACTION, updatedAt,
        { style: input.style, previousPreferenceRevision: current.revision,
          currentPreferenceRevision: nextRevision }, options.requestId ?? auditEventId],
    );
    await connection.query(
      `INSERT INTO ${prefix}.chat_outbox_events (
         event_id, protocol_version, tenant_id, stream_id, type,
         occurred_at, payload, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7,
         $6::timestamptz + ($8::double precision * interval '1 millisecond'))`,
      [createId(), CHAT_PROTOCOL_VERSION, options.actor.tenantId,
        `user:${options.actor.userId}`, UPDATE_REPLY_STYLE_PREFERENCE_OUTBOX_EVENT_TYPE,
        updatedAt, { actorUserId: options.actor.userId, preference: result.preference,
          updatedAt, mutation: input }, outboxRetentionMs],
    );
    await persistOutcome(connection, prefix, options, input, requestHash, result, updatedAt);
    await connection.query("COMMIT");
    return result;
  } catch (error) {
    await rollback(connection);
    throw error;
  } finally {
    connection.release();
  }
}
