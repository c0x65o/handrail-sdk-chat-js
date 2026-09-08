import { Pool } from "pg";

import type { TenantId, UserId } from "../src/index.js";
import {
  ChatAuditDeliveryError,
  ChatAuditDispatcherError,
  createChatAuditDispatcher,
  type ChatAuditAdapter,
  type ChatAuditBatchOutcome,
  type ChatAuditBatchOutcomeStatus,
  type ChatAuditBatchResult,
  type ChatAuditDeliveryFailureClass,
  type ChatAuditEvent,
} from "../src/server/index.js";

const supportedBatchOutcomes: readonly ChatAuditBatchOutcomeStatus[] = [
  "empty",
  "succeeded",
  "partially_failed",
  "failed",
];
// @ts-expect-error Batch outcomes are a closed contract.
const unsupportedBatchOutcome: ChatAuditBatchOutcomeStatus = "other";

const aggregateOutcome: ChatAuditBatchOutcome = {
  claimed: 2,
  delivered: 1,
  retried: 1,
  terminal: 0,
  durationMs: 5,
  oldestEligibleEventLagMs: 20,
  outcome: "partially_failed",
};
const outcomeWithSensitiveIdentity: ChatAuditBatchOutcome = {
  claimed: 0,
  delivered: 0,
  retried: 0,
  terminal: 0,
  durationMs: 0,
  oldestEligibleEventLagMs: null,
  outcome: "empty",
  // @ts-expect-error Audit telemetry is closed and cannot expose tenant identity.
  tenantId: "tenant",
};

const adapter: ChatAuditAdapter = {
  async record(event: ChatAuditEvent) {
    const auditEventId: string = event.auditEventId;
    const tenantId: TenantId = event.tenantId;
    const actorUserId: UserId | null = event.actorUserId;
    const requestId: string = event.requestId;
    const correlationId: string | undefined = event.correlationId;
    void [auditEventId, tenantId, actorUserId, requestId, correlationId];
  },
};

const dispatcher = createChatAuditDispatcher({
  database: new Pool({ connectionString: "postgresql://localhost/example" }),
  adapter,
  onError(error: ChatAuditDispatcherError) {
    const failureClass: "database" | "configuration" = error.failureClass;
    void failureClass;
  },
  monotonicNow: () => 10,
  async onBatch(outcome) {
    const telemetry: ChatAuditBatchOutcome = outcome;
    const status: ChatAuditBatchOutcomeStatus = outcome.outcome;
    const lag: number | null = outcome.oldestEligibleEventLagMs;
    void [telemetry, status, lag];
    // @ts-expect-error Batch telemetry is immutable.
    outcome.claimed = 1;
    // @ts-expect-error Audit event identifiers are never telemetry.
    outcome.auditEventId;
    // @ts-expect-error Actor identifiers are never telemetry.
    outcome.actorUserId;
    // @ts-expect-error Audit actions are never telemetry.
    outcome.action;
    // @ts-expect-error Audit metadata is never telemetry.
    outcome.metadata;
    // @ts-expect-error Request identifiers are never telemetry.
    outcome.requestId;
    // @ts-expect-error Correlation identifiers are never telemetry.
    outcome.correlationId;
    // @ts-expect-error Lease identifiers are never telemetry.
    outcome.leaseOwner;
    // @ts-expect-error Adapter and database errors are never telemetry.
    outcome.error;
  },
});

async function run(): Promise<void> {
  const result: ChatAuditBatchResult = await dispatcher.runOnce();
  await dispatcher.close();
  void result;
}

const failureClass: ChatAuditDeliveryFailureClass = "rate_limited";
const deliveryError = new ChatAuditDeliveryError(failureClass);

new ChatAuditDeliveryError(
  // @ts-expect-error Audit failure classifications are a closed contract.
  "permanent",
);

const invalidEvent: ChatAuditEvent = {
  // @ts-expect-error Stable audit identity is required.
  auditEventId: undefined,
  tenantId: "tenant" as TenantId,
  actorUserId: null,
  action: "tested",
  occurredAt: "2030-01-01T00:00:00.000Z",
  metadata: {},
  requestId: "request",
};

void [
  run,
  deliveryError,
  invalidEvent,
  supportedBatchOutcomes,
  unsupportedBatchOutcome,
  aggregateOutcome,
  outcomeWithSensitiveIdentity,
];
