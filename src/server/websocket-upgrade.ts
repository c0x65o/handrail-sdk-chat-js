import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";

import {
  WebSocket,
  WebSocketServer,
  type RawData,
} from "ws";

import {
  CHAT_REALTIME_BEARER_SUBPROTOCOL_PREFIX,
  CHAT_REALTIME_SUBPROTOCOL,
  decideRealtimeHandshake,
  parseChatEvent,
  type ChatEvent,
  type ChatRealtimeRefreshRequiredMessage,
  type ChatRealtimeSessionAcceptedMessage,
  type ChatRealtimeSnapshotRequiredMessage,
  type ClientHandshakeInput,
  type EventCursor,
  type ServerHandshakeMetadata,
} from "../contracts/realtime.js";
import type {
  ChatAuthAdapter,
  ChatPermissionAdapter,
  ChatRequestAdmissionAdapter,
  ChatRealtimeSubscriber,
  TrustedChatActorContext,
} from "./contracts.js";
import type { TenantId, UserId } from "../contracts/identifiers.js";
import {
  CHAT_REQUEST_ADMISSION_DENIED_CODE,
  CHAT_REQUEST_ADMISSION_DENIED_MESSAGE,
  failedClosedChatRequestAdmission,
  normalizeChatRequestAdmissionOutcome,
} from "./request-admission.js";
import {
  ChatAuthenticationError,
  ChatAuthorizationError,
  resolveChatRequestContext,
  validateChatCapabilities,
  validateTrustedChatActorContext,
} from "./request-context.js";
import { validatePostgresSchema, type PostgresMigrationDatabase } from "./postgres-migrations.js";
import {
  CHAT_WEBSOCKET_SUBSCRIPTION_ERROR_CODES,
  CHAT_WEBSOCKET_SUBSCRIPTION_MESSAGE_TYPES,
  authorizeChatWebSocketStream,
  type ChatWebSocketSessionSubscriptions,
  type ChatWebSocketStreamId,
  type ChatWebSocketSubscriptionErrorCode,
  type ChatWebSocketSubscriptionRevalidationScope,
  type ChatWebSocketSubscriptionRequest,
  type ChatWebSocketSubscriptionServerMessage,
} from "./websocket-subscriptions.js";
import {
  CHAT_EPHEMERAL_EVENT_TYPES,
  DEFAULT_CHAT_WEBSOCKET_MAX_REPLAY_EVENTS,
  isInternalChatEventType,
  readChatWebSocketReplay,
  resolveBufferedReplayEvents,
  type PositionedChatEvent,
} from "./websocket-replay.js";
import type {
  ChatEphemeralSignalController,
  ChatEphemeralSignalSession,
  ChatEphemeralSessionIdentity,
} from "./websocket-ephemeral-signals.js";
import { leaveJoinedHuddlesOnDisconnect } from "./leave-huddle-command.js";

export const DEFAULT_CHAT_WEBSOCKET_PATH = "/_realtime" as const;
export const DEFAULT_CHAT_WEBSOCKET_MAX_CONNECTIONS = 1_000 as const;
export const DEFAULT_CHAT_WEBSOCKET_MAX_CONNECTIONS_PER_TENANT = 100 as const;
export const DEFAULT_CHAT_WEBSOCKET_HANDSHAKE_TIMEOUT_MS = 10_000 as const;
/** Conservative cadence for hosts that support active-session revalidation. */
export const DEFAULT_CHAT_WEBSOCKET_SESSION_REVALIDATION_INTERVAL_MS =
  60_000 as const;
export const MIN_CHAT_WEBSOCKET_SESSION_REVALIDATION_INTERVAL_MS =
  5_000 as const;
export const MAX_CHAT_WEBSOCKET_SESSION_REVALIDATION_INTERVAL_MS =
  3_600_000 as const;
export const DEFAULT_CHAT_WEBSOCKET_MAX_PENDING_EVENTS = 128 as const;
/**
 * Fixed per-session inbound limit, including the active handler and waiters.
 * Bounds retained frames and client work ahead of control/revalidation work.
 */
const MAX_PENDING_INBOUND_MESSAGES = 32;
/** Retained streams per session, including the private user stream. */
const MAX_STREAMS_PER_SESSION = 1_024;
/** Per socket, repeated IDs in this rolling accepted-event window are dropped. */
export const CHAT_WEBSOCKET_DUPLICATE_WINDOW_SIZE = 1_024 as const;
export const CHAT_WEBSOCKET_SLOW_CONSUMER_CURSOR_PREFIX =
  "slow_consumer;cursor=" as const;
const MAX_WEBSOCKET_CLOSE_REASON_BYTES = 123;

export interface ChatWebSocketCloseReason {
  readonly code: number;
  readonly reason: string;
}

/**
 * Application close codes and short wire reasons are stable public protocol.
 * Reasons intentionally contain no adapter or infrastructure error details.
 */
export const CHAT_WEBSOCKET_CLOSE_REASONS = Object.freeze({
  malformedHandshake: Object.freeze({
    code: 4400,
    reason: "malformed_handshake",
  }),
  authenticationFailed: Object.freeze({
    code: 4401,
    reason: "authentication_failed",
  }),
  authorizationFailed: Object.freeze({
    code: 4403,
    reason: "authorization_failed",
  }),
  handshakeTimeout: Object.freeze({
    code: 4408,
    reason: "handshake_timeout",
  }),
  identitySpoofing: Object.freeze({
    code: 4409,
    reason: "identity_spoofing",
  }),
  unsupportedProtocol: Object.freeze({
    code: 4426,
    reason: "unsupported_protocol",
  }),
  snapshotRequired: Object.freeze({
    code: 4410,
    reason: "snapshot_required",
  }),
  connectionLimit: Object.freeze({
    code: 4429,
    reason: "connection_limit",
  }),
  slowConsumer: Object.freeze({
    code: 4413,
    reason: "slow_consumer;cursor=",
  }),
  internalError: Object.freeze({
    code: 4500,
    reason: "internal_error",
  }),
  runtimeClosed: Object.freeze({
    code: 4503,
    reason: "runtime_closed",
  }),
} as const);

const createSlowConsumerCloseReason = (
  cursor: EventCursor | undefined,
): ChatWebSocketCloseReason => {
  const reason = `${CHAT_WEBSOCKET_SLOW_CONSUMER_CURSOR_PREFIX}${
    cursor === undefined ? "" : encodeURIComponent(cursor.eventId)
  }`;
  return {
    code: CHAT_WEBSOCKET_CLOSE_REASONS.slowConsumer.code,
    reason:
      Buffer.byteLength(reason) <= MAX_WEBSOCKET_CLOSE_REASON_BYTES
        ? reason
        : `${CHAT_WEBSOCKET_SLOW_CONSUMER_CURSOR_PREFIX}unavailable`,
  };
};

export interface ChatWebSocketSession<
  Capability extends string = string,
  Feature extends string = string,
> {
  /** Trusted host identity; no identity field is copied from the handshake. */
  readonly actor: TrustedChatActorContext;
  readonly capabilities: readonly Capability[];
  readonly clientPackageVersion: string;
  readonly protocolVersion: number;
  readonly metadata: ServerHandshakeMetadata<Feature>;
  readonly ephemeralIdentity: ChatEphemeralSessionIdentity;
  readonly resumeFrom?: EventCursor;
  /** Advances only after a realtime event frame is successfully written. */
  readonly lastDeliveredCursor: EventCursor | undefined;
  /** Authorized streams for this socket only; client identity cannot modify it. */
  readonly subscriptions: ChatWebSocketSessionSubscriptions;
}

export type ChatWebSocketSessionAcceptedMessage<
  Feature extends string = string,
> = ChatRealtimeSessionAcceptedMessage<Feature>;
export type ChatWebSocketRefreshRequiredMessage<
  Feature extends string = string,
> = ChatRealtimeRefreshRequiredMessage<Feature>;
export type ChatWebSocketSnapshotRequiredMessage<
  Feature extends string = string,
> = ChatRealtimeSnapshotRequiredMessage<Feature>;

export type ChatWebSocketSessionHandler<
  Capability extends string = string,
  Feature extends string = string,
> = (
  socket: WebSocket,
  session: ChatWebSocketSession<Capability, Feature>,
) => void;

export type ChatWebSocketUpgradeOutcomeStatus =
  | "accepted"
  | "admission_denied"
  | "authentication_failed"
  | "authorization_failed"
  | "malformed_handshake"
  | "handshake_timeout"
  | "unsupported_protocol"
  | "snapshot_required"
  | "connection_limit"
  | "internal_error";

/** Privacy-safe, low-cardinality result for one matching upgrade request. */
export interface ChatWebSocketUpgradeOutcome {
  readonly status: ChatWebSocketUpgradeOutcomeStatus;
  readonly durationMs: number;
  /** Present only after trusted server-side authentication succeeds. */
  readonly tenantId?: TenantId;
  /** Present only after trusted server-side authentication succeeds. */
  readonly userId?: UserId;
}

export type ChatWebSocketUpgradeOutcomeObserver = (
  outcome: ChatWebSocketUpgradeOutcome,
) => void | Promise<void>;

export interface ChatWebSocketOptions<
  Capability extends string = string,
  Feature extends string = string,
> {
  readonly path?: string;
  readonly maxConnections?: number;
  readonly maxConnectionsPerTenant?: number;
  readonly handshakeTimeoutMs?: number;
  /**
   * Delay between completion-scheduled active-session checks. Used only when
   * auth.revalidateActiveSession is implemented by the host.
   */
  readonly sessionRevalidationIntervalMs?: number;
  /** Maximum accepted-but-not-yet-written events for each socket. */
  readonly maxPendingEvents?: number;
  /** Maximum retained durable events replayed by a resume handshake. */
  readonly maxReplayEvents?: number;
  /** Called only after trusted auth and protocol negotiation both succeed. */
  readonly onSession?: ChatWebSocketSessionHandler<Capability, Feature>;
  /** Receives one immutable, sanitized result for every matching upgrade. */
  readonly onUpgradeOutcome?: ChatWebSocketUpgradeOutcomeObserver;
  /** Monotonic millisecond clock, primarily for deterministic host tests. */
  readonly now?: () => number;
}

export interface NormalizedChatWebSocketOptions<
  Capability extends string = string,
  Feature extends string = string,
> {
  readonly path: string;
  readonly maxConnections: number;
  readonly maxConnectionsPerTenant: number;
  readonly handshakeTimeoutMs: number;
  readonly sessionRevalidationIntervalMs: number;
  readonly maxPendingEvents: number;
  readonly maxReplayEvents: number;
  readonly onSession: ChatWebSocketSessionHandler<Capability, Feature> | undefined;
  readonly onUpgradeOutcome: ChatWebSocketUpgradeOutcomeObserver | undefined;
  readonly now: () => number;
}

export type ChatWebSocketServer = Pick<HttpServer, "on" | "off">;

interface SocketState {
  readonly socket: WebSocket;
  readonly upgradeOutcome: ChatWebSocketUpgradeLifecycle;
  cleaned: boolean;
  accepted: boolean;
  tenantId?: string;
  timeout?: ReturnType<typeof setTimeout>;
  sessionRevalidationTimeout?: ReturnType<typeof setTimeout>;
  sessionRevalidationGeneration: number;
  subscriptions?: SessionSubscriptionState;
  ephemeralSignals?: ChatEphemeralSignalSession;
  disconnect?: {
    readonly actor: TrustedChatActorContext;
    readonly identity: string;
  };
}

type UpgradeListener = (
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
) => void;

class HandshakeFailure extends Error {
  constructor(readonly closeReason: ChatWebSocketCloseReason) {
    super(closeReason.reason);
  }
}

class SocketEnded extends Error {}

interface ChatWebSocketUpgradeLifecycle {
  trustActor(actor: TrustedChatActorContext): void;
  settle(status: ChatWebSocketUpgradeOutcomeStatus): void;
}

const readChatWebSocketClock = (now: () => number): number => {
  try {
    const value = now();
    return Number.isFinite(value) ? value : performance.now();
  } catch {
    return performance.now();
  }
};

const createChatWebSocketUpgradeLifecycle = (
  options: Pick<
    NormalizedChatWebSocketOptions,
    "now" | "onUpgradeOutcome"
  >,
): ChatWebSocketUpgradeLifecycle => {
  const startedAt = readChatWebSocketClock(options.now);
  let actor: TrustedChatActorContext | undefined;
  let settled = false;

  return Object.freeze({
    trustActor(value: TrustedChatActorContext) {
      if (!settled) {
        actor = value;
      }
    },
    settle(status: ChatWebSocketUpgradeOutcomeStatus) {
      if (settled) return;
      settled = true;
      const completedAt = readChatWebSocketClock(options.now);
      const elapsed = completedAt - startedAt;
      const outcome = Object.freeze({
        status,
        durationMs: Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0,
        ...(actor === undefined
          ? {}
          : { tenantId: actor.tenantId, userId: actor.userId }),
      }) satisfies ChatWebSocketUpgradeOutcome;
      try {
        void Promise.resolve(options.onUpgradeOutcome?.(outcome)).catch(
          () => undefined,
        );
      } catch {
        // Host observation cannot affect upgrade acceptance or rejection.
      }
    },
  });
};

const upgradeStatusForCloseReason = (
  closeReason: ChatWebSocketCloseReason,
): ChatWebSocketUpgradeOutcomeStatus => {
  switch (closeReason.reason) {
    case "authentication_failed":
      return "authentication_failed";
    case "authorization_failed":
      return "authorization_failed";
    case "malformed_handshake":
    case "identity_spoofing":
      return "malformed_handshake";
    case "handshake_timeout":
      return "handshake_timeout";
    case "unsupported_protocol":
      return "unsupported_protocol";
    case "snapshot_required":
      return "snapshot_required";
    case "connection_limit":
      return "connection_limit";
    default:
      return "internal_error";
  }
};

type ChatWebSocketSubscriptionRequestErrorCode = Exclude<
  ChatWebSocketSubscriptionErrorCode,
  typeof CHAT_WEBSOCKET_SUBSCRIPTION_ERROR_CODES.accessRevoked
>;

class SubscriptionRequestFailure extends Error {
  constructor(
    readonly code: ChatWebSocketSubscriptionRequestErrorCode,
    readonly requestId?: string,
  ) {
    super(code);
  }
}

interface SessionSubscriptionState {
  readonly actor: TrustedChatActorContext;
  readonly streams: Set<ChatWebSocketStreamId>;
  readonly registry: ChatWebSocketSessionSubscriptions;
  readonly lastDeliveredCursor: EventCursor | undefined;
  beginReplay(): void;
  prepareReplay(
    replay: readonly PositionedChatEvent[],
    streamIds: readonly ChatWebSocketStreamId[],
    cursorPosition: number,
    protocolVersion: number,
  ): Promise<void>;
  startDelivery(): void;
  enqueueRevalidation(streamId?: ChatWebSocketStreamId): Promise<number>;
  refreshActor(
    actor: TrustedChatActorContext,
    onApplied: () => void,
  ): Promise<number>;
  dispose(): void;
}

const CLIENT_SUBSCRIPTION_FIELDS = new Set([
  "type",
  "requestId",
  "streamId",
]);

const CLIENT_SUBSCRIPTION_IDENTITY_FIELDS = new Set([
  "tenantId",
  "userId",
  "roles",
  "capabilities",
  "actor",
  "actorId",
]);

const containsIdentityScope = (value: unknown): boolean => {
  if (Array.isArray(value)) {
    return value.some(containsIdentityScope);
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return Object.entries(value).some(
    ([key, nested]) =>
      CLIENT_SUBSCRIPTION_IDENTITY_FIELDS.has(key) ||
      containsIdentityScope(nested),
  );
};

const validRequestId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 128 &&
  value.trim() === value &&
  !/[\u0000-\u001f\u007f]/.test(value);

function parseSubscriptionRequest(
  serialized: string,
): ChatWebSocketSubscriptionRequest {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new SubscriptionRequestFailure(
      CHAT_WEBSOCKET_SUBSCRIPTION_ERROR_CODES.malformedRequest,
    );
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SubscriptionRequestFailure(
      CHAT_WEBSOCKET_SUBSCRIPTION_ERROR_CODES.malformedRequest,
    );
  }
  if (containsIdentityScope(value)) {
    const requestId = validRequestId(
      (value as Record<string, unknown>).requestId,
    )
      ? ((value as Record<string, unknown>).requestId as string)
      : undefined;
    throw new SubscriptionRequestFailure(
      CHAT_WEBSOCKET_SUBSCRIPTION_ERROR_CODES.identitySpoofing,
      requestId,
    );
  }

  const candidate = value as Record<string, unknown>;
  const requestId = validRequestId(candidate.requestId)
    ? candidate.requestId
    : undefined;
  if (
    Object.keys(candidate).some(
      (field) => !CLIENT_SUBSCRIPTION_FIELDS.has(field),
    ) ||
    requestId === undefined ||
    typeof candidate.streamId !== "string" ||
    (candidate.type !== CHAT_WEBSOCKET_SUBSCRIPTION_MESSAGE_TYPES.subscribe &&
      candidate.type !==
        CHAT_WEBSOCKET_SUBSCRIPTION_MESSAGE_TYPES.unsubscribe)
  ) {
    throw new SubscriptionRequestFailure(
      CHAT_WEBSOCKET_SUBSCRIPTION_ERROR_CODES.malformedRequest,
      requestId,
    );
  }

  return Object.freeze({
    type: candidate.type,
    requestId,
    streamId: candidate.streamId,
  });
}

function parseSubscriptionStreamId(
  value: string,
  actor: TrustedChatActorContext,
): ChatWebSocketStreamId {
  if (value.startsWith("user:")) {
    if (value === `user:${actor.userId}`) {
      return value as ChatWebSocketStreamId;
    }
    throw new SubscriptionRequestFailure(
      CHAT_WEBSOCKET_SUBSCRIPTION_ERROR_CODES.identitySpoofing,
    );
  }

  if (
    value.length === 0 ||
    value.length > 512 ||
    value.trim() !== value ||
    /[\u0000-\u0020\u007f*?]/.test(value) ||
    /^(?:all|tenant|organization|org)(?::|\/|$)/i.test(value)
  ) {
    throw new SubscriptionRequestFailure(
      CHAT_WEBSOCKET_SUBSCRIPTION_ERROR_CODES.invalidStream,
    );
  }
  return value as ChatWebSocketStreamId;
}

export interface ChatWebSocketController {
  readonly attachedServer: ChatWebSocketServer | undefined;
  readonly sessionCount: number;
  readonly subscriptionCount: number;
  attach(server: ChatWebSocketServer): void;
  detach(reason?: ChatWebSocketCloseReason): void;
  revalidateSubscriptions(
    scope?: ChatWebSocketSubscriptionRevalidationScope,
  ): Promise<number>;
  drainEphemeralSignals(): Promise<void>;
  drainHuddleDisconnects(): Promise<void>;
}

interface CreateChatWebSocketControllerInput<
  Request,
  Capability extends string,
  EntityAction extends string,
  Feature extends string,
> {
  readonly admission?: ChatRequestAdmissionAdapter<IncomingMessage & Request>;
  readonly auth: ChatAuthAdapter<IncomingMessage & Request>;
  readonly permissions: ChatPermissionAdapter<Capability, EntityAction>;
  readonly database: PostgresMigrationDatabase;
  readonly schema: string;
  readonly realtime?: ChatRealtimeSubscriber;
  readonly ephemeralSignals: ChatEphemeralSignalController;
  readonly options: NormalizedChatWebSocketOptions<Capability, Feature>;
  readonly readMetadata: () => Promise<ServerHandshakeMetadata<Feature>>;
}

export function createChatWebSocketController<
  Request,
  Capability extends string,
  EntityAction extends string,
  Feature extends string,
>(
  input: CreateChatWebSocketControllerInput<
    Request,
    Capability,
    EntityAction,
    Feature
  >,
): ChatWebSocketController {
  let attachment:
    | {
        readonly server: ChatWebSocketServer;
        readonly listener: UpgradeListener;
      }
    | undefined;
  let sessionCount = 0;
  let subscriptionCount = 0;
  const sockets = new Set<SocketState>();
  const pendingUpgradeSockets = new Map<
    Duplex,
    ChatWebSocketUpgradeLifecycle
  >();
  const tenantConnectionCounts = new Map<string, number>();
  const pendingDisconnectActivations = new Set<Promise<void>>();
  const pendingHuddleDisconnects = new Set<Promise<void>>();

  const persistDisconnect = (
    disconnect: NonNullable<SocketState["disconnect"]>,
  ): void => {
    const pending = leaveJoinedHuddlesOnDisconnect({
      database: input.database,
      schema: input.schema,
      permissions: input.permissions as ChatPermissionAdapter<string, string>,
      actor: disconnect.actor,
      disconnectIdentity: disconnect.identity,
    })
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => pendingHuddleDisconnects.delete(pending));
    pendingHuddleDisconnects.add(pending);
  };

  const cleanup = (state: SocketState): void => {
    if (state.cleaned) {
      return;
    }
    state.upgradeOutcome.settle("internal_error");
    state.cleaned = true;
    state.sessionRevalidationGeneration += 1;
    if (state.timeout !== undefined) {
      clearTimeout(state.timeout);
    }
    if (state.sessionRevalidationTimeout !== undefined) {
      clearTimeout(state.sessionRevalidationTimeout);
      delete state.sessionRevalidationTimeout;
    }
    state.subscriptions?.dispose();
    delete state.subscriptions;
    state.ephemeralSignals?.dispose();
    delete state.ephemeralSignals;
    if (state.disconnect !== undefined) {
      persistDisconnect(state.disconnect);
      delete state.disconnect;
    }
    sockets.delete(state);
    if (state.accepted) {
      sessionCount -= 1;
    }
    if (state.tenantId !== undefined) {
      const remaining = (tenantConnectionCounts.get(state.tenantId) ?? 1) - 1;
      if (remaining === 0) {
        tenantConnectionCounts.delete(state.tenantId);
      } else {
        tenantConnectionCounts.set(state.tenantId, remaining);
      }
    }
  };

  const reject = (
    state: SocketState,
    closeReason: ChatWebSocketCloseReason,
  ): void => {
    if (state.cleaned) {
      return;
    }
    state.upgradeOutcome.settle(upgradeStatusForCloseReason(closeReason));
    cleanup(state);
    if (
      state.socket.readyState === WebSocket.OPEN ||
      state.socket.readyState === WebSocket.CONNECTING
    ) {
      state.socket.close(closeReason.code, closeReason.reason);
    }
  };

  const sendSubscriptionMessage = (
    state: SocketState,
    message: ChatWebSocketSubscriptionServerMessage,
  ): void => {
    if (state.cleaned || state.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    try {
      state.socket.send(JSON.stringify(message), (error) => {
        if (error) {
          reject(state, CHAT_WEBSOCKET_CLOSE_REASONS.internalError);
        }
      });
    } catch {
      reject(state, CHAT_WEBSOCKET_CLOSE_REASONS.internalError);
    }
  };

  const sendControlAndReject = (
    state: SocketState,
    message:
      | ChatWebSocketRefreshRequiredMessage<Feature>
      | ChatWebSocketSnapshotRequiredMessage<Feature>,
    closeReason: ChatWebSocketCloseReason,
  ): void => {
    if (state.cleaned || state.socket.readyState !== WebSocket.OPEN) {
      reject(state, closeReason);
      return;
    }
    try {
      state.socket.send(JSON.stringify(message), (error) => {
        reject(
          state,
          error == null
            ? closeReason
            : CHAT_WEBSOCKET_CLOSE_REASONS.internalError,
        );
      });
    } catch {
      reject(state, CHAT_WEBSOCKET_CLOSE_REASONS.internalError);
    }
  };

  const createSubscriptionState = (
    state: SocketState,
    initialActor: TrustedChatActorContext,
  ): SessionSubscriptionState => {
    const streams = new Set<ChatWebSocketStreamId>();
    const deliveryQueue: Array<{
      readonly event: ChatEvent;
      readonly serialized: string;
    }> = [];
    const seenEventIds = new Set<string>();
    const seenEventOrder: string[] = [];
    const replayBoundaryBuffer: ChatEvent[] = [];
    // Budget every batch together: drained events may still be resolving or retained.
    let replayBoundaryAdmissions = 0;
    let active = true;
    let actor = initialActor;
    let authorizationRefreshing = false;
    let replaying = false;
    let deliveryStarted = true;
    let operationQueue = Promise.resolve();
    let pendingInboundMessages = 0;
    let pendingEphemeralAuthorizations = 0;
    let sending:
      | { readonly event: ChatEvent; readonly serialized: string }
      | undefined;
    let lastDeliveredCursor: EventCursor | undefined;
    let unsubscribeFanout: (() => void) | undefined;

    const enqueue = <Result>(operation: () => Promise<Result>): Promise<Result> => {
      const result = operationQueue.then(operation);
      operationQueue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    };

    const authorize = async (
      streamId: ChatWebSocketStreamId,
    ): Promise<boolean> => {
      const result = await authorizeChatWebSocketStream({
        database: input.database,
        permissions: input.permissions,
        actor,
        streamId,
        schema: input.schema,
      });
      return result.authorized;
    };

    const detachFanout = (): void => {
      const unsubscribe = unsubscribeFanout;
      unsubscribeFanout = undefined;
      if (unsubscribe !== undefined) {
        try {
          unsubscribe();
        } catch {
          // Cleanup remains idempotent even when a host adapter misbehaves.
        }
      }
    };

    const dropQueuedStream = (streamId: ChatWebSocketStreamId): void => {
      for (let index = deliveryQueue.length - 1; index >= 0; index -= 1) {
        if (deliveryQueue[index]?.event.streamId === streamId) {
          deliveryQueue.splice(index, 1);
        }
      }
    };

    const remove = (streamId: ChatWebSocketStreamId): boolean => {
      if (!streams.delete(streamId)) {
        return false;
      }
      subscriptionCount -= 1;
      dropQueuedStream(streamId);
      if (streams.size === 0) {
        detachFanout();
      }
      return true;
    };

    const add = (streamId: ChatWebSocketStreamId): boolean => {
      if (!active || state.cleaned) {
        return false;
      }
      if (streams.has(streamId)) {
        return true;
      }
      if (streams.size >= MAX_STREAMS_PER_SESSION) {
        reject(state, CHAT_WEBSOCKET_CLOSE_REASONS.connectionLimit);
        return false;
      }
      streams.add(streamId);
      subscriptionCount += 1;
      return true;
    };

    const rememberEventId = (eventId: string): void => {
      seenEventIds.add(eventId);
      seenEventOrder.push(eventId);
      if (seenEventOrder.length > CHAT_WEBSOCKET_DUPLICATE_WINDOW_SIZE) {
        const expired = seenEventOrder.shift();
        if (expired !== undefined) {
          seenEventIds.delete(expired);
        }
      }
    };

    const pumpDeliveryQueue = (): void => {
      if (
        !active ||
        state.cleaned ||
        authorizationRefreshing ||
        !deliveryStarted ||
        sending !== undefined ||
        state.socket.readyState !== WebSocket.OPEN
      ) {
        return;
      }

      const next = deliveryQueue.shift();
      if (next === undefined) {
        return;
      }
      if (!streams.has(next.event.streamId as ChatWebSocketStreamId)) {
        pumpDeliveryQueue();
        return;
      }

      sending = next;
      try {
        state.socket.send(next.serialized, (error) => {
          if (!active || state.cleaned) {
            return;
          }
          sending = undefined;
          if (error) {
            reject(state, CHAT_WEBSOCKET_CLOSE_REASONS.internalError);
            return;
          }
          if (
            !CHAT_EPHEMERAL_EVENT_TYPES.includes(
              next.event.type as (typeof CHAT_EPHEMERAL_EVENT_TYPES)[number],
            )
          ) {
            lastDeliveredCursor = Object.freeze({
              eventId: next.event.eventId,
            });
          }
          pumpDeliveryQueue();
        });
      } catch {
        sending = undefined;
        reject(state, CHAT_WEBSOCKET_CLOSE_REASONS.internalError);
      }
    };

    const queueFanoutEvent = (event: ChatEvent): void => {
      let serialized: string;
      try {
        serialized = JSON.stringify(event);
      } catch {
        return;
      }

      const pendingCount = deliveryQueue.length + (sending === undefined ? 0 : 1);
      if (pendingCount >= input.options.maxPendingEvents) {
        reject(state, createSlowConsumerCloseReason(lastDeliveredCursor));
        return;
      }

      rememberEventId(event.eventId);
      deliveryQueue.push({ event, serialized });
      pumpDeliveryQueue();
    };

    const onFanout = (value: unknown): void => {
      if (!active || state.cleaned) {
        return;
      }

      let event: ChatEvent;
      try {
        event = parseChatEvent(value, actor.tenantId);
      } catch {
        // Fanout is an untrusted boundary. Malformed and cross-tenant values
        // are safely ignored without revealing their contents to the socket.
        return;
      }
      if (isInternalChatEventType(event.type)) {
        return;
      }
      if (replaying) {
        if (
          CHAT_EPHEMERAL_EVENT_TYPES.includes(
            event.type as (typeof CHAT_EPHEMERAL_EVENT_TYPES)[number],
          )
        ) {
          return;
        }
        if (replayBoundaryAdmissions >= input.options.maxPendingEvents) {
          reject(state, createSlowConsumerCloseReason(lastDeliveredCursor));
          return;
        }
        replayBoundaryAdmissions += 1;
        replayBoundaryBuffer.push(event);
        return;
      }
      if (
        !streams.has(event.streamId as ChatWebSocketStreamId) ||
        seenEventIds.has(event.eventId)
      ) {
        return;
      }

      if (
        CHAT_EPHEMERAL_EVENT_TYPES.includes(
          event.type as (typeof CHAT_EPHEMERAL_EVENT_TYPES)[number],
        )
      ) {
        const ephemeral = input.ephemeralSignals.parseFanout(
          value,
          actor.tenantId,
        );
        if (ephemeral === undefined) {
          return;
        }
        // Reserve before enqueueing so queued and active authorization work is bounded.
        const pendingCount =
          pendingEphemeralAuthorizations +
          deliveryQueue.length +
          (sending === undefined ? 0 : 1);
        if (pendingCount >= input.options.maxPendingEvents) {
          reject(state, createSlowConsumerCloseReason(lastDeliveredCursor));
          return;
        }
        pendingEphemeralAuthorizations += 1;
        void enqueue(async () => {
          try {
            if (
              !active ||
              state.cleaned ||
              !streams.has(ephemeral.streamId as ChatWebSocketStreamId) ||
              seenEventIds.has(ephemeral.eventId)
            ) {
              return;
            }
            const authorized = await input.ephemeralSignals.authorizeDelivery(
              actor,
              ephemeral,
            );
            if (
              !active ||
              state.cleaned ||
              !streams.has(ephemeral.streamId as ChatWebSocketStreamId) ||
              seenEventIds.has(ephemeral.eventId) ||
              !authorized
            ) {
              return;
            }
            queueFanoutEvent(ephemeral);
          } catch {
            if (active && !state.cleaned) {
              reject(state, CHAT_WEBSOCKET_CLOSE_REASONS.authorizationFailed);
            }
          } finally {
            // Each callback owns its slot through completion, including after disposal.
            // Do not reset this counter on dispose while callbacks still own slots.
            pendingEphemeralAuthorizations -= 1;
          }
        });
        return;
      }
      queueFanoutEvent(event);
    };

    const attachFanout = (force = false): void => {
      if (
        input.realtime === undefined ||
        unsubscribeFanout !== undefined ||
        (!force && streams.size === 0)
      ) {
        return;
      }
      const unsubscribe = input.realtime.subscribe(onFanout);
      if (typeof unsubscribe !== "function") {
        throw new TypeError("realtime.subscribe must return a function");
      }
      unsubscribeFanout = unsubscribe;
    };

    const rejectRequest = (
      code: ChatWebSocketSubscriptionRequestErrorCode,
      requestId?: string,
    ): void => {
      sendSubscriptionMessage(
        state,
        requestId === undefined
          ? {
              type: CHAT_WEBSOCKET_SUBSCRIPTION_MESSAGE_TYPES.rejected,
              code,
            }
          : {
              type: CHAT_WEBSOCKET_SUBSCRIPTION_MESSAGE_TYPES.rejected,
              code,
              requestId,
            },
      );
    };

    const handleMessage = async (
      data: RawData,
      isBinary: boolean,
    ): Promise<void> => {
      if (!active || state.cleaned) {
        return;
      }
      let request: ChatWebSocketSubscriptionRequest;
      try {
        if (isBinary) {
          throw new SubscriptionRequestFailure(
            CHAT_WEBSOCKET_SUBSCRIPTION_ERROR_CODES.malformedRequest,
          );
        }
        const serialized = data.toString("utf8");
        if (await state.ephemeralSignals?.handle(serialized)) {
          return;
        }
        if (!active || state.cleaned) {
          return;
        }
        request = parseSubscriptionRequest(serialized);
      } catch (error) {
        const failure =
          error instanceof SubscriptionRequestFailure
            ? error
            : new SubscriptionRequestFailure(
                CHAT_WEBSOCKET_SUBSCRIPTION_ERROR_CODES.malformedRequest,
              );
        rejectRequest(failure.code, failure.requestId);
        return;
      }

      let streamId: ChatWebSocketStreamId;
      try {
        streamId = parseSubscriptionStreamId(request.streamId, actor);
      } catch (error) {
        const failure =
          error instanceof SubscriptionRequestFailure
            ? error
            : new SubscriptionRequestFailure(
                CHAT_WEBSOCKET_SUBSCRIPTION_ERROR_CODES.invalidStream,
              );
        rejectRequest(failure.code, request.requestId);
        return;
      }

      if (
        request.type ===
        CHAT_WEBSOCKET_SUBSCRIPTION_MESSAGE_TYPES.unsubscribe
      ) {
        remove(streamId);
        sendSubscriptionMessage(state, {
          type: CHAT_WEBSOCKET_SUBSCRIPTION_MESSAGE_TYPES.unsubscribed,
          requestId: request.requestId,
          streamId,
        });
        return;
      }

      const authorized = await authorize(streamId);
      if (!active || state.cleaned) {
        return;
      }
      if (!authorized) {
        remove(streamId);
        rejectRequest(
          CHAT_WEBSOCKET_SUBSCRIPTION_ERROR_CODES.accessDenied,
          request.requestId,
        );
        return;
      }
      if (!add(streamId)) {
        return;
      }
      sendSubscriptionMessage(state, {
        type: CHAT_WEBSOCKET_SUBSCRIPTION_MESSAGE_TYPES.subscribed,
        requestId: request.requestId,
        streamId,
      });
      try {
        attachFanout();
      } catch {
        reject(state, CHAT_WEBSOCKET_CLOSE_REASONS.internalError);
      }
    };

    const onMessage = (data: RawData, isBinary: boolean): void => {
      if (!active || state.cleaned) {
        return;
      }
      // Admit synchronously before allocating a closure that retains RawData.
      if (pendingInboundMessages >= MAX_PENDING_INBOUND_MESSAGES) {
        reject(state, CHAT_WEBSOCKET_CLOSE_REASONS.connectionLimit);
        return;
      }
      pendingInboundMessages += 1;
      void enqueue(async () => {
        try {
          await handleMessage(data, isBinary);
        } catch {
          if (active && !state.cleaned) {
            rejectRequest(CHAT_WEBSOCKET_SUBSCRIPTION_ERROR_CODES.accessDenied);
          }
        } finally {
          // Each admitted frame owns one slot, even if cleanup skips its work.
          // Do not reset this counter on dispose while handlers still own slots.
          pendingInboundMessages -= 1;
        }
      });
    };
    state.socket.on("message", onMessage);

    const revalidate = async (
      onlyStreamId?: ChatWebSocketStreamId,
    ): Promise<number> => {
      if (!active || state.cleaned) {
        return 0;
      }
      let candidates =
        onlyStreamId === undefined
          ? [...streams]
          : streams.has(onlyStreamId)
            ? [onlyStreamId]
            : [];
      let relationshipFailed = false;
      if (onlyStreamId !== undefined && !onlyStreamId.startsWith("user:")) {
        const otherConversations = [...streams].filter(
          (streamId) => streamId !== onlyStreamId && !streamId.startsWith("user:"),
        );
        if (otherConversations.length > 0) {
          try {
            const schema = validatePostgresSchema(input.schema);
            const result = await input.database.query<{
              id: ChatWebSocketStreamId;
              type: string;
              parent_conversation_id: string | null;
            }>(
              `SELECT id, type, parent_conversation_id
                 FROM "${schema}".chat_conversations
                WHERE tenant_id = $1 AND id = ANY($2::text[])`,
              [actor.tenantId, otherConversations],
            );
            const relationships = new Map(result.rows.map((row) => [row.id, row]));
            candidates.push(...otherConversations.filter((streamId) => {
              const row = relationships.get(streamId);
              // Missing rows must also be rechecked, never retain deleted streams.
              return row === undefined ||
                (row.type === "thread" && row.parent_conversation_id === onlyStreamId);
            }));
          } catch {
            // We cannot safely determine which conversations inherited the
            // notification. Revoke them conservatively, preserving user streams.
            candidates = [...candidates, ...otherConversations];
            relationshipFailed = true;
          }
        }
      }
      let revoked = 0;
      for (const streamId of candidates) {
        const authorized = !relationshipFailed && await authorize(streamId);
        if (!active || state.cleaned) {
          break;
        }
        if (!authorized && remove(streamId)) {
          revoked += 1;
          sendSubscriptionMessage(state, {
            type: CHAT_WEBSOCKET_SUBSCRIPTION_MESSAGE_TYPES.revoked,
            code: CHAT_WEBSOCKET_SUBSCRIPTION_ERROR_CODES.accessRevoked,
            streamId,
          });
        }
      }
      return revoked;
    };

    const enqueueRevalidation = (
      onlyStreamId?: ChatWebSocketStreamId,
    ): Promise<number> => enqueue(() => revalidate(onlyStreamId));

    const registry: ChatWebSocketSessionSubscriptions = Object.freeze({
      get size() {
        return streams.size;
      },
      get streamIds() {
        return Object.freeze([...streams]);
      },
      has(streamId: string) {
        return streams.has(streamId as ChatWebSocketStreamId);
      },
      revalidate() {
        return enqueueRevalidation();
      },
    });

    return {
      get actor() {
        return actor;
      },
      streams,
      registry,
      get lastDeliveredCursor() {
        return lastDeliveredCursor;
      },
      beginReplay() {
        replaying = true;
        deliveryStarted = false;
        attachFanout(true);
      },
      async prepareReplay(
        replay,
        streamIds,
        cursorPosition,
        protocolVersion,
      ) {
        if (!active || state.cleaned) {
          return;
        }
        const positioned = [...replay];
        for (const streamId of streamIds) {
          if (!add(streamId)) {
            return;
          }
        }
        if (!add(`user:${actor.userId}` as ChatWebSocketStreamId)) {
          return;
        }

        while (active && !state.cleaned) {
          const buffered = replayBoundaryBuffer.splice(
            0,
            replayBoundaryBuffer.length,
          );
          if (buffered.length === 0) {
            replaying = false;
            break;
          }
          const resolved = await resolveBufferedReplayEvents({
            database: input.database,
            schema: input.schema,
            permissions: input.permissions,
            actor,
            protocolVersion,
            cursorPosition,
            events: buffered,
          });
          if (!active || state.cleaned) {
            return;
          }
          for (const entry of resolved) {
            if (!add(entry.event.streamId as ChatWebSocketStreamId)) {
              return;
            }
            positioned.push(entry);
          }
        }

        positioned.sort(
          (left, right) => left.replayPosition - right.replayPosition,
        );
        for (const entry of positioned) {
          if (seenEventIds.has(entry.event.eventId)) {
            continue;
          }
          let serialized: string;
          try {
            serialized = JSON.stringify(entry.event);
          } catch {
            continue;
          }
          rememberEventId(entry.event.eventId);
          deliveryQueue.push({ event: entry.event, serialized });
        }
      },
      startDelivery() {
        deliveryStarted = true;
        pumpDeliveryQueue();
      },
      enqueueRevalidation,
      refreshActor(nextActor, onApplied) {
        authorizationRefreshing = true;
        return enqueue(async () => {
          if (!active || state.cleaned) {
            return 0;
          }
          actor = nextActor;
          onApplied();
          return revalidate();
        }).finally(() => {
          authorizationRefreshing = false;
          pumpDeliveryQueue();
        });
      },
      dispose() {
        if (!active) {
          return;
        }
        active = false;
        state.socket.off("message", onMessage);
        detachFanout();
        subscriptionCount -= streams.size;
        streams.clear();
        deliveryQueue.length = 0;
        sending = undefined;
        seenEventIds.clear();
        seenEventOrder.length = 0;
        replayBoundaryBuffer.length = 0;
      },
    };
  };

  const scheduleSessionRevalidation = <CapabilityValue extends string>(
    request: IncomingMessage & Request,
    state: SocketState,
    authorization: {
      actor: TrustedChatActorContext;
      capabilities: readonly CapabilityValue[];
    },
  ): void => {
    const revalidateActiveSession = input.auth.revalidateActiveSession;
    if (revalidateActiveSession === undefined || state.cleaned) {
      return;
    }
    const generation = state.sessionRevalidationGeneration;
    state.sessionRevalidationTimeout = setTimeout(() => {
      delete state.sessionRevalidationTimeout;
      void (async () => {
        let nextActor: TrustedChatActorContext;
        try {
          const unsafeActor = await revalidateActiveSession.call(input.auth, {
            request,
            actor: authorization.actor,
          });
          if (
            state.cleaned ||
            generation !== state.sessionRevalidationGeneration
          ) {
            return;
          }
          nextActor = validateTrustedChatActorContext(unsafeActor);
          if (
            nextActor.tenantId !== authorization.actor.tenantId ||
            nextActor.userId !== authorization.actor.userId
          ) {
            throw new ChatAuthenticationError();
          }
        } catch {
          if (
            !state.cleaned &&
            generation === state.sessionRevalidationGeneration
          ) {
            reject(state, CHAT_WEBSOCKET_CLOSE_REASONS.authenticationFailed);
          }
          return;
        }

        let nextCapabilities: readonly CapabilityValue[];
        try {
          nextCapabilities = validateChatCapabilities<CapabilityValue>(
            await input.permissions.getCapabilities({ actor: nextActor }),
          );
        } catch {
          if (
            !state.cleaned &&
            generation === state.sessionRevalidationGeneration
          ) {
            reject(state, CHAT_WEBSOCKET_CLOSE_REASONS.authorizationFailed);
          }
          return;
        }
        if (
          state.cleaned ||
          generation !== state.sessionRevalidationGeneration
        ) {
          return;
        }

        const subscriptions = state.subscriptions;
        if (subscriptions === undefined) {
          return;
        }
        await subscriptions.refreshActor(nextActor, () => {
          authorization.actor = nextActor;
          authorization.capabilities = nextCapabilities;
          state.ephemeralSignals?.refreshActor(nextActor);
          if (state.disconnect !== undefined) {
            state.disconnect = {
              actor: nextActor,
              identity: state.disconnect.identity,
            };
          }
        });
      })()
        .catch(() => {
          if (
            !state.cleaned &&
            generation === state.sessionRevalidationGeneration
          ) {
            reject(state, CHAT_WEBSOCKET_CLOSE_REASONS.authorizationFailed);
          }
        })
        .finally(() => {
          if (
            !state.cleaned &&
            generation === state.sessionRevalidationGeneration
          ) {
            scheduleSessionRevalidation(request, state, authorization);
          }
        });
    }, input.options.sessionRevalidationIntervalMs);
    state.sessionRevalidationTimeout.unref();
  };

  const establish = async (
    request: IncomingMessage,
    state: SocketState,
    browserAuthorization?: string,
  ): Promise<void> => {
    const handshakePromise = receiveHandshake(state);
    try {
      const previousAuthorization = request.headers.authorization;
      if (
        previousAuthorization === undefined &&
        browserAuthorization !== undefined
      ) {
        request.headers.authorization = browserAuthorization;
      }
      const contextPromise = resolveChatRequestContext(
        request as IncomingMessage & Request,
        input.auth,
        input.permissions,
      )
        .then((context) => {
          state.upgradeOutcome.trustActor(context.actor);
          return context;
        })
        .finally(() => {
          if (
            previousAuthorization === undefined &&
            browserAuthorization !== undefined
          ) {
            delete request.headers.authorization;
          }
        });
      const [context, handshake] = await Promise.all([
        contextPromise,
        handshakePromise,
      ]);
      if (state.cleaned) {
        return;
      }
      if (input.auth.revalidateActiveSession !== undefined) {
        scrubWebSocketRequestCredentials(request);
      }

      const tenantId = context.actor.tenantId;
      const tenantConnections = tenantConnectionCounts.get(tenantId) ?? 0;
      if (tenantConnections >= input.options.maxConnectionsPerTenant) {
        reject(state, CHAT_WEBSOCKET_CLOSE_REASONS.connectionLimit);
        return;
      }
      state.tenantId = tenantId;
      tenantConnectionCounts.set(tenantId, tenantConnections + 1);

      const metadata = freezeMetadata(await input.readMetadata());
      if (state.cleaned) {
        return;
      }
      const decision = decideRealtimeHandshake(handshake, metadata);
      if (decision.state === "refresh_required") {
        sendControlAndReject(
          state,
          {
            type: "chat.session.refresh_required",
            ...decision,
          },
          CHAT_WEBSOCKET_CLOSE_REASONS.unsupportedProtocol,
        );
        return;
      }
      if (decision.state !== "accepted") {
        reject(state, CHAT_WEBSOCKET_CLOSE_REASONS.internalError);
        return;
      }

      const authorization = {
        actor: context.actor,
        capabilities: context.capabilities,
      };
      const subscriptions = createSubscriptionState(state, authorization.actor);
      state.subscriptions = subscriptions;
      const ephemeralSignals = input.ephemeralSignals.attachSession(
        context.actor,
        handshake.protocolVersion,
      );
      state.ephemeralSignals = ephemeralSignals;
      if (handshake.resumeFrom !== undefined) {
        if (input.realtime === undefined) {
          sendControlAndReject(
            state,
            {
              type: "chat.session.snapshot_required",
              state: "snapshot_required",
              reason: "replay_unavailable",
              metadata,
              resumeFrom: handshake.resumeFrom,
            },
            CHAT_WEBSOCKET_CLOSE_REASONS.snapshotRequired,
          );
          return;
        }
        subscriptions.beginReplay();
        const replay = await readChatWebSocketReplay({
          database: input.database,
          schema: input.schema,
          permissions: input.permissions,
          actor: context.actor,
          cursor: handshake.resumeFrom,
          protocolVersion: handshake.protocolVersion,
          limit: input.options.maxReplayEvents,
        });
        if (state.cleaned) {
          return;
        }
        if (replay.state === "snapshot_required") {
          sendControlAndReject(
            state,
            {
              type: "chat.session.snapshot_required",
              state: "snapshot_required",
              reason: replay.reason,
              metadata,
              resumeFrom: handshake.resumeFrom,
            },
            CHAT_WEBSOCKET_CLOSE_REASONS.snapshotRequired,
          );
          return;
        }
        await subscriptions.prepareReplay(
          replay.events,
          replay.streamIds,
          replay.cursorPosition,
          handshake.protocolVersion,
        );
        if (state.cleaned) {
          return;
        }
      }
      const session = createSession(
        () => authorization,
        handshake,
        metadata,
        subscriptions.registry,
        ephemeralSignals.identity,
        () => subscriptions.lastDeliveredCursor,
      );
      state.accepted = true;
      sessionCount += 1;
      if (state.timeout !== undefined) {
        clearTimeout(state.timeout);
        delete state.timeout;
      }

      try {
        input.options.onSession?.(state.socket, session);
      } catch {
        reject(state, CHAT_WEBSOCKET_CLOSE_REASONS.internalError);
        return;
      }

      const acceptedMessage: ChatWebSocketSessionAcceptedMessage<Feature> =
        handshake.resumeFrom === undefined
          ? {
              type: "chat.session.accepted",
              metadata,
              tenantId: context.actor.tenantId,
              actorStreamId: `user:${context.actor.userId}`,
              deviceId: ephemeralSignals.identity.deviceId,
              sessionId: ephemeralSignals.identity.sessionId,
            }
          : {
              type: "chat.session.accepted",
              metadata,
              tenantId: context.actor.tenantId,
              actorStreamId: `user:${context.actor.userId}`,
              deviceId: ephemeralSignals.identity.deviceId,
              sessionId: ephemeralSignals.identity.sessionId,
              resumeFrom: handshake.resumeFrom,
            };
      let resolveActivation: () => void = () => undefined;
      const activation = new Promise<void>((resolve) => {
        resolveActivation = resolve;
      });
      pendingDisconnectActivations.add(activation);
      try {
        state.socket.send(JSON.stringify(acceptedMessage), (error) => {
          try {
            if (error) {
              reject(state, CHAT_WEBSOCKET_CLOSE_REASONS.internalError);
              return;
            }
            const disconnect = {
              actor: context.actor,
              identity: ephemeralSignals.identity.sessionId,
            };
            if (state.cleaned) {
              persistDisconnect(disconnect);
              return;
            }
            state.upgradeOutcome.settle("accepted");
            state.disconnect = disconnect;
            subscriptions.startDelivery();
            scheduleSessionRevalidation(
              request as IncomingMessage & Request,
              state,
              authorization,
            );
          } finally {
            pendingDisconnectActivations.delete(activation);
            resolveActivation();
          }
        });
      } catch (error) {
        pendingDisconnectActivations.delete(activation);
        resolveActivation();
        throw error;
      }
    } catch (error) {
      if (state.cleaned || error instanceof SocketEnded) {
        return;
      }
      if (error instanceof HandshakeFailure) {
        reject(state, error.closeReason);
      } else if (error instanceof ChatAuthorizationError) {
        reject(state, CHAT_WEBSOCKET_CLOSE_REASONS.authorizationFailed);
      } else if (error instanceof ChatAuthenticationError) {
        reject(state, CHAT_WEBSOCKET_CLOSE_REASONS.authenticationFailed);
      } else {
        reject(state, CHAT_WEBSOCKET_CLOSE_REASONS.internalError);
      }
    }
  };

  const controller: ChatWebSocketController = {
    get attachedServer() {
      return attachment?.server;
    },
    get sessionCount() {
      return sessionCount;
    },
    get subscriptionCount() {
      return subscriptionCount;
    },
    attach(server) {
      if (attachment?.server === server) {
        return;
      }
      if (attachment !== undefined) {
        throw new Error(
          "The chat server runtime is already attached to an HTTP server",
        );
      }

      const webSocketServer = new WebSocketServer({
        clientTracking: false,
        handleProtocols(protocols) {
          if (protocols.has(CHAT_REALTIME_SUBPROTOCOL)) {
            return CHAT_REALTIME_SUBPROTOCOL;
          }
          return [...protocols].find(
            (protocol) =>
              !protocol.startsWith(CHAT_REALTIME_BEARER_SUBPROTOCOL_PREFIX),
          ) ?? false;
        },
        maxPayload: 16 * 1024,
        noServer: true,
      });
      const listener: UpgradeListener = (request, socket, head) => {
        if (readPathname(request.url) !== input.options.path) {
          return;
        }

        const upgradeOutcome = createChatWebSocketUpgradeLifecycle(
          input.options,
        );
        pendingUpgradeSockets.set(socket, upgradeOutcome);
        const stopPending = (): void => {
          pendingUpgradeSockets.delete(socket);
          upgradeOutcome.settle("internal_error");
        };
        socket.once("close", stopPending);
        socket.once("error", stopPending);

        const continueUpgrade = (): void => {
          try {
            const browserAuthorization =
              request.headers.authorization === undefined
                ? readBrowserWebSocketAuthorization(
                    request.headers["sec-websocket-protocol"],
                  )
                : undefined;
            webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
              pendingUpgradeSockets.delete(socket);
              if (browserAuthorization !== undefined) {
                scrubBrowserCredentialProtocol(request);
              }
              const state: SocketState = {
                socket: webSocket,
                upgradeOutcome,
                cleaned: false,
                accepted: false,
                sessionRevalidationGeneration: 0,
              };
              sockets.add(state);
              webSocket.once("close", () => cleanup(state));
              webSocket.once("error", () => cleanup(state));

              if (sockets.size > input.options.maxConnections) {
                reject(state, CHAT_WEBSOCKET_CLOSE_REASONS.connectionLimit);
                return;
              }

              state.timeout = setTimeout(() => {
                reject(state, CHAT_WEBSOCKET_CLOSE_REASONS.handshakeTimeout);
              }, input.options.handshakeTimeoutMs);
              state.timeout.unref();
              void establish(request, state, browserAuthorization);
            });
          } catch {
            pendingUpgradeSockets.delete(socket);
            upgradeOutcome.settle("internal_error");
            socket.destroy();
          }
        };

        const admissionAdapter = input.admission;
        if (admissionAdapter === undefined) {
          continueUpgrade();
          return;
        }

        void (async () => {
          let admission;
          try {
            const outcome = await admissionAdapter.admit(
              Object.freeze({
                request: request as IncomingMessage & Request,
                method: "GET" as const,
                routeTemplate: DEFAULT_CHAT_WEBSOCKET_PATH,
              }),
            );
            admission = normalizeChatRequestAdmissionOutcome(outcome);
          } catch {
            admission = failedClosedChatRequestAdmission();
          }

          if (
            !pendingUpgradeSockets.has(socket) ||
            socket.destroyed ||
            socket.writableEnded
          ) {
            return;
          }
          pendingUpgradeSockets.delete(socket);
          if (!admission.admitted) {
            upgradeOutcome.settle("admission_denied");
            writeWebSocketAdmissionDenied(socket, admission.retryAfterSeconds);
            return;
          }
          continueUpgrade();
        })()
          .catch(() => {
            if (pendingUpgradeSockets.delete(socket) && !socket.destroyed) {
              upgradeOutcome.settle("internal_error");
              socket.destroy();
            }
          })
          .finally(() => {
            pendingUpgradeSockets.delete(socket);
          });
      };

      server.on("upgrade", listener);
      attachment = { server, listener };
    },
    async revalidateSubscriptions(scope = {}) {
      const affected = [...sockets]
        .map((state) => state.subscriptions)
        .filter(
          (subscriptions): subscriptions is SessionSubscriptionState =>
            subscriptions !== undefined &&
            (scope.tenantId === undefined ||
              subscriptions.actor.tenantId === scope.tenantId) &&
            (scope.userId === undefined ||
              subscriptions.actor.userId === scope.userId),
        );
      const results = await Promise.all(
        affected.map((subscriptions) =>
          subscriptions.enqueueRevalidation(scope.streamId),
        ),
      );
      return results.reduce((total, revoked) => total + revoked, 0);
    },
    drainEphemeralSignals() {
      return input.ephemeralSignals.drain();
    },
    async drainHuddleDisconnects() {
      await Promise.all([...pendingDisconnectActivations]);
      while (pendingHuddleDisconnects.size > 0) {
        await Promise.all([...pendingHuddleDisconnects]);
      }
    },
    detach(reason = CHAT_WEBSOCKET_CLOSE_REASONS.runtimeClosed) {
      const current = attachment;
      if (current !== undefined) {
        current.server.off("upgrade", current.listener);
        attachment = undefined;
      }
      for (const [socket, upgradeOutcome] of pendingUpgradeSockets) {
        pendingUpgradeSockets.delete(socket);
        upgradeOutcome.settle("internal_error");
        if (!socket.destroyed) {
          socket.destroy();
        }
      }
      for (const state of [...sockets]) {
        cleanup(state);
        if (
          state.socket.readyState === WebSocket.OPEN ||
          state.socket.readyState === WebSocket.CONNECTING
        ) {
          state.socket.close(reason.code, reason.reason);
          setImmediate(() => {
            if (state.socket.readyState !== WebSocket.CLOSED) {
              state.socket.terminate();
            }
          });
        }
      }
    },
  };

  return Object.freeze(controller);
}

function writeWebSocketAdmissionDenied(
  socket: Duplex,
  retryAfterSeconds: number,
): void {
  const body = JSON.stringify({
    error: {
      code: CHAT_REQUEST_ADMISSION_DENIED_CODE,
      message: CHAT_REQUEST_ADMISSION_DENIED_MESSAGE,
    },
  });
  const response = [
    "HTTP/1.1 429 Too Many Requests",
    "Connection: close",
    "Content-Type: application/json; charset=utf-8",
    "Cache-Control: private, no-store",
    `Retry-After: ${retryAfterSeconds}`,
    `Content-Length: ${Buffer.byteLength(body)}`,
    "",
    body,
  ].join("\r\n");
  try {
    socket.end(response, () => socket.destroy());
  } catch {
    socket.destroy();
  }
}

function receiveHandshake(state: SocketState): Promise<ClientHandshakeInput> {
  return new Promise((resolve, reject) => {
    let received = false;
    const onMessage = (data: RawData, isBinary: boolean) => {
      if (received) {
        reject(
          new HandshakeFailure(
            CHAT_WEBSOCKET_CLOSE_REASONS.malformedHandshake,
          ),
        );
        return;
      }
      received = true;
      state.socket.off("message", onMessage);
      state.socket.off("close", onClose);
      try {
        if (isBinary) {
          throw new HandshakeFailure(
            CHAT_WEBSOCKET_CLOSE_REASONS.malformedHandshake,
          );
        }
        resolve(parseHandshake(data.toString("utf8")));
      } catch (error) {
        reject(error);
      }
    };
    const onClose = () => {
      state.socket.off("message", onMessage);
      reject(new SocketEnded());
    };
    state.socket.on("message", onMessage);
    state.socket.once("close", onClose);
  });
}

const CLIENT_HANDSHAKE_FIELDS = new Set([
  "clientPackageVersion",
  "protocolVersion",
  "resumeFrom",
]);
const CLIENT_IDENTITY_FIELDS = new Set([
  "tenantId",
  "userId",
  "roles",
  "capabilities",
  "actor",
  "actorId",
]);

function parseHandshake(serialized: string): ClientHandshakeInput {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new HandshakeFailure(
      CHAT_WEBSOCKET_CLOSE_REASONS.malformedHandshake,
    );
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HandshakeFailure(
      CHAT_WEBSOCKET_CLOSE_REASONS.malformedHandshake,
    );
  }

  const candidate = value as Record<string, unknown>;
  for (const field of Object.keys(candidate)) {
    if (CLIENT_IDENTITY_FIELDS.has(field)) {
      throw new HandshakeFailure(
        CHAT_WEBSOCKET_CLOSE_REASONS.identitySpoofing,
      );
    }
    if (!CLIENT_HANDSHAKE_FIELDS.has(field)) {
      throw new HandshakeFailure(
        CHAT_WEBSOCKET_CLOSE_REASONS.malformedHandshake,
      );
    }
  }

  if (
    typeof candidate.clientPackageVersion !== "string" ||
    candidate.clientPackageVersion.trim().length === 0 ||
    !Number.isSafeInteger(candidate.protocolVersion) ||
    (candidate.protocolVersion as number) < 1
  ) {
    throw new HandshakeFailure(
      CHAT_WEBSOCKET_CLOSE_REASONS.malformedHandshake,
    );
  }

  const resumeFrom = parseResumeCursor(candidate.resumeFrom);
  return resumeFrom === undefined
    ? Object.freeze({
        clientPackageVersion: candidate.clientPackageVersion,
        protocolVersion: candidate.protocolVersion as number,
      })
    : Object.freeze({
        clientPackageVersion: candidate.clientPackageVersion,
        protocolVersion: candidate.protocolVersion as number,
        resumeFrom,
      });
}

function parseResumeCursor(value: unknown): EventCursor | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1
  ) {
    throw new HandshakeFailure(
      CHAT_WEBSOCKET_CLOSE_REASONS.malformedHandshake,
    );
  }
  const eventId = (value as Record<string, unknown>).eventId;
  if (typeof eventId !== "string" || eventId.trim().length === 0) {
    throw new HandshakeFailure(
      CHAT_WEBSOCKET_CLOSE_REASONS.malformedHandshake,
    );
  }
  return Object.freeze({ eventId });
}

function freezeMetadata<Feature extends string>(
  metadata: ServerHandshakeMetadata<Feature>,
): ServerHandshakeMetadata<Feature> {
  return Object.freeze({
    ...metadata,
    enabledFeatures: Object.freeze({ ...metadata.enabledFeatures }),
    supportedProtocolRange: Object.freeze({ ...metadata.supportedProtocolRange }),
  });
}

function createSession<Capability extends string, Feature extends string>(
  getContext: () => Readonly<{
    actor: TrustedChatActorContext;
    capabilities: readonly Capability[];
  }>,
  handshake: ClientHandshakeInput,
  metadata: ServerHandshakeMetadata<Feature>,
  subscriptions: ChatWebSocketSessionSubscriptions,
  ephemeralIdentity: ChatEphemeralSessionIdentity,
  getLastDeliveredCursor: () => EventCursor | undefined,
): ChatWebSocketSession<Capability, Feature> {
  return handshake.resumeFrom === undefined
    ? Object.freeze({
        get actor() {
          return getContext().actor;
        },
        get capabilities() {
          return getContext().capabilities;
        },
        clientPackageVersion: handshake.clientPackageVersion,
        protocolVersion: handshake.protocolVersion,
        metadata,
        ephemeralIdentity,
        subscriptions,
        get lastDeliveredCursor() {
          return getLastDeliveredCursor();
        },
      })
    : Object.freeze({
        get actor() {
          return getContext().actor;
        },
        get capabilities() {
          return getContext().capabilities;
        },
        clientPackageVersion: handshake.clientPackageVersion,
        protocolVersion: handshake.protocolVersion,
        metadata,
        ephemeralIdentity,
        subscriptions,
        get lastDeliveredCursor() {
          return getLastDeliveredCursor();
        },
        resumeFrom: handshake.resumeFrom,
      });
}

function readBrowserWebSocketAuthorization(
  header: string | readonly string[] | undefined,
): string | undefined {
  const serialized =
    typeof header === "string" ? header : header?.join(",");
  if (serialized === undefined) {
    return undefined;
  }
  const credentials = serialized
    .split(",")
    .map((protocol) => protocol.trim())
    .filter((protocol) =>
      protocol.startsWith(CHAT_REALTIME_BEARER_SUBPROTOCOL_PREFIX),
    );
  if (credentials.length !== 1) {
    return undefined;
  }
  const encoded = credentials[0]?.slice(
    CHAT_REALTIME_BEARER_SUBPROTOCOL_PREFIX.length,
  );
  if (
    encoded === undefined ||
    encoded.length === 0 ||
    encoded.length > 12_000 ||
    !/^[A-Za-z0-9_-]+$/.test(encoded)
  ) {
    return undefined;
  }
  try {
    const token = Buffer.from(encoded, "base64url").toString("utf8");
    if (
      token.trim().length === 0 ||
      Buffer.from(token, "utf8").toString("base64url") !== encoded
    ) {
      return undefined;
    }
    return `Bearer ${token}`;
  } catch {
    return undefined;
  }
}

function scrubBrowserCredentialProtocol(request: IncomingMessage): void {
  request.headers["sec-websocket-protocol"] = CHAT_REALTIME_SUBPROTOCOL;
  for (let index = 0; index < request.rawHeaders.length - 1; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === "sec-websocket-protocol") {
      request.rawHeaders[index + 1] = CHAT_REALTIME_SUBPROTOCOL;
    }
  }
}

const RETAINED_REQUEST_CREDENTIAL_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
]);

/** Keeps host-attached session state while avoiding long-lived credential copies. */
function scrubWebSocketRequestCredentials(request: IncomingMessage): void {
  for (const header of RETAINED_REQUEST_CREDENTIAL_HEADERS) {
    delete request.headers[header];
  }
  for (let index = request.rawHeaders.length - 2; index >= 0; index -= 2) {
    if (
      RETAINED_REQUEST_CREDENTIAL_HEADERS.has(
        request.rawHeaders[index]?.toLowerCase() ?? "",
      )
    ) {
      request.rawHeaders.splice(index, 2);
    }
  }
}

function readPathname(url: string | undefined): string | undefined {
  if (url === undefined) {
    return undefined;
  }
  try {
    return new URL(url, "http://handrail.invalid").pathname;
  } catch {
    return undefined;
  }
}
