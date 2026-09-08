import type {
  ChatDirectoryAdapter,
  ChatDirectoryLookupResult,
  ChatDirectorySearchPage,
  ChatPermissionAdapter,
  ChatRealtimePolicyAction,
  TrustedChatActorContext,
} from "../src/server/index.js";
import type { TenantId, UserId } from "../src/index.js";

const actor: TrustedChatActorContext = {
  tenantId: "tenant-a" as TenantId,
  userId: "actor-a" as UserId,
  roles: ["employee"],
};

const explicitOutcomes: readonly ChatDirectoryLookupResult[] = [
  {
    tenantId: actor.tenantId,
    userId: "active" as UserId,
    kind: "active",
    displayName: "Active User",
    avatar: { kind: "initials", initials: "AU" },
    status: { availability: "online" },
  },
  {
    tenantId: actor.tenantId,
    userId: "redacted" as UserId,
    kind: "redacted",
  },
  {
    tenantId: actor.tenantId,
    userId: "missing" as UserId,
    kind: "unavailable",
    reason: "missing",
  },
];

const page: ChatDirectorySearchPage = {
  users: explicitOutcomes,
  continuation: "opaque-provider-page-2",
};

const adapter: ChatDirectoryAdapter = {
  async getUser({ actor: trustedActor, userId }) {
    return {
      tenantId: trustedActor.tenantId,
      userId,
      kind: "unavailable",
      reason: "temporarily_unavailable",
    };
  },
  async searchUsers({ actor: trustedActor, continuation, limit }) {
    const trustedTenant: TenantId = trustedActor.tenantId;
    const providerContinuation: string | undefined = continuation;
    const boundedLimit: number | undefined = limit;
    void [trustedTenant, providerContinuation, boundedLimit];
    return page;
  },
};

const legacyAdapter: ChatDirectoryAdapter = {
  async getUser({ actor: trustedActor, userId }) {
    return {
      tenantId: trustedActor.tenantId,
      userId,
      displayName: "Legacy active user",
      avatarUrl: "/avatars/legacy",
    };
  },
  async searchUsers() {
    return [];
  },
};

const permissions: ChatPermissionAdapter<"chat.read", "invoice.read"> = {
  async getCapabilities() {
    return ["chat.read"];
  },
  async authorizeEntity({ action }) {
    const policyAction:
      | "invoice.read"
      | "directory.lookup"
      | "directory.search"
      | ChatRealtimePolicyAction = action;
    void policyAction;
    return true;
  },
};

const redactedWithProfile: ChatDirectoryLookupResult = {
  tenantId: actor.tenantId,
  userId: "redacted" as UserId,
  kind: "redacted",
  // @ts-expect-error Redacted adapter outcomes cannot supply profile fallback data.
  displayName: "Private name",
};

const unavailableWithAvatar: ChatDirectoryLookupResult = {
  tenantId: actor.tenantId,
  userId: "missing" as UserId,
  kind: "unavailable",
  reason: "missing",
  // @ts-expect-error Unavailable outcomes cannot supply avatar fallback data.
  avatarUrl: "/avatars/missing",
};

void [
  adapter,
  legacyAdapter,
  permissions,
  redactedWithProfile,
  unavailableWithAvatar,
];
