import {
  CHAT_PROTOCOL_VERSION,
  CHAT_REALTIME_BEARER_SUBPROTOCOL_PREFIX,
  CHAT_REALTIME_SUBPROTOCOL,
  CHAT_REALTIME_SUBSCRIPTION_MESSAGE_TYPES,
  CHAT_REFRESH_REQUIRED_MESSAGE,
  parseChatEvent,
  type ChatEvent,
  type ChatRealtimeRefreshRequiredMessage,
  type ChatRealtimeSessionAcceptedMessage,
  type ChatRealtimeSnapshotRequiredMessage,
  type ClientHandshakeInput,
  type EventCursor,
  type ServerHandshakeMetadata,
  type SnapshotRequiredReason,
} from "../contracts/realtime.js";
import { parseEphemeralSignalEvent } from "../contracts/ephemeral-signals.js";
import type { NormalizedChatCache } from "./normalized-cache.js";
import {
  createClientEphemeralSignalEngine,
  type ChatClientEphemeralClock,
  type ChatClientEphemeralSignalOptions,
} from "./typing-presence.js";
import {
  DurableEventReductionError,
  type DurableEventDiagnostic,
  type DurableEventRecoveryReason,
} from "./durable-event-reducer.js";

const EPHEMERAL_EVENT_TYPES = new Set(["typing.signal", "presence.signal"]);
const DEFAULT_INITIAL_RETRY_MS = 1_000;
const DEFAULT_MAX_RETRY_MS = 30_000;
const DEFAULT_RETRY_MULTIPLIER = 2;
const DEFAULT_JITTER_RATIO = 0.2;
const DEFAULT_CURSOR_KEY = "@handrail/chat/realtime-resume-cursor";

export interface ChatRealtimeSocketMessageEvent {
  readonly data: unknown;
}

export interface ChatRealtimeSocketCloseEvent {
  readonly code: number;
  readonly reason: string;
  readonly wasClean?: boolean;
}

export interface ChatRealtimeSocket {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: ChatRealtimeSocketMessageEvent) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: ChatRealtimeSocketCloseEvent) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type ChatRealtimeSocketFactory = (
  url: string,
  protocols: readonly string[],
) => ChatRealtimeSocket;

export interface ChatRealtimeClock {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ChatRealtimeNetwork {
  isOnline(): boolean;
  addEventListener(type: "online" | "offline", listener: () => void): void;
  removeEventListener(type: "online" | "offline", listener: () => void): void;
}

export interface ChatRealtimeCursorStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ChatRealtimeRetryOptions {
  readonly initialDelayMs?: number;
  readonly maximumDelayMs?: number;
  readonly multiplier?: number;
  readonly jitterRatio?: number;
}

export type ChatRealtimeDiagnosticCode =
  | "access_token_failed"
  | "socket_connection_failed"
  | "connection_lost"
  | "malformed_server_frame"
  | "snapshot_hydration_failed"
  | "durable_event_recovery";

export interface ChatRealtimeDiagnostic {
  readonly code: ChatRealtimeDiagnosticCode;
  /** Stable and safe to serialize; thrown values and credentials are discarded. */
  readonly message: string;
}

export type ChatRealtimeSessionState<Feature extends string = string> =
  | Readonly<{ state: "idle" }>
  | Readonly<{ state: "connecting" }>
  | Readonly<{
      state: "connected";
      metadata: ServerHandshakeMetadata<Feature>;
    }>
  | Readonly<{
      state: "reconnecting";
      attempt: number;
      delayMs: number;
      diagnostic: ChatRealtimeDiagnostic;
    }>
  | Readonly<{ state: "offline" }>
  | Readonly<{
      state: "hydrating_snapshot";
      reason: ChatRealtimeSnapshotRecoveryReason;
      diagnostic?: DurableEventDiagnostic;
    }>
  | Readonly<{
      state: "refresh_required";
      reason: "unsupported_protocol";
      message: typeof CHAT_REFRESH_REQUIRED_MESSAGE;
      requestedProtocolVersion: number;
      metadata: ServerHandshakeMetadata<Feature>;
    }>;

export interface ChatRealtimeSnapshotHydrationInput {
  readonly reason: ChatRealtimeSnapshotRecoveryReason;
  readonly expiredCursor: EventCursor;
  readonly diagnostic?: DurableEventDiagnostic;
  readonly signal: AbortSignal;
}

export type ChatRealtimeSnapshotRecoveryReason =
  | SnapshotRequiredReason
  | DurableEventRecoveryReason;

export interface CreateChatRealtimeSessionOptions<
  Feature extends string = string,
> {
  readonly endpoint: string;
  readonly clientPackageVersion: string;
  readonly protocolVersion?: number;
  readonly getAccessToken: (
    context?: Readonly<{ signal: AbortSignal }>,
  ) => string | Promise<string>;
  readonly webSocketFactory?: ChatRealtimeSocketFactory;
  readonly storage?: ChatRealtimeCursorStorage;
  readonly storageKey?: string;
  readonly clock?: ChatRealtimeClock;
  readonly random?: () => number;
  readonly network?: ChatRealtimeNetwork;
  readonly retry?: ChatRealtimeRetryOptions;
  /** Local typing/presence scheduling and deterministic browser boundaries. */
  readonly ephemeralSignals?: ChatClientEphemeralSignalOptions;
  readonly hydrateSnapshot?: (
    input: ChatRealtimeSnapshotHydrationInput,
  ) => EventCursor | null | void | Promise<EventCursor | null | void>;
  /** Canonical state target. Durable events are never surfaced as raw callbacks. */
  readonly cache?: NormalizedChatCache;
  readonly onRecoveryDiagnostic?: (diagnostic: DurableEventDiagnostic) => void;
  readonly onStateChange?: (state: ChatRealtimeSessionState<Feature>) => void;
  /** Receives only events that passed protocol/domain validation and cache reduction. */
  readonly onCanonicalEvent?: (event: ChatEvent) => void;
  /** Invalidates in-flight actor-private reads when the server revokes a stream. */
  readonly onConversationAccessRevoked?: (conversationId: string) => void;
}

export interface ChatRealtimeSession<Feature extends string = string> {
  readonly endpoint: string;
  readonly state: ChatRealtimeSessionState<Feature>;
  start(): void;
  restart(): void;
  subscribeConversation(conversationId: string): () => void;
  /** Starts or refreshes local typing after the subscription is accepted. */
  startTyping(
    conversationId: string,
    visibility?: "public" | "private",
  ): boolean;
  stopTyping(conversationId: string): void;
  setPresence(state: "online" | "away" | "offline"): void;
  notifyActivity(): void;
  /** Applies a leader-relayed canonical event after validating it again locally. */
  applyCanonicalEvent(value: unknown): boolean;
  /** Adopts the last leader-relayed durable cursor before taking ownership. */
  adoptReplayCursor(cursor: EventCursor | undefined): void;
  /** Selects an identity-scoped replay cursor key before starting the session. */
  setCoordinationScope(scope: string | undefined): void;
  close(): void;
}

const IDLE_STATE = Object.freeze({ state: "idle" } as const);
const CONNECTING_STATE = Object.freeze({ state: "connecting" } as const);
const OFFLINE_STATE = Object.freeze({ state: "offline" } as const);

const DIAGNOSTICS = Object.freeze({
  accessToken: Object.freeze({
    code: "access_token_failed",
    message: "Chat realtime credentials could not be obtained.",
  }),
  socket: Object.freeze({
    code: "socket_connection_failed",
    message: "The chat realtime connection could not be opened.",
  }),
  disconnected: Object.freeze({
    code: "connection_lost",
    message: "The chat realtime connection was interrupted.",
  }),
  malformed: Object.freeze({
    code: "malformed_server_frame",
    message: "The chat server sent an invalid realtime frame.",
  }),
  snapshot: Object.freeze({
    code: "snapshot_hydration_failed",
    message: "The chat snapshot could not be hydrated.",
  }),
  durableRecovery: Object.freeze({
    code: "durable_event_recovery",
    message: "Chat state requires snapshot recovery before realtime can resume.",
  }),
} satisfies Record<string, ChatRealtimeDiagnostic>);

const defaultClock: ChatRealtimeClock = {
  setTimeout(callback, delayMs) {
    return globalThis.setTimeout(callback, delayMs);
  },
  clearTimeout(handle) {
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const validPositive = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

const validNonNegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const validCursor = (value: unknown): value is EventCursor =>
  isRecord(value) &&
  Object.keys(value).length === 1 &&
  typeof value.eventId === "string" &&
  value.eventId.trim().length > 0;

const freezeMetadata = <Feature extends string>(
  value: unknown,
): ServerHandshakeMetadata<Feature> | undefined => {
  if (!isRecord(value)) return undefined;
  const range = value.supportedProtocolRange;
  const features = value.enabledFeatures;
  if (
    typeof value.packageVersion !== "string" ||
    value.packageVersion.trim().length === 0 ||
    !Number.isSafeInteger(value.protocolVersion) ||
    (value.protocolVersion as number) < 1 ||
    !Number.isSafeInteger(value.schemaVersion) ||
    (value.schemaVersion as number) < 0 ||
    !isRecord(features) ||
    !Object.values(features).every((enabled) => typeof enabled === "boolean") ||
    !isRecord(range) ||
    !Number.isSafeInteger(range.minimumVersion) ||
    !Number.isSafeInteger(range.maximumVersion) ||
    (range.minimumVersion as number) < 1 ||
    (range.maximumVersion as number) < (range.minimumVersion as number)
  ) {
    return undefined;
  }
  return Object.freeze({
    packageVersion: value.packageVersion,
    protocolVersion: value.protocolVersion as number,
    schemaVersion: value.schemaVersion as number,
    enabledFeatures: Object.freeze({ ...features }) as Record<Feature, boolean>,
    supportedProtocolRange: Object.freeze({
      minimumVersion: range.minimumVersion as number,
      maximumVersion: range.maximumVersion as number,
    }),
  });
};

const encodeBearerProtocol = (token: string): string => {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(token);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8_192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8_192));
  }
  const encode = (globalThis as unknown as { btoa?: (value: string) => string })
    .btoa;
  if (typeof encode !== "function") {
    throw new Error("base64 encoding is unavailable");
  }
  return `${CHAT_REALTIME_BEARER_SUBPROTOCOL_PREFIX}${encode(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "")}`;
};

const normalizeEndpoint = (value: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError("Realtime endpoint must be a non-empty string");
  }
  const endpoint = value.trim().replace(/\/+$/u, "") || "/";
  if (/^https?:\/\//iu.test(endpoint)) {
    const parsed = new URL(endpoint);
    if (parsed.username.length > 0 || parsed.password.length > 0) {
      throw new TypeError("Realtime endpoint credentials are not allowed");
    }
  }
  return endpoint;
};

const toWebSocketUrl = (endpoint: string): string => {
  const path = endpoint === "/" ? "/_realtime" : `${endpoint}/_realtime`;
  if (/^https?:\/\//iu.test(path)) {
    const url = new URL(path);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  }
  return path;
};

const defaultSocketFactory = (
  url: string,
  protocols: readonly string[],
): ChatRealtimeSocket => {
  const Constructor = (
    globalThis as unknown as {
      WebSocket?: new (url: string, protocols: readonly string[]) => ChatRealtimeSocket;
    }
  ).WebSocket;
  if (Constructor === undefined) {
    throw new Error("WebSocket is unavailable");
  }
  return new Constructor(url, protocols);
};

const defaultNetwork = (): ChatRealtimeNetwork => {
  const target = globalThis as unknown as {
    navigator?: { readonly onLine?: boolean };
    addEventListener?: (type: string, listener: () => void) => void;
    removeEventListener?: (type: string, listener: () => void) => void;
  };
  return {
    isOnline: () => target.navigator?.onLine !== false,
    addEventListener(type, listener) {
      target.addEventListener?.(type, listener);
    },
    removeEventListener(type, listener) {
      target.removeEventListener?.(type, listener);
    },
  };
};

const defaultStorage = (): ChatRealtimeCursorStorage | undefined => {
  try {
    return (
      globalThis as unknown as { sessionStorage?: ChatRealtimeCursorStorage }
    ).sessionStorage;
  } catch {
    return undefined;
  }
};

const parseAccepted = <Feature extends string>(
  value: Record<string, unknown>,
): ChatRealtimeSessionAcceptedMessage<Feature> | undefined => {
  const metadata = freezeMetadata<Feature>(value.metadata);
  if (
    metadata === undefined ||
    typeof value.tenantId !== "string" ||
    value.tenantId.trim().length === 0 ||
    typeof value.actorStreamId !== "string" ||
    !/^user:[^\s]+$/u.test(value.actorStreamId) ||
    typeof value.deviceId !== "string" ||
    value.deviceId.trim().length === 0 ||
    typeof value.sessionId !== "string" ||
    value.sessionId.trim().length === 0 ||
    (value.resumeFrom !== undefined && !validCursor(value.resumeFrom))
  ) {
    return undefined;
  }
  return Object.freeze({
    type: "chat.session.accepted",
    metadata,
    tenantId: value.tenantId as ChatRealtimeSessionAcceptedMessage["tenantId"],
    actorStreamId:
      value.actorStreamId as ChatRealtimeSessionAcceptedMessage["actorStreamId"],
    deviceId: value.deviceId as ChatRealtimeSessionAcceptedMessage["deviceId"],
    sessionId: value.sessionId as ChatRealtimeSessionAcceptedMessage["sessionId"],
    ...(value.resumeFrom === undefined
      ? {}
      : { resumeFrom: Object.freeze({ eventId: value.resumeFrom.eventId }) }),
  });
};

/** Creates a browser/headless WebSocket reliability runtime. */
export function createChatRealtimeSession<Feature extends string = string>(
  options: CreateChatRealtimeSessionOptions<Feature>,
): ChatRealtimeSession<Feature> {
  if (!isRecord(options)) {
    throw new TypeError("Realtime options must be an object");
  }
  const endpoint = normalizeEndpoint(options.endpoint);
  if (
    typeof options.clientPackageVersion !== "string" ||
    options.clientPackageVersion.trim().length === 0 ||
    typeof options.getAccessToken !== "function"
  ) {
    throw new TypeError("Realtime package version and token provider are required");
  }
  const protocolVersion = options.protocolVersion ?? CHAT_PROTOCOL_VERSION;
  if (!Number.isSafeInteger(protocolVersion) || protocolVersion < 1) {
    throw new TypeError("Realtime protocol version must be a positive integer");
  }

  const retry = {
    initialDelayMs: options.retry?.initialDelayMs ?? DEFAULT_INITIAL_RETRY_MS,
    maximumDelayMs: options.retry?.maximumDelayMs ?? DEFAULT_MAX_RETRY_MS,
    multiplier: options.retry?.multiplier ?? DEFAULT_RETRY_MULTIPLIER,
    jitterRatio: options.retry?.jitterRatio ?? DEFAULT_JITTER_RATIO,
  };
  if (
    !validNonNegative(retry.initialDelayMs) ||
    !validNonNegative(retry.maximumDelayMs) ||
    retry.maximumDelayMs < retry.initialDelayMs ||
    !validPositive(retry.multiplier) ||
    !validNonNegative(retry.jitterRatio) ||
    retry.jitterRatio > 1
  ) {
    throw new TypeError("Realtime retry options are invalid");
  }

  const socketFactory = options.webSocketFactory ?? defaultSocketFactory;
  const clock = options.clock ?? defaultClock;
  const random = options.random ?? Math.random;
  const network = options.network ?? defaultNetwork();
  const cursorStorage = options.storage ?? defaultStorage();
  const baseStorageKey = options.storageKey ?? `${DEFAULT_CURSOR_KEY}:${endpoint}`;
  let storageKey = baseStorageKey;
  const websocketUrl = toWebSocketUrl(endpoint);
  const requestedConversations = new Map<string, number>();
  const acceptedConversations = new Set<string>();
  const ephemeralClock: ChatClientEphemeralClock =
    options.ephemeralSignals?.clock ?? {
      now: Date.now,
      setTimeout: (callback, delayMs) => clock.setTimeout(callback, delayMs),
      clearTimeout: (handle) => clock.clearTimeout(handle),
    };

  let state: ChatRealtimeSessionState<Feature> = IDLE_STATE;
  let started = false;
  let listenersAttached = false;
  let generation = 0;
  let retryAttempt = 0;
  let retryTimer: unknown;
  let socket: ChatRealtimeSocket | undefined;
  let attemptController: AbortController | undefined;
  let cursor: EventCursor | undefined;
  let cursorLoaded = false;
  let acceptedTenantId:
    | ChatRealtimeSessionAcceptedMessage["tenantId"]
    | undefined;
  let actorStreamId:
    | ChatRealtimeSessionAcceptedMessage["actorStreamId"]
    | undefined;
  let requestSequence = 0;
  let ephemeralExpiryTimer: unknown;

  const clearEphemeralExpiry = (): void => {
    if (ephemeralExpiryTimer !== undefined) {
      ephemeralClock.clearTimeout(ephemeralExpiryTimer);
      ephemeralExpiryTimer = undefined;
    }
  };

  const scheduleEphemeralExpiry = (): void => {
    clearEphemeralExpiry();
    const cache = options.cache;
    if (cache === undefined || state.state !== "connected") return;
    const expiries = [
      ...Object.values(cache.getState().ephemeral.typing),
      ...Object.values(cache.getState().ephemeral.presence),
    ].map((event) => Date.parse(event.payload.expiresAt));
    if (expiries.length === 0) return;
    const currentNow = ephemeralClock.now();
    const nextExpiry = Math.min(...expiries);
    ephemeralExpiryTimer = ephemeralClock.setTimeout(() => {
      ephemeralExpiryTimer = undefined;
      cache.expireEphemeralSignals(ephemeralClock.now());
      scheduleEphemeralExpiry();
    }, Math.max(0, nextExpiry - currentNow));
  };

  const clearEphemeralState = (): void => {
    clearEphemeralExpiry();
    options.cache?.clearEphemeralSignals();
  };

  const ephemeralEngine = createClientEphemeralSignalEngine({
    options: {
      ...options.ephemeralSignals,
      clock: ephemeralClock,
    },
    send(event) {
      if (socket === undefined || socket.readyState !== 1 || state.state !== "connected") {
        return false;
      }
      try {
        socket.send(JSON.stringify(event));
        return true;
      } catch {
        return false;
      }
    },
    getConversationVisibility(conversationId, requestedVisibility) {
      if (!acceptedConversations.has(conversationId)) return undefined;
      const cacheState = options.cache?.getState();
      if (cacheState === undefined) return requestedVisibility;
      const conversation = cacheState.entities.conversations[conversationId as never];
      const membership = cacheState.currentUser.memberships[conversationId as never];
      if (
        conversation === undefined ||
        membership?.state !== "active" ||
        cacheState.identity === null ||
        membership.userId !== cacheState.identity.userId ||
        conversation.tenantId !== cacheState.identity.tenantId
      ) {
        return undefined;
      }
      return conversation.visibility;
    },
  });

  const setState = (next: ChatRealtimeSessionState<Feature>): void => {
    state = next;
    try {
      options.onStateChange?.(next);
    } catch {
      // Observer failures cannot alter connection reliability.
    }
  };

  const publishCanonicalEvent = (event: ChatEvent): void => {
    try {
      options.onCanonicalEvent?.(event);
    } catch {
      // Canonical observers cannot alter socket or replay reliability.
    }
  };

  const loadCursor = (): void => {
    if (cursorLoaded) return;
    cursorLoaded = true;
    try {
      const serialized = cursorStorage?.getItem(storageKey);
      if (serialized !== null && serialized !== undefined) {
        const parsed: unknown = JSON.parse(serialized);
        if (validCursor(parsed)) cursor = Object.freeze({ eventId: parsed.eventId });
      }
    } catch {
      // Storage is opportunistic; an in-memory session remains fully usable.
    }
  };

  const storeCursor = (next: EventCursor | undefined): void => {
    cursor = next === undefined ? undefined : Object.freeze({ eventId: next.eventId });
    try {
      if (cursor === undefined) cursorStorage?.removeItem(storageKey);
      else cursorStorage?.setItem(storageKey, JSON.stringify(cursor));
    } catch {
      // Keep the in-memory cursor when browser storage is unavailable.
    }
  };

  const clearRetry = (): void => {
    if (retryTimer !== undefined) {
      clock.clearTimeout(retryTimer);
      retryTimer = undefined;
    }
  };

  const releaseSocket = (closeSocket: boolean): void => {
    const current = socket;
    ephemeralEngine.deactivate(
      current !== undefined && current.readyState === 1 && state.state === "connected",
    );
    acceptedConversations.clear();
    clearEphemeralState();
    socket = undefined;
    acceptedTenantId = undefined;
    actorStreamId = undefined;
    if (current === undefined) return;
    current.onopen = null;
    current.onmessage = null;
    current.onerror = null;
    current.onclose = null;
    if (closeSocket) {
      try {
        current.close(1000, "client_closed");
      } catch {
        // A transport that already failed still counts as released.
      }
    }
  };

  const calculateDelay = (): number => {
    const base = Math.min(
      retry.maximumDelayMs,
      retry.initialDelayMs * retry.multiplier ** retryAttempt,
    );
    let sample: number;
    try {
      sample = random();
    } catch {
      sample = 0.5;
    }
    if (!Number.isFinite(sample)) sample = 0.5;
    sample = Math.min(1, Math.max(0, sample));
    const factor = 1 - retry.jitterRatio + 2 * retry.jitterRatio * sample;
    return Math.min(retry.maximumDelayMs, Math.max(0, Math.round(base * factor)));
  };

  let connect: () => void;

  const scheduleReconnect = (
    diagnostic: ChatRealtimeDiagnostic,
    immediate = false,
  ): void => {
    if (!started || state.state === "refresh_required") return;
    releaseSocket(true);
    attemptController?.abort();
    attemptController = undefined;
    clearRetry();
    if (!network.isOnline()) {
      setState(OFFLINE_STATE);
      return;
    }
    const delayMs = immediate ? 0 : calculateDelay();
    retryAttempt += 1;
    setState(
      Object.freeze({
        state: "reconnecting",
        attempt: retryAttempt,
        delayMs,
        diagnostic,
      }),
    );
    retryTimer = clock.setTimeout(() => {
      retryTimer = undefined;
      connect();
    }, delayMs);
  };

  const sendSubscription = (
    type:
      | typeof CHAT_REALTIME_SUBSCRIPTION_MESSAGE_TYPES.subscribe
      | typeof CHAT_REALTIME_SUBSCRIPTION_MESSAGE_TYPES.unsubscribe,
    streamId: string,
  ): void => {
    if (socket === undefined || state.state !== "connected") return;
    requestSequence += 1;
    try {
      socket.send(
        JSON.stringify({
          type,
          requestId: `chat-realtime-${requestSequence}`,
          streamId,
        }),
      );
    } catch {
      scheduleReconnect(DIAGNOSTICS.disconnected);
    }
  };

  const restoreSubscriptions = (): void => {
    if (actorStreamId !== undefined) {
      sendSubscription(CHAT_REALTIME_SUBSCRIPTION_MESSAGE_TYPES.subscribe, actorStreamId);
    }
    for (const conversationId of requestedConversations.keys()) {
      sendSubscription(
        CHAT_REALTIME_SUBSCRIPTION_MESSAGE_TYPES.subscribe,
        conversationId,
      );
    }
  };

  const hydrateSnapshot = (
    reason: ChatRealtimeSnapshotRecoveryReason,
    expiredCursor: EventCursor,
    diagnostic?: DurableEventDiagnostic,
  ): void => {
    const hydrationGeneration = ++generation;
    releaseSocket(true);
    storeCursor(undefined);
    const controller = new AbortController();
    attemptController = controller;
    setState(Object.freeze({
      state: "hydrating_snapshot",
      reason,
      ...(diagnostic === undefined ? {} : { diagnostic }),
    }));
    Promise.resolve()
      .then(() =>
        options.hydrateSnapshot?.({
          reason,
          expiredCursor: Object.freeze({ eventId: expiredCursor.eventId }),
          ...(diagnostic === undefined ? {} : { diagnostic }),
          signal: controller.signal,
        }),
      )
      .then(
        (nextCursor) => {
          if (
            !started ||
            controller.signal.aborted ||
            hydrationGeneration !== generation
          ) {
            return;
          }
          if (nextCursor !== undefined && nextCursor !== null && validCursor(nextCursor)) {
            storeCursor(nextCursor);
          }
          scheduleReconnect(DIAGNOSTICS.disconnected, true);
        },
        () => {
          if (
            !started ||
            controller.signal.aborted ||
            hydrationGeneration !== generation
          ) {
            return;
          }
          scheduleReconnect(DIAGNOSTICS.snapshot, true);
        },
      );
  };

  const receiveFrame = (raw: unknown, currentGeneration: number): void => {
    if (currentGeneration !== generation || typeof raw !== "string") return;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      scheduleReconnect(DIAGNOSTICS.malformed);
      return;
    }
    if (!isRecord(value)) {
      scheduleReconnect(DIAGNOSTICS.malformed);
      return;
    }

    if (value.type === "chat.session.accepted") {
      const accepted = parseAccepted<Feature>(value);
      if (accepted === undefined || accepted.metadata.protocolVersion !== protocolVersion) {
        scheduleReconnect(DIAGNOSTICS.malformed);
        return;
      }
      acceptedTenantId = accepted.tenantId;
      actorStreamId = accepted.actorStreamId;
      const acceptedUserId = accepted.actorStreamId.slice("user:".length) as never;
      const currentIdentity = options.cache?.getState().identity;
      options.cache?.setIdentity(Object.freeze({
        tenantId: accepted.tenantId,
        userId: acceptedUserId,
        sessionId:
          currentIdentity?.tenantId === accepted.tenantId &&
          currentIdentity.userId === acceptedUserId
            ? currentIdentity.sessionId
            : accepted.sessionId,
      }));
      retryAttempt = 0;
      setState(Object.freeze({ state: "connected", metadata: accepted.metadata }));
      const advertised = accepted.metadata.enabledFeatures as Readonly<
        Record<string, boolean>
      >;
      ephemeralEngine.accept({
        protocolVersion,
        tenantId: accepted.tenantId,
        userId: acceptedUserId,
        deviceId: accepted.deviceId,
        sessionId: accepted.sessionId,
        enabledFeatures: Object.freeze({
          typing: advertised["typing"] === true,
          presence: advertised["presence"] === true,
        }),
      });
      restoreSubscriptions();
      return;
    }

    if (value.type === "chat.session.refresh_required") {
      const metadata = freezeMetadata<Feature>(value.metadata);
      if (
        metadata === undefined ||
        value.state !== "refresh_required" ||
        value.reason !== "unsupported_protocol" ||
        value.message !== CHAT_REFRESH_REQUIRED_MESSAGE ||
        value.requestedProtocolVersion !== protocolVersion
      ) {
        scheduleReconnect(DIAGNOSTICS.malformed);
        return;
      }
      const message: ChatRealtimeRefreshRequiredMessage<Feature> = {
        type: "chat.session.refresh_required",
        state: "refresh_required",
        reason: "unsupported_protocol",
        message: CHAT_REFRESH_REQUIRED_MESSAGE,
        requestedProtocolVersion: value.requestedProtocolVersion as number,
        metadata,
      };
      ++generation;
      releaseSocket(true);
      clearRetry();
      setState(
        Object.freeze({
          state: message.state,
          reason: message.reason,
          message: message.message,
          requestedProtocolVersion: message.requestedProtocolVersion,
          metadata: message.metadata,
        }),
      );
      return;
    }

    if (value.type === "chat.session.snapshot_required") {
      const metadata = freezeMetadata<Feature>(value.metadata);
      if (
        metadata === undefined ||
        value.state !== "snapshot_required" ||
        ![
          "replay_expired",
          "replay_unavailable",
          "replay_incompatible",
          "replay_overflow",
        ].includes(value.reason as string) ||
        !validCursor(value.resumeFrom)
      ) {
        scheduleReconnect(DIAGNOSTICS.malformed);
        return;
      }
      hydrateSnapshot(
        value.reason as SnapshotRequiredReason,
        Object.freeze({ eventId: value.resumeFrom.eventId }),
      );
      return;
    }

    if (acceptedTenantId === undefined || state.state !== "connected") return;
    if (value.type === CHAT_REALTIME_SUBSCRIPTION_MESSAGE_TYPES.subscribed) {
      if (
        typeof value.streamId === "string" &&
        requestedConversations.has(value.streamId)
      ) {
        acceptedConversations.add(value.streamId);
      }
      return;
    }
    if (
      value.type === CHAT_REALTIME_SUBSCRIPTION_MESSAGE_TYPES.unsubscribed ||
      value.type === CHAT_REALTIME_SUBSCRIPTION_MESSAGE_TYPES.revoked
    ) {
      if (typeof value.streamId === "string") {
        ephemeralEngine.stopTyping(value.streamId);
        acceptedConversations.delete(value.streamId);
        clearEphemeralState();
        if (value.type === CHAT_REALTIME_SUBSCRIPTION_MESSAGE_TYPES.revoked) {
          try { options.onConversationAccessRevoked?.(value.streamId); } catch {
            // Observer failures cannot alter subscription handling.
          }
        }
      }
      return;
    }
    if (typeof value.type === "string" && value.type.startsWith("chat.subscription.")) {
      return;
    }
    try {
      const event = parseChatEvent(value, acceptedTenantId);
      if (event.protocolVersion !== protocolVersion && options.cache === undefined) return;
      if (EPHEMERAL_EVENT_TYPES.has(event.type)) {
        if (options.cache !== undefined) {
          if (
            event.type === "typing.signal" &&
            !acceptedConversations.has(event.streamId)
          ) {
            return;
          }
          if (
            event.type === "presence.signal" &&
            event.streamId !== actorStreamId
          ) {
            return;
          }
          const enabledFeatures = state.metadata.enabledFeatures as Readonly<
            Record<string, boolean>
          >;
          const currentNow = ephemeralClock.now();
          const canonicalEvent = parseEphemeralSignalEvent(event, {
              expectedTenantId: acceptedTenantId,
              enabledFeatures: Object.freeze({
                presence: enabledFeatures["presence"] === true,
                typing: enabledFeatures["typing"] === true,
              }),
              now: currentNow,
            });
          options.cache.applyEphemeralSignal(canonicalEvent, currentNow);
          scheduleEphemeralExpiry();
          publishCanonicalEvent(Object.freeze(canonicalEvent));
        }
        return;
      }
      if (options.cache === undefined) {
        storeCursor({ eventId: event.eventId });
        return;
      }
      try {
        const reduction = options.cache.applyDurableEvent(Object.freeze(event));
        if (reduction.status === "applied") {
          storeCursor({ eventId: event.eventId });
          publishCanonicalEvent(Object.freeze(event));
        }
      } catch (error) {
        if (!(error instanceof DurableEventReductionError)) throw error;
        try {
          options.onRecoveryDiagnostic?.(error.diagnostic);
        } catch {
          // Diagnostics cannot interfere with recovery.
        }
        hydrateSnapshot(
          error.diagnostic.reason,
          cursor ?? Object.freeze({ eventId: event.eventId }),
          error.diagnostic,
        );
      }
    } catch {
      // Invalid domain frames are ignored and never advance the resume cursor.
    }
  };

  connect = (): void => {
    if (!started || state.state === "refresh_required") return;
    clearRetry();
    if (!network.isOnline()) {
      setState(OFFLINE_STATE);
      return;
    }
    const currentGeneration = ++generation;
    releaseSocket(true);
    attemptController?.abort();
    const controller = new AbortController();
    attemptController = controller;
    setState(CONNECTING_STATE);
    Promise.resolve()
      .then(() => options.getAccessToken({ signal: controller.signal }))
      .then(
        (providedToken) => {
          if (
            !started ||
            controller.signal.aborted ||
            currentGeneration !== generation
          ) {
            return;
          }
          if (typeof providedToken !== "string" || providedToken.trim().length === 0) {
            scheduleReconnect(DIAGNOSTICS.accessToken);
            return;
          }
          let authenticationProtocol: string;
          try {
            authenticationProtocol = encodeBearerProtocol(providedToken);
          } catch {
            scheduleReconnect(DIAGNOSTICS.accessToken);
            return;
          }
          let nextSocket: ChatRealtimeSocket;
          try {
            nextSocket = socketFactory(websocketUrl, [
              CHAT_REALTIME_SUBPROTOCOL,
              authenticationProtocol,
            ]);
          } catch {
            scheduleReconnect(DIAGNOSTICS.socket);
            return;
          }
          if (!started || currentGeneration !== generation) {
            try {
              nextSocket.close(1000, "client_closed");
            } catch {
              // The abandoned socket has no callbacks or retry authority.
            }
            return;
          }
          socket = nextSocket;
          nextSocket.onopen = () => {
            if (!started || currentGeneration !== generation || socket !== nextSocket) return;
            const handshake: ClientHandshakeInput =
              cursor === undefined
                ? {
                    clientPackageVersion: options.clientPackageVersion,
                    protocolVersion,
                  }
                : {
                    clientPackageVersion: options.clientPackageVersion,
                    protocolVersion,
                    resumeFrom: cursor,
                  };
            try {
              nextSocket.send(JSON.stringify(handshake));
            } catch {
              scheduleReconnect(DIAGNOSTICS.socket);
            }
          };
          nextSocket.onmessage = (event) => receiveFrame(event.data, currentGeneration);
          nextSocket.onerror = () => {
            if (currentGeneration === generation) {
              scheduleReconnect(DIAGNOSTICS.socket);
            }
          };
          nextSocket.onclose = () => {
            if (currentGeneration === generation) {
              scheduleReconnect(DIAGNOSTICS.disconnected);
            }
          };
        },
        () => {
          if (
            started &&
            !controller.signal.aborted &&
            currentGeneration === generation
          ) {
            scheduleReconnect(DIAGNOSTICS.accessToken);
          }
        },
      );
  };

  const onOffline = (): void => {
    if (!started || state.state === "refresh_required") return;
    ++generation;
    clearRetry();
    attemptController?.abort();
    attemptController = undefined;
    releaseSocket(true);
    setState(OFFLINE_STATE);
  };
  const onOnline = (): void => {
    if (started && state.state === "offline") connect();
  };
  const attachListeners = (): void => {
    if (listenersAttached) return;
    listenersAttached = true;
    network.addEventListener("offline", onOffline);
    network.addEventListener("online", onOnline);
  };
  const detachListeners = (): void => {
    if (!listenersAttached) return;
    listenersAttached = false;
    network.removeEventListener("offline", onOffline);
    network.removeEventListener("online", onOnline);
  };

  const session: ChatRealtimeSession<Feature> = {
    endpoint,
    get state() {
      return state;
    },
    start() {
      if (started) return;
      started = true;
      loadCursor();
      attachListeners();
      connect();
    },
    restart() {
      session.close();
      session.start();
    },
    subscribeConversation(conversationId) {
      if (
        typeof conversationId !== "string" ||
        conversationId.trim().length === 0 ||
        conversationId !== conversationId.trim() ||
        conversationId.startsWith("user:") ||
        /[\u0000-\u0020\u007f*?]/u.test(conversationId) ||
        /^(?:all|tenant|organization|org)(?::|\/|$)/iu.test(conversationId)
      ) {
        throw new TypeError("Conversation subscription id is invalid");
      }
      const count = requestedConversations.get(conversationId) ?? 0;
      requestedConversations.set(conversationId, count + 1);
      if (count === 0) {
        sendSubscription(
          CHAT_REALTIME_SUBSCRIPTION_MESSAGE_TYPES.subscribe,
          conversationId,
        );
      }
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        const current = requestedConversations.get(conversationId) ?? 0;
        if (current <= 1) {
          ephemeralEngine.stopTyping(conversationId);
          acceptedConversations.delete(conversationId);
          clearEphemeralState();
          requestedConversations.delete(conversationId);
          sendSubscription(
            CHAT_REALTIME_SUBSCRIPTION_MESSAGE_TYPES.unsubscribe,
            conversationId,
          );
        } else {
          requestedConversations.set(conversationId, current - 1);
        }
      };
    },
    startTyping(conversationId, visibility) {
      if (!requestedConversations.has(conversationId)) return false;
      return ephemeralEngine.startTyping(conversationId, visibility);
    },
    stopTyping(conversationId) {
      ephemeralEngine.stopTyping(conversationId);
    },
    setPresence(nextState) {
      ephemeralEngine.setPresence(nextState);
    },
    notifyActivity() {
      ephemeralEngine.notifyActivity();
    },
    applyCanonicalEvent(value) {
      const identity = options.cache?.getState().identity;
      if (options.cache === undefined || identity === null || identity === undefined) {
        return false;
      }
      try {
        const event = parseChatEvent(value, identity.tenantId);
        if (event.protocolVersion !== protocolVersion) return false;
        if (EPHEMERAL_EVENT_TYPES.has(event.type)) {
          const currentNow = ephemeralClock.now();
          const canonicalEvent = parseEphemeralSignalEvent(event, {
            expectedTenantId: identity.tenantId,
            enabledFeatures: Object.freeze({ presence: true, typing: true }),
            now: currentNow,
          });
          options.cache.applyEphemeralSignal(canonicalEvent, currentNow);
          scheduleEphemeralExpiry();
          return true;
        }
        const reduction = options.cache.applyDurableEvent(Object.freeze(event));
        return reduction.status === "applied" || reduction.status === "duplicate";
      } catch {
        return false;
      }
    },
    adoptReplayCursor(nextCursor) {
      if (nextCursor !== undefined && !validCursor(nextCursor)) {
        throw new TypeError("Realtime replay cursor is invalid");
      }
      storeCursor(nextCursor);
      cursorLoaded = true;
    },
    setCoordinationScope(scope) {
      if (scope !== undefined && (typeof scope !== "string" || scope.length === 0)) {
        throw new TypeError("Realtime coordination scope is invalid");
      }
      const coordinatedStoragePrefix = options.storageKey ?? DEFAULT_CURSOR_KEY;
      const nextStorageKey = scope === undefined
        ? baseStorageKey
        : `${coordinatedStoragePrefix}:${scope}`;
      if (nextStorageKey === storageKey) return;
      session.close();
      storageKey = nextStorageKey;
      cursor = undefined;
      cursorLoaded = false;
    },
    close() {
      if (!started && state.state === "idle") return;
      started = false;
      ++generation;
      clearRetry();
      attemptController?.abort();
      attemptController = undefined;
      releaseSocket(true);
      detachListeners();
      retryAttempt = 0;
      cursorLoaded = false;
      setState(IDLE_STATE);
    },
  };

  return Object.freeze(session);
}
