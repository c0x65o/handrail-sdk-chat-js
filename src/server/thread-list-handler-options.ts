import type { ConversationId, TenantId } from "../contracts/identifiers.js";

/** Shared host scope. Never pass an actor, request or saved reply style. */
export interface ChatThreadInactivityPolicyScope {
  readonly tenantId: TenantId;
  readonly parentConversationId: ConversationId;
}

/** false disables hiding; hideAfterMs must be a finite number greater than zero. */
export type ChatThreadInactivityPolicy = false | Readonly<{ hideAfterMs: number }>;

export type ChatThreadInactivityPolicyResolver = (
  scope: ChatThreadInactivityPolicyScope,
) => ChatThreadInactivityPolicy | Promise<ChatThreadInactivityPolicy>;

/** Server-only integration boundary for the future authorized thread-list handler. */
export interface ChatThreadListHandlerOptions {
  /**
   * Resolve per list request, after establishing trusted tenant and parent access.
   * Invalid configuration/results and callback failures resolve to false.
   * Apply only to discovery, using latest persisted thread message created_at,
   * or thread created_at for an empty thread. Never use conversation.updated_at.
   * This does not authorize access or mutate lifecycle/private state.
   */
  readonly resolveInactivityPolicy: (
    scope: ChatThreadInactivityPolicyScope,
  ) => Promise<ChatThreadInactivityPolicy>;
}

/** Internal construction helper; only types are exported from the server entry. */
export function createThreadListHandlerOptions(
  configured: unknown,
): ChatThreadListHandlerOptions {
  return Object.freeze({
    async resolveInactivityPolicy(
      scope: ChatThreadInactivityPolicyScope,
    ): Promise<ChatThreadInactivityPolicy> {
      if (typeof configured !== "function") return false;
      try {
        // Copy only shared identifiers, even if a JavaScript caller supplies extras.
        const result: unknown = await configured(Object.freeze({
          tenantId: scope.tenantId,
          parentConversationId: scope.parentConversationId,
        }));
        if (typeof result !== "object" || result === null || Array.isArray(result)) {
          return false;
        }
        const keys = Object.keys(result);
        if (keys.length !== 1 || keys[0] !== "hideAfterMs") return false;
        const hideAfterMs = (result as Record<string, unknown>).hideAfterMs;
        if (
          typeof hideAfterMs !== "number" ||
          !Number.isFinite(hideAfterMs) ||
          hideAfterMs <= 0
        ) {
          return false;
        }
        return Object.freeze({ hideAfterMs });
      } catch {
        // Availability/configuration failures must never activate hiding.
        return false;
      }
    },
  });
}
