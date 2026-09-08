import { createHash, randomUUID } from "node:crypto";
import { validateThreadLifecycle, type ThreadLifecycle } from "../contracts/conversation.js";

import {
  parseSendMessageInput,
  parseSendMessageResult,
  type SendMessageInput,
  type SendMessageResult,
} from "../contracts/message-mutations.js";
import type {
  Message,
  MessageBlock,
  MessageContent,
} from "../contracts/message.js";
import { CHAT_PROTOCOL_VERSION } from "../contracts/realtime.js";
import type {
  IsoTimestamp,
  MessageId,
  MessageSequence,
  TenantId,
  UserId,
} from "../contracts/identifiers.js";
import type {
  ChatDirectoryAdapter,
  ChatPermissionAdapter,
  TrustedChatActorContext,
} from "./contracts.js";
import {
  DEFAULT_POSTGRES_SCHEMA,
  validatePostgresSchema,
  type PostgresMigrationConnection,
  type PostgresMigrationDatabase,
} from "./postgres-migrations.js";
import { ChatAuthorizationError } from "./request-context.js";
import { authorizeThreadAccess } from "./thread-access.js";
import { ensureThreadParticipant } from "./thread-participant.js";
import { selectRootThreadSummary } from "./thread-summary-query.js";

export const SEND_MESSAGE_CAPABILITY = "message.send" as const;
export const SEND_MESSAGE_ENTITY_POLICY_ACTION = "message.send" as const;
export const SEND_MESSAGE_IDEMPOTENCY_OPERATION = "message.send" as const;
export const DEFAULT_SEND_MESSAGE_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_SEND_MESSAGE_OUTBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export type SendMessageCommandErrorCode =
  | "idempotency_conflict"
  | "idempotency_in_progress"
  | "invalid_mention"
  | "invalid_reply_source"
  | "revision_exhausted"
  | "attachment_unavailable";

/** Stable command failure that is safe to translate at a future HTTP boundary. */
export class SendMessageCommandError extends Error {
  public readonly statusCode: number;

  public constructor(
    public readonly code: SendMessageCommandErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SendMessageCommandError";
    this.statusCode = code.startsWith("idempotency_") || code === "revision_exhausted" ? 409 : 422;
  }
}

export interface SendMessageCommandOptions<
  Block extends MessageBlock = MessageBlock,
> {
  readonly database: PostgresMigrationDatabase;
  readonly directory: Pick<ChatDirectoryAdapter, "getUser">;
  readonly permissions: Pick<
    ChatPermissionAdapter<string, typeof SEND_MESSAGE_ENTITY_POLICY_ACTION>,
    "getCapabilities" | "authorizeEntity" | "authorizeThreadSend"
  >;
  /** Trusted host-session identity; caller input cannot override these values. */
  readonly actor: TrustedChatActorContext;
  /** JSON-decoded caller input, validated by the shared mutation contract. */
  readonly input: unknown;
  readonly schema?: string;
  readonly idempotencyTtlMs?: number;
  readonly outboxRetentionMs?: number;
  /** Trusted transport correlation id used only by the existing audit record. */
  readonly requestId?: string;
  /** Supplies opaque durable identifiers; defaults to cryptographic UUIDs. */
  readonly createId?: () => string;
}

interface ClaimedIdempotencyRow {
  readonly idempotency_state: string;
  readonly stored_response_body: unknown | null;
}

interface AllocatedConversationRow {
  readonly parent_conversation_id: string | null;
  readonly root_message_id: string | null;
  readonly sequence: string | number;
  readonly occurred_at: Date | string;
  readonly entity_type: string | null;
  readonly entity_id: string | null;
}

interface StoredAttachmentRow {
  readonly id: string;
}

const quoteIdentifier = (identifier: string): string =>
  `"${identifier.replaceAll('"', '""')}"`;

const positiveSafeInteger = (value: unknown, label: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value as number;
};

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const validateActor = (actor: TrustedChatActorContext): void => {
  if (
    !nonEmptyString(actor.tenantId) ||
    !nonEmptyString(actor.userId) ||
    !Array.isArray(actor.roles) ||
    !actor.roles.every(nonEmptyString)
  ) {
    throw new TypeError("A valid trusted chat actor is required");
  }
};

const validateCapabilities = (value: unknown): readonly string[] => {
  if (!Array.isArray(value) || !value.every(nonEmptyString)) {
    throw new ChatAuthorizationError();
  }
  return value;
};

const requireSendCapability = async (
  actor: TrustedChatActorContext,
  permissions: SendMessageCommandOptions["permissions"],
): Promise<readonly string[]> => {
  let capabilities: readonly string[];
  try {
    capabilities = validateCapabilities(
      await permissions.getCapabilities({ actor }),
    );
  } catch {
    throw new ChatAuthorizationError();
  }
  if (!capabilities.includes(SEND_MESSAGE_CAPABILITY)) {
    throw new ChatAuthorizationError();
  }
  return capabilities;
};

const validateUserMentions = async <Block extends MessageBlock>(
  content: MessageContent<Block>,
  actor: TrustedChatActorContext,
  directory: Pick<ChatDirectoryAdapter, "getUser">,
): Promise<void> => {
  const userIds = [
    ...new Set(
      (content.mentions ?? [])
        .filter((mention) => mention.type === "user")
        .map((mention) => mention.userId),
    ),
  ];

  try {
    const users = await Promise.all(
      userIds.map((userId) => directory.getUser({ actor, userId })),
    );
    const valid = users.every((user, index) => {
      const userId = userIds[index];
      return (
        user !== null &&
        user.kind !== "redacted" &&
        user.kind !== "unavailable" &&
        user.tenantId === actor.tenantId &&
        user.userId === userId
      );
    });
    if (!valid) {
      throw new Error("invalid mention");
    }
  } catch {
    throw new SendMessageCommandError(
      "invalid_mention",
      "One or more mentioned users are unavailable",
    );
  }
};

const canonicalJson = (value: unknown, ancestors = new Set<object>()): string => {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Message content must contain finite JSON numbers");
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new TypeError("Message content must be JSON-compatible");
  }
  if (ancestors.has(value)) {
    throw new TypeError("Message content must not contain cycles");
  }
  const prototype = Object.getPrototypeOf(value);
  if (
    !Array.isArray(value) &&
    prototype !== Object.prototype &&
    prototype !== null
  ) {
    throw new TypeError("Message content must contain only JSON objects and arrays");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => canonicalJson(entry, ancestors)).join(",")}]`;
    }
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(object[key], ancestors)}`,
      )
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
};

const hashRequest = <Block extends MessageBlock>(
  input: SendMessageInput<Block>,
): string => {
  const canonical = canonicalJson({
    operation: input.operation,
    conversationId: input.conversationId,
    clientMessageId: input.clientMessageId,
    content: input.content,
    // Preserve the historical canonical shape for plain-send retries.
    ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
};

const toIsoTimestamp = (value: Date | string): IsoTimestamp => {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.valueOf())) {
    throw new Error("PostgreSQL returned an invalid message timestamp");
  }
  return date.toISOString() as IsoTimestamp;
};

const toMessageSequence = (value: string | number): MessageSequence => {
  const sequence = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error("PostgreSQL returned an invalid message sequence");
  }
  return sequence as MessageSequence;
};

const replayStoredResult = <Block extends MessageBlock>(
  stored: unknown,
): SendMessageResult<Block> => {
  const canonical = parseSendMessageResult<Block>(stored);
  return parseSendMessageResult<Block>({
    ...canonical,
    reconciliationStatus: "replayed",
  });
};

const rollback = async (
  connection: PostgresMigrationConnection,
): Promise<void> => {
  await connection.query("ROLLBACK").catch(() => undefined);
};

const lockDestinationAccess = async (
  connection: PostgresMigrationConnection,
  prefix: string,
  schema: string,
  options: SendMessageCommandOptions,
  conversationId: string,
  replay: boolean,
): Promise<{ parentConversationId: string; threadLifecycle: ThreadLifecycle } | undefined> => {
  // Lock parents before children, then memberships. Membership commands also
  // lock their conversation; the explicit member locks cover direct revocation.
  const parents = await connection.query<{ id: string }>(
    `SELECT id FROM ${prefix}.chat_conversations
     WHERE tenant_id = $1 AND id = (
       SELECT parent_conversation_id FROM ${prefix}.chat_conversations
       WHERE tenant_id = $1 AND id = $2
     ) FOR UPDATE`,
    [options.actor.tenantId, conversationId],
  );
  const locked = await connection.query<{
    type: string; parent_conversation_id: string | null;
    closed_at: Date | string | null; closed_by_user_id: string | null;
    locked: boolean; lifecycle_revision: string | number; occurred_at: Date | string;
  }>(
    `SELECT type, parent_conversation_id, closed_at, closed_by_user_id,
            locked, lifecycle_revision, clock_timestamp() AS occurred_at
     FROM ${prefix}.chat_conversations WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [options.actor.tenantId, conversationId],
  );
  const destination = locked.rows[0];
  // Historical plain-send acknowledgements retain their reconciliation behavior.
  if (replay && destination?.type !== "thread") return;
  if (destination === undefined) throw new ChatAuthorizationError();
  if (destination.type === "thread" &&
      destination.parent_conversation_id !== parents.rows[0]?.id) throw new ChatAuthorizationError();
  // Take write locks up front, parent before child, rather than upgrading SHARE
  // after participant initialization has acquired FK key-share locks.
  const memberships = await connection.query<{ conversation_id: string; state: string }>(
    `SELECT conversation_id, state FROM ${prefix}.chat_conversation_members
     WHERE tenant_id = $1 AND conversation_id = ANY($2::text[]) AND user_id = $3
     ORDER BY (conversation_id = $4), conversation_id
     FOR UPDATE`,
    [options.actor.tenantId, [...parents.rows.map(({ id }) => id), conversationId], options.actor.userId, conversationId],
  );
  const activeParticipant = memberships.rows.some((row) =>
    row.conversation_id === conversationId && row.state === "active"
  );
  if (destination.type !== "thread" && !activeParticipant) throw new ChatAuthorizationError();
  if (destination.type === "thread") {
    const common = {
      database: connection, schema, actor: options.actor,
      threadId: conversationId, permissions: options.permissions,
    };
    // A completed send is a read of its accepted outcome, including after the
    // child is archived. Recheck inherited access without reopening or sending.
    const access = await authorizeThreadAccess(replay
      ? { ...common, operation: "read", entityAction: SEND_MESSAGE_ENTITY_POLICY_ACTION }
      : { ...common, operation: "send" });
    if (replay || options.permissions.authorizeThreadSend !== undefined) {
      try {
        // Refresh after lock waits on replay too; the initial capability check
        // cannot stand in for current authority on a completed outcome.
        const capabilities = await requireSendCapability(options.actor, options.permissions);
        if (options.permissions.authorizeThreadSend !== undefined &&
            await options.permissions.authorizeThreadSend({
          actor: options.actor, threadId: conversationId,
          parentConversationId: access.parentConversationId, capabilities,
        }) !== true) throw new ChatAuthorizationError();
      } catch {
        throw new ChatAuthorizationError();
      }
    }
    // A replay acknowledges the original outcome even if later closed/locked.
    // It never initializes participation or changes lifecycle/activity.
    if (replay) return;
    const before = validateThreadLifecycle({
      revision: Number(destination.lifecycle_revision), locked: destination.locked,
      ...(destination.closed_at === null ? {} : {
        closedAt: toIsoTimestamp(destination.closed_at), closedByUserId: destination.closed_by_user_id,
      }),
    });
    if (before.locked) throw new ChatAuthorizationError();
    if (before.closedAt !== undefined && before.revision === Number.MAX_SAFE_INTEGER) {
      throw new SendMessageCommandError("revision_exhausted", "Thread lifecycle revision cannot be advanced safely");
    }
    if (!activeParticipant) {
      await ensureThreadParticipant({
        connection, schema, actor: options.actor, threadId: conversationId,
        parentConversationId: access.parentConversationId,
        entityAction: SEND_MESSAGE_ENTITY_POLICY_ACTION, permissions: options.permissions,
        occurredAt: toIsoTimestamp(destination.occurred_at), initialRole: "member",
      });
    }
    if (before.closedAt !== undefined) {
      const threadLifecycle = validateThreadLifecycle({ revision: before.revision + 1, locked: false });
      const reopened = await connection.query(
        `UPDATE ${prefix}.chat_conversations
         SET closed_at = NULL, closed_by_user_id = NULL, lifecycle_revision = $3
         WHERE tenant_id = $1 AND id = $2 AND lifecycle_revision = $4 AND NOT locked`,
        [options.actor.tenantId, conversationId, threadLifecycle.revision, before.revision],
      );
      if (reopened.rowCount !== 1) throw new Error("Locked thread reopen failed");
      return { parentConversationId: access.parentConversationId, threadLifecycle };
    }
  }
};

/**
 * Authorizes and persists one canonical message and all consistency side effects
 * in a single checked-out PostgreSQL transaction.
 */
export async function sendMessage<Block extends MessageBlock = MessageBlock>(
  options: SendMessageCommandOptions<Block>,
): Promise<SendMessageResult<Block>> {
  validateActor(options.actor);
  const input = parseSendMessageInput<Block>(options.input);
  const schema = validatePostgresSchema(
    options.schema ?? DEFAULT_POSTGRES_SCHEMA,
  );
  const prefix = quoteIdentifier(schema);
  const idempotencyTtlMs = positiveSafeInteger(
    options.idempotencyTtlMs ?? DEFAULT_SEND_MESSAGE_IDEMPOTENCY_TTL_MS,
    "idempotencyTtlMs",
  );
  const outboxRetentionMs = positiveSafeInteger(
    options.outboxRetentionMs ?? DEFAULT_SEND_MESSAGE_OUTBOX_RETENTION_MS,
    "outboxRetentionMs",
  );
  const createId = options.createId ?? randomUUID;
  const requestHash = hashRequest(input);

  await requireSendCapability(options.actor, options.permissions);

  const connection = await options.database.connect();
  let reconciling = false;
  try {
    await connection.query("BEGIN");

    const claim = await connection.query<ClaimedIdempotencyRow>(
      `SELECT *
       FROM ${prefix}.claim_chat_idempotency_key(
         $1, $2, $3, $4, $5,
         clock_timestamp() + ($6::double precision * interval '1 millisecond')
       )`,
      [
        options.actor.tenantId,
        options.actor.userId,
        SEND_MESSAGE_IDEMPOTENCY_OPERATION,
        input.idempotencyKey,
        requestHash,
        idempotencyTtlMs,
      ],
    );
    const claimed = claim.rows[0];
    if (claimed === undefined) {
      throw new SendMessageCommandError(
        "idempotency_conflict",
        "The idempotency key was already used for a different request",
      );
    }
    if (claimed.idempotency_state === "completed") {
      reconciling = true;
      if (claimed.stored_response_body === null) {
        throw new Error("Completed send-message outcome has no response body");
      }
      const replay = replayStoredResult<Block>(claimed.stored_response_body);
      await lockDestinationAccess(connection, prefix, schema, options, input.conversationId, true);
      await connection.query("COMMIT");
      return replay;
    }
    if (claimed.idempotency_state !== "pending") {
      throw new Error("PostgreSQL returned an invalid idempotency state");
    }

    await validateUserMentions(input.content, options.actor, options.directory);

    const reopened = await lockDestinationAccess(connection, prefix, schema, options, input.conversationId, false);

    if (input.replyTo !== undefined) {
      // Read only identity, never source content. SHARE also blocks soft deletion
      // (unlike KEY SHARE) until this transaction has persisted the reference.
      const source = await connection.query<{ id: string }>(
        `SELECT id FROM ${prefix}.chat_messages
         WHERE tenant_id = $1 AND conversation_id = $2 AND id = $3
           AND deleted_at IS NULL
         FOR SHARE`,
        [options.actor.tenantId, input.conversationId, input.replyTo.messageId],
      );
      if (source.rows.length !== 1) {
        throw new SendMessageCommandError("invalid_reply_source", "The reply source is unavailable");
      }
    }

    const allocation = await connection.query<AllocatedConversationRow>(
      `UPDATE ${prefix}.chat_conversations AS conversation
       SET current_message_sequence = conversation.current_message_sequence + 1,
           updated_at = clock_timestamp()
       FROM ${prefix}.chat_conversation_members AS member
       WHERE conversation.tenant_id = $1
         AND conversation.id = $2
         AND conversation.archived_at IS NULL
         AND conversation.current_message_sequence < 9007199254740991
         AND member.tenant_id = conversation.tenant_id
         AND member.conversation_id = conversation.id
         AND member.user_id = $3
         AND member.state = 'active'
       RETURNING
         conversation.current_message_sequence AS sequence,
         conversation.updated_at AS occurred_at,
         conversation.parent_conversation_id,
         conversation.root_message_id,
         conversation.entity_type,
         conversation.entity_id`,
      [options.actor.tenantId, input.conversationId, options.actor.userId],
    );
    const conversation = allocation.rows[0];
    if (conversation === undefined) {
      throw new ChatAuthorizationError();
    }

    if (conversation.entity_type !== null && conversation.entity_id !== null) {
      let allowed = false;
      try {
        allowed = await options.permissions.authorizeEntity({
          actor: options.actor,
          entity: {
            type: conversation.entity_type,
            id: conversation.entity_id,
          },
          action: SEND_MESSAGE_ENTITY_POLICY_ACTION,
        });
      } catch {
        throw new ChatAuthorizationError();
      }
      if (!allowed) {
        throw new ChatAuthorizationError();
      }
    }

    const sequence = toMessageSequence(conversation.sequence);
    const occurredAt = toIsoTimestamp(conversation.occurred_at);
    const attachmentIds = (input.content.attachments ?? []).map(
      ({ attachmentId }) => attachmentId,
    );
    if (new Set(attachmentIds).size !== attachmentIds.length) {
      throw new SendMessageCommandError(
        "attachment_unavailable",
        "One or more attachments are unavailable",
      );
    }
    if (attachmentIds.length > 0) {
      const usable = await connection.query<StoredAttachmentRow>(
        `SELECT attachment.id
         FROM ${prefix}.chat_attachments AS attachment
         WHERE attachment.tenant_id = $1
           AND attachment.uploader_user_id = $2
           AND attachment.id = ANY($3::text[])
           AND attachment.state = 'pending'
           AND attachment.checksum IS NOT NULL
           AND attachment.expires_at >= $4
         ORDER BY attachment.id
         FOR UPDATE`,
        [
          options.actor.tenantId,
          options.actor.userId,
          attachmentIds,
          occurredAt,
        ],
      );
      const usableIds = new Set(usable.rows.map(({ id }) => id));
      if (
        usableIds.size !== attachmentIds.length ||
        !attachmentIds.every((id) => usableIds.has(id))
      ) {
        throw new SendMessageCommandError(
          "attachment_unavailable",
          "One or more attachments are unavailable",
        );
      }
    }

    const messageId = createId() as MessageId;
    const message: Message<Block> = {
      id: messageId,
      tenantId: options.actor.tenantId as TenantId,
      conversationId: input.conversationId,
      author: { type: "user", userId: options.actor.userId as UserId },
      sequence,
      createdAt: occurredAt,
      updatedAt: occurredAt,
      revision: { revision: 1 },
      content: input.content,
      ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
    };
    const applied = parseSendMessageResult<Block>({
      operation: "send",
      reconciliationStatus: "applied",
      clientMessageId: input.clientMessageId,
      message,
      canonicalRevision: 1,
    });

    await connection.query(
      `INSERT INTO ${prefix}.chat_messages (
         tenant_id, id, conversation_id, sequence, author_user_id,
         client_message_id, content, current_revision, created_at, updated_at,
         reply_to_message_id, reply_notify_author
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $8, $9, $10)`,
      [
        options.actor.tenantId,
        messageId,
        input.conversationId,
        sequence,
        options.actor.userId,
        input.clientMessageId,
        input.content,
        occurredAt,
        input.replyTo?.messageId ?? null,
        input.replyTo?.notifyAuthor ?? false,
      ],
    );
    await connection.query(
      `INSERT INTO ${prefix}.chat_message_revisions (
         tenant_id, message_id, revision_number, content,
         created_at, created_by_user_id
       )
       VALUES ($1, $2, 1, $3, $4, $5)`,
      [
        options.actor.tenantId,
        messageId,
        input.content,
        occurredAt,
        options.actor.userId,
      ],
    );

    if (attachmentIds.length > 0) {
      const attached = await connection.query(
        `UPDATE ${prefix}.chat_attachments
         SET state = 'attached',
             attached_message_id = $1,
             attached_at = $2,
             updated_at = $2
         WHERE tenant_id = $3
           AND uploader_user_id = $4
           AND id = ANY($5::text[])
           AND state = 'pending'
           AND checksum IS NOT NULL
           AND expires_at >= $2`,
        [
          messageId,
          occurredAt,
          options.actor.tenantId,
          options.actor.userId,
          attachmentIds,
        ],
      );
      if (attached.rowCount !== attachmentIds.length) {
        throw new SendMessageCommandError(
          "attachment_unavailable",
          "One or more attachments are unavailable",
        );
      }
    }

    const auditEventId = createId();
    await connection.query(
      `INSERT INTO ${prefix}.chat_audit_events (
         tenant_id, event_id, actor_user_id, action, target_type, target_id,
         occurred_at, metadata, request_id
       )
       VALUES ($1, $2, $3, 'message.created', 'message', $4, $5, $6, $7)`,
      [
        options.actor.tenantId,
        auditEventId,
        options.actor.userId,
        messageId,
        occurredAt,
        {
          conversationId: input.conversationId,
          sequence,
          attachmentCount: attachmentIds.length,
          userMentionCount: (input.content.mentions ?? []).filter(
            (mention) => mention.type === "user",
          ).length,
        },
        options.requestId ?? auditEventId,
      ],
    );

    const outboxEventId = createId();
    if (reopened !== undefined) {
      const { parentConversationId, threadLifecycle } = reopened;
      for (const event of [
        { streamId: input.conversationId, type: "thread.lifecycle.updated",
          payload: { threadId: input.conversationId, parentConversationId, threadLifecycle } },
        { streamId: parentConversationId, type: "thread.lifecycle.changed",
          payload: { threadId: input.conversationId, parentConversationId, revision: threadLifecycle.revision } },
      ]) {
        await connection.query(
          `INSERT INTO ${prefix}.chat_outbox_events
             (event_id, protocol_version, tenant_id, stream_id, type, occurred_at, payload, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7,
             $6::timestamptz + ($8::double precision * interval '1 millisecond'))`,
          [createId(), CHAT_PROTOCOL_VERSION, options.actor.tenantId, event.streamId,
            event.type, occurredAt, event.payload, outboxRetentionMs],
        );
      }
    }
    await connection.query(
      `INSERT INTO ${prefix}.chat_outbox_events (
         event_id, protocol_version, tenant_id, stream_id, type,
         occurred_at, payload, expires_at
       )
       VALUES (
         $1, $2, $3, $4, 'message.created', $5, $6,
         $5::timestamptz + ($7::double precision * interval '1 millisecond')
       )`,
      [
        outboxEventId,
        CHAT_PROTOCOL_VERSION,
        options.actor.tenantId,
        input.conversationId,
        occurredAt,
        { message: applied.message, clientMessageId: input.clientMessageId },
        outboxRetentionMs,
      ],
    );

    if (
      conversation.parent_conversation_id !== null &&
      conversation.root_message_id !== null
    ) {
      // The sequence allocation holds the thread row lock through commit, so
      // concurrent replies cannot publish summaries with a stale count. Persist
      // this after message.created so both live delivery and replay see the
      // authoritative parent summary after the reply that produced it.
      const rootThreadSummary = await selectRootThreadSummary(
        connection,
        prefix,
        options.actor,
        input.conversationId,
      );
      await connection.query(
        `INSERT INTO ${prefix}.chat_outbox_events (
           event_id, protocol_version, tenant_id, stream_id, type,
           occurred_at, payload, expires_at
         ) VALUES (
           $1, $2, $3, $4, 'message.thread_summary.updated', $5, $6,
           $5::timestamptz + ($7::double precision * interval '1 millisecond')
         )`,
        [
          createId(),
          CHAT_PROTOCOL_VERSION,
          options.actor.tenantId,
          conversation.parent_conversation_id,
          occurredAt,
          {
            parentConversationId: conversation.parent_conversation_id,
            rootMessageId: conversation.root_message_id,
            rootThreadSummary,
          },
          outboxRetentionMs,
        ],
      );
    }

    const completed = await connection.query(
      `UPDATE ${prefix}.chat_idempotency_keys
       SET state = 'completed',
           response_status = 201,
           response_body = $1,
           completed_at = GREATEST($2::timestamptz, created_at),
           updated_at = GREATEST($2::timestamptz, created_at)
       WHERE tenant_id = $3
         AND user_id = $4
         AND operation_name = $5
         AND client_key = $6
         AND request_hash = $7
         AND state = 'pending'`,
      [
        applied,
        occurredAt,
        options.actor.tenantId,
        options.actor.userId,
        SEND_MESSAGE_IDEMPOTENCY_OPERATION,
        input.idempotencyKey,
        requestHash,
      ],
    );
    if (completed.rowCount !== 1) {
      throw new SendMessageCommandError(
        "idempotency_in_progress",
        "The idempotent request is already in progress",
      );
    }

    await connection.query("COMMIT");
    return applied;
  } catch (error) {
    await rollback(connection);
    // A new reply cannot disclose whether its inaccessible source exists.
    // Replays retain authorization failures and never revalidate the old source.
    if (input.replyTo !== undefined && !reconciling && error instanceof ChatAuthorizationError) {
      throw new SendMessageCommandError("invalid_reply_source", "The reply source is unavailable");
    }
    throw error;
  } finally {
    connection.release();
  }
}
