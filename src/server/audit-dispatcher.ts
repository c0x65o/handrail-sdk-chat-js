import { randomUUID } from "node:crypto";

import type {
  ChatAuditAdapter,
  ChatAuditDeliveryFailureClass,
  ChatAuditEvent,
} from "./contracts.js";
import { ChatAuditDeliveryError } from "./contracts.js";
import {
  DEFAULT_POSTGRES_SCHEMA,
  validatePostgresSchema,
  type PostgresMigrationConnection,
  type PostgresMigrationDatabase,
} from "./postgres-migrations.js";

export const DEFAULT_CHAT_AUDIT_BATCH_SIZE = 25;
export const DEFAULT_CHAT_AUDIT_POLL_INTERVAL_MS = 250;
export const DEFAULT_CHAT_AUDIT_LEASE_DURATION_MS = 30_000;
export const DEFAULT_CHAT_AUDIT_INITIAL_RETRY_DELAY_MS = 1_000;
export const DEFAULT_CHAT_AUDIT_MAX_RETRY_DELAY_MS = 60_000;
export const MAX_CHAT_AUDIT_METADATA_UTF8_BYTES = 65_536;

export type ChatAuditBatchOutcomeStatus =
  | "empty"
  | "succeeded"
  | "partially_failed"
  | "failed";

/** Aggregate-only diagnostics for one completed audit dispatch batch. */
export interface ChatAuditBatchOutcome {
  readonly claimed: number;
  readonly delivered: number;
  readonly retried: number;
  readonly terminal: number;
  readonly durationMs: number;
  readonly oldestEligibleEventLagMs: number | null;
  readonly outcome: ChatAuditBatchOutcomeStatus;
}

export type ChatAuditBatchListener = (
  outcome: ChatAuditBatchOutcome,
) => void | Promise<void>;

export interface ChatAuditDispatcherOptions {
  readonly batchSize?: number;
  readonly pollIntervalMs?: number;
  readonly leaseDurationMs?: number;
  readonly initialRetryDelayMs?: number;
  readonly maxRetryDelayMs?: number;
  /** Receives only fixed, secret-safe worker failure classifications. */
  readonly onError?: (error: ChatAuditDispatcherError) => void;
  /** Receives immutable, aggregate-only diagnostics for each completed batch. */
  readonly onBatch?: ChatAuditBatchListener;
  /** Monotonic millisecond clock used only for batch duration measurement. */
  readonly monotonicNow?: () => number;
}

export interface NormalizedChatAuditDispatcherOptions {
  readonly batchSize: number;
  readonly pollIntervalMs: number;
  readonly leaseDurationMs: number;
  readonly initialRetryDelayMs: number;
  readonly maxRetryDelayMs: number;
  readonly onError: ChatAuditDispatcherOptions["onError"] | undefined;
  readonly onBatch: ChatAuditBatchListener | undefined;
  readonly monotonicNow: () => number;
}

export interface CreateChatAuditDispatcherOptions
  extends ChatAuditDispatcherOptions {
  readonly database: PostgresMigrationDatabase;
  readonly adapter: ChatAuditAdapter;
  readonly schema?: string;
  /** Primarily useful for deterministic tests and trace correlation. */
  readonly createLeaseOwner?: () => string;
  /** Injected wall clock for deterministic due, lease, and retry decisions. */
  readonly now?: () => Date;
}

export interface ChatAuditBatchResult {
  readonly materialized: number;
  readonly claimed: number;
  readonly delivered: number;
  readonly failed: number;
}

export interface ChatAuditDispatcher {
  readonly running: boolean;
  readonly stopped: boolean;
  start(): void;
  runOnce(): Promise<ChatAuditBatchResult>;
  /** Stops polling and awaits only this dispatcher's in-flight batch. */
  close(): Promise<void>;
  /** Alias for close, matching the other server worker interfaces. */
  stop(): Promise<void>;
}

export type ChatAuditDispatcherErrorClass = "database" | "configuration";

/** A deliberately detail-free error safe for worker callbacks and logs. */
export class ChatAuditDispatcherError extends Error {
  public constructor(public readonly failureClass: ChatAuditDispatcherErrorClass) {
    super(`Audit dispatcher failed: ${failureClass}`);
    this.name = "ChatAuditDispatcherError";
  }
}

interface StoredAuditDelivery {
  readonly tenant_id: unknown;
  readonly audit_event_id: unknown;
  readonly actor_user_id: unknown;
  readonly action: unknown;
  readonly target_type: unknown;
  readonly target_id: unknown;
  readonly occurred_at: unknown;
  readonly metadata: unknown;
  readonly request_id: unknown;
  readonly correlation_id: unknown;
  readonly attempt_count: string | number;
}

type StoredAuditFailureClass =
  | "transient"
  | "rate_limited"
  | "rejected"
  | "configuration"
  | "unknown";

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

export function normalizeChatAuditDispatcherOptions(
  options: ChatAuditDispatcherOptions = {},
): NormalizedChatAuditDispatcherOptions {
  const initialRetryDelayMs = nonNegativeInteger(
    options.initialRetryDelayMs,
    DEFAULT_CHAT_AUDIT_INITIAL_RETRY_DELAY_MS,
    "auditDelivery.initialRetryDelayMs",
  );
  const maxRetryDelayMs = nonNegativeInteger(
    options.maxRetryDelayMs,
    DEFAULT_CHAT_AUDIT_MAX_RETRY_DELAY_MS,
    "auditDelivery.maxRetryDelayMs",
  );
  if (maxRetryDelayMs < initialRetryDelayMs) {
    throw new TypeError(
      "auditDelivery.maxRetryDelayMs must be greater than or equal to auditDelivery.initialRetryDelayMs",
    );
  }
  if (options.onError !== undefined && typeof options.onError !== "function") {
    throw new TypeError("auditDelivery.onError must be a function");
  }
  if (options.onBatch !== undefined && typeof options.onBatch !== "function") {
    throw new TypeError("auditDelivery.onBatch must be a function");
  }
  if (
    options.monotonicNow !== undefined &&
    typeof options.monotonicNow !== "function"
  ) {
    throw new TypeError("auditDelivery.monotonicNow must be a function");
  }
  return Object.freeze({
    batchSize: positiveInteger(
      options.batchSize,
      DEFAULT_CHAT_AUDIT_BATCH_SIZE,
      "auditDelivery.batchSize",
    ),
    pollIntervalMs: nonNegativeInteger(
      options.pollIntervalMs,
      DEFAULT_CHAT_AUDIT_POLL_INTERVAL_MS,
      "auditDelivery.pollIntervalMs",
    ),
    leaseDurationMs: positiveInteger(
      options.leaseDurationMs,
      DEFAULT_CHAT_AUDIT_LEASE_DURATION_MS,
      "auditDelivery.leaseDurationMs",
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

const UNSAFE_AUDIT_METADATA_KEYS = new Set([
  "message", "messagebody", "messagecontent", "body", "content", "payload",
  "text", "accesstoken", "refreshtoken", "idtoken", "authtoken",
  "bearertoken", "authorization", "authentication", "authheader",
  "authorizationheader", "apikey", "clientsecret", "privatekey", "password",
  "secret", "credential", "credentials", "cookie", "setcookie",
  "attachmentbytes", "attachmentcontent", "filecontent", "binary", "bytes",
]);

const normalizedMetadataKey = (key: string): string =>
  key.toLocaleLowerCase("en-US").replace(/[^\p{L}\p{N}]/gu, "");

const metadataIsSafe = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.every(metadataIsSafe);
  if (value !== null && typeof value === "object") {
    return Object.entries(value).every(
      ([key, member]) =>
        !UNSAFE_AUDIT_METADATA_KEYS.has(normalizedMetadataKey(key)) &&
        metadataIsSafe(member),
    );
  }
  return (
    value === null ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    typeof value === "boolean"
  );
};

const boundedString = (
  value: unknown,
  maximumBytes: number,
  trim = false,
): value is string =>
  typeof value === "string" &&
  Buffer.byteLength(value, "utf8") >= 1 &&
  Buffer.byteLength(value, "utf8") <= maximumBytes &&
  /\S/u.test(value) &&
  (!trim || value === value.trim());

const toSafeAttempt = (value: string | number): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error("Stored audit delivery is malformed");
  }
  return parsed;
};

const deepFreezeJson = (value: unknown): unknown => {
  if (value !== null && typeof value === "object") {
    for (const member of Object.values(value)) deepFreezeJson(member);
    Object.freeze(value);
  }
  return value;
};

const toAuditEvent = (row: StoredAuditDelivery): ChatAuditEvent => {
  if (
    !boundedString(row.tenant_id, 255) ||
    !boundedString(row.audit_event_id, 255) ||
    (row.actor_user_id !== null && !boundedString(row.actor_user_id, 255)) ||
    !boundedString(row.action, 128, true) ||
    !boundedString(row.request_id, 255) ||
    (row.correlation_id !== null && !boundedString(row.correlation_id, 255)) ||
    (row.target_type === null) !== (row.target_id === null) ||
    (row.target_type !== null && !boundedString(row.target_type, 128, true)) ||
    (row.target_id !== null && !boundedString(row.target_id, 255)) ||
    row.metadata === null ||
    typeof row.metadata !== "object" ||
    Array.isArray(row.metadata) ||
    !metadataIsSafe(row.metadata)
  ) {
    throw new Error("Stored audit event is malformed");
  }
  let serializedMetadata: string;
  let metadata: unknown;
  try {
    serializedMetadata = JSON.stringify(row.metadata);
    metadata = JSON.parse(serializedMetadata) as unknown;
  } catch {
    throw new Error("Stored audit event is malformed");
  }
  if (
    Buffer.byteLength(serializedMetadata, "utf8") >
      MAX_CHAT_AUDIT_METADATA_UTF8_BYTES ||
    metadata === null ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    !metadataIsSafe(metadata)
  ) {
    throw new Error("Stored audit event is malformed");
  }
  const occurredAt =
    row.occurred_at instanceof Date
      ? row.occurred_at
      : new Date(row.occurred_at as string | number);
  if (!Number.isFinite(occurredAt.valueOf())) {
    throw new Error("Stored audit event is malformed");
  }
  const event: ChatAuditEvent = {
    auditEventId: row.audit_event_id,
    tenantId: row.tenant_id as ChatAuditEvent["tenantId"],
    actorUserId: row.actor_user_id as ChatAuditEvent["actorUserId"],
    action: row.action,
    occurredAt: occurredAt.toISOString(),
    metadata: deepFreezeJson(metadata),
    requestId: row.request_id,
    ...(row.correlation_id === null
      ? {}
      : { correlationId: row.correlation_id as string }),
    ...(row.target_type === null || row.target_id === null
      ? {}
      : {
          target: Object.freeze({
            type: row.target_type,
            id: row.target_id,
          }),
        }),
  };
  return Object.freeze(event);
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

const classifyFailure = (error: unknown): StoredAuditFailureClass => {
  if (!(error instanceof ChatAuditDeliveryError)) return "unknown";
  return error.failureClass === "invalid" ? "rejected" : error.failureClass;
};

const terminalFailure = (failureClass: StoredAuditFailureClass): boolean =>
  failureClass === "rejected" || failureClass === "configuration";

const boundedMilliseconds = (value: number): number =>
  Number.isFinite(value)
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, value))
    : 0;

const oldestEligibleEventLag = (
  oldestOccurredAt: number | undefined,
  completedAt: number | null,
): number | null =>
  oldestOccurredAt === undefined || completedAt === null
    ? null
    : Number.isFinite(completedAt - oldestOccurredAt)
      ? boundedMilliseconds(completedAt - oldestOccurredAt)
      : null;

const auditBatchOutcomeStatus = (
  claimed: number,
  delivered: number,
  retried: number,
  terminal: number,
): ChatAuditBatchOutcomeStatus => {
  if (claimed === 0) return "empty";
  if (delivered === claimed && retried === 0 && terminal === 0) {
    return "succeeded";
  }
  return delivered === 0 ? "failed" : "partially_failed";
};

const safeDispatcherError = (
  failureClass: ChatAuditDispatcherErrorClass,
): ChatAuditDispatcherError => new ChatAuditDispatcherError(failureClass);

export function createChatAuditDispatcher(
  options: CreateChatAuditDispatcherOptions,
): ChatAuditDispatcher {
  const normalized = normalizeChatAuditDispatcherOptions(options);
  const schema = validatePostgresSchema(options.schema ?? DEFAULT_POSTGRES_SCHEMA);
  const prefix = quoteIdentifier(schema);
  const auditEvents = `${prefix}.chat_audit_events`;
  const deliveries = `${prefix}.chat_audit_deliveries`;
  const createLeaseOwner = options.createLeaseOwner ?? randomUUID;
  const now = options.now ?? (() => new Date());

  if (
    typeof options.database !== "object" ||
    options.database === null ||
    typeof options.database.query !== "function" ||
    typeof options.database.connect !== "function"
  ) {
    throw new TypeError("auditDelivery.database must support query and connect");
  }
  if (
    typeof options.adapter !== "object" ||
    options.adapter === null ||
    typeof options.adapter.record !== "function"
  ) {
    throw new TypeError("auditDelivery.adapter must implement record");
  }
  if (typeof createLeaseOwner !== "function") {
    throw new TypeError("auditDelivery.createLeaseOwner must be a function");
  }
  if (typeof now !== "function") {
    throw new TypeError("auditDelivery.now must be a function");
  }

  const currentTime = (): Date => {
    const value = now();
    if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) {
      throw new TypeError("auditDelivery.now must return a valid Date");
    }
    return value;
  };
  const injectedTime = (): Date | null =>
    options.now === undefined ? null : currentTime();

  let running = false;
  let stopped = false;
  let loopPromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  let currentBatch: Promise<ChatAuditBatchResult> | undefined;
  let wakeTimer: ReturnType<typeof setTimeout> | undefined;
  let wakePolling: (() => void) | undefined;

  const reportError = (error: ChatAuditDispatcherError): void => {
    try {
      normalized.onError?.(error);
    } catch {
      // Diagnostics must never terminate polling or make shutdown reject.
    }
  };

  const reportBatch = (outcome: ChatAuditBatchOutcome): void => {
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

  const rollback = async (connection: PostgresMigrationConnection): Promise<void> => {
    try {
      await connection.query("ROLLBACK");
    } catch {
      // The original safe classification remains the only emitted detail.
    }
  };

  const claimBatch = async (
    leaseOwner: string,
  ): Promise<{ materialized: number; rows: StoredAuditDelivery[] }> => {
    const connection = await options.database.connect().catch(() => {
      throw safeDispatcherError("database");
    });
    let transactionStarted = false;
    try {
      await connection.query("BEGIN");
      transactionStarted = true;
      const materialized = await connection.query(
        `INSERT INTO ${deliveries} (tenant_id, audit_event_id)
         SELECT event.tenant_id, event.event_id
         FROM ${auditEvents} AS event
         LEFT JOIN ${deliveries} AS delivery
           ON delivery.tenant_id = event.tenant_id
          AND delivery.audit_event_id = event.event_id
         WHERE delivery.audit_event_id IS NULL
         ON CONFLICT (tenant_id, audit_event_id) DO NOTHING`,
      );
      const claimed = await connection.query<StoredAuditDelivery>(
        `WITH moment AS MATERIALIZED (
           SELECT COALESCE($4::timestamptz, clock_timestamp()) AS at
         ), claimable AS MATERIALIZED (
           SELECT candidate.tenant_id, candidate.audit_event_id
           FROM ${deliveries} AS candidate
           CROSS JOIN moment
           WHERE candidate.delivered_at IS NULL
             AND candidate.terminal_at IS NULL
             AND (
               (candidate.lease_owner IS NULL
                AND candidate.next_attempt_at <= moment.at)
               OR
               (candidate.lease_owner IS NOT NULL
                AND candidate.lease_expires_at <= moment.at)
             )
           ORDER BY COALESCE(candidate.lease_expires_at,
                             candidate.next_attempt_at),
                    candidate.tenant_id, candidate.audit_event_id
           FOR UPDATE OF candidate SKIP LOCKED
           LIMIT $1
         )
         UPDATE ${deliveries} AS delivery
         SET attempt_count = delivery.attempt_count + 1,
             lease_owner = $2,
             lease_expires_at = moment.at
               + ($3::double precision * interval '1 millisecond'),
             failure_class = NULL
         FROM claimable
         CROSS JOIN moment
         JOIN ${auditEvents} AS event
           ON event.tenant_id = claimable.tenant_id
          AND event.event_id = claimable.audit_event_id
         WHERE delivery.tenant_id = claimable.tenant_id
           AND delivery.audit_event_id = claimable.audit_event_id
         RETURNING delivery.tenant_id,
                   delivery.audit_event_id,
                   event.actor_user_id,
                   event.action,
                   event.target_type,
                   event.target_id,
                   event.occurred_at,
                   event.metadata,
                   event.request_id,
                   event.correlation_id,
                   delivery.attempt_count`,
        [
          normalized.batchSize,
          leaseOwner,
          normalized.leaseDurationMs,
          injectedTime(),
        ],
      );
      await connection.query("COMMIT");
      transactionStarted = false;
      return { materialized: materialized.rowCount ?? 0, rows: claimed.rows };
    } catch (error) {
      if (transactionStarted) await rollback(connection);
      if (error instanceof ChatAuditDispatcherError) throw error;
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
    row: StoredAuditDelivery,
    leaseOwner: string,
  ): Promise<boolean> => {
    try {
      const result = await options.database.query(
        `WITH moment AS (
           SELECT COALESCE($4::timestamptz, clock_timestamp()) AS at
         )
         UPDATE ${deliveries} AS delivery
         SET delivered_at = moment.at,
             lease_owner = NULL,
             lease_expires_at = NULL,
             failure_class = NULL
         FROM moment
         WHERE delivery.tenant_id = $1
           AND delivery.audit_event_id = $2
           AND delivery.lease_owner = $3
           AND delivery.delivered_at IS NULL
           AND delivery.terminal_at IS NULL
         RETURNING delivery.audit_event_id`,
        [row.tenant_id, row.audit_event_id, leaseOwner, injectedTime()],
      );
      return result.rowCount === 1;
    } catch {
      throw safeDispatcherError("database");
    }
  };

  const finishFailed = async (
    row: StoredAuditDelivery,
    leaseOwner: string,
    failureClass: StoredAuditFailureClass,
  ): Promise<boolean> => {
    const attempt = toSafeAttempt(row.attempt_count);
    const terminal = terminalFailure(failureClass);
    const delayMs = terminal
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
         SET next_attempt_at = CASE
               WHEN $5::boolean THEN delivery.next_attempt_at
               ELSE moment.at
                 + ($6::double precision * interval '1 millisecond')
             END,
             lease_owner = NULL,
             lease_expires_at = NULL,
             terminal_at = CASE WHEN $5::boolean THEN moment.at END,
             failure_class = $4
         FROM moment
         WHERE delivery.tenant_id = $1
           AND delivery.audit_event_id = $2
           AND delivery.lease_owner = $3
           AND delivery.delivered_at IS NULL
           AND delivery.terminal_at IS NULL
         RETURNING delivery.audit_event_id`,
        [
          row.tenant_id,
          row.audit_event_id,
          leaseOwner,
          failureClass,
          terminal,
          delayMs,
          injectedTime(),
        ],
      );
      return result.rowCount === 1;
    } catch {
      throw safeDispatcherError("database");
    }
  };

  const deliver = async (
    row: StoredAuditDelivery,
    leaseOwner: string,
  ): Promise<"delivered" | "retried" | "terminal" | "failed"> => {
    let event: ChatAuditEvent;
    try {
      event = toAuditEvent(row);
      toSafeAttempt(row.attempt_count);
    } catch {
      await finishFailed(row, leaseOwner, "rejected");
      return "terminal";
    }

    try {
      await options.adapter.record(event);
    } catch (error) {
      const failureClass = classifyFailure(error);
      await finishFailed(row, leaseOwner, failureClass);
      return terminalFailure(failureClass) ? "terminal" : "retried";
    }
    return (await finishDelivered(row, leaseOwner)) ? "delivered" : "failed";
  };

  const executeBatch = async (): Promise<ChatAuditBatchResult> => {
    const startedAt = telemetryTime();
    let materializedCount = 0;
    let claimedCount = 0;
    let deliveredCount = 0;
    let failedCount = 0;
    let retriedCount = 0;
    let terminalCount = 0;
    let oldestOccurredAt: number | undefined;
    let emitted = false;

    const emit = (outcome: ChatAuditBatchOutcomeStatus): void => {
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
          retried: retriedCount,
          terminal: terminalCount,
          durationMs,
          oldestEligibleEventLagMs: oldestEligibleEventLag(
            oldestOccurredAt,
            telemetryWallTime(),
          ),
          outcome,
        }) satisfies ChatAuditBatchOutcome,
      );
    };

    try {
      if (stopped) {
        emit("empty");
        return { materialized: 0, claimed: 0, delivered: 0, failed: 0 };
      }

      let leaseOwner: string;
      try {
        leaseOwner = createLeaseOwner();
        if (!boundedString(leaseOwner, 255, true) ||
            !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(leaseOwner)) {
          throw new TypeError("invalid lease owner");
        }
      } catch {
        throw safeDispatcherError("configuration");
      }

      const claimed = await claimBatch(leaseOwner);
      materializedCount = claimed.materialized;
      claimedCount = claimed.rows.length;
      for (const row of claimed.rows) {
        const occurredAt =
          row.occurred_at instanceof Date
            ? row.occurred_at.valueOf()
            : new Date(row.occurred_at as string | number).valueOf();
        if (Number.isFinite(occurredAt)) {
          oldestOccurredAt = Math.min(oldestOccurredAt ?? occurredAt, occurredAt);
        }
        const outcome = await deliver(row, leaseOwner);
        if (outcome === "delivered") deliveredCount += 1;
        else {
          failedCount += 1;
          if (outcome === "retried") retriedCount += 1;
          if (outcome === "terminal") terminalCount += 1;
        }
      }
      const result = {
        materialized: materializedCount,
        claimed: claimedCount,
        delivered: deliveredCount,
        failed: failedCount,
      };
      emit(
        auditBatchOutcomeStatus(
          claimedCount,
          deliveredCount,
          retriedCount,
          terminalCount,
        ),
      );
      return result;
    } catch (error) {
      emit("failed");
      if (error instanceof ChatAuditDispatcherError) throw error;
      throw safeDispatcherError(
        claimedCount === 0 && materializedCount === 0
          ? "configuration"
          : "database",
      );
    }
  };

  const runOnce = (): Promise<ChatAuditBatchResult> => {
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
      let result: ChatAuditBatchResult | undefined;
      try {
        result = await runOnce();
      } catch (error) {
        reportError(
          error instanceof ChatAuditDispatcherError
            ? error
            : safeDispatcherError("database"),
        );
      }
      if (stopped) break;
      if (result?.claimed !== normalized.batchSize) await waitForNextPoll();
    }
    running = false;
  };

  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      stopped = true;
      if (wakeTimer !== undefined) clearTimeout(wakeTimer);
      wakeTimer = undefined;
      wakePolling?.();
      await loopPromise;
      await currentBatch;
      running = false;
    })();
    return closePromise;
  };

  const dispatcher: ChatAuditDispatcher = {
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
    close,
    stop: close,
  };
  return Object.freeze(dispatcher);
}
