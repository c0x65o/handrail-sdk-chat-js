import {
  createExpiredPendingAttachmentMaintenanceJob,
  createPostgresMaintenance,
  normalizeChatPostgresMaintenanceOptions,
  type ChatPostgresMaintenanceOptions,
  type ExpiredPendingAttachmentIdentity,
  type ExpiredPendingAttachmentMaintenanceJobOptions,
  type ExpiredPendingAttachmentMaintenanceResult,
  type NormalizedChatPostgresMaintenanceOptions,
  type PostgresMaintenanceBatchListener,
  type PostgresMaintenanceBatchOutcome,
  type PostgresMaintenanceBatchOutcomeStatus,
  type PostgresMaintenanceBatchResult,
} from "../src/server/index.js";

declare const attachmentOptions: ExpiredPendingAttachmentMaintenanceJobOptions;

const attachmentJob = createExpiredPendingAttachmentMaintenanceJob(
  attachmentOptions,
);
const attachmentResult: Promise<ExpiredPendingAttachmentMaintenanceResult> =
  attachmentJob();
void attachmentResult.then((result) => {
  const identity: ExpiredPendingAttachmentIdentity = result.abandoned[0]!;
  const attachmentId: string = identity.attachmentId;
  const tenantId: string = identity.tenantId;
  const expiresAt: string = identity.expiresAt;
  void [attachmentId, tenantId, expiresAt];

  // @ts-expect-error Storage keys are intentionally absent from public results.
  void identity.storageKey;
  // @ts-expect-error Result identities are immutable.
  identity.attachmentId = "replacement";
  // @ts-expect-error Result identity collections are immutable.
  result.abandoned.push(identity);
});

const maintenanceOptions = {
  pollIntervalMs: 60_000,
  expiredIdempotencyKeys: { batchSize: 10 },
  expiredOutboxEvents: { batchSize: 20 },
  expiredPendingAttachments: { batchSize: 30 },
} satisfies ChatPostgresMaintenanceOptions;
const normalizedMaintenanceOptions: NormalizedChatPostgresMaintenanceOptions =
  normalizeChatPostgresMaintenanceOptions(maintenanceOptions);
// @ts-expect-error Normalized maintenance configuration is immutable.
normalizedMaintenanceOptions.expiredPendingAttachments.batchSize = 40;

const supportedStatuses: readonly PostgresMaintenanceBatchOutcomeStatus[] = [
  "empty",
  "success",
  "partial_failure",
  "failed",
];

// @ts-expect-error Maintenance batch statuses are a closed union.
const unsupportedStatus: PostgresMaintenanceBatchOutcomeStatus = "other";

const listener: PostgresMaintenanceBatchListener = async (outcome) => {
  const telemetry: PostgresMaintenanceBatchOutcome = outcome;
  const result: PostgresMaintenanceBatchResult = outcome;
  const status: PostgresMaintenanceBatchOutcomeStatus = outcome.status;
  const configuredJobs: number = outcome.configuredJobs;
  const durationMs: number = outcome.durationMs;
  void [telemetry, result, status, configuredJobs, durationMs];

  // @ts-expect-error Maintenance telemetry is immutable.
  outcome.status = "failed";
  // @ts-expect-error Maintenance telemetry is immutable.
  outcome.configuredJobs = 0;
  // @ts-expect-error Job identities are intentionally absent.
  void outcome.job;
  // @ts-expect-error Caught errors are intentionally absent.
  void outcome.error;
  // @ts-expect-error Tenant identities are intentionally absent.
  void outcome.tenantId;
  // @ts-expect-error User identities are intentionally absent.
  void outcome.userId;
  // @ts-expect-error Event identities are intentionally absent.
  void outcome.eventId;
  // @ts-expect-error Client identities are intentionally absent.
  void outcome.clientId;
  // @ts-expect-error SQL is intentionally absent.
  void outcome.sql;
  // @ts-expect-error Credentials are intentionally absent.
  void outcome.credentials;
  // @ts-expect-error Error messages are intentionally absent.
  void outcome.message;
  // @ts-expect-error Error stacks are intentionally absent.
  void outcome.stack;
};

const maintenance = createPostgresMaintenance({
  jobs: [async () => undefined],
  onBatch: listener,
});
const runResult: Promise<PostgresMaintenanceBatchResult> = maintenance.runOnce();

void [supportedStatuses, unsupportedStatus, maintenance, runResult];
