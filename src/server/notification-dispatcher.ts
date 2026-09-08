import { createHash, randomUUID } from "node:crypto";

import { MAX_DEVICE_PUSH_TOKEN_UTF8_BYTES } from "../contracts/device-push-token.js";
import { CHAT_PROTOCOL_VERSION } from "../contracts/realtime.js";
import type {
  ChatDirectoryAdapter,
  ChatPermissionAdapter,
  TrustedChatActorContext,
  ChatNotificationAdapter,
  ChatNotificationFailureClass,
  ChatNotificationInput,
  ChatNotificationMetadata,
  ChatNotificationTarget,
  ChatProtectedPushToken,
  ChatPushTokenProtector,
} from "./contracts.js";
import {
  ChatNotificationDeliveryError,
  MAX_CHAT_NOTIFICATION_TARGETS,
  MAX_CHAT_PUSH_TOKEN_CIPHERTEXT_UTF8_BYTES,
  MAX_CHAT_PUSH_TOKEN_KEY_ID_UTF8_BYTES,
} from "./contracts.js";
import { authorizeThreadAccess } from "./thread-access.js";
import { ChatAuthorizationError } from "./request-context.js";
import { recoverExhaustedNotificationLeases } from "./notification-lease-recovery.js";
import {
  DEFAULT_POSTGRES_SCHEMA,
  validatePostgresSchema,
  type PostgresMigrationDatabase,
} from "./postgres-migrations.js";

export const DEFAULT_CHAT_NOTIFICATION_BATCH_SIZE = 25;
export const DEFAULT_CHAT_NOTIFICATION_POLL_INTERVAL_MS = 250;
export const DEFAULT_CHAT_NOTIFICATION_LEASE_DURATION_MS = 30_000;
export const DEFAULT_CHAT_NOTIFICATION_MAX_ATTEMPTS = 5;
export const DEFAULT_CHAT_NOTIFICATION_INITIAL_RETRY_DELAY_MS = 1_000;
export const DEFAULT_CHAT_NOTIFICATION_MAX_RETRY_DELAY_MS = 60_000;

export type ChatNotificationBatchOutcomeStatus =
  | "empty"
  | "succeeded"
  | "partially_failed"
  | "failed";

export type ChatNotificationBatchFailureClass =
  | "none"
  | ChatNotificationFailureClass
  | "unknown"
  | "database";

/**
 * Fixed, low-cardinality classifications for one batch. `none` counts
 * delivered or suppressed claims; `database` counts batch-level failures.
 */
export interface ChatNotificationBatchFailureClassCounts {
  readonly none: number;
  readonly transient: number;
  readonly rate_limited: number;
  readonly permanent: number;
  readonly rejected: number;
  readonly configuration: number;
  readonly unknown: number;
  readonly database: number;
}

/** Aggregate-only diagnostics for one completed notification batch attempt. */
export interface ChatNotificationBatchOutcome
  extends ChatNotificationBatchResult {
  readonly durationMs: number;
  readonly oldestDueDeliveryAgeMs: number | null;
  readonly outcome: ChatNotificationBatchOutcomeStatus;
  readonly failureClassCounts: ChatNotificationBatchFailureClassCounts;
}

export type ChatNotificationBatchListener = (
  outcome: ChatNotificationBatchOutcome,
) => void | Promise<void>;

export interface ChatNotificationRecipientActivityInput {
  readonly tenantId: ChatNotificationInput["tenantId"];
  readonly recipientUserId: ChatNotificationInput["recipientUserId"];
  readonly conversationId: ChatNotificationInput["conversationId"];
}

export interface ChatNotificationDispatcherOptions {
  readonly batchSize?: number;
  readonly pollIntervalMs?: number;
  readonly leaseDurationMs?: number;
  readonly maxAttempts?: number;
  readonly initialRetryDelayMs?: number;
  readonly maxRetryDelayMs?: number;
  /** When true, the leased intent is completed without calling the adapter. */
  readonly isRecipientActive?: (
    input: ChatNotificationRecipientActivityInput,
  ) => boolean | Promise<boolean>;
  /** Receives worker/database errors without terminating polling or shutdown. */
  readonly onError?: (error: unknown) => void;
  /** Receives immutable, aggregate-only diagnostics for each completed batch. */
  readonly onBatch?: ChatNotificationBatchListener;
}

export interface NormalizedChatNotificationDispatcherOptions {
  readonly batchSize: number;
  readonly pollIntervalMs: number;
  readonly leaseDurationMs: number;
  readonly maxAttempts: number;
  readonly initialRetryDelayMs: number;
  readonly maxRetryDelayMs: number;
  readonly isRecipientActive:
    | ChatNotificationDispatcherOptions["isRecipientActive"]
    | undefined;
  readonly onError: ChatNotificationDispatcherOptions["onError"] | undefined;
  readonly onBatch: ChatNotificationBatchListener | undefined;
}

export interface CreateChatNotificationDispatcherOptions
  extends ChatNotificationDispatcherOptions {
  readonly database: PostgresMigrationDatabase;
  readonly adapter: ChatNotificationAdapter;
  readonly pushTokenProtector: ChatPushTokenProtector;
  /** Required for thread notifications; omitted adapters fail closed for threads. */
  readonly directory?: Pick<ChatDirectoryAdapter, "getUser">;
  readonly permissions?: Pick<ChatPermissionAdapter, "authorizeEntity">;
  readonly schema?: string;
  /** Primarily useful for deterministic tests and trace correlation. */
  readonly createLeaseToken?: () => string;
  /** Injected wall clock for deterministic due, lease, and retry decisions. */
  readonly now?: () => Date;
}

export interface ChatNotificationBatchResult {
  readonly materialized: number;
  readonly claimed: number;
  readonly delivered: number;
  readonly suppressed: number;
  readonly failed: number;
}

export interface ChatNotificationDispatcher {
  readonly running: boolean;
  readonly stopped: boolean;
  start(): void;
  runOnce(): Promise<ChatNotificationBatchResult>;
  stop(): Promise<void>;
}

interface StoredDelivery {
  readonly tenant_id: string;
  readonly source_event_id: string;
  readonly recipient_host_user_id: string;
  readonly notification_kind: string;
  readonly notification_metadata: unknown;
  readonly attempt_count: string | number;
  readonly occurred_at: Date | string;
  readonly conversation_id: string;
  readonly message_id: string;
  readonly actor_user_id: string;
  readonly sequence: string | number;
  readonly recipient_eligible: boolean;
  readonly conversation_type: string;
  readonly due_at: Date | string;
}

interface StoredNotificationTarget {
  readonly device_id: unknown;
  readonly platform: unknown;
  readonly provider: unknown;
  readonly environment: unknown;
  readonly opaque_token: unknown;
  readonly token_protection_key_id: unknown;
}

interface StoredReplayPosition {
  readonly replay_position: string | number;
}

interface StoredMaterializerOffset {
  readonly last_replay_position: string | number;
}

const CHAT_NOTIFICATION_MATERIALIZER_NAME =
  "message-created-notifications:v1";

const positiveInteger = (
  value: unknown,
  fallback: number,
  path: string,
): number => {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || (resolved as number) < 1) {
    throw new TypeError(`${path} must be a positive safe integer`);
  }
  return resolved as number;
};

const nonNegativeInteger = (
  value: unknown,
  fallback: number,
  path: string,
): number => {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || (resolved as number) < 0) {
    throw new TypeError(`${path} must be a non-negative safe integer`);
  }
  return resolved as number;
};

export function normalizeChatNotificationDispatcherOptions(
  options: ChatNotificationDispatcherOptions = {},
): NormalizedChatNotificationDispatcherOptions {
  const initialRetryDelayMs = nonNegativeInteger(
    options.initialRetryDelayMs,
    DEFAULT_CHAT_NOTIFICATION_INITIAL_RETRY_DELAY_MS,
    "notificationDelivery.initialRetryDelayMs",
  );
  const maxRetryDelayMs = nonNegativeInteger(
    options.maxRetryDelayMs,
    DEFAULT_CHAT_NOTIFICATION_MAX_RETRY_DELAY_MS,
    "notificationDelivery.maxRetryDelayMs",
  );
  if (maxRetryDelayMs < initialRetryDelayMs) {
    throw new TypeError(
      "notificationDelivery.maxRetryDelayMs must be greater than or equal to notificationDelivery.initialRetryDelayMs",
    );
  }
  if (
    options.isRecipientActive !== undefined &&
    typeof options.isRecipientActive !== "function"
  ) {
    throw new TypeError("notificationDelivery.isRecipientActive must be a function");
  }
  if (options.onError !== undefined && typeof options.onError !== "function") {
    throw new TypeError("notificationDelivery.onError must be a function");
  }
  if (options.onBatch !== undefined && typeof options.onBatch !== "function") {
    throw new TypeError("notificationDelivery.onBatch must be a function");
  }

  return Object.freeze({
    batchSize: positiveInteger(
      options.batchSize,
      DEFAULT_CHAT_NOTIFICATION_BATCH_SIZE,
      "notificationDelivery.batchSize",
    ),
    pollIntervalMs: nonNegativeInteger(
      options.pollIntervalMs,
      DEFAULT_CHAT_NOTIFICATION_POLL_INTERVAL_MS,
      "notificationDelivery.pollIntervalMs",
    ),
    leaseDurationMs: positiveInteger(
      options.leaseDurationMs,
      DEFAULT_CHAT_NOTIFICATION_LEASE_DURATION_MS,
      "notificationDelivery.leaseDurationMs",
    ),
    maxAttempts: positiveInteger(
      options.maxAttempts,
      DEFAULT_CHAT_NOTIFICATION_MAX_ATTEMPTS,
      "notificationDelivery.maxAttempts",
    ),
    initialRetryDelayMs,
    maxRetryDelayMs,
    isRecipientActive: options.isRecipientActive,
    onError: options.onError,
    onBatch: options.onBatch,
  });
}

const quoteIdentifier = (identifier: string): string =>
  `"${identifier.replaceAll('"', '""')}"`;

const toSafeInteger = (value: string | number, field: string): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RangeError(`Stored notification ${field} is not a safe integer`);
  }
  return parsed;
};

const retryDelay = (
  attempt: number,
  initialDelayMs: number,
  maximumDelayMs: number,
): number => {
  if (initialDelayMs === 0 || maximumDelayMs === 0) return 0;
  return Math.min(
    maximumDelayMs,
    initialDelayMs * 2 ** Math.min(Math.max(0, attempt - 1), 52),
  );
};

const terminalFailure = (failureClass: string): boolean =>
  failureClass === "permanent" ||
  failureClass === "rejected" ||
  failureClass === "configuration";

const classifyFailure = (
  error: unknown,
): ChatNotificationFailureClass | "unknown" =>
  error instanceof ChatNotificationDeliveryError
    ? error.failureClass
    : "unknown";

const elapsedMilliseconds = (startedAt: number, completedAt: number): number =>
  Number.isFinite(completedAt - startedAt)
    ? Math.max(0, completedAt - startedAt)
    : 0;

const oldestDueDeliveryAge = (
  oldestDueAt: number | undefined,
  completedAt: number,
): number | null =>
  oldestDueAt === undefined
    ? null
    : Number.isFinite(completedAt - oldestDueAt)
      ? Math.max(0, completedAt - oldestDueAt)
      : null;

const notificationBatchOutcomeStatus = (
  claimed: number,
  delivered: number,
  suppressed: number,
  failed: number,
): ChatNotificationBatchOutcomeStatus => {
  if (claimed === 0) return "empty";
  if (failed === 0) return "succeeded";
  return delivered + suppressed === 0 ? "failed" : "partially_failed";
};

const createFailureClassCounts = (): Record<
  ChatNotificationBatchFailureClass,
  number
> => ({
  none: 0,
  transient: 0,
  rate_limited: 0,
  permanent: 0,
  rejected: 0,
  configuration: 0,
  unknown: 0,
  database: 0,
});

/** Stable, opaque identity for host-side adapter idempotency. */
export function createChatNotificationDeliveryId(input: {
  readonly tenantId: string;
  readonly sourceEventId: string;
  readonly recipientUserId: string;
  readonly type: string;
}): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        "handrail.chat.notification.v1",
        input.tenantId,
        input.sourceEventId,
        input.recipientUserId,
        input.type,
      ]),
    )
    .digest("hex");
  return `notification:${digest}`;
}

const toNotificationInput = (
  row: StoredDelivery,
  targets: readonly ChatNotificationTarget[],
): ChatNotificationInput => {
  const metadata =
    typeof row.notification_metadata === "object" &&
    row.notification_metadata !== null &&
    !Array.isArray(row.notification_metadata)
      ? (row.notification_metadata as ChatNotificationMetadata)
      : {};
  const occurredAt =
    row.occurred_at instanceof Date
      ? row.occurred_at.toISOString()
      : new Date(row.occurred_at).toISOString();
  return Object.freeze({
    deliveryId: createChatNotificationDeliveryId({
      tenantId: row.tenant_id,
      sourceEventId: row.source_event_id,
      recipientUserId: row.recipient_host_user_id,
      type: row.notification_kind,
    }),
    sourceEventId: row.source_event_id,
    tenantId: row.tenant_id as ChatNotificationInput["tenantId"],
    recipientUserId:
      row.recipient_host_user_id as ChatNotificationInput["recipientUserId"],
    type: row.notification_kind,
    occurredAt,
    conversationId:
      row.conversation_id as ChatNotificationInput["conversationId"],
    messageId: row.message_id,
    sequence: toSafeInteger(row.sequence, "sequence"),
    actorUserId: row.actor_user_id as ChatNotificationInput["actorUserId"],
    metadata: Object.freeze({ ...metadata }),
    targets,
  });
};

const isBoundedStoredString = (value: unknown, maximumBytes: number): value is string =>
  typeof value === "string" &&
  Buffer.byteLength(value, "utf8") >= 1 &&
  Buffer.byteLength(value, "utf8") <= maximumBytes &&
  /\S/u.test(value);

const validateStoredNotificationTarget = (row: StoredNotificationTarget): {
  readonly deviceId: ChatNotificationTarget["deviceId"];
  readonly platform: ChatNotificationTarget["platform"];
  readonly provider: ChatNotificationTarget["provider"];
  readonly environment: ChatNotificationTarget["environment"];
  readonly protectedToken: ChatProtectedPushToken;
} => {
  if (
    !isBoundedStoredString(row.device_id, 255) ||
    !isBoundedStoredString(
      row.opaque_token,
      MAX_CHAT_PUSH_TOKEN_CIPHERTEXT_UTF8_BYTES,
    ) ||
    !isBoundedStoredString(
      row.token_protection_key_id,
      MAX_CHAT_PUSH_TOKEN_KEY_ID_UTF8_BYTES,
    )
  ) {
    throw new Error("Stored notification target is invalid");
  }
  const validProviderTarget =
    (row.platform === "ios" &&
      row.provider === "apns" &&
      (row.environment === "sandbox" || row.environment === "production")) ||
    (row.platform === "android" &&
      row.provider === "fcm" &&
      row.environment === "production");
  if (!validProviderTarget) {
    throw new Error("Stored notification target is invalid");
  }
  return Object.freeze({
    deviceId: row.device_id as ChatNotificationTarget["deviceId"],
    platform: row.platform,
    provider: row.provider,
    environment: row.environment,
    protectedToken: Object.freeze({
      ciphertext: row.opaque_token,
      keyId: row.token_protection_key_id,
    }),
  });
};

const createNotificationTarget = (
  stored: ReturnType<typeof validateStoredNotificationTarget>,
  token: unknown,
): ChatNotificationTarget => {
  if (!isBoundedStoredString(token, MAX_DEVICE_PUSH_TOKEN_UTF8_BYTES)) {
    throw new Error("Unprotected notification target is invalid");
  }
  const target: ChatNotificationTarget = {
    deviceId: stored.deviceId,
    platform: stored.platform,
    provider: stored.provider,
    environment: stored.environment,
    token: token as ChatNotificationTarget["token"],
  };
  Object.defineProperty(target, "token", { enumerable: false });
  return Object.freeze(target);
};

export function createChatNotificationDispatcher(
  options: CreateChatNotificationDispatcherOptions,
): ChatNotificationDispatcher {
  const normalized = normalizeChatNotificationDispatcherOptions(options);
  const schema = validatePostgresSchema(options.schema ?? DEFAULT_POSTGRES_SCHEMA);
  const prefix = quoteIdentifier(schema);
  const deliveries = `${prefix}.chat_notification_deliveries`;
  const outbox = `${prefix}.chat_outbox_events`;
  const members = `${prefix}.chat_conversation_members`;
  const follows = `${prefix}.chat_thread_follows`;
  const preferences = `${prefix}.chat_conversation_preferences`;
  const reminders = `${prefix}.chat_message_reminders`;
  const conversations = `${prefix}.chat_conversations`;
  const messages = `${prefix}.chat_messages`;
  const pushTokens = `${prefix}.chat_device_push_tokens`;
  const materializerOffsets =
    `${prefix}.chat_notification_materializer_offsets`;
  const createLeaseToken = options.createLeaseToken ?? randomUUID;
  const now = options.now ?? (() => new Date());
  if (typeof now !== "function") {
    throw new TypeError("notificationDelivery.now must be a function");
  }
  if (
    typeof options.pushTokenProtector !== "object" ||
    options.pushTokenProtector === null ||
    typeof options.pushTokenProtector.protect !== "function" ||
    typeof options.pushTokenProtector.unprotect !== "function"
  ) {
    throw new TypeError("pushTokenProtector must implement protect and unprotect");
  }

  const currentTime = (): Date => {
    const value = now();
    if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) {
      throw new TypeError("notificationDelivery.now must return a valid Date");
    }
    return value;
  };
  const injectedTime = (): Date | null =>
    options.now === undefined ? null : currentTime();

  let running = false;
  let stopped = false;
  let loopPromise: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  let currentBatch: Promise<ChatNotificationBatchResult> | undefined;
  let wakeTimer: ReturnType<typeof setTimeout> | undefined;
  let wakePolling: (() => void) | undefined;

  const reportError = (error: unknown): void => {
    try {
      normalized.onError?.(error);
    } catch {
      // Diagnostics must never terminate delivery or make shutdown reject.
    }
  };

  const reportBatch = (outcome: ChatNotificationBatchOutcome): void => {
    try {
      void Promise.resolve(normalized.onBatch?.(outcome)).catch(() => undefined);
    } catch {
      // Telemetry must never affect delivery, polling, or shutdown.
    }
  };

  const telemetryTime = (): number => {
    try {
      const value = now();
      return value instanceof Date && Number.isFinite(value.valueOf())
        ? value.valueOf()
        : Date.now();
    } catch {
      return Date.now();
    }
  };

  // Shared by materialization and the final thread delivery check. The source
  // author comes from the live, same-conversation message, never reply metadata.
  const deliberateMention = (userId: string): string => `(
    EXISTS (
      SELECT 1 FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(event.payload #> '{message,content,mentions}') = 'array'
          THEN event.payload #> '{message,content,mentions}' ELSE '[]'::jsonb END
      ) AS mention(value)
      WHERE mention.value ->> 'type' = 'user'
        AND mention.value ->> 'userId' = ${userId}
    ) OR (
      event.payload #> '{message,replyTo,notifyAuthor}' = 'true'::jsonb
      AND EXISTS (
        SELECT 1 FROM ${messages} AS reply_source
        WHERE reply_source.tenant_id = event.tenant_id
          AND reply_source.conversation_id = event.stream_id
          AND reply_source.id = event.payload #>> '{message,replyTo,messageId}'
          AND reply_source.deleted_at IS NULL
          AND reply_source.author_user_id = ${userId}
      )
    )
  )`;
  const recipientPolicy = (userId: string): string => `
    ${userId} <> event.payload #>> '{message,author,userId}'
    AND COALESCE(preference.notification_level, 'all') <> 'none'
    AND (
      (COALESCE(preference.notification_level, 'all') = 'all'
        AND (conversation.type <> 'thread'
          OR follow.is_following = true
          OR (follow.user_id IS NULL AND member.state = 'active')))
      OR ${deliberateMention(userId)}
    )
    AND (COALESCE(preference.muted, false) = false
      OR preference.muted_until <= moment.at)`;

  const hasThreadAccess = async (
    database: Pick<PostgresMigrationDatabase, "query">,
    tenantId: string,
    threadId: string,
    userId: string,
  ): Promise<boolean> => {
    if (options.directory === undefined || options.permissions === undefined) return false;
    // Persisted tenant/recipient identity only. A background worker has no
    // authenticated recipient session or host roles to propagate. Hosts must
    // resolve current entity access by identity; no role is synthesized here.
    const actor: TrustedChatActorContext = {
      tenantId: tenantId as TrustedChatActorContext["tenantId"],
      userId: userId as TrustedChatActorContext["userId"],
      roles: [],
    };
    const user = await options.directory.getUser({ actor, userId: actor.userId });
    if (user === null || user.kind === "redacted" || user.kind === "unavailable" ||
        user.tenantId !== tenantId || user.userId !== userId) return false;
    try {
      const access = await authorizeThreadAccess({
        database, schema, actor, threadId, operation: "read",
        entityAction: "conversation.subscribe", permissions: options.permissions,
      });
      return !access.isArchived;
    } catch (error) {
      if (error instanceof ChatAuthorizationError) return false;
      throw error;
    }
  };

  const isThreadDeliveryEligible = async (row: StoredDelivery): Promise<boolean> => {
    if (!await hasThreadAccess(options.database, row.tenant_id,
      row.conversation_id, row.recipient_host_user_id)) return false;
    const result = await options.database.query(
      `WITH moment AS (SELECT COALESCE($4::timestamptz, clock_timestamp()) AS at)
       SELECT 1 FROM ${outbox} AS event
       CROSS JOIN moment
       JOIN ${conversations} AS conversation
         ON conversation.tenant_id = event.tenant_id AND conversation.id = event.stream_id
       LEFT JOIN ${members} AS member
         ON member.tenant_id = event.tenant_id AND member.conversation_id = event.stream_id
        AND member.user_id = $3
       LEFT JOIN ${follows} AS follow
         ON follow.tenant_id = event.tenant_id AND follow.conversation_id = event.stream_id
        AND follow.user_id = $3
       LEFT JOIN ${preferences} AS preference
         ON preference.tenant_id = event.tenant_id AND preference.conversation_id = event.stream_id
        AND preference.user_id = $3
       WHERE event.tenant_id = $1 AND event.event_id = $2
         AND conversation.type = 'thread' AND conversation.archived_at IS NULL
         AND ${recipientPolicy("$3")}`,
      [row.tenant_id, row.source_event_id, row.recipient_host_user_id, injectedTime()],
    );
    return result.rows.length !== 0;
  };

  const materializeCreatedMessages = async (): Promise<number> => {
    const connection = await options.database.connect();
    let transactionStarted = false;
    let releaseError: Error | undefined;
    try {
      await connection.query("BEGIN");
      transactionStarted = true;
      await connection.query(
        `INSERT INTO ${materializerOffsets} (
           materializer_name, last_replay_position
         ) VALUES ($1, 0)
         ON CONFLICT (materializer_name) DO NOTHING`,
        [CHAT_NOTIFICATION_MATERIALIZER_NAME],
      );
      const offset = await connection.query<StoredMaterializerOffset>(
        `SELECT last_replay_position
         FROM ${materializerOffsets}
         WHERE materializer_name = $1
         FOR UPDATE`,
        [CHAT_NOTIFICATION_MATERIALIZER_NAME],
      );
      const storedOffset = offset.rows[0];
      if (offset.rows.length !== 1 || storedOffset === undefined) {
        throw new Error("Notification materializer offset row is unavailable");
      }

      const page = await connection.query<StoredReplayPosition>(
        `SELECT event.replay_position
         FROM ${outbox} AS event
         WHERE event.replay_position > $1
         ORDER BY event.replay_position
         LIMIT $2`,
        [storedOffset.last_replay_position, normalized.batchSize],
      );
      if (page.rows.length === 0) {
        await connection.query("COMMIT");
        transactionStarted = false;
        return 0;
      }

      const replayPositions = page.rows.map((row) => row.replay_position);
      const highestReplayPosition = replayPositions[replayPositions.length - 1];
      if (highestReplayPosition === undefined) {
        throw new Error("Notification materializer page has no replay position");
      }
      const candidates = await connection.query<{
        tenant_id: string; source_event_id: string; recipient_host_user_id: string;
        conversation_id: string; conversation_type: string; notification_metadata: unknown;
      }>(
        `WITH moment AS (SELECT clock_timestamp() AS at)
         SELECT event.tenant_id, event.event_id AS source_event_id,
                candidate.user_id AS recipient_host_user_id,
                conversation.id AS conversation_id, conversation.type AS conversation_type,
                jsonb_build_object(
                  'conversationId', event.stream_id,
                  'messageId', event.payload #>> '{message,id}',
                  'actorUserId', event.payload #>> '{message,author,userId}',
                  'sequence', (event.payload #>> '{message,sequence}')::bigint,
                  'protocolVersion', event.protocol_version
                ) AS notification_metadata
         FROM ${outbox} AS event
         CROSS JOIN moment
         JOIN ${conversations} AS conversation
           ON conversation.tenant_id = event.tenant_id AND conversation.id = event.stream_id
         CROSS JOIN LATERAL (
           SELECT participant.user_id FROM ${members} AS participant
           WHERE participant.tenant_id = event.tenant_id
             AND participant.conversation_id = event.stream_id
             AND (conversation.type = 'thread' OR participant.state = 'active')
           UNION
           SELECT subscription.user_id FROM ${follows} AS subscription
           WHERE conversation.type = 'thread' AND subscription.tenant_id = event.tenant_id
             AND subscription.conversation_id = event.stream_id
           UNION
           SELECT mention.value ->> 'userId' FROM jsonb_array_elements(
             CASE WHEN jsonb_typeof(event.payload #> '{message,content,mentions}') = 'array'
               THEN event.payload #> '{message,content,mentions}' ELSE '[]'::jsonb END
           ) AS mention(value)
           WHERE conversation.type = 'thread' AND mention.value ->> 'type' = 'user'
             AND jsonb_typeof(mention.value -> 'userId') = 'string'
             AND length(btrim(mention.value ->> 'userId')) > 0
           UNION
           SELECT reply_source.author_user_id FROM ${messages} AS reply_source
           WHERE conversation.type = 'thread'
             AND event.payload #> '{message,replyTo,notifyAuthor}' = 'true'::jsonb
             AND reply_source.tenant_id = event.tenant_id
             AND reply_source.conversation_id = event.stream_id
             AND reply_source.id = event.payload #>> '{message,replyTo,messageId}'
             AND reply_source.deleted_at IS NULL
         ) AS candidate
         LEFT JOIN ${members} AS member
           ON member.tenant_id = event.tenant_id AND member.conversation_id = event.stream_id
          AND member.user_id = candidate.user_id
         LEFT JOIN ${follows} AS follow
           ON follow.tenant_id = event.tenant_id AND follow.conversation_id = event.stream_id
          AND follow.user_id = candidate.user_id
         LEFT JOIN ${preferences} AS preference
           ON preference.tenant_id = event.tenant_id AND preference.conversation_id = event.stream_id
          AND preference.user_id = candidate.user_id
         WHERE event.replay_position = ANY($1::bigint[])
           AND event.type = 'message.created'
           AND event.expires_at > moment.at
           AND jsonb_typeof(event.payload -> 'message') = 'object'
           AND jsonb_typeof(event.payload #> '{message,id}') = 'string'
           AND jsonb_typeof(event.payload #> '{message,author,userId}') = 'string'
           AND jsonb_typeof(event.payload #> '{message,sequence}') = 'number'
           AND (event.payload #>> '{message,sequence}') ~ '^[0-9]+$'
           AND (event.payload #>> '{message,sequence}')::numeric
                 BETWEEN 1 AND 9007199254740991
           AND jsonb_typeof(
                 COALESCE(event.payload #> '{message,content,mentions}', '[]'::jsonb)
               ) = 'array'
           AND ${recipientPolicy("candidate.user_id")}`,
        [replayPositions],
      );
      const eligible = [];
      // Keep host lookups bounded to concrete candidates, and sequential.
      for (const candidate of candidates.rows) {
        if (candidate.conversation_type !== "thread" || await hasThreadAccess(
          connection, candidate.tenant_id, candidate.conversation_id,
          candidate.recipient_host_user_id,
        )) eligible.push(candidate);
      }
      const result = await connection.query(
        `WITH moment AS (SELECT clock_timestamp() AS at)
         INSERT INTO ${deliveries} (
           tenant_id, source_event_id, recipient_host_user_id,
           notification_kind, notification_metadata, next_attempt_at, created_at, updated_at
         )
         SELECT candidate.tenant_id, candidate.source_event_id, candidate.recipient_host_user_id,
                'message.created', candidate.notification_metadata, moment.at, moment.at, moment.at
         FROM jsonb_to_recordset($1::jsonb) AS candidate(
           tenant_id text, source_event_id text, recipient_host_user_id text,
           notification_metadata jsonb
         ) CROSS JOIN moment
         ON CONFLICT (
           tenant_id, source_event_id, recipient_host_user_id, notification_kind
         ) DO NOTHING`,
        [JSON.stringify(eligible)],
      );
      const advanced = await connection.query(
        `UPDATE ${materializerOffsets}
         SET last_replay_position = $2,
             updated_at = clock_timestamp()
         WHERE materializer_name = $1`,
        [
          CHAT_NOTIFICATION_MATERIALIZER_NAME,
          highestReplayPosition,
        ],
      );
      if (advanced.rowCount !== 1) {
        throw new Error("Notification materializer offset row was not advanced");
      }
      await connection.query("COMMIT");
      transactionStarted = false;
      return result.rowCount ?? 0;
    } catch (error) {
      if (transactionStarted) {
        try {
          await connection.query("ROLLBACK");
        } catch (rollbackError) {
          releaseError =
            rollbackError instanceof Error
              ? rollbackError
              : new Error("Notification materializer rollback failed");
          throw new AggregateError(
            [error, rollbackError],
            "Notification materialization failed and could not be rolled back",
          );
        }
      }
      throw error;
    } finally {
      connection.release(releaseError);
    }
  };

  const materializeDueReminders = async (): Promise<number> => {
    const connection = await options.database.connect();
    let transactionStarted = false;
    let releaseError: Error | undefined;
    try {
      await connection.query("BEGIN");
      transactionStarted = true;
      const result = await connection.query(
        `WITH due AS MATERIALIZED (
           SELECT reminder.tenant_id, reminder.user_id, reminder.message_id,
                  reminder.conversation_id, reminder.remind_at,
                  reminder.reminder_revision, message.sequence
           FROM ${reminders} AS reminder
           JOIN ${messages} AS message
             ON message.tenant_id = reminder.tenant_id
            AND message.conversation_id = reminder.conversation_id
            AND message.id = reminder.message_id
           WHERE reminder.status = 'active'
             AND reminder.remind_at <= $1::timestamptz
             AND reminder.materialized_revision IS DISTINCT FROM
                   reminder.reminder_revision
           ORDER BY reminder.remind_at, reminder.tenant_id,
                    reminder.user_id, reminder.message_id
           FOR UPDATE OF reminder SKIP LOCKED
           LIMIT $2
         ), prepared AS MATERIALIZED (
           SELECT due.*,
                  'message-reminder:' || md5(jsonb_build_array(
                    due.tenant_id, due.user_id, due.message_id,
                    due.reminder_revision
                  )::text) AS source_event_id
           FROM due
         ), inserted_events AS (
           INSERT INTO ${outbox} (
             event_id, protocol_version, tenant_id, stream_id, type,
             occurred_at, payload, available_at, published_at, expires_at
           )
           SELECT prepared.source_event_id, $3, prepared.tenant_id,
                  prepared.conversation_id, 'message.reminder',
                  prepared.remind_at,
                  jsonb_build_object(
                    'message', jsonb_build_object(
                      'id', prepared.message_id,
                      'author', jsonb_build_object('userId', prepared.user_id),
                      'sequence', prepared.sequence
                    ),
                    'reminder', jsonb_build_object(
                      'userId', prepared.user_id,
                      'revision', prepared.reminder_revision,
                      'dueAt', prepared.remind_at
                    )
                  ),
                  $1::timestamptz, $1::timestamptz,
                  GREATEST($1::timestamptz, prepared.remind_at)
                    + interval '30 days'
           FROM prepared
           ON CONFLICT (event_id) DO NOTHING
           RETURNING tenant_id, event_id
         ), inserted_deliveries AS (
           INSERT INTO ${deliveries} (
             tenant_id, source_event_id, recipient_host_user_id,
             notification_kind, notification_metadata, next_attempt_at,
             created_at, updated_at
           )
           SELECT prepared.tenant_id, prepared.source_event_id,
                  prepared.user_id, 'message.reminder',
                  jsonb_build_object(
                    'conversationId', prepared.conversation_id,
                    'messageId', prepared.message_id,
                    'sequence', prepared.sequence,
                    'reminderRevision', prepared.reminder_revision,
                    'reminderDueAt', prepared.remind_at
                  ),
                  $1::timestamptz, $1::timestamptz, $1::timestamptz
           FROM prepared
           JOIN inserted_events
             ON inserted_events.tenant_id = prepared.tenant_id
            AND inserted_events.event_id = prepared.source_event_id
           ON CONFLICT (
             tenant_id, source_event_id, recipient_host_user_id,
             notification_kind
           ) DO NOTHING
         )
         UPDATE ${reminders} AS reminder
         SET materialized_revision = prepared.reminder_revision,
             materialized_at = $1::timestamptz,
             materialized_source_event_id = prepared.source_event_id,
             updated_at = $1::timestamptz
         FROM prepared
         WHERE reminder.tenant_id = prepared.tenant_id
           AND reminder.user_id = prepared.user_id
           AND reminder.message_id = prepared.message_id
           AND reminder.status = 'active'
           AND reminder.reminder_revision = prepared.reminder_revision`,
        [currentTime(), normalized.batchSize, CHAT_PROTOCOL_VERSION],
      );
      await connection.query("COMMIT");
      transactionStarted = false;
      return result.rowCount ?? 0;
    } catch (error) {
      if (transactionStarted) {
        try {
          await connection.query("ROLLBACK");
        } catch (rollbackError) {
          releaseError =
            rollbackError instanceof Error
              ? rollbackError
              : new Error("Reminder materializer rollback failed");
          throw new AggregateError(
            [error, rollbackError],
            "Reminder materialization failed and could not be rolled back",
          );
        }
      }
      throw error;
    } finally {
      connection.release(releaseError);
    }
  };

  const finishDelivered = async (
    row: StoredDelivery,
    leaseToken: string,
    reminderStatus: "delivered" | "cancelled" | null,
  ): Promise<boolean> => {
    const result = await options.database.query(
      `WITH moment AS (
         SELECT COALESCE($7::timestamptz, clock_timestamp()) AS at
       ),
       updated_delivery AS (
         UPDATE ${deliveries} AS delivery
         SET status = 'delivered',
             lease_token = NULL,
             lease_acquired_at = NULL,
             lease_expires_at = NULL,
             delivered_at = moment.at,
             updated_at = moment.at
         FROM moment
         WHERE delivery.tenant_id = $1
           AND delivery.source_event_id = $2
           AND delivery.recipient_host_user_id = $3
           AND delivery.notification_kind = $4
           AND delivery.status = 'leased'
           AND delivery.lease_token = $5
         RETURNING delivery.tenant_id, delivery.source_event_id,
                   delivery.recipient_host_user_id
       ),
       finalized_reminder AS (
         UPDATE ${reminders} AS reminder
         SET status = $6,
             delivered_at = CASE WHEN $6 = 'delivered' THEN moment.at END,
             cancelled_at = CASE WHEN $6 = 'cancelled' THEN moment.at END,
             reminder_revision = reminder.reminder_revision + 1,
             updated_at = moment.at
         FROM updated_delivery
         CROSS JOIN moment
         WHERE $6::text IS NOT NULL
           AND reminder.tenant_id = updated_delivery.tenant_id
           AND reminder.user_id = updated_delivery.recipient_host_user_id
           AND reminder.materialized_source_event_id = updated_delivery.source_event_id
           AND reminder.status = 'active'
           AND reminder.materialized_revision = reminder.reminder_revision
         RETURNING reminder.message_id
       )
       SELECT source_event_id FROM updated_delivery`,
      [
        row.tenant_id,
        row.source_event_id,
        row.recipient_host_user_id,
        row.notification_kind,
        leaseToken,
        reminderStatus,
        injectedTime(),
      ],
    );
    return result.rowCount === 1;
  };

  const finishFailed = async (
    row: StoredDelivery,
    leaseToken: string,
    failureClass: ChatNotificationFailureClass | "unknown",
  ): Promise<void> => {
    const attempt = toSafeInteger(row.attempt_count, "attempt_count");
    const storedFailureClass =
      failureClass === "permanent" ? "rejected" : failureClass;
    const delayMs = terminalFailure(failureClass)
      ? 0
      : retryDelay(
          attempt,
          normalized.initialRetryDelayMs,
          normalized.maxRetryDelayMs,
        );
    const cancelReminder =
      row.notification_kind === "message.reminder" &&
      (terminalFailure(failureClass) || attempt >= normalized.maxAttempts);
    await options.database.query(
      `WITH moment AS (
         SELECT COALESCE($9::timestamptz, clock_timestamp()) AS at
       ),
       updated_delivery AS (
         UPDATE ${deliveries} AS delivery
         SET status = 'failed',
             next_attempt_at = moment.at
               + ($6::double precision * interval '1 millisecond'),
             lease_token = NULL,
             lease_acquired_at = NULL,
             lease_expires_at = NULL,
             last_error_class = $7,
             last_error_at = moment.at,
             updated_at = moment.at
         FROM moment
         WHERE delivery.tenant_id = $1
           AND delivery.source_event_id = $2
           AND delivery.recipient_host_user_id = $3
           AND delivery.notification_kind = $4
           AND delivery.status = 'leased'
           AND delivery.lease_token = $5
         RETURNING delivery.tenant_id, delivery.source_event_id,
                   delivery.recipient_host_user_id
       ),
       cancelled_reminder AS (
         UPDATE ${reminders} AS reminder
         SET status = 'cancelled',
             cancelled_at = moment.at,
             reminder_revision = reminder.reminder_revision + 1,
             updated_at = moment.at
         FROM updated_delivery
         CROSS JOIN moment
         WHERE $8::boolean
           AND reminder.tenant_id = updated_delivery.tenant_id
           AND reminder.user_id = updated_delivery.recipient_host_user_id
           AND reminder.materialized_source_event_id = updated_delivery.source_event_id
           AND reminder.status = 'active'
           AND reminder.materialized_revision = reminder.reminder_revision
         RETURNING reminder.message_id
       )
       SELECT source_event_id FROM updated_delivery`,
      [
        row.tenant_id,
        row.source_event_id,
        row.recipient_host_user_id,
        row.notification_kind,
        leaseToken,
        delayMs,
        storedFailureClass,
        cancelReminder,
        injectedTime(),
      ],
    );
  };

  const resolveNotificationTargets = async (
    row: StoredDelivery,
  ): Promise<readonly ChatNotificationTarget[]> => {
    const result = await options.database.query<StoredNotificationTarget>(
      `SELECT device_id, platform, provider, environment, opaque_token,
              token_protection_key_id
       FROM ${pushTokens}
       WHERE tenant_id = $1
         AND user_id = $2
         AND revoked_at IS NULL
         AND token_protection_scheme = 'host_encrypted'
       ORDER BY device_id
       LIMIT $3`,
      [
        row.tenant_id,
        row.recipient_host_user_id,
        MAX_CHAT_NOTIFICATION_TARGETS,
      ],
    );
    if (result.rows.length > MAX_CHAT_NOTIFICATION_TARGETS) {
      throw new Error("Stored notification target set exceeds its bound");
    }
    const storedTargets = result.rows.map(validateStoredNotificationTarget);
    const targets = await Promise.all(
      storedTargets.map(async (stored) =>
        createNotificationTarget(
          stored,
          await options.pushTokenProtector.unprotect({
            tenantId: row.tenant_id as ChatNotificationInput["tenantId"],
            userId:
              row.recipient_host_user_id as ChatNotificationInput["recipientUserId"],
            deviceId: stored.deviceId,
            protectedToken: stored.protectedToken,
          }),
        ),
      ),
    );
    return Object.freeze(targets);
  };

  type DeliveryOutcome =
    | Readonly<{
        status: "delivered" | "suppressed";
        failureClass: "none";
      }>
    | Readonly<{
        status: "failed";
        failureClass: ChatNotificationFailureClass | "unknown";
      }>;

  const deliver = async (
    row: StoredDelivery,
    leaseToken: string,
  ): Promise<DeliveryOutcome> => {
    try {
      if (!row.recipient_eligible) {
        return (await finishDelivered(
          row,
          leaseToken,
          row.notification_kind === "message.reminder" ? "cancelled" : null,
        ))
          ? { status: "suppressed", failureClass: "none" }
          : { status: "failed", failureClass: "unknown" };
      }
      if (
        normalized.isRecipientActive !== undefined &&
        (await normalized.isRecipientActive({
          tenantId: row.tenant_id as ChatNotificationInput["tenantId"],
          recipientUserId:
            row.recipient_host_user_id as ChatNotificationInput["recipientUserId"],
          conversationId:
            row.conversation_id as ChatNotificationInput["conversationId"],
        }))
      ) {
        return (await finishDelivered(
          row,
          leaseToken,
          row.notification_kind === "message.reminder" ? "delivered" : null,
        ))
          ? { status: "suppressed", failureClass: "none" }
          : { status: "failed", failureClass: "unknown" };
      }
      let targets: readonly ChatNotificationTarget[];
      try {
        targets = await resolveNotificationTargets(row);
      } catch {
        await finishFailed(row, leaseToken, "unknown");
        return { status: "failed", failureClass: "unknown" };
      }
      if (targets.length === 0) {
        return (await finishDelivered(
          row,
          leaseToken,
          row.notification_kind === "message.reminder" ? "delivered" : null,
        ))
          ? { status: "suppressed", failureClass: "none" }
          : { status: "failed", failureClass: "unknown" };
      }
      if (row.notification_kind === "message.created" && row.conversation_type === "thread" &&
          !await isThreadDeliveryEligible(row)) {
        return (await finishDelivered(row, leaseToken, null))
          ? { status: "suppressed", failureClass: "none" }
          : { status: "failed", failureClass: "unknown" };
      }
      const input = toNotificationInput(row, targets);
      await options.adapter.send(input);
      return (await finishDelivered(
        row,
        leaseToken,
        row.notification_kind === "message.reminder" ? "delivered" : null,
      ))
        ? { status: "delivered", failureClass: "none" }
        : { status: "failed", failureClass: "unknown" };
    } catch (error) {
      const failureClass = classifyFailure(error);
      await finishFailed(row, leaseToken, failureClass);
      return { status: "failed", failureClass };
    }
  };

  const executeBatch = async (): Promise<ChatNotificationBatchResult> => {
    const startedAt = telemetryTime();
    let materializedCount = 0;
    let claimedCount = 0;
    let deliveredCount = 0;
    let suppressedCount = 0;
    let failedCount = 0;
    let oldestDueAt: number | undefined;
    let activeFailureClass: ChatNotificationBatchFailureClass = "database";
    const failureClassCounts = createFailureClassCounts();

    const emit = (outcome: ChatNotificationBatchOutcomeStatus): void => {
      const completedAt = telemetryTime();
      reportBatch(
        Object.freeze({
          materialized: materializedCount,
          claimed: claimedCount,
          delivered: deliveredCount,
          suppressed: suppressedCount,
          failed: failedCount,
          durationMs: elapsedMilliseconds(startedAt, completedAt),
          oldestDueDeliveryAgeMs: oldestDueDeliveryAge(
            oldestDueAt,
            completedAt,
          ),
          outcome,
          failureClassCounts: Object.freeze({ ...failureClassCounts }),
        }),
      );
    };

    try {
      if (stopped) {
        emit("empty");
        return {
          materialized: 0,
          claimed: 0,
          delivered: 0,
          suppressed: 0,
          failed: 0,
        };
      }
      materializedCount += await materializeCreatedMessages();
      materializedCount += await materializeDueReminders();

      activeFailureClass = "configuration";
      const leaseToken = createLeaseToken();
      if (typeof leaseToken !== "string" || leaseToken.trim().length === 0) {
        throw new TypeError("createLeaseToken must return a non-empty string");
      }

      activeFailureClass = "database";
      const recoveryTime = injectedTime();
      // Recovery terminalizations do not contribute to batch counters: they
      // are neither new claims nor provider attempts in this batch.
      await recoverExhaustedNotificationLeases({
        database: options.database,
        schema,
        batchSize: normalized.batchSize,
        maxAttempts: normalized.maxAttempts,
        ...(recoveryTime === null ? {} : { now: recoveryTime }),
      });
      const claimed = await options.database.query<StoredDelivery>(
        `WITH moment AS (
         SELECT COALESCE($5::timestamptz, clock_timestamp()) AS at
       ),
       claimable AS MATERIALIZED (
         SELECT candidate.tenant_id, candidate.source_event_id,
                candidate.recipient_host_user_id, candidate.notification_kind,
                COALESCE(
                  candidate.lease_expires_at, candidate.next_attempt_at
                ) AS due_at
         FROM ${deliveries} AS candidate
         CROSS JOIN moment
         WHERE candidate.attempt_count < $4
           AND (
             (
               candidate.status IN ('pending', 'failed')
               AND candidate.next_attempt_at <= moment.at
               AND (
                 candidate.status = 'pending'
                 OR candidate.last_error_class IN (
                   'transient', 'rate_limited', 'unknown'
                 )
               )
             )
             OR (
               candidate.status = 'leased'
               AND candidate.lease_expires_at <= moment.at
             )
           )
         ORDER BY COALESCE(candidate.lease_expires_at, candidate.next_attempt_at),
                  candidate.tenant_id, candidate.source_event_id,
                  candidate.recipient_host_user_id, candidate.notification_kind
         FOR UPDATE OF candidate SKIP LOCKED
         LIMIT $1
       )
       UPDATE ${deliveries} AS delivery
       SET status = 'leased',
           attempt_count = delivery.attempt_count + 1,
           lease_token = $2,
           lease_acquired_at = moment.at,
           lease_expires_at = moment.at
             + ($3::double precision * interval '1 millisecond'),
           last_error_class = NULL,
           last_error_at = NULL,
           updated_at = moment.at
       FROM claimable
       CROSS JOIN moment
       JOIN ${outbox} AS event
         ON event.tenant_id = claimable.tenant_id
        AND event.event_id = claimable.source_event_id
       LEFT JOIN ${reminders} AS reminder
         ON claimable.notification_kind = 'message.reminder'
        AND reminder.tenant_id = claimable.tenant_id
        AND reminder.user_id = claimable.recipient_host_user_id
        AND reminder.message_id = event.payload #>> '{message,id}'
       LEFT JOIN ${conversations} AS conversation
         ON conversation.tenant_id = claimable.tenant_id
        AND conversation.id = event.stream_id
       LEFT JOIN ${members} AS recipient_member
         ON recipient_member.tenant_id = claimable.tenant_id
        AND recipient_member.conversation_id = event.stream_id
        AND recipient_member.user_id = claimable.recipient_host_user_id
       WHERE delivery.tenant_id = claimable.tenant_id
         AND delivery.source_event_id = claimable.source_event_id
         AND delivery.recipient_host_user_id = claimable.recipient_host_user_id
         AND delivery.notification_kind = claimable.notification_kind
       RETURNING delivery.tenant_id, delivery.source_event_id,
                 delivery.recipient_host_user_id, delivery.notification_kind,
                 delivery.notification_metadata, delivery.attempt_count,
                 event.occurred_at, event.stream_id AS conversation_id,
                 event.payload #>> '{message,id}' AS message_id,
                 event.payload #>> '{message,author,userId}' AS actor_user_id,
                 event.payload #>> '{message,sequence}' AS sequence,
                 claimable.due_at, conversation.type AS conversation_type,
                 CASE
                   WHEN delivery.notification_kind <> 'message.reminder'
                     THEN conversation.id IS NOT NULL
                       AND conversation.archived_at IS NULL
                       AND (conversation.type = 'thread'
                         OR (recipient_member.state = 'active') IS TRUE)
                   ELSE reminder.status = 'active'
                     AND reminder.reminder_revision =
                           (event.payload #>> '{reminder,revision}')::bigint
                     AND reminder.materialized_revision =
                           reminder.reminder_revision
                     AND reminder.materialized_source_event_id = event.event_id
                     AND event.payload #>> '{reminder,userId}' =
                           delivery.recipient_host_user_id
                     AND (
                       (
                         conversation.type = 'channel'
                         AND conversation.visibility = 'public'
                       )
                       OR recipient_member.state = 'active'
                     )
                 END AS recipient_eligible`,
        [
          normalized.batchSize,
          leaseToken,
          normalized.leaseDurationMs,
          normalized.maxAttempts,
          injectedTime(),
        ],
      );

      claimedCount = claimed.rows.length;
      for (const row of claimed.rows) {
        const dueAt =
          row.due_at instanceof Date
            ? row.due_at.getTime()
            : new Date(row.due_at).getTime();
        if (Number.isFinite(dueAt)) {
          oldestDueAt = Math.min(oldestDueAt ?? dueAt, dueAt);
        }
      }

      if (claimedCount === 0) {
        emit("empty");
        return {
          materialized: materializedCount,
          claimed: 0,
          delivered: 0,
          suppressed: 0,
          failed: 0,
        };
      }

      const outcomes = await Promise.all(
        claimed.rows.map((row) => deliver(row, leaseToken)),
      );
      for (const outcome of outcomes) {
        failureClassCounts[outcome.failureClass] += 1;
        if (outcome.status === "delivered") deliveredCount += 1;
        if (outcome.status === "suppressed") suppressedCount += 1;
        if (outcome.status === "failed") failedCount += 1;
      }
      const result = {
        materialized: materializedCount,
        claimed: claimedCount,
        delivered: deliveredCount,
        suppressed: suppressedCount,
        failed: failedCount,
      };
      emit(
        notificationBatchOutcomeStatus(
          claimedCount,
          deliveredCount,
          suppressedCount,
          failedCount,
        ),
      );
      return result;
    } catch (error) {
      const unaccountedDeliveries = Math.max(
        0,
        claimedCount - deliveredCount - suppressedCount - failedCount,
      );
      failedCount += unaccountedDeliveries;
      failureClassCounts[activeFailureClass] += Math.max(
        1,
        unaccountedDeliveries,
      );
      emit("failed");
      throw error;
    }
  };

  const runOnce = (): Promise<ChatNotificationBatchResult> => {
    currentBatch ??= executeBatch().finally(() => {
      currentBatch = undefined;
    });
    return currentBatch;
  };

  const waitForNextPoll = (): Promise<void> =>
    new Promise<void>((resolve) => {
      wakePolling = resolve;
      wakeTimer = setTimeout(resolve, normalized.pollIntervalMs);
    }).finally(() => {
      if (wakeTimer !== undefined) clearTimeout(wakeTimer);
      wakeTimer = undefined;
      wakePolling = undefined;
    });

  const poll = async (): Promise<void> => {
    while (!stopped) {
      let batch: ChatNotificationBatchResult | undefined;
      try {
        batch = await runOnce();
      } catch (error) {
        reportError(error);
      }
      if (stopped) break;
      if (batch?.claimed !== normalized.batchSize) await waitForNextPoll();
    }
    running = false;
  };

  const dispatcher: ChatNotificationDispatcher = {
    get running() {
      return running;
    },
    get stopped() {
      return stopped;
    },
    start() {
      if (running || stopped) return;
      running = true;
      loopPromise = Promise.resolve().then(poll);
    },
    runOnce,
    stop() {
      stopPromise ??= (async () => {
        stopped = true;
        if (wakeTimer !== undefined) clearTimeout(wakeTimer);
        wakePolling?.();
        await loopPromise;
        await currentBatch;
        running = false;
      })();
      return stopPromise;
    },
  };

  return Object.freeze(dispatcher);
}
