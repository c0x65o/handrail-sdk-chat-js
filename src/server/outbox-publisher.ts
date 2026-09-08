import { randomUUID } from "node:crypto";

import type { ChatEvent } from "../contracts/realtime.js";
import type {
  ChatRealtimeAdapter,
  ChatRealtimeListener,
  ChatRealtimeSubscriber,
} from "./contracts.js";
import {
  DEFAULT_POSTGRES_SCHEMA,
  validatePostgresSchema,
  type PostgresMigrationDatabase,
} from "./postgres-migrations.js";

export const DEFAULT_CHAT_OUTBOX_BATCH_SIZE = 25;
export const DEFAULT_CHAT_OUTBOX_POLL_INTERVAL_MS = 250;
export const DEFAULT_CHAT_OUTBOX_LEASE_DURATION_MS = 30_000;
export const DEFAULT_CHAT_OUTBOX_INITIAL_RETRY_DELAY_MS = 100;
export const DEFAULT_CHAT_OUTBOX_MAX_RETRY_DELAY_MS = 30_000;

export type ChatOutboxBatchOutcomeStatus =
  | "empty"
  | "succeeded"
  | "partially_failed"
  | "failed";

export type ChatOutboxBatchFailureClass =
  | "none"
  | "delivery"
  | "database"
  | "configuration";

/** Aggregate-only diagnostics for one completed outbox batch. */
export interface ChatOutboxBatchOutcome {
  readonly claimed: number;
  readonly published: number;
  readonly failed: number;
  readonly durationMs: number;
  readonly oldestClaimedEventAgeMs: number | null;
  readonly outcome: ChatOutboxBatchOutcomeStatus;
  readonly failureClass: ChatOutboxBatchFailureClass;
}

export type ChatOutboxBatchListener = (
  outcome: ChatOutboxBatchOutcome,
) => void | Promise<void>;

export interface ChatOutboxOptions {
  readonly batchSize?: number;
  readonly pollIntervalMs?: number;
  readonly leaseDurationMs?: number;
  readonly initialRetryDelayMs?: number;
  readonly maxRetryDelayMs?: number;
  /** Receives polling/lease persistence errors without stopping the worker. */
  readonly onError?: (error: unknown) => void;
  /** Receives immutable, aggregate-only diagnostics for each completed batch. */
  readonly onBatch?: ChatOutboxBatchListener;
}

export interface NormalizedChatOutboxOptions {
  readonly batchSize: number;
  readonly pollIntervalMs: number;
  readonly leaseDurationMs: number;
  readonly initialRetryDelayMs: number;
  readonly maxRetryDelayMs: number;
  readonly onError: ((error: unknown) => void) | undefined;
  readonly onBatch: ChatOutboxBatchListener | undefined;
}

export interface CreateChatOutboxPublisherOptions extends ChatOutboxOptions {
  readonly database: PostgresMigrationDatabase;
  readonly schema?: string;
  /** Defaults to an in-process hub when an external fanout adapter is absent. */
  readonly realtime?: ChatRealtimeAdapter;
  /** Primarily useful for deterministic tests and trace correlation. */
  readonly createClaimToken?: () => string;
}

export interface ChatOutboxBatchResult {
  readonly claimed: number;
  readonly published: number;
  readonly failed: number;
}

export type { ChatRealtimeListener } from "./contracts.js";

export interface ChatLocalRealtimeHub
  extends ChatRealtimeAdapter,
    ChatRealtimeSubscriber {
  readonly subscriberCount: number;
  /** Returns an idempotent unsubscribe function. */
  subscribe(listener: ChatRealtimeListener): () => void;
}

export interface ChatOutboxPublisher {
  readonly running: boolean;
  readonly stopped: boolean;
  readonly realtime: ChatRealtimeAdapter;
  /** Starts background polling on a later microtask. Idempotent. */
  start(): void;
  /** Claims and delivers at most one event per tenant/stream. */
  runOnce(): Promise<ChatOutboxBatchResult>;
  /** Stops future polling and waits for an in-flight batch. Idempotent. */
  stop(): Promise<void>;
}

interface StoredOutboxEvent {
  readonly event_id: string;
  readonly protocol_version: string | number;
  readonly tenant_id: string;
  readonly stream_id: string;
  readonly type: string;
  readonly occurred_at: Date | string;
  readonly payload: unknown;
  readonly publish_attempts: string | number;
}

const positiveInteger = (
  value: unknown,
  fallback: number,
  name: string,
): number => {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || (resolved as number) < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return resolved as number;
};

const nonNegativeInteger = (
  value: unknown,
  fallback: number,
  name: string,
): number => {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || (resolved as number) < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
  return resolved as number;
};

export function normalizeChatOutboxOptions(
  options: ChatOutboxOptions = {},
): NormalizedChatOutboxOptions {
  const batchSize = positiveInteger(
    options.batchSize,
    DEFAULT_CHAT_OUTBOX_BATCH_SIZE,
    "outbox.batchSize",
  );
  const pollIntervalMs = nonNegativeInteger(
    options.pollIntervalMs,
    DEFAULT_CHAT_OUTBOX_POLL_INTERVAL_MS,
    "outbox.pollIntervalMs",
  );
  const leaseDurationMs = positiveInteger(
    options.leaseDurationMs,
    DEFAULT_CHAT_OUTBOX_LEASE_DURATION_MS,
    "outbox.leaseDurationMs",
  );
  const initialRetryDelayMs = nonNegativeInteger(
    options.initialRetryDelayMs,
    DEFAULT_CHAT_OUTBOX_INITIAL_RETRY_DELAY_MS,
    "outbox.initialRetryDelayMs",
  );
  const maxRetryDelayMs = nonNegativeInteger(
    options.maxRetryDelayMs,
    DEFAULT_CHAT_OUTBOX_MAX_RETRY_DELAY_MS,
    "outbox.maxRetryDelayMs",
  );
  if (maxRetryDelayMs < initialRetryDelayMs) {
    throw new TypeError(
      "outbox.maxRetryDelayMs must be greater than or equal to outbox.initialRetryDelayMs",
    );
  }
  if (options.onError !== undefined && typeof options.onError !== "function") {
    throw new TypeError("outbox.onError must be a function");
  }
  if (options.onBatch !== undefined && typeof options.onBatch !== "function") {
    throw new TypeError("outbox.onBatch must be a function");
  }

  return Object.freeze({
    batchSize,
    pollIntervalMs,
    leaseDurationMs,
    initialRetryDelayMs,
    maxRetryDelayMs,
    onError: options.onError,
    onBatch: options.onBatch,
  });
}

export function createLocalChatRealtimeHub(): ChatLocalRealtimeHub {
  const listeners = new Set<ChatRealtimeListener>();

  return Object.freeze({
    get subscriberCount() {
      return listeners.size;
    },
    subscribe(listener: ChatRealtimeListener) {
      if (typeof listener !== "function") {
        throw new TypeError("realtime listener must be a function");
      }
      listeners.add(listener);
      let subscribed = true;
      return () => {
        if (subscribed) {
          subscribed = false;
          listeners.delete(listener);
        }
      };
    },
    async publish(event: ChatEvent) {
      await Promise.all([...listeners].map((listener) => listener(event)));
    },
  });
}

const quoteIdentifier = (identifier: string): string =>
  `"${identifier.replaceAll('"', '""')}"`;

const toSafeNumber = (value: string | number, field: string): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RangeError(`Stored outbox ${field} is not a safe integer`);
  }
  return parsed;
};

const toChatEvent = (row: StoredOutboxEvent): ChatEvent => {
  const occurredAt =
    row.occurred_at instanceof Date
      ? row.occurred_at.toISOString()
      : new Date(row.occurred_at).toISOString();
  return Object.freeze({
    eventId: row.event_id,
    protocolVersion: toSafeNumber(row.protocol_version, "protocol_version"),
    tenantId: row.tenant_id as ChatEvent["tenantId"],
    streamId: row.stream_id,
    type: row.type,
    occurredAt,
    payload: row.payload,
  });
};

const retryDelay = (
  attempt: number,
  initialDelayMs: number,
  maximumDelayMs: number,
): number => {
  if (initialDelayMs === 0 || maximumDelayMs === 0) {
    return 0;
  }
  const exponent = Math.min(Math.max(0, attempt - 1), 52);
  return Math.min(maximumDelayMs, initialDelayMs * 2 ** exponent);
};

const elapsedMilliseconds = (startedAt: number, completedAt: number): number =>
  Number.isFinite(completedAt - startedAt)
    ? Math.max(0, completedAt - startedAt)
    : 0;

const oldestClaimedEventAge = (
  oldestOccurredAt: number | undefined,
  completedAt: number,
): number | null =>
  oldestOccurredAt === undefined
    ? null
    : Number.isFinite(completedAt - oldestOccurredAt)
      ? Math.max(0, completedAt - oldestOccurredAt)
      : null;

const outcomeStatus = (
  claimed: number,
  published: number,
  failed: number,
): ChatOutboxBatchOutcomeStatus => {
  if (claimed === 0) return "empty";
  if (failed === 0) return "succeeded";
  return published === 0 ? "failed" : "partially_failed";
};

export function createChatOutboxPublisher(
  options: CreateChatOutboxPublisherOptions,
): ChatOutboxPublisher {
  const normalized = normalizeChatOutboxOptions(options);
  const schema = validatePostgresSchema(options.schema ?? DEFAULT_POSTGRES_SCHEMA);
  const table = `${quoteIdentifier(schema)}.chat_outbox_events`;
  const realtime = options.realtime ?? createLocalChatRealtimeHub();
  const createClaimToken = options.createClaimToken ?? randomUUID;

  let running = false;
  let stopped = false;
  let loopPromise: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  let currentBatch: Promise<ChatOutboxBatchResult> | undefined;
  let wakeTimer: ReturnType<typeof setTimeout> | undefined;
  let wakePolling: (() => void) | undefined;

  const reportError = (error: unknown): void => {
    try {
      normalized.onError?.(error);
    } catch {
      // Diagnostics must never terminate delivery or make shutdown reject.
    }
  };

  const reportBatch = (outcome: ChatOutboxBatchOutcome): void => {
    try {
      void Promise.resolve(normalized.onBatch?.(outcome)).catch(() => undefined);
    } catch {
      // Telemetry must never affect delivery, polling, or shutdown.
    }
  };

  const waitForNextPoll = (): Promise<void> =>
    new Promise<void>((resolve) => {
      wakePolling = resolve;
      wakeTimer = setTimeout(resolve, normalized.pollIntervalMs);
    }).finally(() => {
      if (wakeTimer !== undefined) {
        clearTimeout(wakeTimer);
        wakeTimer = undefined;
      }
      wakePolling = undefined;
    });

  const heartbeatLease = async (
    claimToken: string,
    finished: Promise<void>,
  ): Promise<void> => {
    const intervalMs = Math.max(1, Math.floor(normalized.leaseDurationMs / 3));
    while (true) {
      const shouldStop = await Promise.race([
        finished.then(() => true),
        new Promise<false>((resolve) => {
          const timer = setTimeout(() => resolve(false), intervalMs);
          timer.unref?.();
        }),
      ]);
      if (shouldStop) {
        return;
      }
      await options.database.query(
        `UPDATE ${table}
         SET claimed_at = clock_timestamp()
         WHERE claim_token = $1
           AND published_at IS NULL`,
        [claimToken],
      );
    }
  };

  const finishDelivery = async (
    row: StoredOutboxEvent,
    claimToken: string,
    delivered: boolean,
  ): Promise<boolean> => {
    if (delivered) {
      const result = await options.database.query(
        `UPDATE ${table}
         SET published_at = clock_timestamp(),
             claim_token = NULL,
             claimed_at = NULL
         WHERE event_id = $1
           AND claim_token = $2
           AND published_at IS NULL
         RETURNING event_id`,
        [row.event_id, claimToken],
      );
      return result.rowCount === 1;
    }

    const attempt = toSafeNumber(row.publish_attempts, "publish_attempts");
    const delayMs = retryDelay(
      attempt,
      normalized.initialRetryDelayMs,
      normalized.maxRetryDelayMs,
    );
    const result = await options.database.query(
      `UPDATE ${table}
       SET available_at = clock_timestamp()
             + ($3::double precision * interval '1 millisecond'),
           claim_token = NULL,
           claimed_at = NULL
       WHERE event_id = $1
         AND claim_token = $2
         AND published_at IS NULL
       RETURNING event_id`,
      [row.event_id, claimToken, delayMs],
    );
    return result.rowCount === 1;
  };

  const deliverClaimed = async (
    row: StoredOutboxEvent,
    claimToken: string,
  ): Promise<"published" | "failed"> => {
    try {
      await realtime.publish(toChatEvent(row));
    } catch {
      await finishDelivery(row, claimToken, false);
      return "failed";
    }
    return (await finishDelivery(row, claimToken, true))
      ? "published"
      : "failed";
  };

  const executeBatch = async (): Promise<ChatOutboxBatchResult> => {
    const startedAt = Date.now();
    let claimedCount = 0;
    let publishedCount = 0;
    let failedCount = 0;
    let oldestOccurredAt: number | undefined;
    let activeFailureClass: ChatOutboxBatchFailureClass = "configuration";

    const emit = (
      outcome: ChatOutboxBatchOutcomeStatus,
      failureClass: ChatOutboxBatchFailureClass,
    ): void => {
      const completedAt = Date.now();
      reportBatch(
        Object.freeze({
          claimed: claimedCount,
          published: publishedCount,
          failed: failedCount,
          durationMs: elapsedMilliseconds(startedAt, completedAt),
          oldestClaimedEventAgeMs: oldestClaimedEventAge(
            oldestOccurredAt,
            completedAt,
          ),
          outcome,
          failureClass,
        }),
      );
    };

    try {
      if (stopped) {
        emit("empty", "none");
        return { claimed: 0, published: 0, failed: 0 };
      }
      const claimToken = createClaimToken();
      if (typeof claimToken !== "string" || claimToken.trim().length === 0) {
        throw new TypeError("createClaimToken must return a non-empty string");
      }

      activeFailureClass = "database";
      const claimed = await options.database.query<StoredOutboxEvent>(
        `WITH claim_clock AS MATERIALIZED (
         SELECT clock_timestamp() AS claimed_at
       ),
       claimable AS MATERIALIZED (
         SELECT candidate.replay_position, claim_clock.claimed_at
         FROM ${table} AS candidate
         CROSS JOIN claim_clock
         WHERE candidate.published_at IS NULL
           AND candidate.expires_at > claim_clock.claimed_at
           AND candidate.available_at <= claim_clock.claimed_at
           AND (
             candidate.claim_token IS NULL
             OR candidate.claimed_at <= claim_clock.claimed_at
                  - ($3::double precision * interval '1 millisecond')
           )
           AND NOT EXISTS (
             SELECT 1
             FROM ${table} AS earlier
             WHERE earlier.tenant_id = candidate.tenant_id
               AND earlier.stream_id = candidate.stream_id
               AND earlier.published_at IS NULL
               AND earlier.expires_at > claim_clock.claimed_at
               AND earlier.replay_position < candidate.replay_position
           )
         ORDER BY candidate.replay_position
         FOR UPDATE OF candidate SKIP LOCKED
         LIMIT $1
       )
       UPDATE ${table} AS event
       SET publish_attempts = event.publish_attempts + 1,
           claim_token = $2,
           claimed_at = claimable.claimed_at
       FROM claimable
       WHERE event.replay_position = claimable.replay_position
       RETURNING event.event_id, event.protocol_version, event.tenant_id,
                 event.stream_id, event.type, event.occurred_at, event.payload,
                 event.publish_attempts`,
        [normalized.batchSize, claimToken, normalized.leaseDurationMs],
      );

      claimedCount = claimed.rows.length;
      for (const row of claimed.rows) {
        const occurredAt =
          row.occurred_at instanceof Date
            ? row.occurred_at.getTime()
            : new Date(row.occurred_at).getTime();
        if (Number.isFinite(occurredAt)) {
          oldestOccurredAt = Math.min(oldestOccurredAt ?? occurredAt, occurredAt);
        }
      }

      if (claimedCount === 0) {
        emit("empty", "none");
        return { claimed: 0, published: 0, failed: 0 };
      }

      let finishHeartbeat: (() => void) | undefined;
      const finished = new Promise<void>((resolve) => {
        finishHeartbeat = resolve;
      });
      const heartbeat = heartbeatLease(claimToken, finished).catch(reportError);
      try {
        await Promise.all(
          claimed.rows.map(async (row) => {
            const outcome = await deliverClaimed(row, claimToken);
            if (outcome === "published") {
              publishedCount += 1;
            } else {
              failedCount += 1;
            }
          }),
        );
      } finally {
        finishHeartbeat?.();
        await heartbeat;
      }

      const result = {
        claimed: claimedCount,
        published: publishedCount,
        failed: failedCount,
      };
      emit(
        outcomeStatus(claimedCount, publishedCount, failedCount),
        failedCount === 0 ? "none" : "delivery",
      );
      return result;
    } catch (error) {
      failedCount = Math.max(failedCount, claimedCount - publishedCount);
      emit("failed", activeFailureClass);
      throw error;
    }
  };

  const runOnce = (): Promise<ChatOutboxBatchResult> => {
    currentBatch ??= executeBatch().finally(() => {
      currentBatch = undefined;
    });
    return currentBatch;
  };

  const poll = async (): Promise<void> => {
    while (!stopped) {
      let batch: ChatOutboxBatchResult | undefined;
      try {
        batch = await runOnce();
      } catch (error) {
        reportError(error);
      }
      if (stopped) {
        break;
      }
      if (batch?.claimed !== normalized.batchSize) {
        await waitForNextPoll();
      }
    }
    running = false;
  };

  const publisher: ChatOutboxPublisher = {
    get running() {
      return running;
    },
    get stopped() {
      return stopped;
    },
    realtime,
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

  return Object.freeze(publisher);
}
