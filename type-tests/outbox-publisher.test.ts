import type { Pool } from "pg";

import type { ChatEvent } from "../src/contracts/realtime.js";
import {
  createChatOutboxPublisher,
  createChatServer,
  createLocalChatRealtimeHub,
  type ChatLocalRealtimeHub,
  type ChatOutboxBatchFailureClass,
  type ChatOutboxBatchOutcome,
  type ChatOutboxBatchOutcomeStatus,
  type ChatOutboxPublisher,
} from "../src/server/index.js";

declare const pool: Pool;

// @ts-expect-error Batch outcomes are a closed enum.
const unsupportedOutcome: ChatOutboxBatchOutcomeStatus = "other";
// @ts-expect-error Failure classes are a closed enum.
const unsupportedFailureClass: ChatOutboxBatchFailureClass = "provider_error";

const hub: ChatLocalRealtimeHub = createLocalChatRealtimeHub();
const unsubscribe: () => void = hub.subscribe(async (event: ChatEvent) => {
  void event.eventId;
});

const publisher: ChatOutboxPublisher = createChatOutboxPublisher({
  database: pool,
  schema: "handrail_chat",
  realtime: hub,
  batchSize: 10,
  pollIntervalMs: 5,
  leaseDurationMs: 1_000,
  initialRetryDelayMs: 10,
  maxRetryDelayMs: 1_000,
  onError(error) {
    void error;
  },
  async onBatch(outcome) {
    const immutableOutcome: ChatOutboxBatchOutcome = outcome;
    const status: ChatOutboxBatchOutcomeStatus = outcome.outcome;
    const failureClass: ChatOutboxBatchFailureClass = outcome.failureClass;
    const age: number | null = outcome.oldestClaimedEventAgeMs;
    void [immutableOutcome, status, failureClass, age];
    // @ts-expect-error Batch telemetry is immutable.
    outcome.claimed = 1;
  },
});

const runtime = createChatServer({
  database: { pool },
  auth: { async resolveActor() { throw new Error("type fixture"); } },
  directory: {
    async getUser() { return null; },
    async searchUsers() { return []; },
  },
  permissions: {
    async getCapabilities() { return []; },
    async authorizeEntity() { return true; },
  },
  outbox: {
    pollIntervalMs: 25,
    leaseDurationMs: 5_000,
    onBatch(outcome) {
      void outcome.durationMs;
    },
  },
});

const runtimePublisher: ChatOutboxPublisher = runtime.outboxPublisher;
const runtimeHub: ChatLocalRealtimeHub = runtime.realtimeHub;

createChatOutboxPublisher({
  database: pool,
  // @ts-expect-error Batch sizes must be numeric.
  batchSize: "ten",
});

unsubscribe();
void [
  publisher,
  runtimePublisher,
  runtimeHub,
  unsupportedOutcome,
  unsupportedFailureClass,
];
