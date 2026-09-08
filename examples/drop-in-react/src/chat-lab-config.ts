import {
  createNormalizedChatCache,
  type CreateChatClientConfig,
  type ChatRealtimeSessionState,
  type ApplicationChatStorageIdentity,
} from "@handrail/chat/client";
import type { HuddleControlsPermissions } from "@handrail/chat/ui";

import { createChatLabReplyStorage } from "./chat-lab-reply-storage";

type ChatLabCacheIdentity = NonNullable<
  Parameters<typeof createNormalizedChatCache>[0]
>;

const allowedMemberManagementAvailability = Object.freeze({
  canView: true,
  canAddMember: () => true,
  canRemoveMember: () => true,
  canChangeMemberRole: () => true,
});

const deniedMemberManagementAvailability = Object.freeze({ canView: false });

const hostHuddlePermissions = Object.freeze({
  ada: Object.freeze({
    canStart: true,
    canJoin: true,
    canLeave: true,
    canControlMicrophone: true,
    canShareScreen: true,
    canSelectDevices: true,
    canRetry: true,
    canRejoin: true,
    canEnd: true,
  }) satisfies HuddleControlsPermissions,
  grace: Object.freeze({
    canStart: false,
    canJoin: true,
    canLeave: true,
    canControlMicrophone: true,
    canShareScreen: true,
    canSelectDevices: true,
    canRetry: true,
    canRejoin: true,
    canEnd: false,
  }) satisfies HuddleControlsPermissions,
  margaret: Object.freeze({
    canStart: false,
    canJoin: true,
    canLeave: true,
    canControlMicrophone: true,
    canShareScreen: false,
    canSelectDevices: true,
    canRetry: true,
    canRejoin: true,
    canEnd: false,
  }) satisfies HuddleControlsPermissions,
});

export const chatLabActors = Object.freeze([
  Object.freeze({
    id: "ada",
    displayName: "Ada Lovelace",
    role: "Product",
    creationAvailability: Object.freeze({
      channel: Object.freeze({ canCreate: true }),
      direct: Object.freeze({ canCreate: true }),
      groupDirect: Object.freeze({ canCreate: true }),
    }),
    memberManagementAvailability: allowedMemberManagementAvailability,
    huddlePermissions: hostHuddlePermissions.ada,
  }),
  Object.freeze({
    id: "grace",
    displayName: "Grace Hopper",
    role: "Engineering",
    creationAvailability: Object.freeze({
      channel: Object.freeze({ canCreate: true }),
      direct: Object.freeze({ canCreate: true }),
      groupDirect: Object.freeze({ canCreate: true }),
    }),
    memberManagementAvailability: deniedMemberManagementAvailability,
    huddlePermissions: hostHuddlePermissions.grace,
  }),
  Object.freeze({
    id: "margaret",
    displayName: "Margaret Hamilton",
    role: "Flight software",
    creationAvailability: Object.freeze({
      channel: Object.freeze({ canCreate: true }),
      direct: Object.freeze({ canCreate: true }),
      groupDirect: Object.freeze({ canCreate: true }),
    }),
    memberManagementAvailability: deniedMemberManagementAvailability,
    huddlePermissions: hostHuddlePermissions.margaret,
  }),
]);

export const replyStyleLabActors = Object.freeze([
  { ...chatLabActors[0]!, id: "alice", displayName: "Alice", role: "Launch planning" },
  { ...chatLabActors[0]!, id: "bob", displayName: "Bob", role: "Launch planning" },
  { ...chatLabActors[1]!, id: "carol", displayName: "Carol", role: "No saved reply preference" },
  { ...chatLabActors[1]!, id: "dave", displayName: "Dave", role: "Observer — denied thread actions",
    creationAvailability: {
      channel: { canCreate: false }, direct: { canCreate: false }, groupDirect: { canCreate: false },
    },
  },
] as const);

export type ChatLabActorId = (typeof chatLabActors)[number]["id"] | (typeof replyStyleLabActors)[number]["id"];

export const isChatLabActorId = (value: string): value is ChatLabActorId =>
  [...chatLabActors, ...replyStyleLabActors].some(({ id }) => id === value);

export const createChatLabConfig = (
  actorId: ChatLabActorId,
  onRealtimeStateChange?: (state: ChatRealtimeSessionState) => void,
  instanceId?: string,
): CreateChatClientConfig => ({
  endpoint: "/api/chat",
  ...(replyStyleLabActors.some(({ id }) => id === actorId) ? {
    normalizedCachePersistence: {
      storage: createChatLabReplyStorage(),
      resolveIdentity: () => ({
        tenantId: "chat-lab" as ChatLabCacheIdentity["tenantId"],
        userId: actorId as ChatLabCacheIdentity["userId"],
        deviceId: `reply-styles:${instanceId ?? "local"}` as ApplicationChatStorageIdentity["deviceId"],
      }),
    },
  } : {}),
  cache: createNormalizedChatCache({
    tenantId: "chat-lab" as ChatLabCacheIdentity["tenantId"],
    userId: actorId as ChatLabCacheIdentity["userId"],
    sessionId: `test-session:chat-lab:${actorId}${
      instanceId === undefined ? "" : `:${instanceId}`
    }` as ChatLabCacheIdentity["sessionId"],
  }),
  // Keep search in the public client transport; the host only tunes its debounce.
  messageSearch: { debounceMs: 100 },
  // Keep actor-private preference projections on the same fixed clock as the
  // real-stack Chat Lab harness; canonical state still comes from PostgreSQL.
  conversationPreferences: {
    now: () => Date.parse("2026-08-28T12:00:00.000Z"),
  },
  // Default demos coordinate same-actor tabs. The opt-in scenario uses independent
  // tab-local storage and sessions, so it does not elect a cross-tab writer.
  ...(replyStyleLabActors.some(({ id }) => id === actorId) ? {} : { crossTab: {
    sessionFingerprint: `chat-lab:actor:${actorId}${
      instanceId === undefined ? "" : `:${instanceId}`
    }`,
  } }),
  // The SDK owns the socket, authentication, replay, snapshot hydration, and
  // lifecycle. Chat Lab observes only the public managed-session state.
  realtime: {
    ...(onRealtimeStateChange === undefined
      ? {}
      : { onStateChange: onRealtimeStateChange }),
  },
  async getAccessToken() {
    const response = await fetch(
      `/__chat-lab/session?actor=${encodeURIComponent(actorId)}`,
      { credentials: "same-origin" },
    );
    if (!response.ok) {
      throw new Error("The chat lab session is unavailable.");
    }
    return response.text();
  },
});
