import {
  ChatNotificationDeliveryError,
  createChatNotificationDispatcher,
  createChatServer,
  type ChatNotificationAdapter,
  type ChatNotificationBatchFailureClass,
  type ChatNotificationBatchFailureClassCounts,
  type ChatNotificationBatchOutcome,
  type ChatNotificationBatchOutcomeStatus,
  type ChatNotificationBatchResult,
  type ChatNotificationInput,
  type ChatPushTokenProtector,
} from "../src/server/index.js";
import type {
  CanonicalDevicePushTokenState,
  ChatEvent,
  ConversationId,
  DeviceId,
  DevicePushTokenResult,
  OpaquePushToken,
  TenantId,
  UserId,
} from "../src/index.js";
import type { PostgresMigrationDatabase } from "../src/server/postgres-migrations.js";

declare const database: PostgresMigrationDatabase;
declare const tenantId: TenantId;
declare const conversationId: ConversationId;
declare const recipientUserId: UserId;
declare const actorUserId: UserId;
declare const deviceId: DeviceId;
declare const providerToken: OpaquePushToken;
declare const canonicalDeviceToken: CanonicalDevicePushTokenState;
declare const devicePushTokenResult: DevicePushTokenResult;
declare const realtimeEvent: ChatEvent;
declare const batchResult: ChatNotificationBatchResult;

// @ts-expect-error Batch outcomes are a closed enum.
const unsupportedBatchOutcome: ChatNotificationBatchOutcomeStatus = "other";
// @ts-expect-error Failure classes are a closed enum.
const unsupportedBatchFailureClass: ChatNotificationBatchFailureClass =
  "provider_error";

const pushTokenProtector: ChatPushTokenProtector = {
  async protect() { return { ciphertext: "protected", keyId: "key" }; },
  async unprotect() { return providerToken; },
};

const input: ChatNotificationInput = {
  deliveryId: "notification:stable",
  sourceEventId: "event-1",
  tenantId,
  recipientUserId,
  type: "message.created",
  occurredAt: "2030-01-01T00:00:00.000Z",
  conversationId,
  messageId: "message-1",
  sequence: 7,
  actorUserId,
  metadata: { protocolVersion: 4, quiet: false, optional: null },
  targets: [{
    deviceId,
    platform: "ios",
    provider: "apns",
    environment: "production",
    token: providerToken,
  }],
};

const adapter: ChatNotificationAdapter = {
  async send(delivery) {
    const stableId: string = delivery.deliveryId;
    const sequence: number = delivery.sequence;
    void [stableId, sequence];
  },
};

const dispatcher = createChatNotificationDispatcher({
  database,
  adapter,
  pushTokenProtector,
  maxAttempts: 4,
  isRecipientActive: async ({
    tenantId: activeTenant,
    recipientUserId: activeUser,
    conversationId: activeConversation,
  }) =>
    activeTenant === tenantId &&
    activeUser === recipientUserId &&
    activeConversation === conversationId,
  async onBatch(outcome) {
    const telemetry: ChatNotificationBatchOutcome = outcome;
    const status: ChatNotificationBatchOutcomeStatus = outcome.outcome;
    const failureCounts: ChatNotificationBatchFailureClassCounts =
      outcome.failureClassCounts;
    const age: number | null = outcome.oldestDueDeliveryAgeMs;
    const retryableFailures: number = outcome.failureClassCounts.transient;
    void [telemetry, status, failureCounts, age, retryableFailures];
    // @ts-expect-error Batch telemetry is immutable.
    outcome.failed = 1;
    // @ts-expect-error Failure-class counts are immutable.
    outcome.failureClassCounts.transient = 1;
    // @ts-expect-error Failure-class keys are deliberately bounded.
    outcome.failureClassCounts.provider_error;
    // @ts-expect-error Sensitive recipient identity is never telemetry.
    outcome.recipientUserId;
    // @ts-expect-error Sensitive tenant identity is never telemetry.
    outcome.tenantId;
    // @ts-expect-error Sensitive event identity is never telemetry.
    outcome.sourceEventId;
    // @ts-expect-error Sensitive conversation identity is never telemetry.
    outcome.conversationId;
    // @ts-expect-error Sensitive message identity is never telemetry.
    outcome.messageId;
    // @ts-expect-error Sensitive device identity is never telemetry.
    outcome.deviceId;
    // @ts-expect-error Device targets and tokens are never telemetry.
    outcome.targets;
    // @ts-expect-error Notification metadata is never telemetry.
    outcome.metadata;
    // @ts-expect-error Lease material is never telemetry.
    outcome.leaseToken;
    // @ts-expect-error Adapter/database error text is never telemetry.
    outcome.error;
  },
});
const running: boolean = dispatcher.running;
const batch: Promise<{
  readonly materialized: number;
  readonly claimed: number;
  readonly delivered: number;
  readonly suppressed: number;
  readonly failed: number;
}> = dispatcher.runOnce();

new ChatNotificationDeliveryError("transient");
new ChatNotificationDeliveryError("rate_limited");
new ChatNotificationDeliveryError("permanent");
new ChatNotificationDeliveryError("rejected");
new ChatNotificationDeliveryError("configuration");

// @ts-expect-error Provider payloads are not part of the public notification input.
input.payload;
// @ts-expect-error Notification target collections are readonly.
input.targets.push(input.targets[0]);
// @ts-expect-error Notification target fields are readonly.
input.targets[0]!.token = providerToken;
// @ts-expect-error Notification target fields are readonly.
input.targets[0]!.deviceId = deviceId;
// @ts-expect-error Canonical device-token state never exposes provider targets.
canonicalDeviceToken.targets;
// @ts-expect-error Canonical device-token state never exposes raw tokens.
canonicalDeviceToken.token;
// @ts-expect-error HTTP device-token results never expose provider targets.
devicePushTokenResult.targets;
// @ts-expect-error HTTP device-token results never expose raw tokens.
devicePushTokenResult.token;
// @ts-expect-error Realtime events never expose provider targets.
realtimeEvent.targets;
// @ts-expect-error Realtime events never expose raw tokens.
realtimeEvent.token;
// @ts-expect-error Worker results never expose provider targets.
batchResult.targets;
// @ts-expect-error Worker results never expose raw tokens.
batchResult.token;
// @ts-expect-error Failure classes are deliberately bounded.
new ChatNotificationDeliveryError("provider_error");

const runtime = createChatServer({
  database: { pool: database },
  auth: { async resolveActor() { return { tenantId, userId: actorUserId, roles: [] }; } },
  directory: { async getUser() { return null; }, async searchUsers() { return []; } },
  permissions: { async getCapabilities() { return []; }, async authorizeEntity() { return true; } },
  notifications: adapter,
  pushTokenProtector,
  features: { notifications: true },
  notificationDelivery: {
    maxAttempts: 3,
    isRecipientActive: () => false,
    onBatch(outcome) {
      const duration: number = outcome.durationMs;
      void duration;
    },
  },
});
const runtimeDispatcher = runtime.notificationDispatcher;

void [
  batch,
  running,
  runtimeDispatcher,
  unsupportedBatchOutcome,
  unsupportedBatchFailureClass,
];
