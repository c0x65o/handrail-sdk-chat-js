import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import {
  deriveCanonicalParticipantIdentity,
  parseConversationCreationInput,
  parseConversationCreationResult,
  type CanonicalParticipantIdentity,
  type ConversationCreationInput,
  type ConversationCreationResult,
} from "../contracts/conversation-creation.js";
import {
  MAX_CONVERSATION_LIST_ACTIVE_MEMBER_USER_IDS,
  createConversationSnapshotMetadata,
  type ConversationDetailSnapshotConversation,
} from "../contracts/conversation-snapshot.js";
import type { ConversationVisibility } from "../contracts/conversation.js";
import type {
  ConversationId,
  IsoTimestamp,
  MessageSequence,
  TenantId,
  UserId,
} from "../contracts/identifiers.js";
import {
  CHAT_PROTOCOL_VERSION,
  type ServerHandshakeMetadataInput,
} from "../contracts/realtime.js";
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
import { handrailChatPostgresMigrations } from "./postgres-schema-migrations.js";
import { ChatAuthorizationError } from "./request-context.js";

const packageManifest = createRequire(import.meta.url)("../../package.json") as {
  readonly version: string;
};

export const CREATE_CONVERSATION_CAPABILITY = "conversation.create" as const;
export const CREATE_CONVERSATION_ENTITY_POLICY_ACTION =
  "conversation.create" as const;
export const CREATE_CONVERSATION_IDEMPOTENCY_OPERATION =
  "conversation.create" as const;
export const DEFAULT_CREATE_CONVERSATION_IDEMPOTENCY_TTL_MS =
  24 * 60 * 60 * 1_000;
export const DEFAULT_CREATE_CONVERSATION_OUTBOX_RETENTION_MS =
  7 * 24 * 60 * 60 * 1_000;

export type CreateConversationCommandErrorCode =
  | "idempotency_conflict"
  | "idempotency_in_progress"
  | "directory_user_unavailable";

/** Stable command failure suitable for a future transport boundary. */
export class CreateConversationCommandError extends Error {
  public readonly statusCode: number;

  public constructor(
    public readonly code: CreateConversationCommandErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CreateConversationCommandError";
    this.statusCode = code.startsWith("idempotency_") ? 409 : 422;
  }
}

export interface CreateConversationCommandOptions<Feature extends string = string> {
  readonly database: PostgresMigrationDatabase;
  readonly directory: Pick<ChatDirectoryAdapter, "getUser">;
  readonly permissions: Pick<
    ChatPermissionAdapter<
      string,
      typeof CREATE_CONVERSATION_ENTITY_POLICY_ACTION
    >,
    "getCapabilities" | "authorizeEntity"
  >;
  /** Trusted host-session identity; caller input cannot override these values. */
  readonly actor: TrustedChatActorContext;
  /** JSON-decoded caller input, validated by the shared creation contract. */
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

interface StoredConversationRow {
  readonly id: string;
  readonly type: string;
  readonly visibility: string;
  readonly name: string | null;
  readonly entity_type: string | null;
  readonly entity_id: string | null;
  readonly current_message_sequence: string | number;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
  readonly member_role: string | null;
  readonly member_state: string | null;
  readonly member_joined_at: Date | string | null;
  readonly member_updated_at: Date | string | null;
  readonly last_read_sequence: string | number | null;
  readonly read_updated_at: Date | string | null;
  readonly notification_level: string | null;
  readonly muted: boolean | null;
  readonly muted_until: Date | string | null;
  readonly preference_revision: string | number | null;
  readonly preference_updated_at: Date | string | null;
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

const requireCreateCapability = async (
  actor: TrustedChatActorContext,
  permissions: CreateConversationCommandOptions["permissions"],
): Promise<void> => {
  try {
    const capabilities = await permissions.getCapabilities({ actor });
    if (
      !Array.isArray(capabilities) ||
      !capabilities.every(nonEmptyString) ||
      !capabilities.includes(CREATE_CONVERSATION_CAPABILITY)
    ) {
      throw new Error("denied");
    }
  } catch {
    throw new ChatAuthorizationError();
  }
};

const authorizeEntity = async (
  input: ConversationCreationInput,
  actor: TrustedChatActorContext,
  permissions: CreateConversationCommandOptions["permissions"],
): Promise<void> => {
  if (input.type !== "channel" || input.entity === undefined) return;
  try {
    const allowed = await permissions.authorizeEntity({
      actor,
      entity: input.entity,
      action: CREATE_CONVERSATION_ENTITY_POLICY_ACTION,
    });
    if (!allowed) throw new Error("denied");
  } catch {
    throw new ChatAuthorizationError();
  }
};

const validateIntendedMembers = async (
  input: ConversationCreationInput,
  actor: TrustedChatActorContext,
  directory: Pick<ChatDirectoryAdapter, "getUser">,
): Promise<CanonicalParticipantIdentity | undefined> => {
  if (input.type === "channel") return undefined;
  const identity = deriveCanonicalParticipantIdentity(
    actor.userId,
    input.intendedMemberUserIds,
  );
  try {
    const users = await Promise.all(
      input.intendedMemberUserIds.map((userId) =>
        directory.getUser({ actor, userId }),
      ),
    );
    const valid = users.every((user, index) => {
      const expectedUserId = input.intendedMemberUserIds[index];
      return (
        user !== null &&
        user.kind !== "redacted" &&
        user.kind !== "unavailable" &&
        user.tenantId === actor.tenantId &&
        user.userId === expectedUserId
      );
    });
    if (!valid) throw new Error("unavailable");
  } catch {
    throw new CreateConversationCommandError(
      "directory_user_unavailable",
      "One or more intended conversation members are unavailable",
    );
  }
  return identity;
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

const hashRequest = (
  input: ConversationCreationInput,
  participantIdentity: CanonicalParticipantIdentity | undefined,
): string => {
  const canonical =
    input.type === "channel"
      ? {
          operation: input.operation,
          type: input.type,
          name: input.name,
          visibility: input.visibility,
          clientRequestId: input.clientRequestId,
          ...(input.entity === undefined ? {} : { entity: input.entity }),
        }
      : {
          operation: input.operation,
          type: input.type,
          visibility: input.visibility,
          clientRequestId: input.clientRequestId,
          participantIdentity: participantIdentity?.key,
        };
  return `sha256:${createHash("sha256").update(canonicalJson(canonical)).digest("hex")}`;
};

const toIsoTimestamp = (value: Date | string, label: string): IsoTimestamp => {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.valueOf())) {
    throw new Error(`PostgreSQL returned an invalid ${label}`);
  }
  return date.toISOString() as IsoTimestamp;
};

const toSequence = (value: string | number): MessageSequence => {
  const sequence = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error("PostgreSQL returned an invalid conversation sequence");
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

const isCreationType = (
  value: string,
): value is "channel" | "direct" | "group_direct" =>
  value === "channel" || value === "direct" || value === "group_direct";

const isVisibility = (value: string): value is ConversationVisibility =>
  value === "public" || value === "private";

const rowToConversation = (
  row: StoredConversationRow,
  actor: TrustedChatActorContext,
): ConversationDetailSnapshotConversation => {
  if (
    !isCreationType(row.type) ||
    !isVisibility(row.visibility) ||
    row.member_role === null ||
    row.member_state !== "active" ||
    row.member_joined_at === null ||
    row.member_updated_at === null
  ) {
    throw new Error("PostgreSQL returned an invalid created conversation");
  }
  const type = row.type;
  const visibility = row.visibility;
  const conversationId = row.id as ConversationId;
  const userId = actor.userId as UserId;
  const createdAt = toIsoTimestamp(row.created_at, "conversation timestamp");
  const updatedAt = toIsoTimestamp(row.updated_at, "conversation timestamp");
  const memberUpdatedAt = toIsoTimestamp(row.member_updated_at, "membership timestamp");
  const readUpdatedAt =
    row.read_updated_at === null
      ? memberUpdatedAt
      : toIsoTimestamp(row.read_updated_at, "read cursor timestamp");
  const preferenceUpdatedAt =
    row.preference_updated_at === null
      ? memberUpdatedAt
      : toIsoTimestamp(row.preference_updated_at, "preference timestamp");
  const memberUserIds = Object.freeze(
    row.member_user_ids.map((id) => id as UserId),
  );
  const base = {
    id: conversationId,
    tenantId: actor.tenantId as TenantId,
    visibility,
    createdAt,
    updatedAt,
    latestSequence: toSequence(row.current_message_sequence),
    activityAt: updatedAt,
    unreadMentionCount: 0,
    currentMember: {
      tenantId: actor.tenantId as TenantId,
      conversationId,
      userId,
      role: row.member_role as "owner" | "moderator" | "member",
      state: "active" as const,
      joinedAt: toIsoTimestamp(row.member_joined_at, "membership timestamp"),
      updatedAt: memberUpdatedAt,
    },
    currentReadState: {
      conversationId,
      userId,
      lastReadSequence:
        row.last_read_sequence === null ? 0 : toSequence(row.last_read_sequence),
      updatedAt: readUpdatedAt,
    },
    activeMemberUserIds: Object.freeze(
      memberUserIds.slice(0, MAX_CONVERSATION_LIST_ACTIVE_MEMBER_USER_IDS),
    ),
    memberUserIds,
    currentPreference: {
      preferenceRevision: row.preference_revision === null
        ? 0
        : toSequence(row.preference_revision),
      conversationId,
      userId,
      isStarred: false,
      notificationPreference:
        row.notification_level === "mentions" || row.notification_level === "none"
          ? row.notification_level
          : "all",
      mute:
        row.muted === true
          ? {
              muted: true as const,
              ...(row.muted_until === null
                ? {}
                : { mutedUntil: toIsoTimestamp(row.muted_until, "mute timestamp") }),
            }
          : { muted: false as const },
      updatedAt: preferenceUpdatedAt,
    },
  };
  if (type === "channel") {
    if (row.name === null) throw new Error("PostgreSQL returned an unnamed channel");
    return {
      ...base,
      type: "channel",
      name: row.name,
      ...(row.entity_type === null || row.entity_id === null
        ? {}
        : { entity: { type: row.entity_type, id: row.entity_id } }),
    } as ConversationDetailSnapshotConversation;
  }
  return {
    ...base,
    type,
    visibility: "private",
  } as ConversationDetailSnapshotConversation;
};

const selectConversation = async (
  connection: PostgresMigrationConnection,
  prefix: string,
  actor: TrustedChatActorContext,
  conversationId: string,
): Promise<StoredConversationRow> => {
  const result = await connection.query<StoredConversationRow>(
    `SELECT conversation.id, conversation.type, conversation.visibility,
            conversation.name, conversation.entity_type, conversation.entity_id,
            conversation.current_message_sequence, conversation.created_at,
            conversation.updated_at, member.role AS member_role,
            member.state AS member_state, member.joined_at AS member_joined_at,
            member.updated_at AS member_updated_at,
            cursor.last_read_sequence, cursor.updated_at AS read_updated_at,
            preference.notification_level, preference.muted,
            preference.muted_until, preference.preference_revision, preference.updated_at AS preference_updated_at,
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
       LEFT JOIN ${prefix}.chat_read_cursors AS cursor
         ON cursor.tenant_id = member.tenant_id
        AND cursor.conversation_id = member.conversation_id
        AND cursor.user_id = member.user_id
       LEFT JOIN ${prefix}.chat_conversation_preferences AS preference
         ON preference.tenant_id = member.tenant_id
        AND preference.conversation_id = member.conversation_id
        AND preference.user_id = member.user_id
       WHERE conversation.tenant_id = $1 AND conversation.id = $3
       LIMIT 1`,
    [actor.tenantId, actor.userId, conversationId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("Created conversation could not be reloaded");
  return row;
};

const findEquivalentConversation = async (
  connection: PostgresMigrationConnection,
  prefix: string,
  actor: TrustedChatActorContext,
  type: "direct" | "group_direct",
  participantIdentity: CanonicalParticipantIdentity,
): Promise<StoredConversationRow | undefined> => {
  await connection.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    JSON.stringify([actor.tenantId, type, participantIdentity.key]),
  ]);
  const result = await connection.query<{ readonly id: string }>(
    `SELECT conversation.id
       FROM ${prefix}.chat_conversations AS conversation
       WHERE conversation.tenant_id = $1
         AND conversation.type = $2
         AND conversation.archived_at IS NULL
         AND ARRAY(
           SELECT member.user_id
           FROM ${prefix}.chat_conversation_members AS member
           WHERE member.tenant_id = conversation.tenant_id
             AND member.conversation_id = conversation.id
             AND member.state = 'active'
           ORDER BY member.user_id
         ) = $3::text[]
       ORDER BY conversation.created_at, conversation.id
       LIMIT 1`,
    [actor.tenantId, type, participantIdentity.participantUserIds],
  );
  const id = result.rows[0]?.id;
  return id === undefined
    ? undefined
    : selectConversation(connection, prefix, actor, id);
};

const replayStoredResult = (
  stored: unknown,
  input: ConversationCreationInput,
): ConversationCreationResult => {
  const canonical = parseConversationCreationResult(stored, input);
  return parseConversationCreationResult(
    { ...canonical, reconciliationStatus: "replayed" },
    input,
  );
};

const rollback = async (connection: PostgresMigrationConnection): Promise<void> => {
  await connection.query("ROLLBACK").catch(() => undefined);
};

/** Atomically creates or reconciles one channel, direct, or group-direct stream. */
export async function createConversation<Feature extends string = string>(
  options: CreateConversationCommandOptions<Feature>,
): Promise<ConversationCreationResult> {
  validateActor(options.actor);
  const input = parseConversationCreationInput(options.input);
  const participantIdentity =
    input.type === "channel"
      ? undefined
      : deriveCanonicalParticipantIdentity(
          options.actor.userId,
          input.intendedMemberUserIds,
        );
  const schema = validatePostgresSchema(options.schema ?? DEFAULT_POSTGRES_SCHEMA);
  const prefix = quoteIdentifier(schema);
  const idempotencyTtlMs = positiveSafeInteger(
    options.idempotencyTtlMs ?? DEFAULT_CREATE_CONVERSATION_IDEMPOTENCY_TTL_MS,
    "idempotencyTtlMs",
  );
  const outboxRetentionMs = positiveSafeInteger(
    options.outboxRetentionMs ?? DEFAULT_CREATE_CONVERSATION_OUTBOX_RETENTION_MS,
    "outboxRetentionMs",
  );
  const requestHash = hashRequest(input, participantIdentity);
  const createId = options.createId ?? randomUUID;

  await requireCreateCapability(options.actor, options.permissions);

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
        CREATE_CONVERSATION_IDEMPOTENCY_OPERATION,
        input.idempotencyKey,
        requestHash,
        idempotencyTtlMs,
      ],
    );
    const claimed = claim.rows[0];
    if (claimed === undefined) {
      throw new CreateConversationCommandError(
        "idempotency_conflict",
        "The idempotency key was already used for a different request",
      );
    }
    if (claimed.idempotency_state === "completed") {
      if (claimed.stored_response_body === null) {
        throw new Error("Completed create-conversation outcome has no response body");
      }
      const replay = replayStoredResult(claimed.stored_response_body, input);
      await connection.query("COMMIT");
      return replay;
    }
    if (claimed.idempotency_state !== "pending") {
      throw new Error("PostgreSQL returned an invalid idempotency state");
    }

    await authorizeEntity(input, options.actor, options.permissions);
    const validatedIdentity = await validateIntendedMembers(
      input,
      options.actor,
      options.directory,
    );

    let stored: StoredConversationRow | undefined;
    let reconciliationStatus: "created" | "existing_equivalent" = "created";
    if (input.type !== "channel" && validatedIdentity !== undefined) {
      stored = await findEquivalentConversation(
        connection,
        prefix,
        options.actor,
        input.type,
        validatedIdentity,
      );
      if (stored !== undefined) reconciliationStatus = "existing_equivalent";
    }

    if (stored === undefined) {
      const conversationId = createId();
      const inserted = await connection.query<{ created_at: Date | string }>(
        `INSERT INTO ${prefix}.chat_conversations (
           tenant_id, id, type, visibility, name, entity_type, entity_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING created_at`,
        [
          options.actor.tenantId,
          conversationId,
          input.type,
          input.visibility,
          input.type === "channel" ? input.name : null,
          input.type === "channel" ? input.entity?.type ?? null : null,
          input.type === "channel" ? input.entity?.id ?? null : null,
        ],
      );
      const occurredAt = toIsoTimestamp(
        inserted.rows[0]?.created_at ?? new Date(Number.NaN),
        "conversation timestamp",
      );
      const participantUserIds =
        validatedIdentity?.participantUserIds ?? [options.actor.userId as UserId];
      await connection.query(
        `INSERT INTO ${prefix}.chat_conversation_members (
           tenant_id, conversation_id, user_id, role, state, joined_at, updated_at
         ) SELECT $1, $2, member.user_id,
                  CASE WHEN member.user_id = $3 THEN 'owner' ELSE 'member' END,
                  'active', $4, $4
             FROM unnest($5::text[]) AS member(user_id)`,
        [
          options.actor.tenantId,
          conversationId,
          options.actor.userId,
          occurredAt,
          participantUserIds,
        ],
      );
      await connection.query(
        `INSERT INTO ${prefix}.chat_read_cursors (
           tenant_id, conversation_id, user_id, last_read_sequence, updated_at
         ) SELECT $1, $2, user_id, 0, $3 FROM unnest($4::text[]) AS member(user_id)`,
        [options.actor.tenantId, conversationId, occurredAt, participantUserIds],
      );
      await connection.query(
        `INSERT INTO ${prefix}.chat_conversation_preferences (
           tenant_id, conversation_id, user_id, notification_level,
           muted, created_at, updated_at
         ) SELECT $1, $2, user_id, 'all', false, $3, $3
             FROM unnest($4::text[]) AS member(user_id)`,
        [options.actor.tenantId, conversationId, occurredAt, participantUserIds],
      );

      stored = await selectConversation(
        connection,
        prefix,
        options.actor,
        conversationId,
      );
      const conversation = rowToConversation(stored, options.actor);
      const auditEventId = createId();
      await connection.query(
        `INSERT INTO ${prefix}.chat_audit_events (
           tenant_id, event_id, actor_user_id, action, target_type, target_id,
           occurred_at, metadata, request_id
         ) VALUES ($1, $2, $3, 'conversation.created', 'conversation', $4, $5, $6, $7)`,
        [
          options.actor.tenantId,
          auditEventId,
          options.actor.userId,
          conversationId,
          occurredAt,
          {
            conversationType: input.type,
            visibility: input.visibility,
            participantCount: participantUserIds.length,
            entityScoped: input.type === "channel" && input.entity !== undefined,
          },
          options.requestId ?? auditEventId,
        ],
      );
      await connection.query(
        `INSERT INTO ${prefix}.chat_outbox_events (
           event_id, protocol_version, tenant_id, stream_id, type,
           occurred_at, payload, expires_at
         ) VALUES (
           $1, $2, $3, $4, 'conversation.created', $5, $6,
           $5::timestamptz + ($7::double precision * interval '1 millisecond')
         )`,
        [
          createId(),
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
              ...(conversation.type === "channel"
                ? {
                    name: conversation.name,
                    ...(conversation.entity === undefined
                      ? {}
                      : { entity: conversation.entity }),
                  }
                : {}),
              createdAt: conversation.createdAt,
              updatedAt: conversation.updatedAt,
              memberUserIds: conversation.memberUserIds,
            },
            clientRequestId: input.clientRequestId,
          },
          outboxRetentionMs,
        ],
      );
    }

    const conversation = rowToConversation(stored, options.actor);
    const result = parseConversationCreationResult(
      {
        operation: "create_conversation",
        type: input.type,
        reconciliationStatus,
        clientRequestId: input.clientRequestId,
        conversation: {
          kind: "conversation_detail",
          conversation,
          _meta: createConversationSnapshotMetadata(
            options.metadata ?? defaultMetadata<Feature>(),
          ),
        },
        ...(validatedIdentity === undefined
          ? {}
          : { participantIdentity: validatedIdentity }),
      },
      input,
    );
    const completed = await connection.query(
      `UPDATE ${prefix}.chat_idempotency_keys
         SET state = 'completed', response_status = $1, response_body = $2,
             completed_at = clock_timestamp(), updated_at = clock_timestamp()
       WHERE tenant_id = $3 AND user_id = $4 AND operation_name = $5
         AND client_key = $6 AND request_hash = $7 AND state = 'pending'`,
      [
        reconciliationStatus === "created" ? 201 : 200,
        result,
        options.actor.tenantId,
        options.actor.userId,
        CREATE_CONVERSATION_IDEMPOTENCY_OPERATION,
        input.idempotencyKey,
        requestHash,
      ],
    );
    if (completed.rowCount !== 1) {
      throw new CreateConversationCommandError(
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
