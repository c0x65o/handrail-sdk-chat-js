import { createHash, randomUUID } from "node:crypto";

import {
  DevicePushTokenContractError,
  parseDevicePushTokenInput,
  parseDevicePushTokenResult,
  type CanonicalDevicePushTokenState,
  type DevicePushTokenInput,
  type DevicePushTokenResult,
} from "../contracts/device-push-token.js";
import type { IsoTimestamp } from "../contracts/identifiers.js";
import { CHAT_PROTOCOL_VERSION } from "../contracts/realtime.js";
import {
  MAX_CHAT_PUSH_TOKEN_CIPHERTEXT_UTF8_BYTES,
  MAX_CHAT_PUSH_TOKEN_KEY_ID_UTF8_BYTES,
  type ChatProtectedPushToken,
  type ChatPushTokenProtector,
  type TrustedChatActorContext,
} from "./contracts.js";
import {
  DEFAULT_POSTGRES_SCHEMA,
  validatePostgresSchema,
  type PostgresMigrationConnection,
  type PostgresMigrationDatabase,
} from "./postgres-migrations.js";

export const DEVICE_PUSH_TOKEN_IDEMPOTENCY_OPERATION =
  "device.push_token.update" as const;
export const DEVICE_PUSH_TOKEN_AUDIT_ACTION =
  "device.push_token.update" as const;
export const DEVICE_PUSH_TOKEN_OUTBOX_EVENT_TYPE =
  "device.push_token.updated" as const;
export const DEFAULT_DEVICE_PUSH_TOKEN_IDEMPOTENCY_TTL_MS =
  24 * 60 * 60 * 1_000;
export const DEFAULT_DEVICE_PUSH_TOKEN_OUTBOX_RETENTION_MS =
  7 * 24 * 60 * 60 * 1_000;

export type DevicePushTokenCommandErrorCode =
  | "idempotency_conflict"
  | "idempotency_in_progress"
  | "token_protection_failed"
  | "registration_state_conflict"
  | "stale_revision";

/** Stable token-free command failure suitable for the HTTP boundary. */
export class DevicePushTokenCommandError extends Error {
  public readonly statusCode: number;

  public constructor(
    public readonly code: DevicePushTokenCommandErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DevicePushTokenCommandError";
    this.statusCode = code === "token_protection_failed" ? 503 : 409;
  }
}

export interface DevicePushTokenCommandOptions {
  readonly database: PostgresMigrationDatabase;
  readonly pushTokenProtector: ChatPushTokenProtector;
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

interface StoredDevicePushTokenRow {
  readonly platform: string;
  readonly provider: string;
  readonly environment: string;
  readonly token_revision: string | number;
  readonly updated_at: Date | string;
  readonly revoked_at: Date | string | null;
}

interface DevicePushTokenHistoryRow {
  readonly current_revision: string | number | null;
  readonly active_token_revision: string | number | null;
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

const validUtf8EnvelopeValue = (
  value: unknown,
  maximumBytes: number,
): value is string =>
  nonEmptyString(value) && Buffer.byteLength(value, "utf8") <= maximumBytes;

const protectToken = async (
  options: DevicePushTokenCommandOptions,
  input: Exclude<DevicePushTokenInput, { readonly operation: "unregister" }>,
): Promise<ChatProtectedPushToken> => {
  try {
    if (typeof options.pushTokenProtector?.protect !== "function") {
      throw new Error("invalid protector");
    }
    const protectedToken = await options.pushTokenProtector.protect({
      token: input.token,
      tenantId: options.actor.tenantId,
      userId: options.actor.userId,
      deviceId: input.deviceId,
    });
    const ciphertext = protectedToken?.ciphertext;
    const keyId = protectedToken?.keyId;
    if (
      typeof protectedToken !== "object" ||
      protectedToken === null ||
      !validUtf8EnvelopeValue(
        ciphertext,
        MAX_CHAT_PUSH_TOKEN_CIPHERTEXT_UTF8_BYTES,
      ) ||
      !validUtf8EnvelopeValue(
        keyId,
        MAX_CHAT_PUSH_TOKEN_KEY_ID_UTF8_BYTES,
      )
    ) {
      throw new Error("invalid protected token");
    }
    return {
      ciphertext,
      keyId,
    };
  } catch {
    throw new DevicePushTokenCommandError(
      "token_protection_failed",
      "Device push-token protection is temporarily unavailable",
    );
  }
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

const hashRequest = (input: DevicePushTokenInput): string =>
  `sha256:${createHash("sha256")
    .update(
      JSON.stringify(
        input.operation === "unregister"
          ? {
              operation: input.operation,
              intent: input.intent,
              deviceId: input.deviceId,
              tokenRevision: input.tokenRevision,
            }
          : {
              operation: input.operation,
              deviceId: input.deviceId,
              platform: input.platform,
              provider: input.provider,
              environment: input.environment,
              token: input.token,
              tokenRevision: input.tokenRevision,
            },
      ),
    )
    .digest("hex")}`;

const toIsoTimestamp = (value: Date | string, label: string): IsoTimestamp => {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.valueOf())) {
    throw new Error(`PostgreSQL returned an invalid ${label}`);
  }
  return date.toISOString() as IsoTimestamp;
};

const toRevision = (
  value: string | number | null,
  label: string,
): number | undefined => {
  if (value === null) return undefined;
  const revision = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error(`PostgreSQL returned an invalid ${label}`);
  }
  return revision;
};

const canonicalStateFromRow = (
  input: DevicePushTokenInput,
  row: StoredDevicePushTokenRow,
): CanonicalDevicePushTokenState => {
  if (row.platform !== "ios" && row.platform !== "android") {
    throw new Error("PostgreSQL returned an invalid device platform");
  }
  if (row.provider !== "apns" && row.provider !== "fcm") {
    throw new Error("PostgreSQL returned an invalid push provider");
  }
  if (row.environment !== "sandbox" && row.environment !== "production") {
    throw new Error("PostgreSQL returned an invalid push environment");
  }
  const tokenRevision = toRevision(row.token_revision, "token revision");
  if (tokenRevision === undefined) {
    throw new Error("PostgreSQL returned a missing token revision");
  }
  return {
    deviceId: input.deviceId,
    status: row.revoked_at === null ? "active" : "unregistered",
    platform: row.platform,
    provider: row.provider,
    environment: row.environment,
    tokenRevision,
    updatedAt: toIsoTimestamp(row.updated_at, "device push-token timestamp"),
  };
};

const replayStoredResult = (
  stored: unknown,
  input: DevicePushTokenInput,
): DevicePushTokenResult => {
  const canonical = parseDevicePushTokenResult(stored, input);
  if (canonical.reconciliationStatus === "replayed") return canonical;
  return parseDevicePushTokenResult(
    { ...canonical, reconciliationStatus: "replayed" },
    input,
  );
};

const completeIdempotency = async (
  connection: PostgresMigrationConnection,
  prefix: string,
  options: DevicePushTokenCommandOptions,
  input: DevicePushTokenInput,
  requestHash: string,
  result: DevicePushTokenResult,
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
      result.devicePushToken.updatedAt,
      options.actor.tenantId,
      options.actor.userId,
      DEVICE_PUSH_TOKEN_IDEMPOTENCY_OPERATION,
      input.idempotencyKey,
      requestHash,
    ],
  );
  if (completed.rowCount !== 1) {
    throw new DevicePushTokenCommandError(
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

const assertMonotonicRevision = (
  input: DevicePushTokenInput,
  currentRevision: number | undefined,
): void => {
  try {
    parseDevicePushTokenInput(
      input,
      currentRevision === undefined ? {} : { currentTokenRevision: currentRevision },
    );
  } catch (error) {
    if (
      error instanceof DevicePushTokenContractError &&
      error.code === "revision_not_monotonic"
    ) {
      throw new DevicePushTokenCommandError(
        "stale_revision",
        "The device push-token revision is stale",
      );
    }
    throw error;
  }
};

/**
 * Atomically registers, refreshes, or revokes one actor-owned device token.
 * The opaque token is persisted only in chat_device_push_tokens and is never
 * copied into results, idempotency responses, audit metadata, or outbox data.
 */
export async function updateDevicePushToken(
  options: DevicePushTokenCommandOptions,
): Promise<DevicePushTokenResult> {
  validateActor(options.actor);
  const input = parseDevicePushTokenInput(options.input);
  const schema = validatePostgresSchema(
    options.schema ?? DEFAULT_POSTGRES_SCHEMA,
  );
  const prefix = quoteIdentifier(schema);
  const idempotencyTtlMs = positiveSafeInteger(
    options.idempotencyTtlMs ?? DEFAULT_DEVICE_PUSH_TOKEN_IDEMPOTENCY_TTL_MS,
    "idempotencyTtlMs",
  );
  const outboxRetentionMs = positiveSafeInteger(
    options.outboxRetentionMs ??
      DEFAULT_DEVICE_PUSH_TOKEN_OUTBOX_RETENTION_MS,
    "outboxRetentionMs",
  );
  const createId = options.createId ?? randomUUID;
  const requestHash = hashRequest(input);
  const protectedToken =
    input.operation === "unregister"
      ? undefined
      : await protectToken(options, input);

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
        DEVICE_PUSH_TOKEN_IDEMPOTENCY_OPERATION,
        input.idempotencyKey,
        requestHash,
        idempotencyTtlMs,
      ],
    );
    const claimed = claim.rows[0];
    if (claimed === undefined) {
      throw new DevicePushTokenCommandError(
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
    if (claimed.idempotency_state === "completed") {
      if (claimed.stored_response_body === null) {
        throw new Error("Completed device push-token outcome has no response body");
      }
      const replay = replayStoredResult(claimed.stored_response_body, input);
      await connection.query("COMMIT");
      return replay;
    }

    // Advisory locking also serializes the no-row and post-revocation cases.
    await connection.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [
        JSON.stringify([
          options.actor.tenantId,
          options.actor.userId,
          input.deviceId,
        ]),
      ],
    );

    const historyResult = await connection.query<DevicePushTokenHistoryRow>(
      `SELECT
         max(token_revision) AS current_revision,
         max(token_revision) FILTER (WHERE revoked_at IS NULL)
           AS active_token_revision,
         GREATEST(
           clock_timestamp(),
           COALESCE(max(updated_at), '-infinity'::timestamptz)
         ) AS occurred_at
       FROM ${prefix}.chat_device_push_tokens
      WHERE tenant_id = $1 AND user_id = $2 AND device_id = $3`,
      [options.actor.tenantId, options.actor.userId, input.deviceId],
    );
    const history = historyResult.rows[0];
    if (history === undefined) {
      throw new Error("PostgreSQL returned no device push-token aggregate");
    }
    const currentRevision = toRevision(
      history.current_revision,
      "current token revision",
    );
    const activeRevision = toRevision(
      history.active_token_revision,
      "active token revision",
    );
    const occurredAt = toIsoTimestamp(
      history.occurred_at,
      "device push-token command timestamp",
    );
    assertMonotonicRevision(input, currentRevision);

    if (input.operation === "register" && activeRevision !== undefined) {
      throw new DevicePushTokenCommandError(
        "registration_state_conflict",
        "The device already has an active push-token registration",
      );
    }
    if (input.operation !== "register" && activeRevision === undefined) {
      throw new DevicePushTokenCommandError(
        "registration_state_conflict",
        "The device has no active push-token registration",
      );
    }

    let stored: StoredDevicePushTokenRow | undefined;
    if (input.operation === "register") {
      const inserted = await connection.query<StoredDevicePushTokenRow>(
        `INSERT INTO ${prefix}.chat_device_push_tokens (
         tenant_id, user_id, device_id, platform, provider, environment,
           opaque_token, token_protection_scheme, token_protection_key_id,
           token_revision, created_at, activated_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, 'host_encrypted', $8, $9,
           $10, $10, $10
         )
         RETURNING platform, provider, environment, token_revision,
                   updated_at, revoked_at`,
        [
          options.actor.tenantId,
          options.actor.userId,
          input.deviceId,
          input.platform,
          input.provider,
          input.environment,
          protectedToken!.ciphertext,
          protectedToken!.keyId,
          input.tokenRevision,
          occurredAt,
        ],
      );
      stored = inserted.rows[0];
    } else if (input.operation === "refresh") {
      const refreshed = await connection.query<StoredDevicePushTokenRow>(
        `UPDATE ${prefix}.chat_device_push_tokens
            SET platform = $1, provider = $2, environment = $3,
                opaque_token = $4, token_protection_scheme = 'host_encrypted',
                token_protection_key_id = $5, token_revision = $6,
                updated_at = $7
          WHERE tenant_id = $8 AND user_id = $9 AND device_id = $10
            AND revoked_at IS NULL AND token_revision = $11
        RETURNING platform, provider, environment, token_revision,
                  updated_at, revoked_at`,
        [
          input.platform,
          input.provider,
          input.environment,
          protectedToken!.ciphertext,
          protectedToken!.keyId,
          input.tokenRevision,
          occurredAt,
          options.actor.tenantId,
          options.actor.userId,
          input.deviceId,
          activeRevision,
        ],
      );
      stored = refreshed.rows[0];
    } else {
      const revoked = await connection.query<StoredDevicePushTokenRow>(
        `UPDATE ${prefix}.chat_device_push_tokens
            SET opaque_token = NULL,
                token_protection_key_id = NULL,
                token_revision = $1,
                revoked_at = $2,
                updated_at = $2
          WHERE tenant_id = $3 AND user_id = $4 AND device_id = $5
            AND revoked_at IS NULL AND token_revision = $6
        RETURNING platform, provider, environment, token_revision,
                  updated_at, revoked_at`,
        [
          input.tokenRevision,
          occurredAt,
          options.actor.tenantId,
          options.actor.userId,
          input.deviceId,
          activeRevision,
        ],
      );
      stored = revoked.rows[0];
    }
    if (stored === undefined) {
      throw new DevicePushTokenCommandError(
        "registration_state_conflict",
        "The device push-token state changed concurrently",
      );
    }

    const devicePushToken = canonicalStateFromRow(input, stored);
    const result = parseDevicePushTokenResult(
      {
        operation: input.operation,
        reconciliationStatus: "applied",
        idempotencyKey: input.idempotencyKey,
        devicePushToken,
      },
      input,
    );
    const auditMetadata = {
      operation: input.operation,
      deviceId: input.deviceId,
      platform: devicePushToken.platform,
      provider: devicePushToken.provider,
      environment: devicePushToken.environment,
      status: devicePushToken.status,
      previousTokenRevision: currentRevision ?? null,
      currentTokenRevision: devicePushToken.tokenRevision,
    };

    const auditEventId = createId();
    await connection.query(
      `INSERT INTO ${prefix}.chat_audit_events (
         tenant_id, event_id, actor_user_id, action, target_type, target_id,
         occurred_at, metadata, request_id
       ) VALUES ($1, $2, $3, $4, 'device', $5, $6, $7, $8)`,
      [
        options.actor.tenantId,
        auditEventId,
        options.actor.userId,
        DEVICE_PUSH_TOKEN_AUDIT_ACTION,
        input.deviceId,
        devicePushToken.updatedAt,
        auditMetadata,
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
        DEVICE_PUSH_TOKEN_OUTBOX_EVENT_TYPE,
        devicePushToken.updatedAt,
        {
          actorUserId: options.actor.userId,
          operation: input.operation,
          idempotencyKey: input.idempotencyKey,
          devicePushToken,
        },
        outboxRetentionMs,
      ],
    );

    await completeIdempotency(
      connection,
      prefix,
      options,
      input,
      requestHash,
      result,
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
