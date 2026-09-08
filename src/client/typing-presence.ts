import {
  MAX_PRESENCE_SIGNAL_TTL_MS,
  MAX_TYPING_SIGNAL_TTL_MS,
  type EphemeralSignalEvent,
  type EphemeralSignalFeature,
  type PresenceSignalEvent,
  type TypingSignalEvent,
  type TypingSignalScope,
} from "../contracts/ephemeral-signals.js";
import type {
  DeviceId,
  SessionId,
  TenantId,
  UserId,
} from "../contracts/identifiers.js";
import type { EnabledFeatures } from "../contracts/realtime.js";

export const DEFAULT_CLIENT_TYPING_TTL_MS = 10_000 as const;
export const DEFAULT_CLIENT_TYPING_HEARTBEAT_MS = 5_000 as const;
export const DEFAULT_CLIENT_TYPING_IDLE_MS = 5_000 as const;
export const DEFAULT_CLIENT_PRESENCE_TTL_MS = 60_000 as const;
export const DEFAULT_CLIENT_PRESENCE_HEARTBEAT_MS = 30_000 as const;
export const DEFAULT_CLIENT_PRESENCE_IDLE_MS = 60_000 as const;
export const DEFAULT_CLIENT_EPHEMERAL_RATE_LIMIT_MAX_SIGNALS = 10 as const;
export const DEFAULT_CLIENT_EPHEMERAL_RATE_LIMIT_WINDOW_MS = 1_000 as const;

export interface ChatClientEphemeralClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ChatClientVisibility {
  isVisible(): boolean;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface ChatClientEphemeralSignalOptions {
  readonly clock?: ChatClientEphemeralClock;
  readonly visibility?: ChatClientVisibility;
  readonly typingTtlMs?: number;
  readonly typingHeartbeatMs?: number;
  readonly typingIdleMs?: number;
  readonly presenceTtlMs?: number;
  readonly presenceHeartbeatMs?: number;
  readonly presenceIdleMs?: number;
  readonly rateLimitMaxSignals?: number;
  readonly rateLimitWindowMs?: number;
  /** A local privacy/feature restriction applied in addition to the handshake. */
  readonly enabledFeatures?: EnabledFeatures<EphemeralSignalFeature>;
}

export interface AcceptedEphemeralSession {
  readonly protocolVersion: number;
  readonly tenantId: TenantId;
  readonly userId: UserId;
  readonly deviceId: DeviceId;
  readonly sessionId: SessionId;
  readonly enabledFeatures: EnabledFeatures<EphemeralSignalFeature>;
}

export interface ClientEphemeralSignalEngine {
  accept(session: AcceptedEphemeralSession): void;
  deactivate(sendTerminalSignals: boolean): void;
  startTyping(conversationId: string, visibility?: "public" | "private"): boolean;
  stopTyping(conversationId: string): void;
  setPresence(state: "online" | "away" | "offline"): void;
  notifyActivity(): void;
}

interface CreateClientEphemeralSignalEngineInput {
  readonly options?: ChatClientEphemeralSignalOptions;
  readonly send: (event: EphemeralSignalEvent) => boolean;
  readonly getConversationVisibility: (
    conversationId: string,
    requestedVisibility?: "public" | "private",
  ) => "public" | "private" | undefined;
}

interface ActiveTyping {
  readonly scope: TypingSignalScope;
  heartbeatTimer?: unknown;
  idleTimer?: unknown;
}

const defaultClock: ChatClientEphemeralClock = Object.freeze({
  now: Date.now,
  setTimeout(callback: () => void, delayMs: number) {
    return globalThis.setTimeout(callback, delayMs);
  },
  clearTimeout(handle: unknown) {
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
});

const defaultVisibility = (): ChatClientVisibility => {
  const target = globalThis as unknown as {
    document?: {
      readonly visibilityState?: string;
      addEventListener?: (type: string, listener: () => void) => void;
      removeEventListener?: (type: string, listener: () => void) => void;
    };
  };
  return {
    isVisible: () => target.document?.visibilityState !== "hidden",
    addEventListener(type, listener) {
      target.document?.addEventListener?.(type, listener);
    },
    removeEventListener(type, listener) {
      target.document?.removeEventListener?.(type, listener);
    },
  };
};

const positiveInteger = (
  value: unknown,
  fallback: number,
  name: string,
  maximum?: number,
): number => {
  const candidate = value ?? fallback;
  if (
    !Number.isSafeInteger(candidate) ||
    (candidate as number) < 1 ||
    (maximum !== undefined && (candidate as number) > maximum)
  ) {
    throw new TypeError(
      `${name} must be a positive safe integer${
        maximum === undefined ? "" : ` no greater than ${maximum}`
      }`,
    );
  }
  return candidate as number;
};

/** Internal state engine used by the realtime session's public actions. */
export function createClientEphemeralSignalEngine(
  input: CreateClientEphemeralSignalEngineInput,
): ClientEphemeralSignalEngine {
  const options = input.options ?? {};
  const clock = options.clock ?? defaultClock;
  const visibility = options.visibility ?? defaultVisibility();
  if (
    typeof clock.now !== "function" ||
    typeof clock.setTimeout !== "function" ||
    typeof clock.clearTimeout !== "function" ||
    typeof visibility.isVisible !== "function" ||
    typeof visibility.addEventListener !== "function" ||
    typeof visibility.removeEventListener !== "function"
  ) {
    throw new TypeError("ephemeral signal clock and visibility boundaries are invalid");
  }

  const typingTtlMs = positiveInteger(
    options.typingTtlMs,
    DEFAULT_CLIENT_TYPING_TTL_MS,
    "typingTtlMs",
    MAX_TYPING_SIGNAL_TTL_MS,
  );
  const typingHeartbeatMs = positiveInteger(
    options.typingHeartbeatMs,
    DEFAULT_CLIENT_TYPING_HEARTBEAT_MS,
    "typingHeartbeatMs",
    typingTtlMs - 1,
  );
  const typingIdleMs = positiveInteger(
    options.typingIdleMs,
    DEFAULT_CLIENT_TYPING_IDLE_MS,
    "typingIdleMs",
  );
  const presenceTtlMs = positiveInteger(
    options.presenceTtlMs,
    DEFAULT_CLIENT_PRESENCE_TTL_MS,
    "presenceTtlMs",
    MAX_PRESENCE_SIGNAL_TTL_MS,
  );
  const presenceHeartbeatMs = positiveInteger(
    options.presenceHeartbeatMs,
    DEFAULT_CLIENT_PRESENCE_HEARTBEAT_MS,
    "presenceHeartbeatMs",
    presenceTtlMs - 1,
  );
  const presenceIdleMs = positiveInteger(
    options.presenceIdleMs,
    DEFAULT_CLIENT_PRESENCE_IDLE_MS,
    "presenceIdleMs",
  );
  const rateLimitMaxSignals = positiveInteger(
    options.rateLimitMaxSignals,
    DEFAULT_CLIENT_EPHEMERAL_RATE_LIMIT_MAX_SIGNALS,
    "rateLimitMaxSignals",
  );
  const rateLimitWindowMs = positiveInteger(
    options.rateLimitWindowMs,
    DEFAULT_CLIENT_EPHEMERAL_RATE_LIMIT_WINDOW_MS,
    "rateLimitWindowMs",
  );

  let accepted: AcceptedEphemeralSession | undefined;
  let desiredPresence: "online" | "away" | "offline" = "online";
  let idleAway = false;
  let listenersAttached = false;
  let presenceHeartbeatTimer: unknown;
  let presenceIdleTimer: unknown;
  let sequence = 0;
  let lastWireTimestamp = -Infinity;
  const rateTimestamps: number[] = [];
  const activeTyping = new Map<string, ActiveTyping>();

  const now = (): number => {
    const timestamp = clock.now();
    if (!Number.isFinite(timestamp)) {
      throw new TypeError("ephemeral signal clock.now must return a finite number");
    }
    return timestamp;
  };

  const featureEnabled = (feature: EphemeralSignalFeature): boolean =>
    accepted?.enabledFeatures[feature] === true &&
    options.enabledFeatures?.[feature] !== false;

  const clearTimer = (handle: unknown): void => {
    if (handle !== undefined) clock.clearTimeout(handle);
  };

  const consumeRate = (timestamp: number, terminal: boolean): boolean => {
    if (terminal) return true;
    while (
      rateTimestamps.length > 0 &&
      (rateTimestamps[0] as number) <= timestamp - rateLimitWindowMs
    ) {
      rateTimestamps.shift();
    }
    if (rateTimestamps.length >= rateLimitMaxSignals) return false;
    rateTimestamps.push(timestamp);
    return true;
  };

  const wireTimestamp = (): number => {
    const timestamp = Math.max(now(), lastWireTimestamp + 1);
    lastWireTimestamp = timestamp;
    return timestamp;
  };

  const emit = (
    feature: EphemeralSignalFeature,
    state: "start" | "stop" | "online" | "away" | "offline",
    scope: TypingSignalScope | undefined,
    terminal = false,
  ): boolean => {
    const session = accepted;
    if (session === undefined || !featureEnabled(feature)) return false;
    const rateNow = now();
    if (!consumeRate(rateNow, terminal)) return false;
    const sentAtMs = wireTimestamp();
    const sentAt = new Date(sentAtMs).toISOString();
    const expiresAt = new Date(
      sentAtMs + (feature === "typing" ? typingTtlMs : presenceTtlMs),
    ).toISOString();
    sequence += 1;
    const base = {
      eventId: `client-ephemeral-${session.sessionId}-${sequence}`,
      protocolVersion: session.protocolVersion,
      tenantId: session.tenantId,
      occurredAt: sentAt,
    } as const;
    const event: EphemeralSignalEvent =
      feature === "typing"
        ? ({
            ...base,
            streamId: (scope as TypingSignalScope).conversationId,
            type: "typing.signal",
            payload: {
              capability: "typing",
              durability: "ephemeral",
              actorUserId: session.userId,
              deviceId: session.deviceId,
              sessionId: session.sessionId,
              sequence,
              sentAt,
              expiresAt,
              state: state as "start" | "stop",
              scope: scope as TypingSignalScope,
            },
          } satisfies TypingSignalEvent)
        : ({
            ...base,
            streamId: `user:${session.userId}`,
            type: "presence.signal",
            payload: {
              capability: "presence",
              durability: "ephemeral",
              actorUserId: session.userId,
              deviceId: session.deviceId,
              sessionId: session.sessionId,
              sequence,
              sentAt,
              expiresAt,
              state: state as "online" | "away" | "offline",
              scope: { type: "user_private", userId: session.userId },
            },
          } satisfies PresenceSignalEvent);
    return input.send(Object.freeze(event));
  };

  const effectivePresence = (): "online" | "away" | "offline" => {
    if (desiredPresence === "offline") return "offline";
    if (!visibility.isVisible() || desiredPresence === "away" || idleAway) {
      return "away";
    }
    return "online";
  };

  const schedulePresenceHeartbeat = (): void => {
    clearTimer(presenceHeartbeatTimer);
    presenceHeartbeatTimer = undefined;
    if (!featureEnabled("presence") || effectivePresence() === "offline") return;
    presenceHeartbeatTimer = clock.setTimeout(() => {
      presenceHeartbeatTimer = undefined;
      emit("presence", effectivePresence(), undefined);
      schedulePresenceHeartbeat();
    }, presenceHeartbeatMs);
  };

  const schedulePresenceIdle = (): void => {
    clearTimer(presenceIdleTimer);
    presenceIdleTimer = undefined;
    if (
      !featureEnabled("presence") ||
      desiredPresence !== "online" ||
      !visibility.isVisible()
    ) {
      return;
    }
    presenceIdleTimer = clock.setTimeout(() => {
      presenceIdleTimer = undefined;
      idleAway = true;
      emit("presence", "away", undefined);
      schedulePresenceHeartbeat();
    }, presenceIdleMs);
  };

  const scheduleTypingHeartbeat = (
    conversationId: string,
    typing: ActiveTyping,
  ): void => {
    clearTimer(typing.heartbeatTimer);
    typing.heartbeatTimer = clock.setTimeout(() => {
      typing.heartbeatTimer = undefined;
      if (activeTyping.get(conversationId) !== typing) return;
      emit("typing", "start", typing.scope);
      scheduleTypingHeartbeat(conversationId, typing);
    }, typingHeartbeatMs);
  };

  const scheduleTypingIdle = (
    conversationId: string,
    typing: ActiveTyping,
  ): void => {
    clearTimer(typing.idleTimer);
    typing.idleTimer = clock.setTimeout(() => {
      typing.idleTimer = undefined;
      if (activeTyping.get(conversationId) === typing) {
        engine.stopTyping(conversationId);
      }
    }, typingIdleMs);
  };

  const stopAllTyping = (sendStops: boolean): void => {
    for (const [conversationId, typing] of [...activeTyping]) {
      clearTimer(typing.heartbeatTimer);
      clearTimer(typing.idleTimer);
      activeTyping.delete(conversationId);
      if (sendStops) emit("typing", "stop", typing.scope, true);
    }
  };

  const onVisibilityChange = (): void => {
    if (!visibility.isVisible()) {
      stopAllTyping(true);
      clearTimer(presenceIdleTimer);
      presenceIdleTimer = undefined;
      if (desiredPresence !== "offline") emit("presence", "away", undefined, true);
    } else {
      idleAway = false;
      if (desiredPresence !== "offline") {
        emit("presence", effectivePresence(), undefined);
      }
      schedulePresenceIdle();
    }
    schedulePresenceHeartbeat();
  };

  const attachVisibility = (): void => {
    if (listenersAttached) return;
    listenersAttached = true;
    visibility.addEventListener("visibilitychange", onVisibilityChange);
  };

  const detachVisibility = (): void => {
    if (!listenersAttached) return;
    listenersAttached = false;
    visibility.removeEventListener("visibilitychange", onVisibilityChange);
  };

  const engine: ClientEphemeralSignalEngine = {
    accept(session) {
      accepted = session;
      sequence = 0;
      rateTimestamps.length = 0;
      lastWireTimestamp = -Infinity;
      idleAway = false;
      attachVisibility();
      if (featureEnabled("presence") && desiredPresence !== "offline") {
        emit("presence", effectivePresence(), undefined);
      }
      schedulePresenceHeartbeat();
      schedulePresenceIdle();
    },
    deactivate(sendTerminalSignals) {
      stopAllTyping(sendTerminalSignals);
      clearTimer(presenceHeartbeatTimer);
      clearTimer(presenceIdleTimer);
      presenceHeartbeatTimer = undefined;
      presenceIdleTimer = undefined;
      if (sendTerminalSignals && accepted !== undefined) {
        emit("presence", "offline", undefined, true);
      }
      accepted = undefined;
      rateTimestamps.length = 0;
      detachVisibility();
    },
    startTyping(conversationId, requestedVisibility) {
      if (!featureEnabled("typing") || !visibility.isVisible()) return false;
      const authorizedVisibility = input.getConversationVisibility(
        conversationId,
        requestedVisibility,
      );
      if (
        authorizedVisibility === undefined ||
        (requestedVisibility !== undefined &&
          requestedVisibility !== authorizedVisibility)
      ) {
        return false;
      }
      engine.notifyActivity();
      const existing = activeTyping.get(conversationId);
      if (existing !== undefined) {
        scheduleTypingIdle(conversationId, existing);
        return true;
      }
      const scope: TypingSignalScope =
        authorizedVisibility === "public"
          ? {
              type: "conversation",
              conversationId: conversationId as never,
              visibility: "public",
              audience: "active_participants",
            }
          : {
              type: "conversation",
              conversationId: conversationId as never,
              visibility: "private",
              audience: "members",
            };
      const typing: ActiveTyping = { scope };
      if (!emit("typing", "start", scope)) return false;
      activeTyping.set(conversationId, typing);
      scheduleTypingHeartbeat(conversationId, typing);
      scheduleTypingIdle(conversationId, typing);
      return true;
    },
    stopTyping(conversationId) {
      const typing = activeTyping.get(conversationId);
      if (typing === undefined) return;
      activeTyping.delete(conversationId);
      clearTimer(typing.heartbeatTimer);
      clearTimer(typing.idleTimer);
      emit("typing", "stop", typing.scope, true);
    },
    setPresence(next) {
      desiredPresence = next;
      idleAway = false;
      if (next === "offline") stopAllTyping(true);
      emit("presence", effectivePresence(), undefined, next === "offline");
      schedulePresenceHeartbeat();
      schedulePresenceIdle();
    },
    notifyActivity() {
      if (desiredPresence !== "online" || !visibility.isVisible()) return;
      const wasAway = idleAway;
      idleAway = false;
      if (wasAway) emit("presence", "online", undefined);
      schedulePresenceIdle();
    },
  };

  return Object.freeze(engine);
}
