import { randomUUID } from "node:crypto";

import {
  MAX_PRESENCE_SIGNAL_TTL_MS,
  MAX_TYPING_SIGNAL_TTL_MS,
  parseEphemeralSignalEvent,
  type EphemeralSignalEvent,
  type EphemeralSignalFeature,
  type PresenceSignalEvent,
  type PresenceSignalPayload,
  type TypingSignalEvent,
  type TypingSignalPayload,
  type TypingSignalScope,
} from "../contracts/ephemeral-signals.js";
import type {
  ConversationId,
  DeviceId,
  SessionId,
  TenantId,
} from "../contracts/identifiers.js";
import type { EnabledFeatures } from "../contracts/realtime.js";
import type {
  ChatPermissionAdapter,
  ChatRealtimeAdapter,
  TrustedChatActorContext,
} from "./contracts.js";
import type { PostgresMigrationDatabase } from "./postgres-migrations.js";
import {
  authorizeChatWebSocketStream,
  type ChatWebSocketStreamId,
} from "./websocket-subscriptions.js";

export const DEFAULT_CHAT_TYPING_SIGNAL_TTL_MS = 10_000 as const;
export const DEFAULT_CHAT_PRESENCE_SIGNAL_TTL_MS = 60_000 as const;
export const DEFAULT_CHAT_EPHEMERAL_RATE_LIMIT_MAX_SIGNALS = 20 as const;
export const DEFAULT_CHAT_EPHEMERAL_RATE_LIMIT_WINDOW_MS = 1_000 as const;

export interface ChatEphemeralSignalClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ChatEphemeralSignalOptions {
  readonly typingTtlMs?: number;
  readonly presenceTtlMs?: number;
  readonly rateLimitMaxSignals?: number;
  readonly rateLimitWindowMs?: number;
  /** Injectable together so fake time never mixes with real timers. */
  readonly clock?: ChatEphemeralSignalClock;
  /** Generates opaque server-owned event, device, and socket-session IDs. */
  readonly idFactory?: () => string;
}

export interface NormalizedChatEphemeralSignalOptions {
  readonly typingTtlMs: number;
  readonly presenceTtlMs: number;
  readonly rateLimitMaxSignals: number;
  readonly rateLimitWindowMs: number;
  readonly clock: ChatEphemeralSignalClock;
  readonly idFactory: () => string;
}

export interface ChatEphemeralSessionIdentity {
  readonly deviceId: DeviceId;
  readonly sessionId: SessionId;
}

export interface ChatEphemeralSignalSession {
  readonly identity: ChatEphemeralSessionIdentity;
  /** Replaces roles from the same trusted tenant/user session identity. */
  refreshActor(actor: TrustedChatActorContext): void;
  /** Returns true when the frame belongs to the ephemeral signal protocol. */
  handle(serialized: string): Promise<boolean>;
  /** Idempotently removes socket-owned support and schedules clearing fanout. */
  dispose(): void;
}

export interface ChatEphemeralSignalController {
  attachSession(
    actor: TrustedChatActorContext,
    protocolVersion: number,
  ): ChatEphemeralSignalSession;
  parseFanout(
    value: unknown,
    expectedTenantId: TenantId,
  ): EphemeralSignalEvent | undefined;
  authorizeDelivery(
    actor: TrustedChatActorContext,
    event: EphemeralSignalEvent,
  ): Promise<boolean>;
  drain(): Promise<void>;
}

const defaultClock: ChatEphemeralSignalClock = Object.freeze({
  now: Date.now,
  setTimeout(callback: () => void, delayMs: number) {
    const handle = setTimeout(callback, delayMs);
    handle.unref();
    return handle;
  },
  clearTimeout(handle: unknown) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
});

const readPositiveInteger = (
  value: unknown,
  fallback: number,
  field: string,
  maximum?: number,
): number => {
  const candidate = value ?? fallback;
  if (
    !Number.isSafeInteger(candidate) ||
    (candidate as number) < 1 ||
    (maximum !== undefined && (candidate as number) > maximum)
  ) {
    throw new TypeError(
      `${field} must be a positive safe integer${
        maximum === undefined ? "" : ` no greater than ${maximum}`
      }`,
    );
  }
  return candidate as number;
};

export function normalizeChatEphemeralSignalOptions(
  value: ChatEphemeralSignalOptions | undefined,
): NormalizedChatEphemeralSignalOptions {
  const options = value ?? {};
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new TypeError("ephemeralSignals must be an object");
  }
  const allowed = new Set([
    "typingTtlMs",
    "presenceTtlMs",
    "rateLimitMaxSignals",
    "rateLimitWindowMs",
    "clock",
    "idFactory",
  ]);
  for (const field of Object.keys(options)) {
    if (!allowed.has(field)) {
      throw new TypeError(`ephemeralSignals.${field} is not supported`);
    }
  }

  const clock = options.clock ?? defaultClock;
  if (
    typeof clock !== "object" ||
    clock === null ||
    typeof clock.now !== "function" ||
    typeof clock.setTimeout !== "function" ||
    typeof clock.clearTimeout !== "function"
  ) {
    throw new TypeError(
      "ephemeralSignals.clock must provide now, setTimeout, and clearTimeout",
    );
  }
  const idFactory = options.idFactory ?? randomUUID;
  if (typeof idFactory !== "function") {
    throw new TypeError("ephemeralSignals.idFactory must be a function");
  }

  return Object.freeze({
    typingTtlMs: readPositiveInteger(
      options.typingTtlMs,
      DEFAULT_CHAT_TYPING_SIGNAL_TTL_MS,
      "ephemeralSignals.typingTtlMs",
      MAX_TYPING_SIGNAL_TTL_MS,
    ),
    presenceTtlMs: readPositiveInteger(
      options.presenceTtlMs,
      DEFAULT_CHAT_PRESENCE_SIGNAL_TTL_MS,
      "ephemeralSignals.presenceTtlMs",
      MAX_PRESENCE_SIGNAL_TTL_MS,
    ),
    rateLimitMaxSignals: readPositiveInteger(
      options.rateLimitMaxSignals,
      DEFAULT_CHAT_EPHEMERAL_RATE_LIMIT_MAX_SIGNALS,
      "ephemeralSignals.rateLimitMaxSignals",
    ),
    rateLimitWindowMs: readPositiveInteger(
      options.rateLimitWindowMs,
      DEFAULT_CHAT_EPHEMERAL_RATE_LIMIT_WINDOW_MS,
      "ephemeralSignals.rateLimitWindowMs",
    ),
    clock,
    idFactory,
  });
}

interface SignalOwner {
  readonly key: string;
  actor: TrustedChatActorContext;
  readonly protocolVersion: number;
  readonly identity: ChatEphemeralSessionIdentity;
  active: boolean;
  sequence: number;
  lastWireTimestamp: number;
  readonly ordering: Map<string, number>;
  readonly rate: RateBucket;
}

interface RateBucket {
  count: number;
  resetAt: number;
}

// Clients key typing by device/session as well as actor and conversation.
// Every removed owner must emit its own stop, even while another owner types.
interface TypingState {
  readonly owner: SignalOwner;
  readonly scope: TypingSignalScope;
  readonly sourceSentAt: number;
  readonly expiresAt: number;
  readonly timer: unknown;
}

// Presence wire state is session-scoped: clear each departing owner independently.
interface PresenceState {
  readonly owner: SignalOwner;
  readonly expiresAt: number;
  readonly timer: unknown;
}

interface CreateChatEphemeralSignalControllerInput {
  readonly database: PostgresMigrationDatabase;
  readonly schema: string;
  readonly permissions: ChatPermissionAdapter<string, string>;
  readonly realtime: Pick<ChatRealtimeAdapter, "publish">;
  readonly features: EnabledFeatures<EphemeralSignalFeature>;
  readonly options: NormalizedChatEphemeralSignalOptions;
}

const ownerStateKey = (ownerKey: string, subjectId: string): string =>
  JSON.stringify([ownerKey, subjectId]);

const actorRateKey = (actor: TrustedChatActorContext): string =>
  JSON.stringify([actor.tenantId, actor.userId]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const signalType = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) &&
  (value.type === "typing.signal" || value.type === "presence.signal");

const safeId = (factory: () => string): string => {
  const value = factory();
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError("ephemeralSignals.idFactory must return a non-empty string");
  }
  return value;
};

const quoteIdentifier = (identifier: string): string =>
  `"${identifier.replaceAll('"', '""')}"`;

interface TypingConversationRow {
  readonly visibility: "public" | "private";
  readonly archived_at: Date | string | null;
  readonly member_state: string | null;
}

async function authorizeTypingScope(
  input: CreateChatEphemeralSignalControllerInput,
  actor: TrustedChatActorContext,
  scope: TypingSignalScope,
): Promise<boolean> {
  const streamId = scope.conversationId as ChatWebSocketStreamId;
  const base = await authorizeChatWebSocketStream({
    database: input.database,
    permissions: input.permissions,
    actor,
    streamId,
    schema: input.schema,
  });
  if (!base.authorized || base.kind !== "conversation") {
    return false;
  }

  try {
    const prefix = quoteIdentifier(input.schema);
    const result = await input.database.query<TypingConversationRow>(
      `SELECT
         conversation.visibility,
         conversation.archived_at,
         current_member.state AS member_state
       FROM ${prefix}.chat_conversations AS conversation
       LEFT JOIN ${prefix}.chat_conversation_members AS current_member
         ON current_member.tenant_id = conversation.tenant_id
        AND current_member.conversation_id = conversation.id
        AND current_member.user_id = $3
       WHERE conversation.tenant_id = $1
         AND conversation.id = $2
       LIMIT 1`,
      [actor.tenantId, scope.conversationId, actor.userId],
    );
    const row = result.rows[0];
    return (
      row !== undefined &&
      row.archived_at === null &&
      row.member_state === "active" &&
      row.visibility === scope.visibility &&
      ((row.visibility === "private" && scope.audience === "members") ||
        (row.visibility === "public" &&
          scope.audience === "active_participants"))
    );
  } catch {
    return false;
  }
}

export function createChatEphemeralSignalController(
  input: CreateChatEphemeralSignalControllerInput,
): ChatEphemeralSignalController {
  const owners = new Map<string, SignalOwner>();
  const actorRates = new Map<string, RateBucket>();
  const typing = new Map<string, TypingState>();
  const presence = new Map<string, PresenceState>();
  let generatedIdSequence = 0;
  const ownerQueues = new Map<SignalOwner, Promise<void>>();

  const generateId = (): string =>
    `${safeId(input.options.idFactory)}-${++generatedIdSequence}`;

  const enqueue = <Result>(
    owner: SignalOwner,
    operation: () => Promise<Result>,
  ): Promise<Result> => {
    const result = (ownerQueues.get(owner) ?? Promise.resolve()).then(operation);
    const release = () => {
      // Settling an earlier operation must not discard a newer queued tail.
      if (ownerQueues.get(owner) === tail) {
        ownerQueues.delete(owner);
      }
    };
    // Keep the queue usable after rejection while preserving the caller's result.
    const tail = result.then(release, release);
    ownerQueues.set(owner, tail);
    return result;
  };

  const now = (): number => {
    const value = input.options.clock.now();
    if (!Number.isFinite(value)) {
      throw new TypeError("ephemeralSignals.clock.now must return a finite number");
    }
    return value;
  };

  const consumeBucket = (bucket: RateBucket, timestamp: number): boolean => {
    if (timestamp >= bucket.resetAt) {
      bucket.count = 0;
      bucket.resetAt = timestamp + input.options.rateLimitWindowMs;
    }
    if (bucket.count >= input.options.rateLimitMaxSignals) {
      return false;
    }
    bucket.count += 1;
    return true;
  };

  const consumeRate = (owner: SignalOwner, timestamp: number): boolean => {
    // Shared actor admission stays synchronous across independent owner queues.
    const key = actorRateKey(owner.actor);
    let actorBucket = actorRates.get(key);
    if (actorBucket === undefined) {
      actorBucket = { count: 0, resetAt: timestamp + input.options.rateLimitWindowMs };
      actorRates.set(key, actorBucket);
    }
    if (
      owner.rate.count >= input.options.rateLimitMaxSignals &&
      timestamp < owner.rate.resetAt
    ) {
      return false;
    }
    if (
      actorBucket.count >= input.options.rateLimitMaxSignals &&
      timestamp < actorBucket.resetAt
    ) {
      return false;
    }
    return consumeBucket(owner.rate, timestamp) && consumeBucket(actorBucket, timestamp);
  };

  const publish = async (
    owner: SignalOwner,
    type: EphemeralSignalEvent["type"],
    streamId: string,
    payload: TypingSignalPayload | PresenceSignalPayload,
  ): Promise<void> => {
    const occurredAt = payload.sentAt;
    const event: EphemeralSignalEvent =
      type === "typing.signal"
        ? ({
            eventId: `ephemeral-${generateId()}`,
            protocolVersion: owner.protocolVersion,
            tenantId: owner.actor.tenantId,
            streamId: streamId as ConversationId,
            type,
            occurredAt,
            payload: payload as TypingSignalPayload,
          } satisfies TypingSignalEvent)
        : ({
            eventId: `ephemeral-${generateId()}`,
            protocolVersion: owner.protocolVersion,
            tenantId: owner.actor.tenantId,
            streamId: streamId as `user:${string}`,
            type,
            occurredAt,
            payload: payload as PresenceSignalPayload,
          } satisfies PresenceSignalEvent);
    try {
      await input.realtime.publish(event);
    } catch {
      // Ephemeral delivery failure never enters durable retry/outbox state.
    }
  };

  const wireTimestamp = (owner: SignalOwner, timestamp: number): number => {
    // Clients order by sentAt alone; sequence cannot supersede equal or older timestamps.
    owner.lastWireTimestamp = Math.max(timestamp, owner.lastWireTimestamp + 1);
    return owner.lastWireTimestamp;
  };

  const typingPayload = (
    owner: SignalOwner,
    scope: TypingSignalScope,
    state: "start" | "stop",
    timestamp: number,
  ): TypingSignalPayload => {
    const sentAt = wireTimestamp(owner, timestamp);
    return {
      capability: "typing",
      durability: "ephemeral",
      actorUserId: owner.actor.userId,
      deviceId: owner.identity.deviceId,
      sessionId: owner.identity.sessionId,
      sequence: ++owner.sequence,
      sentAt: new Date(sentAt).toISOString(),
      expiresAt: new Date(sentAt + input.options.typingTtlMs).toISOString(),
      state,
      scope,
    };
  };

  const presencePayload = (
    owner: SignalOwner,
    state: PresenceSignalPayload["state"],
    timestamp: number,
  ): PresenceSignalPayload => {
    const sentAt = wireTimestamp(owner, timestamp);
    return {
      capability: "presence",
      durability: "ephemeral",
      actorUserId: owner.actor.userId,
      deviceId: owner.identity.deviceId,
      sessionId: owner.identity.sessionId,
      sequence: ++owner.sequence,
      sentAt: new Date(sentAt).toISOString(),
      expiresAt: new Date(sentAt + input.options.presenceTtlMs).toISOString(),
      state,
      scope: { type: "user_private", userId: owner.actor.userId },
    };
  };

  const expireTyping = async (stateKey: string, expected: TypingState) => {
    const current = typing.get(stateKey);
    if (current !== expected || current.expiresAt > now()) {
      return;
    }
    typing.delete(stateKey);
    const timestamp = now();
    await publish(
      current.owner,
      "typing.signal",
      current.scope.conversationId,
      typingPayload(current.owner, current.scope, "stop", timestamp),
    );
  };

  const expirePresence = async (stateKey: string, expected: PresenceState) => {
    const current = presence.get(stateKey);
    if (current !== expected || current.expiresAt > now()) {
      return;
    }
    presence.delete(stateKey);
    const timestamp = now();
    await publish(
      current.owner,
      "presence.signal",
      `user:${current.owner.actor.userId}`,
      presencePayload(current.owner, "offline", timestamp),
    );
  };

  const handleTyping = async (owner: SignalOwner, event: TypingSignalEvent) => {
    const timestamp = now();
    const sourceSentAt = Date.parse(event.payload.sentAt);
    const stateKey = ownerStateKey(owner.key, event.payload.scope.conversationId);
    if ((owner.ordering.get(stateKey) ?? -Infinity) >= sourceSentAt) {
      return;
    }
    if (!consumeRate(owner, timestamp)) {
      return;
    }
    if (!(await authorizeTypingScope(input, owner.actor, event.payload.scope))) {
      return;
    }
    owner.ordering.set(stateKey, sourceSentAt);

    const previous = typing.get(stateKey);
    if (previous !== undefined) {
      input.options.clock.clearTimeout(previous.timer);
      typing.delete(stateKey);
    }

    if (event.payload.state === "start") {
      const expiresAt = timestamp + input.options.typingTtlMs;
      let next!: TypingState;
      const timer = input.options.clock.setTimeout(() => {
        void enqueue(owner, () => expireTyping(stateKey, next));
      }, input.options.typingTtlMs);
      next = {
        owner,
        scope: event.payload.scope,
        sourceSentAt,
        expiresAt,
        timer,
      };
      typing.set(stateKey, next);
      await publish(
        owner,
        "typing.signal",
        event.payload.scope.conversationId,
        typingPayload(owner, event.payload.scope, "start", timestamp),
      );
      return;
    }

    if (previous !== undefined) {
      await publish(
        owner,
        "typing.signal",
        event.payload.scope.conversationId,
        typingPayload(owner, event.payload.scope, "stop", timestamp),
      );
    }
  };

  const handlePresence = async (
    owner: SignalOwner,
    event: PresenceSignalEvent,
  ) => {
    const timestamp = now();
    const sourceSentAt = Date.parse(event.payload.sentAt);
    const stateKey = ownerStateKey(owner.key, "presence");
    if ((owner.ordering.get(stateKey) ?? -Infinity) >= sourceSentAt) {
      return;
    }
    if (!consumeRate(owner, timestamp)) {
      return;
    }
    owner.ordering.set(stateKey, sourceSentAt);

    const previous = presence.get(stateKey);
    if (previous !== undefined) {
      input.options.clock.clearTimeout(previous.timer);
      presence.delete(stateKey);
    }

    if (event.payload.state !== "offline") {
      const expiresAt = timestamp + input.options.presenceTtlMs;
      let next!: PresenceState;
      const timer = input.options.clock.setTimeout(() => {
        void enqueue(owner, () => expirePresence(stateKey, next));
      }, input.options.presenceTtlMs);
      next = {
        owner,
        expiresAt,
        timer,
      };
      presence.set(stateKey, next);
      await publish(
        owner,
        "presence.signal",
        `user:${owner.actor.userId}`,
        presencePayload(owner, event.payload.state, timestamp),
      );
      return;
    }

    if (previous !== undefined) {
      await publish(
        owner,
        "presence.signal",
        `user:${owner.actor.userId}`,
        presencePayload(owner, "offline", timestamp),
      );
    }
  };

  const disposeOwner = async (owner: SignalOwner): Promise<void> => {
    if (!owner.active) {
      return;
    }
    owner.active = false;
    owners.delete(owner.key);
    const timestamp = now();

    for (const [stateKey, current] of [...typing]) {
      if (current.owner !== owner) continue;
      input.options.clock.clearTimeout(current.timer);
      typing.delete(stateKey);
      await publish(
        owner,
        "typing.signal",
        current.scope.conversationId,
        typingPayload(owner, current.scope, "stop", timestamp),
      );
    }

    for (const [stateKey, current] of [...presence]) {
      if (current.owner !== owner) continue;
      input.options.clock.clearTimeout(current.timer);
      presence.delete(stateKey);
      await publish(
        owner,
        "presence.signal",
        `user:${owner.actor.userId}`,
        presencePayload(owner, "offline", timestamp),
      );
    }

    // Recheck after publishing: another session may have attached during cleanup.
    if (
      ![...owners.values()].some(
        (candidate) => actorRateKey(candidate.actor) === actorRateKey(owner.actor),
      )
    ) {
      actorRates.delete(actorRateKey(owner.actor));
    }
  };

  const controller: ChatEphemeralSignalController = {
    attachSession(
      actor: TrustedChatActorContext,
      protocolVersion: number,
    ) {
      const identity = Object.freeze({
        deviceId: `device-${generateId()}` as DeviceId,
        sessionId: `session-${generateId()}` as SessionId,
      });
      const owner: SignalOwner = {
        key: identity.sessionId,
        actor,
        protocolVersion,
        identity,
        active: true,
        sequence: 0,
        lastWireTimestamp: -Infinity,
        ordering: new Map(),
        rate: { count: 0, resetAt: now() + input.options.rateLimitWindowMs },
      };
      owners.set(owner.key, owner);
      return Object.freeze({
        identity,
        refreshActor(actor: TrustedChatActorContext) {
          if (
            !owner.active ||
            actor.tenantId !== owner.actor.tenantId ||
            actor.userId !== owner.actor.userId
          ) {
            return;
          }
          owner.actor = actor;
        },
        async handle(serialized: string) {
          let value: unknown;
          try {
            value = JSON.parse(serialized) as unknown;
          } catch {
            return false;
          }
          if (!signalType(value)) {
            return false;
          }
          await enqueue(owner, async () => {
            if (!owner.active) return;
            let event: EphemeralSignalEvent;
            const timestamp = now();
            try {
              event = parseEphemeralSignalEvent(value, {
                expectedTenantId: owner.actor.tenantId,
                enabledFeatures: input.features,
                now: timestamp,
                trustedAcceptedSessionIdentity: {
                  actorUserId: owner.actor.userId,
                  deviceId: owner.identity.deviceId,
                  sessionId: owner.identity.sessionId,
                },
              });
            } catch {
              return;
            }
            if (
              event.protocolVersion !== owner.protocolVersion ||
              Date.parse(event.payload.sentAt) >
                timestamp +
                  (event.type === "typing.signal"
                    ? MAX_TYPING_SIGNAL_TTL_MS
                    : MAX_PRESENCE_SIGNAL_TTL_MS)
            ) {
              return;
            }
            if (event.type === "typing.signal") {
              await handleTyping(owner, event);
            } else if (
              event.payload.scope.userId === owner.actor.userId &&
              event.streamId === `user:${owner.actor.userId}`
            ) {
              await handlePresence(owner, event);
            }
          });
          return true;
        },
        dispose() {
          void enqueue(owner, () => disposeOwner(owner));
        },
      });
    },
    parseFanout(value: unknown, expectedTenantId: TenantId) {
      if (!signalType(value)) return undefined;
      try {
        return parseEphemeralSignalEvent(value, {
          expectedTenantId,
          enabledFeatures: input.features,
          now: now(),
        });
      } catch {
        return undefined;
      }
    },
    async authorizeDelivery(
      actor: TrustedChatActorContext,
      event: EphemeralSignalEvent,
    ) {
      if (event.type === "presence.signal") {
        return (
          event.streamId === `user:${actor.userId}` &&
          event.payload.scope.userId === actor.userId
        );
      }
      return authorizeTypingScope(input, actor, event.payload.scope);
    },
    async drain() {
      // Include expiry/disposal work enqueued while outstanding work settles.
      while (ownerQueues.size > 0) {
        await Promise.all(ownerQueues.values());
      }
    },
  };
  return Object.freeze(controller);
}
