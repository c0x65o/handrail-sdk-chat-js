import { createHash, randomUUID } from "node:crypto";

import {
  parseForwardMessageInput,
  parseForwardMessageResult,
  type ForwardMessageInput,
  type ForwardMessageResult,
} from "../contracts/generated/forward-message.js";
import type {
  ConversationId,
  IsoTimestamp,
  MessageId,
  MessageSequence,
  TenantId,
  UserId,
} from "../contracts/identifiers.js";
import type {
  ForwardedMessageSnapshot,
  Message,
  MessageBlock,
  MessageContent,
  MessageMention,
} from "../contracts/message.js";
import { CHAT_PROTOCOL_VERSION } from "../contracts/realtime.js";
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
import { selectRootThreadSummary } from "./thread-summary-query.js";

export const FORWARD_MESSAGE_SEND_CAPABILITY = "message.send" as const;
export const FORWARD_MESSAGE_SOURCE_ENTITY_POLICY_ACTION =
  "message.read" as const;
export const FORWARD_MESSAGE_DESTINATION_ENTITY_POLICY_ACTION =
  "message.send" as const;
export const FORWARD_MESSAGE_IDEMPOTENCY_OPERATION =
  "message.forward" as const;
export const DEFAULT_FORWARD_MESSAGE_IDEMPOTENCY_TTL_MS =
  24 * 60 * 60 * 1_000;
export const DEFAULT_FORWARD_MESSAGE_OUTBOX_RETENTION_MS =
  7 * 24 * 60 * 60 * 1_000;

export type ForwardMessageCommandErrorCode =
  | "idempotency_conflict"
  | "idempotency_in_progress"
  | "destination_message_conflict"
  | "source_message_not_found"
  | "source_message_forbidden"
  | "destination_conversation_not_found"
  | "destination_conversation_forbidden"
  | "source_attachments_unsupported"
  | "source_content_unsupported";

/** Stable command failure with no provider or persistence diagnostics. */
export class ForwardMessageCommandError extends Error {
  public readonly statusCode: number;

  public constructor(
    public readonly code: ForwardMessageCommandErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ForwardMessageCommandError";
    this.statusCode =
      code === "source_message_not_found" ||
      code === "destination_conversation_not_found"
        ? 404
        : code === "source_message_forbidden" ||
            code === "destination_conversation_forbidden"
          ? 403
          : code === "source_attachments_unsupported" ||
              code === "source_content_unsupported"
            ? 422
            : 409;
  }
}

export interface ForwardMessageCommandOptions<
  Block extends MessageBlock = MessageBlock,
> {
  readonly database: PostgresMigrationDatabase;
  readonly directory: Pick<ChatDirectoryAdapter, "getUser">;
  readonly permissions: Pick<
    ChatPermissionAdapter<
      string,
      | typeof FORWARD_MESSAGE_SOURCE_ENTITY_POLICY_ACTION
      | typeof FORWARD_MESSAGE_DESTINATION_ENTITY_POLICY_ACTION
    >,
    "getCapabilities" | "authorizeEntity"
  >;
  readonly actor: TrustedChatActorContext;
  readonly input: unknown;
  readonly schema?: string;
  readonly idempotencyTtlMs?: number;
  readonly outboxRetentionMs?: number;
  /** Trusted transport correlation id used only by the existing audit record. */
  readonly requestId?: string;
  readonly createId?: () => string;
}

interface ClaimedIdempotencyRow {
  readonly idempotency_state: string;
  readonly stored_response_body: unknown | null;
}

interface SourceMessageRow {
  readonly id: string;
  readonly conversation_id: string;
  readonly author_user_id: string;
  readonly content: unknown | null;
  readonly created_at: Date | string;
  readonly deleted_at: Date | string | null;
  readonly visibility: string;
  readonly entity_type: string | null;
  readonly entity_id: string | null;
  readonly has_attachment_references: boolean;
}

interface DestinationConversationRow {
  readonly archived_at: Date | string | null;
  readonly entity_type: string | null;
  readonly entity_id: string | null;
  readonly parent_conversation_id: string | null;
  readonly root_message_id: string | null;
}

interface ConversationMemberRow {
  readonly state: string;
}

interface AllocatedConversationRow {
  readonly sequence: string | number;
  readonly occurred_at: Date | string;
}

const quoteIdentifier = (identifier: string): string =>
  `"${identifier.replaceAll('"', '""')}"`;

const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const positiveSafeInteger = (value: unknown, label: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value as number;
};

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

const requireSendCapability = async (
  options: ForwardMessageCommandOptions,
): Promise<void> => {
  let capabilities: unknown;
  try {
    capabilities = await options.permissions.getCapabilities({
      actor: options.actor,
    });
  } catch {
    throw new ChatAuthorizationError();
  }
  if (
    !Array.isArray(capabilities) ||
    !capabilities.every(nonEmptyString) ||
    !capabilities.includes(FORWARD_MESSAGE_SEND_CAPABILITY)
  ) {
    throw new ChatAuthorizationError();
  }
};

const canonicalJson = (value: unknown, ancestors = new Set<object>()): string => {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Input must contain finite JSON numbers");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new TypeError("Input must be JSON-compatible");
  }
  if (ancestors.has(value)) throw new TypeError("Input must not contain cycles");
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Input must contain only JSON objects and arrays");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => canonicalJson(entry, ancestors)).join(",")}]`;
    }
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key], ancestors)}`)
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
};

const hashRequest = (input: ForwardMessageInput): string => {
  const canonical = canonicalJson({
    operation: input.operation,
    sourceMessageId: input.sourceMessageId,
    destinationConversationId: input.destinationConversationId,
    clientCorrelationId: input.clientCorrelationId,
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
};

const toIsoTimestamp = (value: Date | string, label: string): IsoTimestamp => {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.valueOf())) {
    throw new Error(`PostgreSQL returned an invalid ${label}`);
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

const requireRecord = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ForwardMessageCommandError(
      "source_content_unsupported",
      "The source message content cannot be forwarded",
    );
  }
  return value as Record<string, unknown>;
};

const assertExactKeys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
): void => {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) {
    throw new ForwardMessageCommandError(
      "source_content_unsupported",
      "The source message content cannot be forwarded",
    );
  }
};

const cloneMention = (value: unknown): MessageMention => {
  const mention = requireRecord(value);
  if (mention.type === "user") {
    assertExactKeys(mention, ["type", "userId"]);
    if (!nonEmptyString(mention.userId)) throw new Error("invalid mention");
    return { type: "user", userId: mention.userId as UserId };
  }
  if (mention.type === "conversation") {
    assertExactKeys(mention, ["type", "conversationId"]);
    if (!nonEmptyString(mention.conversationId)) throw new Error("invalid mention");
    return {
      type: "conversation",
      conversationId: mention.conversationId as ConversationId,
    };
  }
  if (mention.type === "entity") {
    assertExactKeys(mention, ["type", "entity"]);
    const entity = requireRecord(mention.entity);
    assertExactKeys(entity, ["type", "id"]);
    if (!nonEmptyString(entity.type) || !nonEmptyString(entity.id)) {
      throw new Error("invalid mention");
    }
    return { type: "entity", entity: { type: entity.type, id: entity.id } };
  }
  throw new Error("invalid mention");
};

const validateExistingSnapshot = (value: unknown): void => {
  const snapshot = requireRecord(value);
  assertExactKeys(snapshot, [
    "sourceMessageId",
    "originalAuthor",
    "originalCreatedAt",
  ]);
  const author = requireRecord(snapshot.originalAuthor);
  assertExactKeys(author, ["userId", "displayName"]);
  if (
    !nonEmptyString(snapshot.sourceMessageId) ||
    !nonEmptyString(author.userId) ||
    !nonEmptyString(author.displayName) ||
    author.displayName.length > 256 ||
    typeof snapshot.originalCreatedAt !== "string" ||
    !ISO_TIMESTAMP_PATTERN.test(snapshot.originalCreatedAt) ||
    !Number.isFinite(Date.parse(snapshot.originalCreatedAt))
  ) {
    throw new ForwardMessageCommandError(
      "source_content_unsupported",
      "The source message content cannot be forwarded",
    );
  }
};

const snapshotDisplayContent = (
  value: unknown,
  forwarded: ForwardedMessageSnapshot,
): MessageContent => {
  const content = requireRecord(value);
  if (Object.hasOwn(content, "attachments")) {
    const attachments = content.attachments;
    if (!Array.isArray(attachments) || attachments.length > 0) {
      throw new ForwardMessageCommandError(
        "source_attachments_unsupported",
        "Source message attachments cannot be forwarded",
      );
    }
  }
  assertExactKeys(content, ["format", "text", "mentions", "attachments", "forwarded"]);
  if (
    (content.format !== "plain" && content.format !== "markdown") ||
    typeof content.text !== "string"
  ) {
    throw new ForwardMessageCommandError(
      "source_content_unsupported",
      "The source message content cannot be forwarded",
    );
  }
  if (content.forwarded !== undefined) validateExistingSnapshot(content.forwarded);

  let mentions: readonly MessageMention[] | undefined;
  try {
    if (content.mentions !== undefined) {
      if (!Array.isArray(content.mentions)) throw new Error("invalid mentions");
      mentions = Object.freeze(content.mentions.map(cloneMention));
    }
  } catch (error) {
    if (error instanceof ForwardMessageCommandError) throw error;
    throw new ForwardMessageCommandError(
      "source_content_unsupported",
      "The source message content cannot be forwarded",
    );
  }

  return Object.freeze({
    format: content.format,
    text: content.text,
    ...(mentions === undefined ? {} : { mentions }),
    forwarded: Object.freeze(forwarded),
  }) as MessageContent;
};

const authorizeEntity = async (
  options: ForwardMessageCommandOptions,
  row: { readonly entity_type: string | null; readonly entity_id: string | null },
  action:
    | typeof FORWARD_MESSAGE_SOURCE_ENTITY_POLICY_ACTION
    | typeof FORWARD_MESSAGE_DESTINATION_ENTITY_POLICY_ACTION,
  errorCode: "source_message_forbidden" | "destination_conversation_forbidden",
): Promise<void> => {
  if ((row.entity_type === null) !== (row.entity_id === null)) {
    throw new Error("PostgreSQL returned an invalid entity reference");
  }
  if (row.entity_type === null || row.entity_id === null) return;
  let allowed = false;
  try {
    allowed = await options.permissions.authorizeEntity({
      actor: options.actor,
      entity: { type: row.entity_type, id: row.entity_id },
      action,
    });
  } catch {
    allowed = false;
  }
  if (!allowed) {
    throw new ForwardMessageCommandError(
      errorCode,
      errorCode === "source_message_forbidden"
        ? "The source message is unavailable"
        : "The destination conversation is unavailable",
    );
  }
};

const replayStoredResult = (
  stored: unknown,
  input: ForwardMessageInput,
): ForwardMessageResult => {
  const canonical = parseForwardMessageResult(stored, input);
  return parseForwardMessageResult(
    { ...canonical, reconciliationStatus: "replayed" },
    input,
  );
};

const isDestinationMessageConflict = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "23505" &&
  "constraint" in error &&
  error.constraint === "chat_messages_author_client_message_key";

const rollback = async (connection: PostgresMigrationConnection): Promise<void> => {
  await connection.query("ROLLBACK").catch(() => undefined);
};

/** Creates one immutable forward snapshot and all ordinary message side effects. */
export async function forwardMessage<Block extends MessageBlock = MessageBlock>(
  options: ForwardMessageCommandOptions<Block>,
): Promise<ForwardMessageResult<Block>> {
  validateActor(options.actor);
  const input = parseForwardMessageInput(options.input);
  const schema = validatePostgresSchema(options.schema ?? DEFAULT_POSTGRES_SCHEMA);
  const prefix = quoteIdentifier(schema);
  const idempotencyTtlMs = positiveSafeInteger(
    options.idempotencyTtlMs ?? DEFAULT_FORWARD_MESSAGE_IDEMPOTENCY_TTL_MS,
    "idempotencyTtlMs",
  );
  const outboxRetentionMs = positiveSafeInteger(
    options.outboxRetentionMs ?? DEFAULT_FORWARD_MESSAGE_OUTBOX_RETENTION_MS,
    "outboxRetentionMs",
  );
  const createId = options.createId ?? randomUUID;
  const requestHash = hashRequest(input);

  await requireSendCapability(options);

  const connection = await options.database.connect();
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
        FORWARD_MESSAGE_IDEMPOTENCY_OPERATION,
        input.idempotencyKey,
        requestHash,
        idempotencyTtlMs,
      ],
    );
    const claimed = claim.rows[0];
    if (claimed === undefined) {
      throw new ForwardMessageCommandError(
        "idempotency_conflict",
        "The idempotency key was already used for a different request",
      );
    }
    if (claimed.idempotency_state === "completed") {
      if (claimed.stored_response_body === null) {
        throw new Error("Completed forward-message outcome has no response body");
      }
      const replay = replayStoredResult(claimed.stored_response_body, input);
      await connection.query("COMMIT");
      return replay as ForwardMessageResult<Block>;
    }
    if (claimed.idempotency_state !== "pending") {
      throw new Error("PostgreSQL returned an invalid idempotency state");
    }

    const sourceResult = await connection.query<SourceMessageRow>(
      `SELECT
         message.id,
         message.conversation_id,
         message.author_user_id,
         message.content,
         message.created_at,
         message.deleted_at,
         conversation.visibility,
         conversation.entity_type,
         conversation.entity_id,
         EXISTS (
           SELECT 1
           FROM ${prefix}.chat_attachments AS attachment
           WHERE attachment.tenant_id = message.tenant_id
             AND attachment.attached_message_id = message.id
         ) AS has_attachment_references
       FROM ${prefix}.chat_messages AS message
       INNER JOIN ${prefix}.chat_conversations AS conversation
         ON conversation.tenant_id = message.tenant_id
        AND conversation.id = message.conversation_id
       WHERE message.tenant_id = $1
         AND message.id = $2
       FOR UPDATE OF message`,
      [options.actor.tenantId, input.sourceMessageId],
    );
    const source = sourceResult.rows[0];
    if (source === undefined || source.deleted_at !== null || source.content === null) {
      throw new ForwardMessageCommandError(
        "source_message_not_found",
        "The source message is unavailable",
      );
    }
    if (source.visibility !== "public") {
      const sourceMembership = await connection.query<ConversationMemberRow>(
        `SELECT state
         FROM ${prefix}.chat_conversation_members
         WHERE tenant_id = $1
           AND conversation_id = $2
           AND user_id = $3
         FOR SHARE`,
        [
          options.actor.tenantId,
          source.conversation_id,
          options.actor.userId,
        ],
      );
      if (sourceMembership.rows[0]?.state !== "active") {
        throw new ForwardMessageCommandError(
          "source_message_forbidden",
          "The source message is unavailable",
        );
      }
    }
    await authorizeEntity(
      options,
      source,
      FORWARD_MESSAGE_SOURCE_ENTITY_POLICY_ACTION,
      "source_message_forbidden",
    );
    if (source.has_attachment_references) {
      throw new ForwardMessageCommandError(
        "source_attachments_unsupported",
        "Source message attachments cannot be forwarded",
      );
    }

    let sourceAuthor;
    try {
      sourceAuthor = await options.directory.getUser({
        actor: options.actor,
        userId: source.author_user_id as UserId,
      });
    } catch {
      sourceAuthor = null;
    }
    if (
      sourceAuthor === null ||
      sourceAuthor.kind === "redacted" ||
      sourceAuthor.kind === "unavailable" ||
      sourceAuthor.tenantId !== options.actor.tenantId ||
      sourceAuthor.userId !== source.author_user_id ||
      !nonEmptyString(sourceAuthor.displayName) ||
      sourceAuthor.displayName.length > 256
    ) {
      throw new ForwardMessageCommandError(
        "source_message_forbidden",
        "The source message is unavailable",
      );
    }

    const destinationResult = await connection.query<DestinationConversationRow>(
      `SELECT
         conversation.archived_at,
         conversation.entity_type,
         conversation.entity_id,
         conversation.parent_conversation_id,
         conversation.root_message_id
       FROM ${prefix}.chat_conversations AS conversation
       WHERE conversation.tenant_id = $1
         AND conversation.id = $2
       FOR UPDATE OF conversation`,
      [
        options.actor.tenantId,
        input.destinationConversationId,
      ],
    );
    const destination = destinationResult.rows[0];
    if (destination === undefined) {
      throw new ForwardMessageCommandError(
        "destination_conversation_not_found",
        "The destination conversation is unavailable",
      );
    }
    if (destination.archived_at !== null) {
      throw new ForwardMessageCommandError(
        "destination_conversation_forbidden",
        "The destination conversation is unavailable",
      );
    }
    const destinationMembership =
      await connection.query<ConversationMemberRow>(
        `SELECT state
         FROM ${prefix}.chat_conversation_members
         WHERE tenant_id = $1
           AND conversation_id = $2
           AND user_id = $3
         FOR SHARE`,
        [
          options.actor.tenantId,
          input.destinationConversationId,
          options.actor.userId,
        ],
      );
    if (destinationMembership.rows[0]?.state !== "active") {
      throw new ForwardMessageCommandError(
        "destination_conversation_forbidden",
        "The destination conversation is unavailable",
      );
    }
    await authorizeEntity(
      options,
      destination,
      FORWARD_MESSAGE_DESTINATION_ENTITY_POLICY_ACTION,
      "destination_conversation_forbidden",
    );

    const allocation = await connection.query<AllocatedConversationRow>(
      `UPDATE ${prefix}.chat_conversations AS conversation
       SET current_message_sequence = conversation.current_message_sequence + 1,
           updated_at = clock_timestamp()
       WHERE conversation.tenant_id = $1
         AND conversation.id = $2
         AND conversation.archived_at IS NULL
         AND conversation.current_message_sequence < 9007199254740991
       RETURNING
         conversation.current_message_sequence AS sequence,
         conversation.updated_at AS occurred_at`,
      [options.actor.tenantId, input.destinationConversationId],
    );
    const allocated = allocation.rows[0];
    if (allocated === undefined) {
      throw new ForwardMessageCommandError(
        "destination_conversation_forbidden",
        "The destination conversation is unavailable",
      );
    }

    const sequence = toMessageSequence(allocated.sequence);
    const occurredAt = toIsoTimestamp(allocated.occurred_at, "message timestamp");
    const sourceCreatedAt = toIsoTimestamp(source.created_at, "source message timestamp");
    const forwarded: ForwardedMessageSnapshot = Object.freeze({
      sourceMessageId: source.id as MessageId,
      originalAuthor: Object.freeze({
        userId: source.author_user_id as UserId,
        displayName: sourceAuthor.displayName,
      }),
      originalCreatedAt: sourceCreatedAt,
    });
    const content = snapshotDisplayContent(source.content, forwarded);
    const messageId = createId() as MessageId;
    const message: Message<Block> = {
      id: messageId,
      tenantId: options.actor.tenantId as TenantId,
      conversationId: input.destinationConversationId,
      author: { type: "user", userId: options.actor.userId as UserId },
      sequence,
      createdAt: occurredAt,
      updatedAt: occurredAt,
      revision: { revision: 1 },
      content: content as MessageContent<Block>,
    };
    const applied = parseForwardMessageResult<Block>(
      {
        operation: "forward_message.v1",
        reconciliationStatus: "applied",
        clientCorrelationId: input.clientCorrelationId,
        destinationConversationId: input.destinationConversationId,
        message,
        canonicalRevision: 1,
      },
      input,
    );

    try {
      await connection.query(
        `INSERT INTO ${prefix}.chat_messages (
           tenant_id, id, conversation_id, sequence, author_user_id,
           client_message_id, content, current_revision, created_at, updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $8)`,
        [
          options.actor.tenantId,
          messageId,
          input.destinationConversationId,
          sequence,
          options.actor.userId,
          input.clientCorrelationId,
          content,
          occurredAt,
        ],
      );
    } catch (error) {
      if (isDestinationMessageConflict(error)) {
        throw new ForwardMessageCommandError(
          "destination_message_conflict",
          "The destination message correlation is already in use",
        );
      }
      throw error;
    }

    await connection.query(
      `INSERT INTO ${prefix}.chat_message_revisions (
         tenant_id, message_id, revision_number, content,
         created_at, created_by_user_id
       )
       VALUES ($1, $2, 1, $3, $4, $5)`,
      [
        options.actor.tenantId,
        messageId,
        content,
        occurredAt,
        options.actor.userId,
      ],
    );

    const auditEventId = createId();
    await connection.query(
      `INSERT INTO ${prefix}.chat_audit_events (
         tenant_id, event_id, actor_user_id, action, target_type, target_id,
         occurred_at, metadata, request_id, correlation_id
       )
       VALUES ($1, $2, $3, 'message.created', 'message', $4, $5, $6, $8, $7)`,
      [
        options.actor.tenantId,
        auditEventId,
        options.actor.userId,
        messageId,
        occurredAt,
        {
          conversationId: input.destinationConversationId,
          sequence,
          attachmentCount: 0,
          userMentionCount: (content.mentions ?? []).filter(
            (mention) => mention.type === "user",
          ).length,
          forwarded: true,
          sourceMessageId: input.sourceMessageId,
        },
        input.clientCorrelationId,
        options.requestId ?? auditEventId,
      ],
    );

    const outboxEventId = createId();
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
        input.destinationConversationId,
        occurredAt,
        { message: applied.message, clientMessageId: input.clientCorrelationId },
        outboxRetentionMs,
      ],
    );

    if (
      destination.parent_conversation_id !== null &&
      destination.root_message_id !== null
    ) {
      // The destination row lock is held through commit, so concurrent replies
      // cannot publish stale counts. Persist the summary after message.created
      // so live delivery and replay observe the reply before its parent summary.
      const rootThreadSummary = await selectRootThreadSummary(
        connection,
        prefix,
        options.actor,
        input.destinationConversationId,
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
          destination.parent_conversation_id,
          occurredAt,
          {
            parentConversationId: destination.parent_conversation_id,
            rootMessageId: destination.root_message_id,
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
        FORWARD_MESSAGE_IDEMPOTENCY_OPERATION,
        input.idempotencyKey,
        requestHash,
      ],
    );
    if (completed.rowCount !== 1) {
      throw new ForwardMessageCommandError(
        "idempotency_in_progress",
        "The idempotent request is already in progress",
      );
    }

    await connection.query("COMMIT");
    return applied;
  } catch (error) {
    await rollback(connection);
    throw error;
  } finally {
    connection.release();
  }
}
