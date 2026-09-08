import {
  DEFAULT_POSTGRES_SCHEMA,
  validatePostgresSchema,
  type PostgresMigrationDatabase,
} from "./postgres-migrations.js";

export const DEFAULT_POSTGRES_MAINTENANCE_POLL_INTERVAL_MS = 60_000;
export const DEFAULT_EXPIRED_IDEMPOTENCY_KEY_BATCH_SIZE = 100;
export const DEFAULT_EXPIRED_OUTBOX_EVENT_BATCH_SIZE = 100;
export const DEFAULT_EXPIRED_PENDING_ATTACHMENT_BATCH_SIZE = 100;

export type PostgresMaintenanceJob = () => unknown | Promise<unknown>;

export interface PostgresMaintenanceBatchResult {
  readonly succeeded: number;
  readonly failed: number;
}

export type PostgresMaintenanceBatchOutcomeStatus =
  | "empty"
  | "success"
  | "partial_failure"
  | "failed";

/** Aggregate-only diagnostics for one completed maintenance batch. */
export interface PostgresMaintenanceBatchOutcome
  extends PostgresMaintenanceBatchResult {
  readonly configuredJobs: number;
  readonly durationMs: number;
  readonly status: PostgresMaintenanceBatchOutcomeStatus;
}

export type PostgresMaintenanceBatchListener = (
  outcome: PostgresMaintenanceBatchOutcome,
) => void | Promise<void>;

export interface ExpiredIdempotencyKeyIdentity {
  readonly expiresAt: Date;
  readonly tenantId: string;
  readonly userId: string;
  readonly operationName: string;
  readonly clientKey: string;
}

export interface ExpiredIdempotencyKeyCleanupResult {
  readonly deletedCount: number;
  /** Bounded identity metadata in the exact order selected for deletion. */
  readonly deleted: readonly ExpiredIdempotencyKeyIdentity[];
}

export interface ExpiredIdempotencyKeyMaintenanceJobOptions {
  readonly database: Pick<PostgresMigrationDatabase, "query">;
  readonly schema?: string;
  readonly batchSize?: number;
}

export type ExpiredIdempotencyKeyMaintenanceJob =
  () => Promise<ExpiredIdempotencyKeyCleanupResult>;

export interface ExpiredOutboxEventIdentity {
  readonly expiresAt: string;
  readonly replayPosition: number;
  readonly tenantId: string;
  readonly eventId: string;
}

export interface ExpiredOutboxEventCleanupResult {
  readonly deletedCount: number;
  readonly deletedDeliveryCount: number;
  /** Bounded parent identity metadata in expiry/replay order. */
  readonly deleted: readonly ExpiredOutboxEventIdentity[];
}

export interface ExpiredOutboxEventMaintenanceJobOptions {
  readonly database: Pick<PostgresMigrationDatabase, "connect">;
  readonly schema?: string;
  readonly batchSize?: number;
}

export type ExpiredOutboxEventMaintenanceJob =
  () => Promise<ExpiredOutboxEventCleanupResult>;

/** Public, storage-key-free identity for one expired attachment transition. */
export interface ExpiredPendingAttachmentIdentity {
  readonly expiresAt: string;
  readonly tenantId: string;
  readonly attachmentId: string;
}

export interface ExpiredPendingAttachmentMaintenanceResult {
  readonly abandonedCount: number;
  readonly cleanupDeliveryCount: number;
  /** Bounded identity metadata in the exact order selected for transition. */
  readonly abandoned: readonly ExpiredPendingAttachmentIdentity[];
}

export interface ExpiredPendingAttachmentMaintenanceJobOptions {
  readonly database: Pick<PostgresMigrationDatabase, "connect">;
  readonly schema?: string;
  readonly batchSize?: number;
}

export type ExpiredPendingAttachmentMaintenanceJob =
  () => Promise<ExpiredPendingAttachmentMaintenanceResult>;

export interface PostgresMaintenanceJobBatchOptions {
  readonly batchSize?: number;
}

/** Host-facing configuration for the server-owned PostgreSQL maintenance loop. */
export interface ChatPostgresMaintenanceOptions {
  readonly pollIntervalMs?: number;
  readonly expiredIdempotencyKeys?: PostgresMaintenanceJobBatchOptions;
  readonly expiredOutboxEvents?: PostgresMaintenanceJobBatchOptions;
  readonly expiredPendingAttachments?: PostgresMaintenanceJobBatchOptions;
  readonly onError?: (error: unknown, job: PostgresMaintenanceJob) => void;
  readonly onBatch?: PostgresMaintenanceBatchListener;
}

export interface NormalizedChatPostgresMaintenanceOptions {
  readonly pollIntervalMs: number;
  readonly expiredIdempotencyKeys: Readonly<{ readonly batchSize: number }>;
  readonly expiredOutboxEvents: Readonly<{ readonly batchSize: number }>;
  readonly expiredPendingAttachments: Readonly<{ readonly batchSize: number }>;
  readonly onError:
    | ((error: unknown, job: PostgresMaintenanceJob) => void)
    | undefined;
  readonly onBatch: PostgresMaintenanceBatchListener | undefined;
}

export interface PostgresMaintenanceOptions {
  /** Fixed, ordered set of bounded jobs to execute during each batch. */
  readonly jobs: readonly PostgresMaintenanceJob[];
  readonly pollIntervalMs?: number;
  /** Receives individual job failures without stopping the batch or poll loop. */
  readonly onError?: (error: unknown, job: PostgresMaintenanceJob) => void;
  /** Receives immutable, aggregate-only diagnostics for each completed batch. */
  readonly onBatch?: PostgresMaintenanceBatchListener;
}

export interface PostgresMaintenance {
  readonly running: boolean;
  readonly stopped: boolean;
  /** Starts background polling on a later microtask. Idempotent. */
  start(): void;
  /** Runs the fixed job list sequentially, sharing any active batch. */
  runOnce(): Promise<PostgresMaintenanceBatchResult>;
  /** Stops future polling and waits for an in-flight batch. Idempotent. */
  stop(): Promise<void>;
}

const validatePollInterval = (value: unknown): number => {
  const resolved = value ?? DEFAULT_POSTGRES_MAINTENANCE_POLL_INTERVAL_MS;
  if (!Number.isSafeInteger(resolved) || (resolved as number) < 0) {
    throw new TypeError(
      "postgresMaintenance.pollIntervalMs must be a non-negative safe integer",
    );
  }
  return resolved as number;
};

const validateBatchSize = (value: unknown): number => {
  const resolved = value ?? DEFAULT_EXPIRED_IDEMPOTENCY_KEY_BATCH_SIZE;
  if (!Number.isSafeInteger(resolved) || (resolved as number) <= 0) {
    throw new TypeError(
      "expiredIdempotencyKeys.batchSize must be a positive safe integer",
    );
  }
  return resolved as number;
};

const validateOutboxBatchSize = (value: unknown): number => {
  const resolved = value ?? DEFAULT_EXPIRED_OUTBOX_EVENT_BATCH_SIZE;
  if (!Number.isSafeInteger(resolved) || (resolved as number) <= 0) {
    throw new TypeError(
      "expiredOutboxEvents.batchSize must be a positive safe integer",
    );
  }
  return resolved as number;
};

const validatePendingAttachmentBatchSize = (value: unknown): number => {
  const resolved = value ?? DEFAULT_EXPIRED_PENDING_ATTACHMENT_BATCH_SIZE;
  if (!Number.isSafeInteger(resolved) || (resolved as number) <= 0) {
    throw new TypeError(
      "expiredPendingAttachments.batchSize must be a positive safe integer",
    );
  }
  return resolved as number;
};

const requirePlainOptions = (
  value: unknown,
  path: string,
): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
};

const normalizeJobBatchOptions = (
  value: unknown,
  path: string,
  validate: (batchSize: unknown) => number,
): Readonly<{ readonly batchSize: number }> => {
  const options = value === undefined ? {} : requirePlainOptions(value, path);
  for (const field of Object.keys(options)) {
    if (field !== "batchSize") {
      throw new TypeError(`${path}.${field} is not supported`);
    }
  }
  return Object.freeze({ batchSize: validate(options.batchSize) });
};

export function normalizeChatPostgresMaintenanceOptions(
  value: ChatPostgresMaintenanceOptions = {},
): NormalizedChatPostgresMaintenanceOptions {
  const options = requirePlainOptions(value, "postgresMaintenance");
  const allowedFields = new Set([
    "pollIntervalMs",
    "expiredIdempotencyKeys",
    "expiredOutboxEvents",
    "expiredPendingAttachments",
    "onError",
    "onBatch",
  ]);
  for (const field of Object.keys(options)) {
    if (!allowedFields.has(field)) {
      throw new TypeError(`postgresMaintenance.${field} is not supported`);
    }
  }
  if (options.onError !== undefined && typeof options.onError !== "function") {
    throw new TypeError("postgresMaintenance.onError must be a function");
  }
  if (options.onBatch !== undefined && typeof options.onBatch !== "function") {
    throw new TypeError("postgresMaintenance.onBatch must be a function");
  }

  return Object.freeze({
    pollIntervalMs: validatePollInterval(options.pollIntervalMs),
    expiredIdempotencyKeys: normalizeJobBatchOptions(
      options.expiredIdempotencyKeys,
      "expiredIdempotencyKeys",
      validateBatchSize,
    ),
    expiredOutboxEvents: normalizeJobBatchOptions(
      options.expiredOutboxEvents,
      "expiredOutboxEvents",
      validateOutboxBatchSize,
    ),
    expiredPendingAttachments: normalizeJobBatchOptions(
      options.expiredPendingAttachments,
      "expiredPendingAttachments",
      validatePendingAttachmentBatchSize,
    ),
    onError:
      options.onError as NormalizedChatPostgresMaintenanceOptions["onError"],
    onBatch: options.onBatch as PostgresMaintenanceBatchListener | undefined,
  });
}

const quoteIdentifier = (identifier: string): string =>
  `"${identifier.replaceAll('"', '""')}"`;

interface DeletedIdempotencyKeyRow {
  readonly expires_at: Date;
  readonly tenant_id: string;
  readonly user_id: string;
  readonly operation_name: string;
  readonly client_key: string;
}

interface OutboxEventRow {
  readonly expires_at: Date | string;
  readonly replay_position: number | string;
  readonly tenant_id: string;
  readonly event_id: string;
}

interface NotificationDeliveryRow {
  readonly tenant_id: string;
  readonly source_event_id: string;
  readonly recipient_host_user_id: string;
  readonly notification_kind: string;
}

interface InspectedNotificationDeliveryRow extends NotificationDeliveryRow {
  readonly active_lease: boolean;
}

interface ExpiredPendingAttachmentRow {
  readonly expires_at: Date | string;
  readonly tenant_id: string;
  readonly attachment_id: string;
  readonly storage_key: string;
}

const outboxIdentityKey = (row: {
  readonly tenant_id: string;
  readonly event_id: string;
}): string => `${row.tenant_id}\u0000${row.event_id}`;

const deliveryIdentityKey = (row: NotificationDeliveryRow): string =>
  `${row.tenant_id}\u0000${row.source_event_id}\u0000` +
  `${row.recipient_host_user_id}\u0000${row.notification_kind}`;

const toSafeReplayPosition = (value: number | string): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new RangeError("Stored outbox replay position is invalid");
  }
  return parsed;
};

const toIsoTimestamp = (value: Date | string): string => {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new RangeError("Stored outbox expiry timestamp is invalid");
  }
  return parsed.toISOString();
};

/**
 * Creates one bounded, concurrency-safe cleanup job for expired mutation keys.
 * Each invocation is one PostgreSQL statement and never retains response bodies.
 */
export function createExpiredIdempotencyKeyMaintenanceJob(
  options: ExpiredIdempotencyKeyMaintenanceJobOptions,
): ExpiredIdempotencyKeyMaintenanceJob {
  const schema = validatePostgresSchema(options.schema ?? DEFAULT_POSTGRES_SCHEMA);
  const batchSize = validateBatchSize(options.batchSize);
  const table = `${quoteIdentifier(schema)}.chat_idempotency_keys`;

  return async () => {
    const result = (await options.database.query(
      `WITH expired_keys AS MATERIALIZED (
         SELECT expires_at, tenant_id, user_id, operation_name, client_key
         FROM ${table}
         WHERE expires_at <= clock_timestamp()
         ORDER BY expires_at, tenant_id, user_id, operation_name, client_key
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       ),
       deleted_keys AS (
         DELETE FROM ${table} AS stored
         USING expired_keys
         WHERE stored.tenant_id = expired_keys.tenant_id
           AND stored.user_id = expired_keys.user_id
           AND stored.operation_name = expired_keys.operation_name
           AND stored.client_key = expired_keys.client_key
         RETURNING
           stored.expires_at,
           stored.tenant_id,
           stored.user_id,
           stored.operation_name,
           stored.client_key
       )
       SELECT expires_at, tenant_id, user_id, operation_name, client_key
       FROM deleted_keys
       ORDER BY expires_at, tenant_id, user_id, operation_name, client_key`,
      [batchSize],
    )) as { readonly rows: readonly DeletedIdempotencyKeyRow[] };
    const deleted = Object.freeze(
      result.rows.map((row) =>
        Object.freeze({
          expiresAt: row.expires_at,
          tenantId: row.tenant_id,
          userId: row.user_id,
          operationName: row.operation_name,
          clientKey: row.client_key,
        }),
      ),
    );
    return Object.freeze({ deletedCount: deleted.length, deleted });
  };
}

/**
 * Creates one bounded expired-outbox cleanup job. Parent and delivery locks,
 * eligibility rechecking, and child-before-parent deletion share one reserved
 * PostgreSQL connection and transaction.
 */
export function createExpiredOutboxEventMaintenanceJob(
  options: ExpiredOutboxEventMaintenanceJobOptions,
): ExpiredOutboxEventMaintenanceJob {
  const schema = validatePostgresSchema(options.schema ?? DEFAULT_POSTGRES_SCHEMA);
  const batchSize = validateOutboxBatchSize(options.batchSize);
  const prefix = quoteIdentifier(schema);
  const outbox = `${prefix}.chat_outbox_events`;
  const deliveries = `${prefix}.chat_notification_deliveries`;

  return async () => {
    const connection = await options.database.connect();
    let transactionStarted = false;
    let releaseError: Error | undefined;

    try {
      await connection.query("BEGIN");
      transactionStarted = true;

      const candidateResult = (await connection.query(
        `SELECT event.expires_at, event.replay_position,
                event.tenant_id, event.event_id
         FROM ${outbox} AS event
         WHERE event.expires_at <= clock_timestamp()
           AND NOT EXISTS (
             SELECT 1
             FROM ${deliveries} AS active_delivery
             WHERE active_delivery.tenant_id = event.tenant_id
               AND active_delivery.source_event_id = event.event_id
               AND active_delivery.status = 'leased'
               AND active_delivery.lease_expires_at > clock_timestamp()
           )
         ORDER BY event.expires_at, event.replay_position
         LIMIT $1
         FOR UPDATE OF event SKIP LOCKED`,
        [batchSize],
      )) as { readonly rows: readonly OutboxEventRow[] };
      const candidates = candidateResult.rows;

      let eligible: readonly OutboxEventRow[] = candidates;
      if (candidates.length > 0) {
        const tenantIds = candidates.map((row) => row.tenant_id);
        const eventIds = candidates.map((row) => row.event_id);
        const lockedResult = (await connection.query(
          `SELECT delivery.tenant_id, delivery.source_event_id,
                  delivery.recipient_host_user_id, delivery.notification_kind
           FROM ${deliveries} AS delivery
           JOIN unnest($1::text[], $2::text[])
             AS candidate(tenant_id, event_id)
             ON candidate.tenant_id = delivery.tenant_id
            AND candidate.event_id = delivery.source_event_id
           ORDER BY delivery.tenant_id, delivery.source_event_id,
                    delivery.recipient_host_user_id, delivery.notification_kind
           FOR UPDATE OF delivery SKIP LOCKED`,
          [tenantIds, eventIds],
        )) as { readonly rows: readonly NotificationDeliveryRow[] };
        const inspectedResult = (await connection.query(
          `SELECT delivery.tenant_id, delivery.source_event_id,
                  delivery.recipient_host_user_id, delivery.notification_kind,
                  delivery.status = 'leased'
                    AND delivery.lease_expires_at > clock_timestamp()
                    AS active_lease
           FROM ${deliveries} AS delivery
           JOIN unnest($1::text[], $2::text[])
             AS candidate(tenant_id, event_id)
             ON candidate.tenant_id = delivery.tenant_id
            AND candidate.event_id = delivery.source_event_id
           ORDER BY delivery.tenant_id, delivery.source_event_id,
                    delivery.recipient_host_user_id, delivery.notification_kind`,
          [tenantIds, eventIds],
        )) as { readonly rows: readonly InspectedNotificationDeliveryRow[] };
        const locked = new Set(lockedResult.rows.map(deliveryIdentityKey));
        const childrenByParent = new Map<
          string,
          InspectedNotificationDeliveryRow[]
        >();
        for (const row of inspectedResult.rows) {
          const parentKey = `${row.tenant_id}\u0000${row.source_event_id}`;
          const children = childrenByParent.get(parentKey);
          if (children === undefined) {
            childrenByParent.set(parentKey, [row]);
          } else {
            children.push(row);
          }
        }
        eligible = candidates.filter((candidate) =>
          (childrenByParent.get(outboxIdentityKey(candidate)) ?? []).every(
            (delivery) =>
              locked.has(deliveryIdentityKey(delivery)) && !delivery.active_lease,
          ),
        );
      }

      let deletedDeliveryCount = 0;
      let deletedRows: readonly OutboxEventRow[] = [];
      if (eligible.length > 0) {
        const tenantIds = eligible.map((row) => row.tenant_id);
        const eventIds = eligible.map((row) => row.event_id);
        // Settle only the current materialized revision before its delivery is
        // removed, keeping timestamp precision and ordering inside PostgreSQL.
        await connection.query(
          `UPDATE ${prefix}.chat_message_reminders AS reminder
           SET status = 'cancelled',
               reminder_revision = reminder.reminder_revision + 1,
               cancelled_at = GREATEST(statement_timestamp(), reminder.updated_at),
               updated_at = GREATEST(statement_timestamp(), reminder.updated_at)
           FROM ${deliveries} AS delivery
           JOIN unnest($1::text[], $2::text[])
             AS selected(tenant_id, event_id)
             ON delivery.tenant_id = selected.tenant_id
            AND delivery.source_event_id = selected.event_id
           WHERE delivery.notification_kind = 'message.reminder'
             AND reminder.tenant_id = delivery.tenant_id
             AND reminder.user_id = delivery.recipient_host_user_id
             AND reminder.materialized_source_event_id = delivery.source_event_id
             AND reminder.materialized_revision = reminder.reminder_revision
             AND reminder.status = 'active'`,
          [tenantIds, eventIds],
        );
        const deletedDeliveries = await connection.query(
          `DELETE FROM ${deliveries} AS delivery
           USING unnest($1::text[], $2::text[])
             AS selected(tenant_id, event_id)
           WHERE delivery.tenant_id = selected.tenant_id
             AND delivery.source_event_id = selected.event_id`,
          [tenantIds, eventIds],
        );
        deletedDeliveryCount = deletedDeliveries.rowCount ?? 0;

        const replayPositions = eligible.map((row) => row.replay_position);
        const deletedParents = (await connection.query(
          `WITH selected(replay_position) AS (
             SELECT unnest($1::bigint[])
           ),
           deleted_events AS (
             DELETE FROM ${outbox} AS event
             USING selected
             WHERE event.replay_position = selected.replay_position
             RETURNING event.expires_at, event.replay_position,
                       event.tenant_id, event.event_id
           )
           SELECT expires_at, replay_position, tenant_id, event_id
           FROM deleted_events
           ORDER BY expires_at, replay_position`,
          [replayPositions],
        )) as { readonly rows: readonly OutboxEventRow[] };
        deletedRows = deletedParents.rows;
        if (deletedRows.length !== eligible.length) {
          throw new Error("Expired outbox cleanup did not delete every selected event");
        }
      }

      await connection.query("COMMIT");
      transactionStarted = false;

      const deleted = Object.freeze(
        deletedRows.map((row) =>
          Object.freeze({
            expiresAt: toIsoTimestamp(row.expires_at),
            replayPosition: toSafeReplayPosition(row.replay_position),
            tenantId: row.tenant_id,
            eventId: row.event_id,
          }),
        ),
      );
      return Object.freeze({
        deletedCount: deleted.length,
        deletedDeliveryCount,
        deleted,
      });
    } catch (error) {
      if (transactionStarted) {
        try {
          await connection.query("ROLLBACK");
        } catch (rollbackError) {
          releaseError =
            rollbackError instanceof Error
              ? rollbackError
              : new Error("Expired outbox cleanup rollback failed");
          throw new AggregateError(
            [error, rollbackError],
            "Expired outbox cleanup failed and could not be rolled back",
          );
        }
      }
      throw error;
    } finally {
      connection.release(releaseError);
    }
  };
}

/**
 * Abandons one bounded batch of expired pending attachments and durably queues
 * their objects for the separate cleanup dispatcher. Selection, eligibility
 * rechecking, state transition, and enqueue all share one transaction.
 */
export function createExpiredPendingAttachmentMaintenanceJob(
  options: ExpiredPendingAttachmentMaintenanceJobOptions,
): ExpiredPendingAttachmentMaintenanceJob {
  const schema = validatePostgresSchema(
    options.schema ?? DEFAULT_POSTGRES_SCHEMA,
  );
  const batchSize = validatePendingAttachmentBatchSize(options.batchSize);
  const prefix = quoteIdentifier(schema);
  const attachments = `${prefix}.chat_attachments`;
  const deliveries = `${prefix}.chat_attachment_cleanup_deliveries`;

  return async () => {
    const connection = await options.database.connect();
    let transactionStarted = false;
    let releaseError: Error | undefined;

    try {
      await connection.query("BEGIN");
      transactionStarted = true;

      const selectedResult = (await connection.query(
        `SELECT attachment.expires_at,
                attachment.tenant_id,
                attachment.id AS attachment_id,
                attachment.storage_key
         FROM ${attachments} AS attachment
         WHERE attachment.state = 'pending'
           AND attachment.expires_at <= clock_timestamp()
         ORDER BY attachment.expires_at, attachment.tenant_id, attachment.id
         LIMIT $1
         FOR UPDATE OF attachment SKIP LOCKED`,
        [batchSize],
      )) as { readonly rows: readonly ExpiredPendingAttachmentRow[] };

      let transitionedRows: readonly ExpiredPendingAttachmentRow[] = [];
      let cleanupDeliveryCount = 0;
      if (selectedResult.rows.length > 0) {
        const tenantIds = selectedResult.rows.map((row) => row.tenant_id);
        const attachmentIds = selectedResult.rows.map(
          (row) => row.attachment_id,
        );
        const transitionedResult = (await connection.query(
          `WITH transition_time AS (
             SELECT statement_timestamp() AS transitioned_at
           ),
           selected(tenant_id, attachment_id) AS (
             SELECT * FROM unnest($1::text[], $2::text[])
           ),
           transitioned AS (
             UPDATE ${attachments} AS attachment
             SET state = 'abandoned',
                 updated_at = greatest(
                   transition_time.transitioned_at,
                   attachment.updated_at
                 ),
                 abandoned_at = greatest(
                   transition_time.transitioned_at,
                   attachment.updated_at
                 )
             FROM selected, transition_time
             WHERE attachment.tenant_id = selected.tenant_id
               AND attachment.id = selected.attachment_id
               AND attachment.state = 'pending'
               AND attachment.expires_at <= clock_timestamp()
             RETURNING attachment.expires_at,
                       attachment.tenant_id,
                       attachment.id AS attachment_id,
                       attachment.storage_key
           )
           SELECT expires_at, tenant_id, attachment_id, storage_key
           FROM transitioned
           ORDER BY expires_at, tenant_id, attachment_id`,
          [tenantIds, attachmentIds],
        )) as { readonly rows: readonly ExpiredPendingAttachmentRow[] };
        transitionedRows = transitionedResult.rows;

        if (transitionedRows.length > 0) {
          const deliveryTenantIds = transitionedRows.map((row) => row.tenant_id);
          const deliveryAttachmentIds = transitionedRows.map(
            (row) => row.attachment_id,
          );
          const storageKeys = transitionedRows.map((row) => row.storage_key);
          const inserted = await connection.query(
            `WITH delivery_time AS (
               SELECT statement_timestamp() AS queued_at
             )
             INSERT INTO ${deliveries} (
               tenant_id,
               attachment_id,
               storage_key,
               state,
               attempt_count,
               next_attempt_at,
               created_at,
               updated_at
             )
             SELECT selected.tenant_id,
                    selected.attachment_id,
                    selected.storage_key,
                    'pending',
                    0,
                    delivery_time.queued_at,
                    delivery_time.queued_at,
                    delivery_time.queued_at
             FROM unnest($1::text[], $2::text[], $3::text[])
               AS selected(tenant_id, attachment_id, storage_key)
             CROSS JOIN delivery_time
             WHERE true
             ON CONFLICT (tenant_id, attachment_id) DO NOTHING`,
            [deliveryTenantIds, deliveryAttachmentIds, storageKeys],
          );
          cleanupDeliveryCount = inserted.rowCount ?? 0;
          if (cleanupDeliveryCount !== transitionedRows.length) {
            throw new Error("Attachment cleanup delivery invariant failed");
          }
        }
      }

      await connection.query("COMMIT");
      transactionStarted = false;

      const abandoned = Object.freeze(
        transitionedRows.map((row) =>
          Object.freeze({
            expiresAt: toIsoTimestamp(row.expires_at),
            tenantId: row.tenant_id,
            attachmentId: row.attachment_id,
          }),
        ),
      );
      return Object.freeze({
        abandonedCount: abandoned.length,
        cleanupDeliveryCount,
        abandoned,
      });
    } catch {
      if (transactionStarted) {
        try {
          await connection.query("ROLLBACK");
        } catch {
          releaseError = new Error(
            "Expired pending attachment maintenance rollback failed",
          );
          throw new AggregateError(
            [
              new Error("Expired pending attachment maintenance failed"),
              releaseError,
            ],
            "Expired pending attachment maintenance failed and could not be rolled back",
          );
        }
      }
      throw new Error("Expired pending attachment maintenance failed");
    } finally {
      connection.release(releaseError);
    }
  };
}

export function createPostgresMaintenance(
  options: PostgresMaintenanceOptions,
): PostgresMaintenance {
  if (!Array.isArray(options.jobs)) {
    throw new TypeError("postgresMaintenance.jobs must be an array");
  }
  const jobs = Object.freeze([...options.jobs]);
  for (const job of jobs) {
    if (typeof job !== "function") {
      throw new TypeError("postgresMaintenance.jobs must contain functions");
    }
  }
  const pollIntervalMs = validatePollInterval(options.pollIntervalMs);
  if (options.onError !== undefined && typeof options.onError !== "function") {
    throw new TypeError("postgresMaintenance.onError must be a function");
  }
  if (options.onBatch !== undefined && typeof options.onBatch !== "function") {
    throw new TypeError("postgresMaintenance.onBatch must be a function");
  }

  let running = false;
  let stopped = false;
  let loopPromise: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  let currentBatch: Promise<PostgresMaintenanceBatchResult> | undefined;
  let wakeTimer: ReturnType<typeof setTimeout> | undefined;
  let wakePolling: (() => void) | undefined;

  const reportError = (error: unknown, job: PostgresMaintenanceJob): void => {
    try {
      options.onError?.(error, job);
    } catch {
      // Diagnostics must never interrupt maintenance or make shutdown reject.
    }
  };

  const reportBatch = (outcome: PostgresMaintenanceBatchOutcome): void => {
    try {
      void Promise.resolve(options.onBatch?.(outcome)).catch(() => undefined);
    } catch {
      // Telemetry must never affect maintenance, polling, or shutdown.
    }
  };

  const batchStatus = (
    succeeded: number,
    failed: number,
  ): PostgresMaintenanceBatchOutcomeStatus => {
    if (jobs.length === 0) return "empty";
    if (failed === 0) return "success";
    return succeeded === 0 ? "failed" : "partial_failure";
  };

  const executeBatch = async (): Promise<PostgresMaintenanceBatchResult> => {
    const startedAt = Date.now();
    let succeeded = 0;
    let failed = 0;
    for (const job of jobs) {
      try {
        await job();
        succeeded += 1;
      } catch (error) {
        failed += 1;
        reportError(error, job);
      }
    }
    const elapsedMs = Date.now() - startedAt;
    reportBatch(
      Object.freeze({
        configuredJobs: jobs.length,
        succeeded,
        failed,
        durationMs: Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0,
        status: batchStatus(succeeded, failed),
      }),
    );
    return { succeeded, failed };
  };

  const runOnce = (): Promise<PostgresMaintenanceBatchResult> => {
    currentBatch ??= executeBatch().finally(() => {
      currentBatch = undefined;
    });
    return currentBatch;
  };

  const waitForNextPoll = (): Promise<void> =>
    new Promise<void>((resolve) => {
      wakePolling = resolve;
      wakeTimer = setTimeout(resolve, pollIntervalMs);
      wakeTimer.unref?.();
    }).finally(() => {
      if (wakeTimer !== undefined) {
        clearTimeout(wakeTimer);
        wakeTimer = undefined;
      }
      wakePolling = undefined;
    });

  const poll = async (): Promise<void> => {
    while (!stopped) {
      await runOnce();
      if (!stopped) {
        await waitForNextPoll();
      }
    }
    running = false;
  };

  const maintenance: PostgresMaintenance = {
    get running() {
      return running;
    },
    get stopped() {
      return stopped;
    },
    start() {
      if (running || stopped) {
        return;
      }
      running = true;
      loopPromise = Promise.resolve().then(poll);
    },
    runOnce,
    stop() {
      stopPromise ??= (async () => {
        stopped = true;
        if (wakeTimer !== undefined) {
          clearTimeout(wakeTimer);
          wakeTimer = undefined;
        }
        wakePolling?.();
        await loopPromise;
        await currentBatch;
        running = false;
      })();
      return stopPromise;
    },
  };

  return Object.freeze(maintenance);
}
