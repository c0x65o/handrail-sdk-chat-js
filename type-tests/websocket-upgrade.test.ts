import type { IncomingMessage } from "node:http";

import type { WebSocket } from "ws";
import type { Pool } from "pg";

import {
  CHAT_WEBSOCKET_CLOSE_REASONS,
  CHAT_WEBSOCKET_SUBSCRIPTION_MESSAGE_TYPES,
  DEFAULT_CHAT_WEBSOCKET_MAX_REPLAY_EVENTS,
  createChatServer,
  type ChatRequestAdmissionAdapter,
  type ChatRequestAdmissionInput,
  type ChatRequestAdmissionOutcome,
  type ChatWebSocketOptions,
  type ChatWebSocketSession,
  type ChatWebSocketSessionAcceptedMessage,
  type ChatWebSocketSnapshotRequiredMessage,
  type ChatWebSocketSubscriptionAcceptedMessage,
  type ChatWebSocketUpgradeOutcome,
  type ChatWebSocketUpgradeOutcomeObserver,
  type ChatWebSocketUpgradeOutcomeStatus,
} from "../src/server/index.js";

type Capability = "message.read" | "message.send";
type Feature = "attachments" | "realtime";

const webSocketOptions = {
  path: "/chat/socket",
  maxConnections: 50,
  maxConnectionsPerTenant: 5,
  handshakeTimeoutMs: 2_000,
  sessionRevalidationIntervalMs: 60_000,
  maxReplayEvents: 75,
  now: () => 10,
  onUpgradeOutcome(outcome) {
    const typedOutcome: ChatWebSocketUpgradeOutcome = outcome;
    const status: ChatWebSocketUpgradeOutcomeStatus = outcome.status;
    const durationMs: number = outcome.durationMs;
    const tenantId: string | undefined = outcome.tenantId;
    const userId: string | undefined = outcome.userId;
    // @ts-expect-error Upgrade outcome fields are immutable.
    outcome.status = "accepted";
    // @ts-expect-error Trusted outcome identity is immutable.
    outcome.tenantId = "client-authored-tenant";
    void [typedOutcome, status, durationMs, tenantId, userId];
  },
  onSession(socket, session) {
    const typedSocket: WebSocket = socket;
    const typedSession: ChatWebSocketSession<Capability, Feature> = session;
    const capability: Capability | undefined = session.capabilities[0];

    // @ts-expect-error Trusted session identity is immutable.
    session.actor.userId = "client-authored-user";
    // @ts-expect-error Trusted capabilities expose no mutable operations.
    session.capabilities.push("message.send");
    // @ts-expect-error Negotiated metadata is immutable.
    session.metadata.protocolVersion = 999;
    const subscriptionCount: number = session.subscriptions.size;
    const subscribed: boolean = session.subscriptions.has("conversation-1");
    // @ts-expect-error The subscription registry exposes no caller-controlled add.
    session.subscriptions.add("conversation-1");
    void [typedSocket, typedSession, capability, subscriptionCount, subscribed];
  },
} satisfies ChatWebSocketOptions<Capability, Feature>;

const upgradeOutcomeStatuses: readonly ChatWebSocketUpgradeOutcomeStatus[] = [
  "accepted",
  "admission_denied",
  "authentication_failed",
  "authorization_failed",
  "malformed_handshake",
  "handshake_timeout",
  "unsupported_protocol",
  "snapshot_required",
  "connection_limit",
  "internal_error",
];
// @ts-expect-error The public status union is closed.
const unsupportedUpgradeOutcomeStatus: ChatWebSocketUpgradeOutcomeStatus =
  "other";

const synchronousUpgradeOutcomeObserver: ChatWebSocketUpgradeOutcomeObserver =
  () => undefined;
const asynchronousUpgradeOutcomeObserver: ChatWebSocketUpgradeOutcomeObserver =
  async () => undefined;

const boundedUpgradeOutcome: ChatWebSocketUpgradeOutcome = {
  status: "accepted",
  durationMs: 3,
  tenantId: "tenant" as never,
  userId: "user" as never,
};
const outcomeWithSensitiveField: ChatWebSocketUpgradeOutcome = {
  status: "internal_error",
  durationMs: 3,
  // @ts-expect-error Outcomes cannot carry arbitrary sensitive fields.
  authorization: "Bearer secret",
};
const invalidUpgradeClock = {
  // @ts-expect-error The monotonic clock must return a number synchronously.
  now: async () => 10,
} satisfies ChatWebSocketOptions;

const authenticationCloseCode: 4401 =
  CHAT_WEBSOCKET_CLOSE_REASONS.authenticationFailed.code;
const authenticationCloseReason: "authentication_failed" =
  CHAT_WEBSOCKET_CLOSE_REASONS.authenticationFailed.reason;

declare const accepted: ChatWebSocketSessionAcceptedMessage<Feature>;
const acceptedType: "chat.session.accepted" = accepted.type;
declare const snapshotRequired: ChatWebSocketSnapshotRequiredMessage<Feature>;
const snapshotRequiredType: "chat.session.snapshot_required" =
  snapshotRequired.type;
const replayLimit: number = DEFAULT_CHAT_WEBSOCKET_MAX_REPLAY_EVENTS;
declare const subscribed: ChatWebSocketSubscriptionAcceptedMessage;
const subscribedType: "chat.subscription.accepted" = subscribed.type;
const subscribedConstant: "chat.subscription.accepted" =
  CHAT_WEBSOCKET_SUBSCRIPTION_MESSAGE_TYPES.subscribed;

declare const database: Pool;

const webSocketAdmission = {
  async admit(input) {
    const typedInput: ChatRequestAdmissionInput<IncomingMessage> = input;
    const request: IncomingMessage = input.request;
    const method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" =
      input.method;
    const routeTemplate: ChatRequestAdmissionInput<IncomingMessage>["routeTemplate"] =
      input.routeTemplate;
    void [typedInput, request, method, routeTemplate];
    return { decision: "allow" };
  },
} satisfies ChatRequestAdmissionAdapter<IncomingMessage>;

const webSocketAdmissionInput: ChatRequestAdmissionInput<IncomingMessage> = {
  request: {} as IncomingMessage,
  method: "GET",
  routeTemplate: "/_realtime",
};
const webSocketAdmissionDenial: ChatRequestAdmissionOutcome = {
  decision: "deny",
  retryAfterSeconds: 30,
};
const invalidWebSocketAdmissionOutcome: ChatRequestAdmissionOutcome = {
  decision: "allow",
  // @ts-expect-error Admission outcomes are closed and allow has no extra fields.
  retryAfterSeconds: 30,
};

const runtime = createChatServer<IncomingMessage, Capability>({
  database: { pool: database },
  admission: webSocketAdmission,
  auth: {
    async resolveActor(request) {
      void request;
      return {
        tenantId: "tenant" as never,
        userId: "user" as never,
        roles: [],
      };
    },
    async revalidateActiveSession({ request, actor }) {
      const typedRequest: IncomingMessage = request;
      void typedRequest;
      return actor;
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
      return ["message.read"];
    },
    async authorizeEntity() {
      return true;
    },
  },
  webSocket: webSocketOptions,
});

const sessionCount: number = runtime.webSocketSessionCount;
const subscriptionCount: number = runtime.webSocketSubscriptionCount;
const revalidation: Promise<number> = runtime.revalidateWebSocketSubscriptions({
  tenantId: "tenant" as never,
  userId: "user" as never,
  streamId: "conversation-1" as never,
});
runtime.detachWebSocket();

void [
  authenticationCloseCode,
  authenticationCloseReason,
  acceptedType,
  snapshotRequiredType,
  replayLimit,
  subscribedType,
  subscribedConstant,
  sessionCount,
  subscriptionCount,
  revalidation,
  webSocketAdmissionInput,
  webSocketAdmissionDenial,
  invalidWebSocketAdmissionOutcome,
  upgradeOutcomeStatuses,
  unsupportedUpgradeOutcomeStatus,
  synchronousUpgradeOutcomeObserver,
  asynchronousUpgradeOutcomeObserver,
  boundedUpgradeOutcome,
  outcomeWithSensitiveField,
  invalidUpgradeClock,
];
