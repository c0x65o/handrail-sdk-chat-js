import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import {
  parseThreadCreationInput,
  parseThreadCreationResult,
  type ThreadCreationInput,
  type ThreadCreationResult,
} from "../contracts/thread-creation.js";
import {
  MAX_CONVERSATION_LIST_ACTIVE_MEMBER_USER_IDS,
  createConversationSnapshotMetadata,
  type ConversationDetailSnapshotConversation,
} from "../contracts/conversation-snapshot.js";
import type { ConversationVisibility } from "../contracts/conversation.js";
import type {
  ConversationId,
  IsoTimestamp,
  MessageId,
  MessageSequence,
  TenantId,
  UserId,
} from "../contracts/identifiers.js";
import {
  CHAT_PROTOCOL_VERSION,
  type ServerHandshakeMetadataInput,
} from "../contracts/realtime.js";
import type {
  ChatPermissionAdapter,
  TrustedChatActorContext,
} from "./contracts.js";
import {
  DEFAULT_POSTGRES_SCHEMA,
  validatePostgresSchema,
  type PostgresMigrationConnection,
  type PostgresMigrationDatabase,
} from "./postgres-migrations.js";
import { handrailChatPostgresMigrations } from "./postgres-schema-migrations.js";
import { ChatAuthorizationError } from "./request-context.js";
import { selectRootThreadSummary } from "./thread-summary-query.js";
import { ensureThreadParticipant } from "./thread-participant.js";

const packageManifest = createRequire(import.meta.url)("../../package.json") as {
  readonly version: string;
};

export const CREATE_THREAD_CAPABILITY = "thread.create" as const;
export const CREATE_THREAD_ENTITY_POLICY_ACTION = "thread.create" as const;
export const CREATE_THREAD_IDEMPOTENCY_OPERATION = "thread.create" as const;
export const DEFAULT_CREATE_THREAD_INITIAL_FOLLOW = true;
export const DEFAULT_CREATE_THREAD_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_CREATE_THREAD_OUTBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export type CreateThreadCommandErrorCode =
  | "idempotency_conflict"
  | "idempotency_in_progress";

/** Stable command failure suitable for a future transport boundary. */
export class CreateThreadCommandError extends Error {
  public readonly statusCode = 409;

  public constructor(
    public readonly code: CreateThreadCommandErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CreateThreadCommandError";
  }
}

export interface CreateThreadCommandOptions<Feature extends string = string> {
  readonly database: PostgresMigrationDatabase;
  readonly permissions: Pick<
    ChatPermissionAdapter<string, typeof CREATE_THREAD_ENTITY_POLICY_ACTION>,
    "getCapabilities" | "authorizeEntity"
  >;
  /** Trusted host-session identity; caller input cannot override these values. */
  readonly actor: TrustedChatActorContext;
  /** JSON-decoded caller input, validated by the shared thread contract. */
  readonly input: unknown;
  readonly schema?: string;
  readonly idempotencyTtlMs?: number;
  readonly outboxRetentionMs?: number;
  /** Trusted transport correlation id used only by the existing audit record. */
  readonly requestId?: string;
  /** Metadata from the embedding server; deterministic package/schema defaults are provided. */
  readonly metadata?: ServerHandshakeMetadataInput<Feature>;
  /** Supplies opaque durable identifiers; defaults to cryptographic UUIDs. */
  readonly createId?: () => string;
}

interface ClaimedIdempotencyRow {
  readonly idempotency_state: string;
  readonly stored_response_body: unknown | null;
}

interface EligibleParentRootRow {
  readonly visibility: string;
  readonly entity_type: string | null;
  readonly entity_id: string | null;
}

interface ExistingThreadRow {
  readonly id: string;
  readonly archived_at: Date | string | null;
}

interface StoredThreadRow {
  readonly id: string;
  readonly name: string | null;
  readonly visibility: string;
  readonly parent_conversation_id: string;
  readonly root_message_id: string;
  readonly current_message_sequence: string | number;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly member_role: string;
  readonly member_state: string;
  readonly member_joined_at: Date | string;
  readonly member_updated_at: Date | string;
  readonly last_read_sequence: string | number;
  readonly manual_unread_from_sequence: string | number | null;
  readonly read_updated_at: Date | string;
  readonly notification_level: string;
  readonly muted: boolean;
  readonly muted_until: Date | string | null;
  readonly preference_revision: string | number | null;
  readonly preference_updated_at: Date | string;
  readonly member_user_ids: readonly string[];
}

const quoteIdentifier = (identifier: string): string =>
  `"${identifier.replaceAll('"', '""')}"`;

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

const requireCreateThreadCapability = async (
  actor: TrustedChatActorContext,
  permissions: CreateThreadCommandOptions["permissions"],
): Promise<void> => {
  try {
    const capabilities = await permissions.getCapabilities({ actor });
    if (
      !Array.isArray(capabilities) ||
      !capabilities.every(nonEmptyString) ||
      !capabilities.includes(CREATE_THREAD_CAPABILITY)
    ) {
      throw new Error("denied");
    }
  } catch {
    throw new ChatAuthorizationError();
  }
};

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Input must contain finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") throw new TypeError("Input must be JSON-compatible");
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
};

const hashRequest = (input: ThreadCreationInput): string =>
  `sha256:${createHash("sha256")
    .update(
      canonicalJson({
        operation: input.operation,
        parentConversationId: input.parentConversationId,
        rootMessageId: input.rootMessageId,
        initialFollow:
          input.initialFollow ?? DEFAULT_CREATE_THREAD_INITIAL_FOLLOW,
        // Preserve the exact legacy hash for unnamed requests and retries.
        ...(input.name === undefined ? {} : { name: input.name }),
      }),
    )
    .digest("hex")}`;

const toIsoTimestamp = (value: Date | string, label: string): IsoTimestamp => {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.valueOf())) {
    throw new Error(`PostgreSQL returned an invalid ${label}`);
  }
  return date.toISOString() as IsoTimestamp;
};

const toSequence = (
  value: string | number,
  label: string,
): MessageSequence => {
  const sequence = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error(`PostgreSQL returned an invalid ${label}`);
  }
  return sequence as MessageSequence;
};

const defaultMetadata = <Feature extends string>(): ServerHandshakeMetadataInput<Feature> => ({
  packageVersion: packageManifest.version,
  protocolVersion: CHAT_PROTOCOL_VERSION,
  schemaVersion: handrailChatPostgresMigrations.reduce(
    (highest, migration) => Math.max(highest, migration.order),
    0,
  ),
  enabledFeatures: {} as Readonly<Record<Feature, boolean>>,
});

const isVisibility = (value: string): value is ConversationVisibility =>
  value === "public" || value === "private";

const isMemberRole = (
  value: string,
): value is "owner" | "moderator" | "member" =>
  value === "owner" || value === "moderator" || value === "member";

const rowToThread = (
  row: StoredThreadRow,
  actor: TrustedChatActorContext,
): ConversationDetailSnapshotConversation => {
  if (
    !isVisibility(row.visibility) ||
    !isMemberRole(row.member_role) ||
    row.member_state !== "active" ||
    (row.notification_level !== "all" &&
      row.notification_level !== "mentions" &&
      row.notification_level !== "none")
  ) {
    throw new Error("PostgreSQL returned an invalid thread conversation");
  }
  const conversationId = row.id as ConversationId;
  const tenantId = actor.tenantId as TenantId;
  const userId = actor.userId as UserId;
  const createdAt = toIsoTimestamp(row.created_at, "thread creation timestamp");
  const updatedAt = toIsoTimestamp(row.updated_at, "thread update timestamp");
  const memberUserIds = Object.freeze(
    row.member_user_ids.map((memberUserId) => memberUserId as UserId),
  );
  return {
    id: conversationId,
    tenantId,
    type: "thread",
    visibility: row.visibility,
    ...(row.name === null ? {} : { name: row.name }),
    parentConversationId: row.parent_conversation_id as ConversationId,
    rootMessageId: row.root_message_id as MessageId,
    createdAt,
    updatedAt,
    latestSequence: toSequence(
      row.current_message_sequence,
      "thread message sequence",
    ),
    activityAt: updatedAt,
    unreadMentionCount: 0,
    currentMember: {
      tenantId,
      conversationId,
      userId,
      role: row.member_role,
      state: "active",
      joinedAt: toIsoTimestamp(row.member_joined_at, "thread membership timestamp"),
      updatedAt: toIsoTimestamp(row.member_updated_at, "thread membership timestamp"),
    },
    currentReadState: {
      conversationId,
      userId,
      lastReadSequence: toSequence(
        row.last_read_sequence,
        "thread read sequence",
      ),
      ...(row.manual_unread_from_sequence === null
        ? {}
        : {
            manualUnreadFromSequence: toSequence(
              row.manual_unread_from_sequence,
              "thread manual unread sequence",
            ),
          }),
      updatedAt: toIsoTimestamp(row.read_updated_at, "thread read timestamp"),
    },
    activeMemberUserIds: Object.freeze(
      memberUserIds.slice(0, MAX_CONVERSATION_LIST_ACTIVE_MEMBER_USER_IDS),
    ),
    memberUserIds,
    currentPreference: {
      preferenceRevision: row.preference_revision === null
        ? 0
        : toSequence(row.preference_revision, "preference revision"),
      conversationId,
      userId,
      isStarred: false,
      notificationPreference: row.notification_level,
      mute:
        row.muted
          ? {
              muted: true,
              ...(row.muted_until === null
                ? {}
                : {
                    mutedUntil: toIsoTimestamp(
                      row.muted_until,
                      "thread mute timestamp",
                    ),
                  }),
            }
          : { muted: false },
      updatedAt: toIsoTimestamp(
        row.preference_updated_at,
        "thread preference timestamp",
      ),
    },
  };
};

const lockLogicalThread = async (
  connection: PostgresMigrationConnection,
  actor: TrustedChatActorContext,
  input: ThreadCreationInput,
): Promise<void> => {
  await connection.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    JSON.stringify([
      actor.tenantId,
      input.parentConversationId,
      input.rootMessageId,
    ]),
  ]);
};

const loadEligibleParentRoot = async (
  connection: PostgresMigrationConnection,
  prefix: string,
  actor: TrustedChatActorContext,
  input: ThreadCreationInput,
): Promise<EligibleParentRootRow> => {
  const result = await connection.query<EligibleParentRootRow>(
    `SELECT parent.visibility, parent.entity_type, parent.entity_id
       FROM ${prefix}.chat_conversations AS parent
       INNER JOIN ${prefix}.chat_messages AS root
         ON root.tenant_id = parent.tenant_id
        AND root.conversation_id = parent.id
        AND root.id = $4
       LEFT JOIN ${prefix}.chat_conversation_members AS member
         ON member.tenant_id = parent.tenant_id
        AND member.conversation_id = parent.id
        AND member.user_id = $2
       WHERE parent.tenant_id = $1
         AND parent.id = $3
         AND parent.type <> 'thread'
         AND parent.archived_at IS NULL
         AND root.deleted_at IS NULL
         AND (
           (parent.type = 'channel' AND parent.visibility = 'public')
           OR member.state = 'active'
         )
       LIMIT 1
       FOR UPDATE OF parent, root`,
    [actor.tenantId, actor.userId, input.parentConversationId, input.rootMessageId],
  );
  const row = result.rows[0];
  if (row === undefined || !isVisibility(row.visibility)) {
    throw new ChatAuthorizationError();
  }
  return row;
};

const authorizeParentEntity = async (
  parent: EligibleParentRootRow,
  actor: TrustedChatActorContext,
  permissions: CreateThreadCommandOptions["permissions"],
): Promise<void> => {
  if (parent.entity_type === null || parent.entity_id === null) return;
  try {
    const allowed = await permissions.authorizeEntity({
      actor,
      entity: { type: parent.entity_type, id: parent.entity_id },
      action: CREATE_THREAD_ENTITY_POLICY_ACTION,
    });
    if (!allowed) throw new Error("denied");
  } catch {
    throw new ChatAuthorizationError();
  }
};

const findThreadForRoot = async (
  connection: PostgresMigrationConnection,
  prefix: string,
  actor: TrustedChatActorContext,
  input: ThreadCreationInput,
): Promise<ExistingThreadRow | undefined> => {
  const result = await connection.query<ExistingThreadRow>(
    `SELECT conversation.id, conversation.archived_at
       FROM ${prefix}.chat_conversations AS conversation
       WHERE conversation.tenant_id = $1
         AND conversation.type = 'thread'
         AND conversation.parent_conversation_id = $2
         AND conversation.root_message_id = $3
       ORDER BY conversation.created_at, conversation.id
       LIMIT 1`,
    [actor.tenantId, input.parentConversationId, input.rootMessageId],
  );
  return result.rows[0];
};

const seedCreatorFollow = async (
  connection: PostgresMigrationConnection,
  prefix: string,
  actor: TrustedChatActorContext,
  conversationId: string,
  occurredAt: IsoTimestamp,
  isFollowing: boolean,
): Promise<void> => {
  await connection.query(
    `INSERT INTO ${prefix}.chat_thread_follows (
       tenant_id, conversation_id, user_id, is_following,
       follow_source, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, 'manual', $5, $5)
     ON CONFLICT (tenant_id, conversation_id, user_id) DO NOTHING`,
    [actor.tenantId, conversationId, actor.userId, isFollowing, occurredAt],
  );
};

const selectThread = async (
  connection: PostgresMigrationConnection,
  prefix: string,
  actor: TrustedChatActorContext,
  conversationId: string,
): Promise<StoredThreadRow> => {
  const result = await connection.query<StoredThreadRow>(
    `SELECT conversation.id, conversation.visibility, conversation.name,
            conversation.parent_conversation_id, conversation.root_message_id,
            conversation.current_message_sequence, conversation.created_at,
            conversation.updated_at, member.role AS member_role,
            member.state AS member_state, member.joined_at AS member_joined_at,
            member.updated_at AS member_updated_at,
            cursor.last_read_sequence, cursor.manual_unread_from_sequence,
            cursor.updated_at AS read_updated_at,
            preference.notification_level, preference.muted,
            preference.muted_until,
            preference.preference_revision, preference.updated_at AS preference_updated_at,
            ARRAY(
              SELECT active_member.user_id
              FROM ${prefix}.chat_conversation_members AS active_member
              WHERE active_member.tenant_id = conversation.tenant_id
                AND active_member.conversation_id = conversation.id
                AND active_member.state = 'active'
              ORDER BY active_member.user_id
            ) AS member_user_ids
       FROM ${prefix}.chat_conversations AS conversation
       INNER JOIN ${prefix}.chat_conversation_members AS member
         ON member.tenant_id = conversation.tenant_id
        AND member.conversation_id = conversation.id
        AND member.user_id = $2
       INNER JOIN ${prefix}.chat_read_cursors AS cursor
         ON cursor.tenant_id = member.tenant_id
        AND cursor.conversation_id = member.conversation_id
        AND cursor.user_id = member.user_id
       INNER JOIN ${prefix}.chat_conversation_preferences AS preference
         ON preference.tenant_id = member.tenant_id
        AND preference.conversation_id = member.conversation_id
        AND preference.user_id = member.user_id
       WHERE conversation.tenant_id = $1
         AND conversation.id = $3
         AND conversation.type = 'thread'
         AND conversation.archived_at IS NULL
       LIMIT 1`,
    [actor.tenantId, actor.userId, conversationId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("Created thread could not be reloaded");
  return row;
};

const replayStoredResult = (
  stored: unknown,
  input: ThreadCreationInput,
): ThreadCreationResult => {
  const canonical = parseThreadCreationResult(stored, input);
  return parseThreadCreationResult(
    { ...canonical, reconciliationStatus: "replayed" },
    input,
  );
};

const rollback = async (connection: PostgresMigrationConnection): Promise<void> => {
  await connection.query("ROLLBACK").catch(() => undefined);
};

/** Atomically creates or reconciles the one thread stream attached to a root message. */
export async function createThread<Feature extends string = string>(
  options: CreateThreadCommandOptions<Feature>,
): Promise<ThreadCreationResult> {
  validateActor(options.actor);
  const input = parseThreadCreationInput(options.input);
  const schema = validatePostgresSchema(options.schema ?? DEFAULT_POSTGRES_SCHEMA);
  const prefix = quoteIdentifier(schema);
  const idempotencyTtlMs = positiveSafeInteger(
    options.idempotencyTtlMs ?? DEFAULT_CREATE_THREAD_IDEMPOTENCY_TTL_MS,
    "idempotencyTtlMs",
  );
  const outboxRetentionMs = positiveSafeInteger(
    options.outboxRetentionMs ?? DEFAULT_CREATE_THREAD_OUTBOX_RETENTION_MS,
    "outboxRetentionMs",
  );
  const requestHash = hashRequest(input);
  const createId = options.createId ?? randomUUID;
  const initialFollow = input.initialFollow ?? DEFAULT_CREATE_THREAD_INITIAL_FOLLOW;

  await requireCreateThreadCapability(options.actor, options.permissions);

  const connection = await options.database.connect();
  try {
    await connection.query("BEGIN");
    const claim = await connection.query<ClaimedIdempotencyRow>(
      `SELECT * FROM ${prefix}.claim_chat_idempotency_key(
         $1, $2, $3, $4, $5,
         clock_timestamp() + ($6::double precision * interval '1 millisecond')
       )`,
      [
        options.actor.tenantId,
        options.actor.userId,
        CREATE_THREAD_IDEMPOTENCY_OPERATION,
        input.idempotencyKey,
        requestHash,
        idempotencyTtlMs,
      ],
    );
    const claimed = claim.rows[0];
    if (claimed === undefined) {
      throw new CreateThreadCommandError(
        "idempotency_conflict",
        "The idempotency key was already used for a different request",
      );
    }
    if (claimed.idempotency_state !== "pending" && claimed.idempotency_state !== "completed") {
      throw new Error("PostgreSQL returned an invalid idempotency state");
    }

    await lockLogicalThread(connection, options.actor, input);
    const parent = await loadEligibleParentRoot(
      connection,
      prefix,
      options.actor,
      input,
    );
    await authorizeParentEntity(parent, options.actor, options.permissions);

    if (claimed.idempotency_state === "completed") {
      if (claimed.stored_response_body === null) {
        throw new Error("Completed create-thread outcome has no response body");
      }
      const replay = replayStoredResult(claimed.stored_response_body, input);
      await connection.query("COMMIT");
      return replay;
    }

    const timestamp = await connection.query<{ occurred_at: Date | string }>(
      "SELECT clock_timestamp() AS occurred_at",
    );
    const occurredAt = toIsoTimestamp(
      timestamp.rows[0]?.occurred_at ?? new Date(Number.NaN),
      "thread command timestamp",
    );
    const existing = await findThreadForRoot(connection, prefix, options.actor, input);
    if (existing !== undefined && existing.archived_at !== null) {
      throw new ChatAuthorizationError();
    }

    const reconciliationStatus: "created" | "existing_for_root" =
      existing === undefined ? "created" : "existing_for_root";
    const conversationId = existing?.id ?? createId();
    if (existing === undefined) {
      await connection.query(
        `INSERT INTO ${prefix}.chat_conversations (
           tenant_id, id, type, visibility, parent_conversation_id,
           root_message_id, created_at, updated_at, name
         ) VALUES ($1, $2, 'thread', $3, $4, $5, $6, $6, $7)`,
        [
          options.actor.tenantId,
          conversationId,
          parent.visibility,
          input.parentConversationId,
          input.rootMessageId,
          occurredAt,
          input.name ?? null,
        ],
      );
    }

    await ensureThreadParticipant({
      connection,
      schema,
      actor: options.actor,
      threadId: conversationId,
      parentConversationId: input.parentConversationId,
      entityAction: CREATE_THREAD_ENTITY_POLICY_ACTION,
      permissions: options.permissions,
      occurredAt,
      initialRole: reconciliationStatus === "created" ? "owner" : "member",
    });
    await seedCreatorFollow(
      connection,
      prefix,
      options.actor,
      conversationId,
      occurredAt,
      initialFollow,
    );
    const stored = await selectThread(
      connection,
      prefix,
      options.actor,
      conversationId,
    );
    const conversation = rowToThread(stored, options.actor);
    const rootThreadSummary = await selectRootThreadSummary(
      connection,
      prefix,
      options.actor,
      conversationId,
    );
    const result = parseThreadCreationResult(
      {
        operation: "create_thread",
        reconciliationStatus,
        parentConversationId: input.parentConversationId,
        rootMessageId: input.rootMessageId,
        conversation: {
          kind: "conversation_detail",
          conversation,
          _meta: createConversationSnapshotMetadata(
            options.metadata ?? defaultMetadata<Feature>(),
          ),
        },
        rootThreadSummary,
      },
      input,
    );

    if (reconciliationStatus === "created") {
      const auditEventId = createId();
      await connection.query(
        `INSERT INTO ${prefix}.chat_audit_events (
           tenant_id, event_id, actor_user_id, action, target_type, target_id,
           occurred_at, metadata, request_id
         ) VALUES ($1, $2, $3, 'thread.created', 'conversation', $4, $5, $6, $7)`,
        [
          options.actor.tenantId,
          auditEventId,
          options.actor.userId,
          conversationId,
          occurredAt,
          {
            parentConversationId: input.parentConversationId,
            rootMessageId: input.rootMessageId,
            visibility: parent.visibility,
            initialFollowing: initialFollow,
          },
          options.requestId ?? auditEventId,
        ],
      );
      const threadEventId = createId();
      await connection.query(
        `INSERT INTO ${prefix}.chat_outbox_events (
           event_id, protocol_version, tenant_id, stream_id, type,
           occurred_at, payload, expires_at
         ) VALUES (
           $1, $2, $3, $4, 'thread.created', $5, $6,
           $5::timestamptz + ($7::double precision * interval '1 millisecond')
         )`,
        [
          threadEventId,
          CHAT_PROTOCOL_VERSION,
          options.actor.tenantId,
          conversationId,
          occurredAt,
          {
            conversation: {
              id: conversation.id,
              tenantId: conversation.tenantId,
              type: conversation.type,
              visibility: conversation.visibility,
              ...(conversation.name === undefined ? {} : { name: conversation.name }),
              parentConversationId: conversation.parentConversationId,
              rootMessageId: conversation.rootMessageId,
              createdAt: conversation.createdAt,
              updatedAt: conversation.updatedAt,
              memberUserIds: conversation.memberUserIds,
            },
            rootThreadSummary,
          },
          outboxRetentionMs,
        ],
      );
      const parentEventId = createId();
      await connection.query(
        `INSERT INTO ${prefix}.chat_outbox_events (
           event_id, protocol_version, tenant_id, stream_id, type,
           occurred_at, payload, expires_at
         ) VALUES (
           $1, $2, $3, $4, 'message.thread_summary.updated', $5, $6,
           $5::timestamptz + ($7::double precision * interval '1 millisecond')
         )`,
        [
          parentEventId,
          CHAT_PROTOCOL_VERSION,
          options.actor.tenantId,
          input.parentConversationId,
          occurredAt,
          {
            parentConversationId: input.parentConversationId,
            rootMessageId: input.rootMessageId,
            rootThreadSummary,
          },
          outboxRetentionMs,
        ],
      );
    }

    // PostgreSQL evaluates target columns in table order, not SET order. Use
    // one statement timestamp so completion cannot be newer than updated_at.
    const completed = await connection.query(
      `UPDATE ${prefix}.chat_idempotency_keys
         SET state = 'completed', response_status = $1, response_body = $2,
             completed_at = GREATEST(statement_timestamp(), created_at),
             updated_at = GREATEST(statement_timestamp(), created_at)
       WHERE tenant_id = $3 AND user_id = $4 AND operation_name = $5
         AND client_key = $6 AND request_hash = $7 AND state = 'pending'`,
      [
        reconciliationStatus === "created" ? 201 : 200,
        result,
        options.actor.tenantId,
        options.actor.userId,
        CREATE_THREAD_IDEMPOTENCY_OPERATION,
        input.idempotencyKey,
        requestHash,
      ],
    );
    if (completed.rowCount !== 1) {
      throw new CreateThreadCommandError(
        "idempotency_in_progress",
        "The idempotent request is already in progress",
      );
    }
    await connection.query("COMMIT");
    return result;
  } catch (error) {
    await rollback(connection);
    throw error;
  } finally {
    connection.release();
  }
}
