import type { Pool } from "pg";

import type { DeviceId, SessionId } from "../src/contracts/identifiers.js";
import {
  DEFAULT_CHAT_EPHEMERAL_RATE_LIMIT_MAX_SIGNALS,
  DEFAULT_CHAT_PRESENCE_SIGNAL_TTL_MS,
  DEFAULT_CHAT_TYPING_SIGNAL_TTL_MS,
  createChatServer,
  type ChatEphemeralSignalClock,
  type ChatEphemeralSignalOptions,
  type ChatWebSocketSessionAcceptedMessage,
} from "../src/server/index.js";

let now = 1_000;
const timers = new Map<number, () => void>();
const clock = {
  now: () => now,
  setTimeout(callback, _delayMs) {
    const handle = timers.size + 1;
    timers.set(handle, callback);
    return handle;
  },
  clearTimeout(handle) {
    timers.delete(handle as number);
  },
} satisfies ChatEphemeralSignalClock;

const signalOptions = {
  clock,
  idFactory: () => "server-owned-id",
  typingTtlMs: DEFAULT_CHAT_TYPING_SIGNAL_TTL_MS,
  presenceTtlMs: DEFAULT_CHAT_PRESENCE_SIGNAL_TTL_MS,
  rateLimitMaxSignals: DEFAULT_CHAT_EPHEMERAL_RATE_LIMIT_MAX_SIGNALS,
  rateLimitWindowMs: 1_000,
} satisfies ChatEphemeralSignalOptions;

declare const database: Pool;
const runtime = createChatServer({
  database: { pool: database },
  auth: {
    async resolveActor() {
      return { tenantId: "tenant" as never, userId: "user" as never, roles: [] };
    },
  },
  directory: {
    async getUser() { return null; },
    async searchUsers() { return []; },
  },
  permissions: {
    async getCapabilities() { return []; },
    async authorizeEntity() { return true; },
  },
  features: { typing: true, presence: true },
  ephemeralSignals: signalOptions,
});

declare const accepted: ChatWebSocketSessionAcceptedMessage;
const deviceId: DeviceId = accepted.deviceId;
const sessionId: SessionId = accepted.sessionId;
const normalizedTtl: number = runtime.config.ephemeralSignals.typingTtlMs;

// @ts-expect-error Clock implementations must provide clearTimeout.
const invalidClock: ChatEphemeralSignalClock = { now: () => now, setTimeout: () => 1 };

now += 1;
void [deviceId, sessionId, normalizedTtl, invalidClock];
