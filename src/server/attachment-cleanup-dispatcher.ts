import { randomUUID } from "node:crypto";

import type {
  ChatStorageAdapter,
  ChatStorageObjectInput,
} from "./contracts.js";
import {
  DEFAULT_POSTGRES_SCHEMA,
  validatePostgresSchema,
  type PostgresMigrationConnection,
  type PostgresMigrationDatabase,
} from "./postgres-migrations.js";

export const DEFAULT_CHAT_ATTACHMENT_CLEANUP_BATCH_SIZE = 25;
export const DEFAULT_CHAT_ATTACHMENT_CLEANUP_POLL_INTERVAL_MS = 250;
export const DEFAULT_CHAT_ATTACHMENT_CLEANUP_LEASE_DURATION_MS = 30_000;
export const DEFAULT_CHAT_ATTACHMENT_CLEANUP_MAX_ATTEMPTS = 5;
export const DEFAULT_CHAT_ATTACHMENT_CLEANUP_INITIAL_RETRY_DELAY_MS = 1_000;
export const DEFAULT_CHAT_ATTACHMENT_CLEANUP_MAX_RETRY_DELAY_MS = 60_000;

export type ChatAttachmentCleanupProviderFailureClass =
  | "retryable"
  | "terminal";

/**
 * The only provider diagnostic consumed by the dispatcher. The deliberately
 * fixed message prevents provider responses or credentials from crossing the
 * storage boundary through worker telemetry.
 */
export class ChatAttachmentCleanupProviderError extends Error {
  public constructor(
    public readonly failureClass: ChatAttachmentCleanupProviderFailureClass,
  ) {
    super(`Attachment cleanup provider failed: ${failureClass}`);
    this.name = "ChatAttachmentCleanupProviderError";
  }
}

export type ChatAttachmentCleanupDispatcherErrorClass =
  | "database"
  | "configuration";

/** A fixed, low-cardinality error safe for host callbacks and logs. */
export class ChatAttachmentCleanupDispatcherError extends Error {
  public constructor(
    public readonly failureClass: ChatAttachmentCleanupDispatcherErrorClass,
  ) {
    super(`Attachment cleanup dispatcher failed: ${failureClass}`);
    this.name = "ChatAttachmentCleanupDispatcherError";
  }
}

export type ChatAttachmentCleanupBatchOutcomeStatus =
  | "empty"
  | "succeeded"
  | "partially_failed"
  | "failed";

/** Aggregate-only diagnostics for one completed cleanup batch attempt. */
export interface ChatAttachmentCleanupBatchOutcome {
  readonly claimed: number;
  readonly delivered: number;
  readonly failed: number;
  readonly retried: number;
  readonly terminal: number;
  readonly exhausted: number;
  readonly staleSettlements: number;
  readonly durationMs: number;
  readonly oldestReadyAgeMs: number | null;
  readonly outcome: ChatAttachmentCleanupBatchOutcomeStatus;
}

export type ChatAttachmentCleanupBatchListener = (
  outcome: ChatAttachmentCleanupBatchOutcome,
) => void | Promise<void>;

export interface ChatAttachmentCleanupDispatcherOptions {
  readonly batchSize?: number;
  readonly pollIntervalMs?: number;
  readonly leaseDurationMs?: number;
  readonly maxAttempts?: number;
  readonly initialRetryDelayMs?: number;
  readonly maxRetryDelayMs?: number;
  /** Receives only fixed, secret-safe worker failure classifications. */
  readonly onError?: (
    error: ChatAttachmentCleanupDispatcherError,
  ) => void | Promise<void>;
  /** Receives one immutable aggregate for each completed batch attempt. */
  readonly onBatch?: ChatAttachmentCleanupBatchListener;
  /** Monotonic millisecond clock used only for batch duration measurement. */
  readonly monotonicNow?: () => number;
}

export interface NormalizedChatAttachmentCleanupDispatcherOptions {
  readonly batchSize: number;
  readonly pollIntervalMs: number;
  readonly leaseDurationMs: number;
  readonly maxAttempts: number;
  readonly initialRetryDelayMs: number;
  readonly maxRetryDelayMs: number;
  readonly onError: ChatAttachmentCleanupDispatcherOptions["onError"] | undefined;
  readonly onBatch: ChatAttachmentCleanupBatchListener | undefined;
  readonly monotonicNow: () => number;
}

export interface CreateChatAttachmentCleanupDispatcherOptions
  extends ChatAttachmentCleanupDispatcherOptions {
  readonly database: PostgresMigrationDatabase;
  readonly adapter: ChatStorageAdapter;
  readonly schema?: string;
  /** Primarily useful for deterministic tests and worker correlation. */
  readonly createLeaseOwner?: () => string;
  /** Injected wall clock for deterministic due, lease, and retry decisions. */
  readonly now?: () => Date;
}

export interface ChatAttachmentCleanupBatchResult {
  readonly claimed: number;
  readonly delivered: number;
  readonly failed: number;
}

export interface ChatAttachmentCleanupDispatcher {
  readonly running: boolean;
  readonly stopped: boolean;
  start(): void;
  runOnce(): Promise<ChatAttachmentCleanupBatchResult>;
  /** Stops polling and awaits only this dispatcher's in-flight batch. */
  stop(): Promise<void>;
}

interface StoredCleanupDelivery {
  readonly tenant_id: unknown;
  readonly attachment_id: unknown;
  readonly storage_key: unknown;
  readonly uploader_user_id: unknown;
  readonly attempt_count: string | number;
  readonly ready_at: Date | string;
}

type DeliveryOutcome =
  | "delivered"
  | "retried"
  | "terminal"
  | "exhausted"
  | "stale";

const RETRYABLE_ERROR_CODE = "storage.retryable";
const UNKNOWN_ERROR_CODE = "storage.unknown";
const TERMINAL_ERROR_CODE = "storage.terminal";
const EXHAUSTED_ERROR_CODE = "storage.exhausted";
const INVALID_DELIVERY_ERROR_CODE = "dispatcher.invalid_delivery";
const EMPTY_ROLES: readonly string[] = Object.freeze([]);

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

export function normalizeChatAttachmentCleanupDispatcherOptions(
  options: ChatAttachmentCleanupDispatcherOptions = {},
): NormalizedChatAttachmentCleanupDispatcherOptions {
  const initialRetryDelayMs = nonNegativeInteger(
    options.initialRetryDelayMs,
    DEFAULT_CHAT_ATTACHMENT_CLEANUP_INITIAL_RETRY_DELAY_MS,
    "attachmentCleanup.initialRetryDelayMs",
  );
  const maxRetryDelayMs = nonNegativeInteger(
    options.maxRetryDelayMs,
    DEFAULT_CHAT_ATTACHMENT_CLEANUP_MAX_RETRY_DELAY_MS,
    "attachmentCleanup.maxRetryDelayMs",
  );
  if (maxRetryDelayMs < initialRetryDelayMs) {
    throw new TypeError(
      "attachmentCleanup.maxRetryDelayMs must be greater than or equal to attachmentCleanup.initialRetryDelayMs",
    );
  }
  if (options.onError !== undefined && typeof options.onError !== "function") {
    throw new TypeError("attachmentCleanup.onError must be a function");
  }
  if (options.onBatch !== undefined && typeof options.onBatch !== "function") {
    throw new TypeError("attachmentCleanup.onBatch must be a function");
  }
  if (
    options.monotonicNow !== undefined &&
    typeof options.monotonicNow !== "function"
  ) {
    throw new TypeError("attachmentCleanup.monotonicNow must be a function");
  }

  return Object.freeze({
    batchSize: positiveInteger(
      options.batchSize,
      DEFAULT_CHAT_ATTACHMENT_CLEANUP_BATCH_SIZE,
      "attachmentCleanup.batchSize",
    ),
    pollIntervalMs: nonNegativeInteger(
      options.pollIntervalMs,
      DEFAULT_CHAT_ATTACHMENT_CLEANUP_POLL_INTERVAL_MS,
      "attachmentCleanup.pollIntervalMs",
    ),
    leaseDurationMs: positiveInteger(
      options.leaseDurationMs,
      DEFAULT_CHAT_ATTACHMENT_CLEANUP_LEASE_DURATION_MS,
      "attachmentCleanup.leaseDurationMs",
    ),
    maxAttempts: positiveInteger(
      options.maxAttempts,
      DEFAULT_CHAT_ATTACHMENT_CLEANUP_MAX_ATTEMPTS,
      "attachmentCleanup.maxAttempts",
    ),
    initialRetryDelayMs,
    maxRetryDelayMs,
    onError: options.onError,
    onBatch: options.onBatch,
    monotonicNow: options.monotonicNow ?? (() => performance.now()),
  });
}

const quoteIdentifier = (identifier: string): string =>
  `"${identifier.replaceAll('"', '""')}"`;

const boundedString = (
  value: unknown,
  maximumBytes: number,
): value is string =>
  typeof value === "string" &&
  Buffer.byteLength(value, "utf8") >= 1 &&
  Buffer.byteLength(value, "utf8") <= maximumBytes &&
  /\S/u.test(value);

const toAttempt = (value: string | number): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error("Stored cleanup delivery is malformed");
  }
  return parsed;
};

const toStorageObjectInput = (
  row: StoredCleanupDelivery,
): ChatStorageObjectInput => {
  if (
    !boundedString(row.tenant_id, 255) ||
    !boundedString(row.attachment_id, 255) ||
    !boundedString(row.storage_key, 2_048) ||
    !boundedString(row.uploader_user_id, 255)
  ) {
    throw new Error("Stored cleanup delivery is malformed");
  }
  const actor = Object.freeze({
    tenantId: row.tenant_id as ChatStorageObjectInput["actor"]["tenantId"],
    userId: row.uploader_user_id as ChatStorageObjectInput["actor"]["userId"],
    roles: EMPTY_ROLES,
  });
  return Object.freeze({
    actor,
    attachmentId: row.attachment_id as ChatStorageObjectInput["attachmentId"],
    objectKey: row.storage_key,
  });
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

const boundedMilliseconds = (value: number): number =>
  Number.isFinite(value)
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, value))
    : 0;

const oldestReadyAge = (
  oldestReadyAt: number | undefined,
  completedAt: number | null,
): number | null =>
  oldestReadyAt === undefined || completedAt === null
    ? null
    : Number.isFinite(completedAt - oldestReadyAt)
      ? boundedMilliseconds(completedAt - oldestReadyAt)
      : null;

const batchOutcomeStatus = (
  claimed: number,
  delivered: number,
  failed: number,
): ChatAttachmentCleanupBatchOutcomeStatus => {
  if (claimed === 0) return "empty";
  if (failed === 0) return "succeeded";
  return delivered === 0 ? "failed" : "partially_failed";
};

const safeDispatcherError = (
  failureClass: ChatAttachmentCleanupDispatcherErrorClass,
): ChatAttachmentCleanupDispatcherError =>
  new ChatAttachmentCleanupDispatcherError(failureClass);

export function createChatAttachmentCleanupDispatcher(
  options: CreateChatAttachmentCleanupDispatcherOptions,
): ChatAttachmentCleanupDispatcher {
  const normalized = normalizeChatAttachmentCleanupDispatcherOptions(options);
  const schema = validatePostgresSchema(options.schema ?? DEFAULT_POSTGRES_SCHEMA);
  const prefix = quoteIdentifier(schema);
  const deliveries = `${prefix}.chat_attachment_cleanup_deliveries`;
  const attachments = `${prefix}.chat_attachments`;
  const createLeaseOwner = options.createLeaseOwner ?? randomUUID;
  const now = options.now ?? (() => new Date());

  if (
    typeof options.database !== "object" ||
    options.database === null ||
    typeof options.database.query !== "function" ||
    typeof options.database.connect !== "function"
  ) {
    throw new TypeError("attachmentCleanup.database must support query and connect");
  }
  if (
    typeof options.adapter !== "object" ||
    options.adapter === null ||
    typeof options.adapter.deleteObject !== "function"
  ) {
    throw new TypeError("attachmentCleanup.adapter must implement deleteObject");
  }
  if (typeof createLeaseOwner !== "function") {
    throw new TypeError("attachmentCleanup.createLeaseOwner must be a function");
  }
  if (typeof now !== "function") {
    throw new TypeError("attachmentCleanup.now must be a function");
  }

  const currentTime = (): Date => {
    const value = now();
    if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) {
      throw new TypeError("attachmentCleanup.now must return a valid Date");
    }
    return value;
  };
  const injectedTime = (): Date | null =>
    options.now === undefined ? null : currentTime();

  let running = false;
  let stopped = false;
  let loopPromise: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  let currentBatch: Promise<ChatAttachmentCleanupBatchResult> | undefined;
  let wakeTimer: ReturnType<typeof setTimeout> | undefined;
  let wakePolling: (() => void) | undefined;

  const reportError = (error: ChatAttachmentCleanupDispatcherError): void => {
    try {
      void Promise.resolve(normalized.onError?.(error)).catch(() => undefined);
    } catch {
      // Diagnostics must never terminate polling or make shutdown reject.
    }
  };

  const reportBatch = (outcome: ChatAttachmentCleanupBatchOutcome): void => {
    try {
      void Promise.resolve(normalized.onBatch?.(outcome)).catch(() => undefined);
    } catch {
      // Telemetry must never affect delivery, polling, or shutdown.
    }
  };

  const telemetryTime = (): number | null => {
    try {
      const value = normalized.monotonicNow();
      return Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  };

  const telemetryWallTime = (): number | null => {
    try {
      return currentTime().valueOf();
    } catch {
      return null;
    }
  };

  const rollback = async (
    connection: PostgresMigrationConnection,
  ): Promise<void> => {
    try {
      await connection.query("ROLLBACK");
    } catch {
      // The original safe classification remains the only emitted detail.
    }
  };

  const claimBatch = async (
    leaseOwner: string,
  ): Promise<readonly StoredCleanupDelivery[]> => {
    const connection = await options.database.connect().catch(() => {
      throw safeDispatcherError("database");
    });
    let transactionStarted = false;
    try {
      await connection.query("BEGIN");
      transactionStarted = true;
      const claimed = await connection.query<StoredCleanupDelivery>(
        `WITH moment AS MATERIALIZED (
           SELECT COALESCE($5::timestamptz, clock_timestamp()) AS at
         ), claimable AS MATERIALIZED (
           SELECT candidate.tenant_id,
                  candidate.attachment_id,
                  CASE WHEN candidate.state = 'leased'
                       THEN candidate.lease_expires_at
                       ELSE candidate.next_attempt_at
                  END AS ready_at
           FROM ${deliveries} AS candidate
           CROSS JOIN moment
           WHERE (
             candidate.state = 'pending'
             AND candidate.next_attempt_at <= moment.at
             AND candidate.attempt_count < $4
           ) OR (
             candidate.state = 'failed'
             AND candidate.next_attempt_at <= moment.at
             AND candidate.attempt_count < $4
             AND candidate.last_error_code IN (
               '${RETRYABLE_ERROR_CODE}', '${UNKNOWN_ERROR_CODE}'
             )
           ) OR (
             candidate.state = 'leased'
             AND candidate.lease_expires_at <= moment.at
           )
           ORDER BY ready_at, candidate.tenant_id, candidate.attachment_id
           FOR UPDATE OF candidate SKIP LOCKED
           LIMIT $1
         )
         UPDATE ${deliveries} AS delivery
         SET state = 'leased',
             attempt_count = delivery.attempt_count + 1,
             lease_owner = $2,
             lease_expires_at = moment.at
               + ($3::double precision * interval '1 millisecond'),
             last_error_code = NULL,
             updated_at = moment.at
         FROM claimable
         CROSS JOIN moment
         JOIN ${attachments} AS attachment
           ON attachment.tenant_id = claimable.tenant_id
          AND attachment.id = claimable.attachment_id
         WHERE delivery.tenant_id = claimable.tenant_id
           AND delivery.attachment_id = claimable.attachment_id
         RETURNING delivery.tenant_id,
                   delivery.attachment_id,
                   delivery.storage_key,
                   attachment.uploader_user_id,
                   delivery.attempt_count,
                   claimable.ready_at`,
        [
          normalized.batchSize,
          leaseOwner,
          normalized.leaseDurationMs,
          normalized.maxAttempts,
          injectedTime(),
        ],
      );
      await connection.query("COMMIT");
      transactionStarted = false;
      return claimed.rows;
    } catch (error) {
      if (transactionStarted) await rollback(connection);
      if (error instanceof ChatAttachmentCleanupDispatcherError) throw error;
      throw safeDispatcherError("database");
    } finally {
      try {
        connection.release();
      } catch {
        throw safeDispatcherError("database");
      }
    }
  };

  const finishDelivered = async (
    row: StoredCleanupDelivery,
    leaseOwner: string,
    attempt: number,
  ): Promise<boolean> => {
    try {
      const result = await options.database.query(
        `WITH moment AS (
           SELECT COALESCE($5::timestamptz, clock_timestamp()) AS at
         )
         UPDATE ${deliveries} AS delivery
         SET state = 'delivered',
             lease_owner = NULL,
             lease_expires_at = NULL,
             last_error_code = NULL,
             updated_at = moment.at,
             delivered_at = moment.at
         FROM moment
         WHERE delivery.tenant_id = $1
           AND delivery.attachment_id = $2
           AND delivery.state = 'leased'
           AND delivery.lease_owner = $3
           AND delivery.attempt_count = $4
         RETURNING delivery.attachment_id`,
        [row.tenant_id, row.attachment_id, leaseOwner, attempt, injectedTime()],
      );
      return result.rowCount === 1;
    } catch {
      throw safeDispatcherError("database");
    }
  };

  const finishFailed = async (
    row: StoredCleanupDelivery,
    leaseOwner: string,
    attempt: number,
    failureClass: ChatAttachmentCleanupProviderFailureClass | "unknown" | "invalid",
  ): Promise<{ readonly settled: boolean; readonly outcome: DeliveryOutcome }> => {
    const terminal = failureClass === "terminal" || failureClass === "invalid";
    const exhausted = !terminal && attempt >= normalized.maxAttempts;
    const errorCode = terminal
      ? failureClass === "invalid"
        ? INVALID_DELIVERY_ERROR_CODE
        : TERMINAL_ERROR_CODE
      : exhausted
        ? EXHAUSTED_ERROR_CODE
        : failureClass === "unknown"
          ? UNKNOWN_ERROR_CODE
          : RETRYABLE_ERROR_CODE;
    const delayMs = terminal || exhausted
      ? 0
      : retryDelay(
          attempt,
          normalized.initialRetryDelayMs,
          normalized.maxRetryDelayMs,
        );
    try {
      const result = await options.database.query(
        `WITH moment AS (
           SELECT COALESCE($7::timestamptz, clock_timestamp()) AS at
         )
         UPDATE ${deliveries} AS delivery
         SET state = 'failed',
             next_attempt_at = moment.at
               + ($6::double precision * interval '1 millisecond'),
             lease_owner = NULL,
             lease_expires_at = NULL,
             last_error_code = $5,
             updated_at = moment.at
         FROM moment
         WHERE delivery.tenant_id = $1
           AND delivery.attachment_id = $2
           AND delivery.state = 'leased'
           AND delivery.lease_owner = $3
           AND delivery.attempt_count = $4
         RETURNING delivery.attachment_id`,
        [
          row.tenant_id,
          row.attachment_id,
          leaseOwner,
          attempt,
          errorCode,
          delayMs,
          injectedTime(),
        ],
      );
      return Object.freeze({
        settled: result.rowCount === 1,
        outcome: terminal ? "terminal" : exhausted ? "exhausted" : "retried",
      });
    } catch {
      throw safeDispatcherError("database");
    }
  };

  const deleteObject = async (
    row: StoredCleanupDelivery,
    leaseOwner: string,
  ): Promise<DeliveryOutcome> => {
    let attempt: number;
    try {
      attempt = toAttempt(row.attempt_count);
    } catch {
      throw safeDispatcherError("database");
    }
    let input: ChatStorageObjectInput;
    try {
      input = toStorageObjectInput(row);
    } catch {
      const result = await finishFailed(row, leaseOwner, attempt, "invalid");
      return result.settled ? result.outcome : "stale";
    }

    try {
      await options.adapter.deleteObject(input);
    } catch (error) {
      const failureClass =
        error instanceof ChatAttachmentCleanupProviderError
          ? error.failureClass
          : "unknown";
      const result = await finishFailed(
        row,
        leaseOwner,
        attempt,
        failureClass,
      );
      return result.settled ? result.outcome : "stale";
    }
    return (await finishDelivered(row, leaseOwner, attempt))
      ? "delivered"
      : "stale";
  };

  const executeBatch = async (): Promise<ChatAttachmentCleanupBatchResult> => {
    const startedAt = telemetryTime();
    let claimedCount = 0;
    let deliveredCount = 0;
    let failedCount = 0;
    let retriedCount = 0;
    let terminalCount = 0;
    let exhaustedCount = 0;
    let staleSettlementCount = 0;
    let oldestReadyAt: number | undefined;
    let emitted = false;

    const emit = (outcome: ChatAttachmentCleanupBatchOutcomeStatus): void => {
      if (emitted) return;
      emitted = true;
      const completedAt = telemetryTime();
      const durationMs =
        startedAt === null || completedAt === null
          ? 0
          : boundedMilliseconds(completedAt - startedAt);
      reportBatch(
        Object.freeze({
          claimed: claimedCount,
          delivered: deliveredCount,
          failed: failedCount,
          retried: retriedCount,
          terminal: terminalCount,
          exhausted: exhaustedCount,
          staleSettlements: staleSettlementCount,
          durationMs,
          oldestReadyAgeMs: oldestReadyAge(
            oldestReadyAt,
            telemetryWallTime(),
          ),
          outcome,
        }) satisfies ChatAttachmentCleanupBatchOutcome,
      );
    };

    try {
      if (stopped) {
        emit("empty");
        return Object.freeze({ claimed: 0, delivered: 0, failed: 0 });
      }

      let leaseOwner: string;
      try {
        leaseOwner = createLeaseOwner();
        if (
          !boundedString(leaseOwner, 255) ||
          leaseOwner !== leaseOwner.trim() ||
          !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(leaseOwner)
        ) {
          throw new TypeError("invalid lease owner");
        }
      } catch {
        throw safeDispatcherError("configuration");
      }

      const claimed = await claimBatch(leaseOwner);
      claimedCount = claimed.length;
      for (const row of claimed) {
        const readyAt = row.ready_at instanceof Date
          ? row.ready_at.valueOf()
          : new Date(row.ready_at).valueOf();
        if (Number.isFinite(readyAt)) {
          oldestReadyAt = Math.min(oldestReadyAt ?? readyAt, readyAt);
        }
        const deliveryOutcome = await deleteObject(row, leaseOwner);
        if (deliveryOutcome === "delivered") deliveredCount += 1;
        else {
          failedCount += 1;
          if (deliveryOutcome === "retried") retriedCount += 1;
          if (deliveryOutcome === "terminal") terminalCount += 1;
          if (deliveryOutcome === "exhausted") exhaustedCount += 1;
          if (deliveryOutcome === "stale") staleSettlementCount += 1;
        }
      }
      const result = Object.freeze({
        claimed: claimedCount,
        delivered: deliveredCount,
        failed: failedCount,
      });
      emit(batchOutcomeStatus(claimedCount, deliveredCount, failedCount));
      return result;
    } catch (error) {
      failedCount = Math.max(failedCount, claimedCount - deliveredCount);
      emit("failed");
      if (error instanceof ChatAttachmentCleanupDispatcherError) throw error;
      throw safeDispatcherError(claimedCount === 0 ? "configuration" : "database");
    }
  };

  const runOnce = (): Promise<ChatAttachmentCleanupBatchResult> => {
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
      let result: ChatAttachmentCleanupBatchResult | undefined;
      try {
        result = await runOnce();
      } catch (error) {
        reportError(
          error instanceof ChatAttachmentCleanupDispatcherError
            ? error
            : safeDispatcherError("database"),
        );
      }
      if (stopped) break;
      if (result?.claimed !== normalized.batchSize) await waitForNextPoll();
    }
    running = false;
  };

  const stop = (): Promise<void> => {
    stopPromise ??= (async () => {
      stopped = true;
      if (wakeTimer !== undefined) clearTimeout(wakeTimer);
      wakeTimer = undefined;
      wakePolling?.();
      await loopPromise;
      await currentBatch;
      running = false;
    })();
    return stopPromise;
  };

  const dispatcher: ChatAttachmentCleanupDispatcher = {
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
    stop,
  };
  return Object.freeze(dispatcher);
}
