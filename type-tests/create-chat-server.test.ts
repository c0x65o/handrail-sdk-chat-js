import type { IncomingMessage, ServerResponse } from "node:http";

import type { Pool } from "pg";

import {
  createChatServer,
  type ChatAttachmentCleanupBatchResult,
  type ChatAttachmentCleanupDispatcher,
  type ChatAttachmentCleanupDispatcherOptions,
  type ChatAuditAdapter,
  type ChatAuditDispatcher,
  type ChatAuditDispatcherOptions,
  type ChatHttpObservabilityOptions,
  type ChatHttpRequestIdInput,
  type ChatHttpRequestOutcome,
  type ChatHttpRequestOutcomeObserver,
  type ChatHostAdapters,
  type ChatPushTokenProtector,
  type ChatRequestAdmissionAdapter,
  type ChatRequestAdmissionInput,
  type ChatRequestAdmissionOutcome,
  type ChatRequestAdmissionRouteTemplate,
  type ChatRealtimeAdapter,
  type ChatRealtimeDelivery,
  type ChatRouter,
  type ChatServerRuntime,
  type ChatStorageAdapter,
  type ChatThreadInactivityPolicy,
  type ChatThreadInactivityPolicyResolver,
  type ChatThreadInactivityPolicyScope,
  type ChatThreadListHandlerOptions,
  type CreateChatServerConfig,
} from "../src/server/index.js";

import type { ConversationId, TenantId } from "../src/contracts/identifiers.js";

declare const pool: Pool;
declare const storage: ChatStorageAdapter;

const pushTokenProtector = {
  async protect() {
    return { ciphertext: "opaque-encrypted-envelope", keyId: "kms-key-1" };
  },
  async unprotect() {
    return "opaque-provider-token" as never;
  },
} satisfies ChatPushTokenProtector;

const admission = {
  async admit(input) {
    const request: IncomingMessage = input.request;
    const method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" =
      input.method;
    const routeTemplate: ChatRequestAdmissionRouteTemplate =
      input.routeTemplate;
    void [request, method, routeTemplate];
    return { decision: "allow" };
  },
} satisfies ChatRequestAdmissionAdapter<IncomingMessage>;

const admissionInput: ChatRequestAdmissionInput<IncomingMessage> = {
  request: {} as IncomingMessage,
  method: "POST",
  routeTemplate: "/conversations/:conversationId/messages",
};
const denial: ChatRequestAdmissionOutcome = {
  decision: "deny",
  retryAfterSeconds: 30,
};

const httpOutcomeObserver: ChatHttpRequestOutcomeObserver = async (outcome) => {
  const immutable: ChatHttpRequestOutcome = outcome;
  const method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" =
    outcome.method;
  const routeTemplate: ChatRequestAdmissionRouteTemplate =
    outcome.routeTemplate;
  void [immutable, method, routeTemplate, outcome.requestId, outcome.statusCode];
};

const httpObservability = {
  createRequestId(input) {
    const trustedRequest: IncomingMessage = input.request;
    const route: ChatRequestAdmissionRouteTemplate = input.routeTemplate;
    void [trustedRequest, route];
    return "trusted-request-id";
  },
  onOutcome: httpOutcomeObserver,
  now: () => 42,
} satisfies ChatHttpObservabilityOptions<IncomingMessage>;

const adapters = {
  auth: {
    async resolveActor(_request: IncomingMessage) {
      return {
        tenantId: "tenant-1" as never,
        userId: "user-1" as never,
        roles: ["employee"],
      };
    },
  },
  directory: {
    async getUser() {
      return null;
    },
    async searchUsers() {
      return [];
    },
  },
  permissions: {
    async getCapabilities() {
      return ["message.send" as const];
    },
    async authorizeEntity() {
      return true;
    },
  },
} satisfies ChatHostAdapters<IncomingMessage, "message.send">;

const minimalConfig = {
  database: { pool },
  ...adapters,
} satisfies CreateChatServerConfig<IncomingMessage, "message.send">;

const publishOnlyRealtime = {
  async publish() {},
} satisfies ChatRealtimeAdapter;

const clusteredRealtime = {
  async publish() {},
  subscribe() {
    return () => {};
  },
} satisfies ChatRealtimeAdapter;

const explicitSingleProcessConfig = {
  ...minimalConfig,
  realtime: publishOnlyRealtime,
  realtimeDelivery: "single_process",
} satisfies CreateChatServerConfig<IncomingMessage, "message.send">;

const clusteredConfig = {
  ...minimalConfig,
  realtime: clusteredRealtime,
  realtimeDelivery: "clustered",
  features: { realtime: true },
} satisfies CreateChatServerConfig<IncomingMessage, "message.send">;

const configWithPushTokenProtector = {
  ...minimalConfig,
  pushTokenProtector,
} satisfies CreateChatServerConfig<IncomingMessage, "message.send">;

const configWithAdmission = {
  ...minimalConfig,
  admission,
} satisfies CreateChatServerConfig<IncomingMessage, "message.send">;

const configWithHttpObservability = {
  ...minimalConfig,
  httpObservability,
} satisfies CreateChatServerConfig<IncomingMessage, "message.send">;

const audit = {
  async record(event) {
    const auditEventId: string = event.auditEventId;
    void auditEventId;
  },
} satisfies ChatAuditAdapter;

const auditDelivery = {
  batchSize: 10,
  pollIntervalMs: 1_000,
  leaseDurationMs: 30_000,
  initialRetryDelayMs: 100,
  maxRetryDelayMs: 1_000,
  onError(error) {
    void error.failureClass;
  },
  onBatch(outcome) {
    void [outcome.claimed, outcome.delivered, outcome.outcome];
  },
  monotonicNow: () => performance.now(),
} satisfies ChatAuditDispatcherOptions;

const configWithAudit = {
  ...minimalConfig,
  audit,
  features: { audit: true },
  auditDelivery,
} satisfies CreateChatServerConfig<IncomingMessage, "message.send">;

const attachmentCleanup = {
  batchSize: 10,
  pollIntervalMs: 1_000,
  leaseDurationMs: 30_000,
  maxAttempts: 4,
  initialRetryDelayMs: 100,
  maxRetryDelayMs: 1_000,
  onError(error) {
    void error.failureClass;
  },
  onBatch(outcome) {
    void [outcome.claimed, outcome.delivered, outcome.outcome];
  },
  monotonicNow: () => performance.now(),
} satisfies ChatAttachmentCleanupDispatcherOptions;

const configWithAttachments = {
  ...minimalConfig,
  storage,
  features: { attachments: true },
  attachmentCleanup,
} satisfies CreateChatServerConfig<IncomingMessage, "message.send">;

const runtime: ChatServerRuntime<IncomingMessage, "message.send"> =
  createChatServer(minimalConfig);
const defaultRealtimeDelivery: ChatRealtimeDelivery =
  runtime.config.realtimeDelivery;
const explicitSingleProcessDelivery: ChatRealtimeDelivery =
  createChatServer(explicitSingleProcessConfig).config.realtimeDelivery;
const clusteredDelivery: ChatRealtimeDelivery =
  createChatServer(clusteredConfig).config.realtimeDelivery;
const router: ChatRouter = runtime.router;
const requestHandler: (
  request: IncomingMessage,
  response: ServerResponse,
) => void = runtime.router;
const normalizedPushTokenProtector: ChatPushTokenProtector | undefined =
  runtime.config.adapters.pushTokenProtector;
const normalizedAdmission: ChatRequestAdmissionAdapter<IncomingMessage> | undefined =
  createChatServer(configWithAdmission).config.adapters.admission;
const auditRuntime = createChatServer(configWithAudit);
const auditDispatcher: ChatAuditDispatcher | undefined =
  auditRuntime.auditDispatcher;
const normalizedAuditDelivery: number =
  auditRuntime.config.auditDelivery.pollIntervalMs;
void auditDispatcher?.runOnce();
const attachmentRuntime = createChatServer(configWithAttachments);
const attachmentCleanupDispatcher: ChatAttachmentCleanupDispatcher | undefined =
  attachmentRuntime.attachmentCleanupDispatcher;
const normalizedAttachmentCleanup: number =
  attachmentRuntime.config.attachmentCleanup.maxAttempts;
const attachmentCleanupBatch: Promise<ChatAttachmentCleanupBatchResult> =
  attachmentRuntime.dispatchAttachmentCleanupOnce();

const invalidAdmissionRoute: ChatRequestAdmissionInput<IncomingMessage> = {
  request: {} as IncomingMessage,
  method: "GET",
  // @ts-expect-error Admission metadata accepts only stable recognized templates.
  routeTemplate: "/conversations/raw-conversation",
};

const invalidAdmissionOutcome: ChatRequestAdmissionOutcome = {
  // @ts-expect-error Admission outcomes are a closed allow-or-deny union.
  decision: "defer",
};

const invalidHttpRequestIdRoute: ChatHttpRequestIdInput<IncomingMessage> = {
  request: {} as IncomingMessage,
  method: "GET",
  // @ts-expect-error Request-id providers receive only recognized templates.
  routeTemplate: "/conversations/raw-client-value",
};

// @ts-expect-error Outcomes require bounded transport facts including duration.
const malformedHttpOutcome: ChatHttpRequestOutcome = {
  requestId: "request-1",
  method: "GET",
  routeTemplate: "/_meta",
  statusCode: 200,
};

const rawRouteHttpOutcome: ChatHttpRequestOutcome = {
  requestId: "request-1",
  method: "GET",
  routeTemplate: "/_meta",
  statusCode: 200,
  durationMs: 1,
  // @ts-expect-error Raw request paths are not part of the observer shape.
  rawUrl: "/_meta?secret=value",
};

const asyncRequestIdProvider: ChatHttpObservabilityOptions<IncomingMessage> = {
  // @ts-expect-error Request ids must be resolved synchronously before commitment.
  createRequestId: async () => "too-late",
};

const ownedRuntime = createChatServer({
  database: {
    connectionString: "postgresql://localhost/chat",
    schema: "custom_chat",
    createPool: () => pool,
  },
  ...adapters,
});

createChatServer({
  // @ts-expect-error Database configuration is required.
  database: undefined,
  ...adapters,
});

createChatServer({
  database: { pool },
  // @ts-expect-error Authentication is a required trusted host boundary.
  auth: undefined,
  directory: adapters.directory,
  permissions: adapters.permissions,
});

createChatServer({
  database: { pool },
  ...adapters,
  // @ts-expect-error Feature flags are booleans.
  features: { media: "enabled" },
});

createChatServer({
  database: { pool },
  ...adapters,
  // @ts-expect-error Realtime delivery is a closed low-cardinality contract.
  realtimeDelivery: "multi_region",
});

void [
  runtime,
  defaultRealtimeDelivery,
  explicitSingleProcessDelivery,
  clusteredDelivery,
  explicitSingleProcessConfig,
  clusteredConfig,
  router,
  requestHandler,
  normalizedPushTokenProtector,
  normalizedAdmission,
  admissionInput,
  denial,
  invalidAdmissionRoute,
  invalidAdmissionOutcome,
  configWithAdmission,
  configWithHttpObservability,
  configWithPushTokenProtector,
  configWithAudit,
  configWithAttachments,
  auditDelivery,
  attachmentCleanup,
  attachmentCleanupDispatcher,
  normalizedAttachmentCleanup,
  attachmentCleanupBatch,
  auditDispatcher,
  normalizedAuditDelivery,
  ownedRuntime,
  invalidHttpRequestIdRoute,
  malformedHttpOutcome,
  rawRouteHttpOutcome,
  asyncRequestIdProvider,
];

const inactivityPolicy: ChatThreadInactivityPolicyResolver = async (scope) => {
  const tenantId: TenantId = scope.tenantId;
  const parentId: ConversationId = scope.parentConversationId;
  // @ts-expect-error Shared policy has no current user.
  scope.userId;
  // @ts-expect-error Shared policy has no saved reply style.
  scope.replyStyle;
  // @ts-expect-error Policy scope is immutable.
  scope.tenantId = tenantId;
  return parentId === "parent-1" ? { hideAfterMs: 60_000 } : false;
};
const inactivityConfig = {
  ...minimalConfig,
  threadInactivityPolicy: inactivityPolicy,
} satisfies CreateChatServerConfig<IncomingMessage, "message.send">;
const disabledInactivityConfig = {
  ...minimalConfig,
  threadInactivityPolicy: false,
} satisfies CreateChatServerConfig<IncomingMessage, "message.send">;
const synchronousInactivityConfig = {
  ...minimalConfig,
  threadInactivityPolicy: () => ({ hideAfterMs: 1000 }),
} satisfies CreateChatServerConfig<IncomingMessage, "message.send">;
const threadListOptions: ChatThreadListHandlerOptions =
  createChatServer(inactivityConfig).threadListHandlerOptions;
declare const inactivityScope: ChatThreadInactivityPolicyScope;
const resolvedInactivity: Promise<ChatThreadInactivityPolicy> =
  threadListOptions.resolveInactivityPolicy(inactivityScope);
// @ts-expect-error An explicit parent is required.
threadListOptions.resolveInactivityPolicy({ tenantId: inactivityScope.tenantId });
// @ts-expect-error Resolution is unavailable on normalized server configuration.
runtime.config.threadInactivityPolicy;
createChatServer({
  ...minimalConfig,
  // @ts-expect-error Durations must be numbers, never strings.
  threadInactivityPolicy: () => ({ hideAfterMs: "1000" }),
});
createChatServer({
  ...minimalConfig,
  // @ts-expect-error Enabling requires an explicit tenant/parent callback.
  threadInactivityPolicy: { hideAfterMs: 1000 },
});
void [disabledInactivityConfig, synchronousInactivityConfig, resolvedInactivity];
