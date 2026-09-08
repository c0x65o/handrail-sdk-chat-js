import type { HostEntityReference } from "../contracts/conversation.js";
import { authorizeThreadAccess } from "./thread-access.js";
import type {
  ConversationId,
  TenantId,
  UserId,
} from "../contracts/identifiers.js";
import {
  CHAT_REALTIME_SUBSCRIPTION_ERROR_CODES,
  CHAT_REALTIME_SUBSCRIPTION_MESSAGE_TYPES,
  type ChatRealtimeSubscribeRequest,
  type ChatRealtimeSubscriptionAcceptedMessage,
  type ChatRealtimeSubscriptionErrorCode,
  type ChatRealtimeSubscriptionRejectedMessage,
  type ChatRealtimeSubscriptionRemovedMessage,
  type ChatRealtimeSubscriptionRequest,
  type ChatRealtimeSubscriptionRevokedMessage,
  type ChatRealtimeSubscriptionServerMessage,
  type ChatRealtimeUnsubscribeRequest,
  type ChatRealtimeUserStreamId,
} from "../contracts/realtime.js";
import type {
  ChatPermissionAdapter,
  TrustedChatActorContext,
} from "./contracts.js";
import {
  DEFAULT_POSTGRES_SCHEMA,
  validatePostgresSchema,
  type PostgresMigrationDatabase,
} from "./postgres-migrations.js";

export const CHAT_WEBSOCKET_SUBSCRIPTION_POLICY_ACTION =
  "conversation.subscribe" as const;

export const CHAT_WEBSOCKET_SUBSCRIPTION_MESSAGE_TYPES =
  CHAT_REALTIME_SUBSCRIPTION_MESSAGE_TYPES;
export const CHAT_WEBSOCKET_SUBSCRIPTION_ERROR_CODES =
  CHAT_REALTIME_SUBSCRIPTION_ERROR_CODES;

export type ChatWebSocketSubscriptionErrorCode =
  ChatRealtimeSubscriptionErrorCode;

export type ChatWebSocketUserStreamId = ChatRealtimeUserStreamId;
export type ChatWebSocketStreamId = ConversationId | ChatWebSocketUserStreamId;

export type ChatWebSocketSubscribeRequest = ChatRealtimeSubscribeRequest;
export type ChatWebSocketUnsubscribeRequest = ChatRealtimeUnsubscribeRequest;
export type ChatWebSocketSubscriptionRequest = ChatRealtimeSubscriptionRequest;
export type ChatWebSocketSubscriptionAcceptedMessage =
  ChatRealtimeSubscriptionAcceptedMessage;
export type ChatWebSocketSubscriptionRemovedMessage =
  ChatRealtimeSubscriptionRemovedMessage;
export type ChatWebSocketSubscriptionRejectedMessage =
  ChatRealtimeSubscriptionRejectedMessage;
export type ChatWebSocketSubscriptionRevokedMessage =
  ChatRealtimeSubscriptionRevokedMessage;
export type ChatWebSocketSubscriptionServerMessage =
  ChatRealtimeSubscriptionServerMessage;

/** Read-only per-session registry exposed to trusted server session handlers. */
export interface ChatWebSocketSessionSubscriptions {
  readonly size: number;
  readonly streamIds: readonly ChatWebSocketStreamId[];
  has(streamId: string): boolean;
  /** Rechecks all currently authorized streams and returns the number revoked. */
  revalidate(): Promise<number>;
}

/** Narrows host-observed access changes to affected authenticated sessions. */
export interface ChatWebSocketSubscriptionRevalidationScope {
  readonly tenantId?: TenantId;
  readonly userId?: UserId;
  readonly streamId?: ChatWebSocketStreamId;
}

export interface ChatWebSocketStreamAuthorizationOptions {
  readonly database: PostgresMigrationDatabase;
  readonly permissions: Pick<
    ChatPermissionAdapter<
      string,
      typeof CHAT_WEBSOCKET_SUBSCRIPTION_POLICY_ACTION
    >,
    "authorizeEntity"
  >;
  readonly actor: TrustedChatActorContext;
  readonly streamId: ChatWebSocketStreamId;
  readonly schema?: string;
}

interface StoredConversationSubscriptionRow {
  readonly type: string;
  readonly visibility: string;
  readonly entity_type: string | null;
  readonly entity_id: string | null;
  readonly archived_at: Date | string | null;
  readonly member_state: string | null;
}

export type ChatWebSocketStreamAuthorization =
  | Readonly<{ authorized: true; kind: "user" | "conversation" }>
  | Readonly<{ authorized: false }>;

const quoteIdentifier = (identifier: string): string =>
  `"${identifier.replaceAll('"', '""')}"`;

/**
 * Authorizes one canonical stream using only immutable trusted actor scope.
 * Missing, archived, malformed, adapter-failed, and inaccessible rows all
 * collapse to the same safe denial result.
 */
export async function authorizeChatWebSocketStream(
  options: ChatWebSocketStreamAuthorizationOptions,
): Promise<ChatWebSocketStreamAuthorization> {
  const expectedUserStream = `user:${options.actor.userId}`;
  if (options.streamId.startsWith("user:")) {
    return options.streamId === expectedUserStream
      ? Object.freeze({ authorized: true, kind: "user" })
      : Object.freeze({ authorized: false });
  }

  const schema = validatePostgresSchema(
    options.schema ?? DEFAULT_POSTGRES_SCHEMA,
  );
  const prefix = quoteIdentifier(schema);
  let rows: readonly StoredConversationSubscriptionRow[];
  try {
    const result = await options.database.query<StoredConversationSubscriptionRow>(
      `SELECT
         conversation.type,
         conversation.visibility,
         conversation.entity_type,
         conversation.entity_id,
         conversation.archived_at,
         current_member.state AS member_state
       FROM ${prefix}.chat_conversations AS conversation
       LEFT JOIN ${prefix}.chat_conversation_members AS current_member
         ON current_member.tenant_id = conversation.tenant_id
        AND current_member.conversation_id = conversation.id
        AND current_member.user_id = $3
       WHERE conversation.tenant_id = $1
         AND conversation.id = $2
       LIMIT 1`,
      [options.actor.tenantId, options.streamId, options.actor.userId],
    );
    rows = result.rows;
  } catch {
    return Object.freeze({ authorized: false });
  }

  const row = rows[0];
  if (row === undefined || row.archived_at !== null) {
    return Object.freeze({ authorized: false });
  }

  if (
    !["channel", "direct", "group_direct", "thread"].includes(row.type) ||
    !["public", "private"].includes(row.visibility) ||
    ((row.type === "direct" || row.type === "group_direct") &&
      row.visibility !== "private")
  ) {
    return Object.freeze({ authorized: false });
  }

  if (row.type === "thread") {
    try {
      const access = await authorizeThreadAccess({
        database: options.database,
        actor: options.actor,
        threadId: options.streamId,
        schema,
        operation: "read",
        entityAction: CHAT_WEBSOCKET_SUBSCRIPTION_POLICY_ACTION,
        permissions: {
          authorizeEntity: async (input) =>
            await options.permissions.authorizeEntity(input) === true,
        },
      });
      // The shared read guard permits archived metadata; subscriptions do not.
      return access.isArchived
        ? Object.freeze({ authorized: false })
        : Object.freeze({ authorized: true, kind: "conversation" });
    } catch {
      return Object.freeze({ authorized: false });
    }
  }

  const visible =
    (row.type === "channel" && row.visibility === "public") ||
    row.member_state === "active";
  if (!visible) {
    return Object.freeze({ authorized: false });
  }

  if (row.entity_type !== null || row.entity_id !== null) {
    if (row.entity_type === null || row.entity_id === null) {
      return Object.freeze({ authorized: false });
    }
    const entity: HostEntityReference = {
      type: row.entity_type,
      id: row.entity_id,
    };
    let authorized = false;
    try {
      authorized = await options.permissions.authorizeEntity({
        actor: options.actor,
        entity,
        action: CHAT_WEBSOCKET_SUBSCRIPTION_POLICY_ACTION,
      });
    } catch {
      return Object.freeze({ authorized: false });
    }
    if (authorized !== true) {
      return Object.freeze({ authorized: false });
    }
  }

  return Object.freeze({ authorized: true, kind: "conversation" });
}
