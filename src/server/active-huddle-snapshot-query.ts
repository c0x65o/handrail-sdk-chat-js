import {
  HuddleContractError,
  parseHuddleSessionState,
  type HuddleParticipant,
  type HuddleSessionState,
} from "../contracts/huddle-session.js";
import type {
  ConversationId,
  IsoTimestamp,
  UserId,
} from "../contracts/identifiers.js";
import type {
  ChatPermissionAdapter,
  TrustedChatActorContext,
} from "./contracts.js";
import {
  DEFAULT_POSTGRES_SCHEMA,
  validatePostgresSchema,
  type PostgresMigrationDatabase,
} from "./postgres-migrations.js";
import { ChatAuthorizationError } from "./request-context.js";

export const ACTIVE_HUDDLE_ENTITY_POLICY_ACTION =
  "huddle.snapshot" as const;

export interface ActiveHuddleSnapshotInput {
  readonly conversationId: ConversationId;
}

export interface ActiveHuddleSnapshotQueryOptions {
  readonly database: PostgresMigrationDatabase;
  readonly permissions: Pick<
    ChatPermissionAdapter<
      string,
      typeof ACTIVE_HUDDLE_ENTITY_POLICY_ACTION
    >,
    "authorizeEntity"
  >;
  /** Trusted host-session identity; caller input cannot override these values. */
  readonly actor: TrustedChatActorContext;
  /** JSON-decoded caller input containing only a conversation identifier. */
  readonly input: unknown;
  readonly schema?: string;
}

interface StoredParticipant {
  readonly user_id: string;
  readonly joined_at: string;
  readonly left_at?: string;
}

interface StoredActiveHuddleSnapshotRow {
  readonly entity_type: string | null;
  readonly entity_id: string | null;
  readonly huddle_session_id: string | null;
  readonly huddle_status: string | null;
  readonly started_at: Date | string | null;
  readonly active_screen_share_owner_user_id: string | null;
  readonly participants: unknown;
}

const quoteIdentifier = (identifier: string): string =>
  `"${identifier.replaceAll('"', '""')}"`;

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const parseInput = (value: unknown): ActiveHuddleSnapshotInput => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HuddleContractError(
      "malformed_input",
      "input must be an object",
    );
  }

  const input = value as Record<string, unknown>;
  const keys = Object.keys(input);
  if (keys.length !== 1 || keys[0] !== "conversationId") {
    throw new HuddleContractError(
      "malformed_input",
      "input must contain only conversationId",
    );
  }
  if (!nonEmptyString(input.conversationId)) {
    throw new HuddleContractError(
      "malformed_input",
      "input.conversationId must be a non-empty string",
    );
  }

  return { conversationId: input.conversationId as ConversationId };
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

const toIsoTimestamp = (value: Date | string, label: string): IsoTimestamp => {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.valueOf())) {
    throw new Error(`Invalid ${label} returned by PostgreSQL`);
  }
  return date.toISOString() as IsoTimestamp;
};

const participantFromStored = (
  value: unknown,
  index: number,
): HuddleParticipant => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid huddle participant ${index} returned by PostgreSQL`);
  }
  const participant = value as Partial<StoredParticipant>;
  if (
    !nonEmptyString(participant.user_id) ||
    !nonEmptyString(participant.joined_at)
  ) {
    throw new Error(`Invalid huddle participant ${index} returned by PostgreSQL`);
  }

  const joinedAt = toIsoTimestamp(
    participant.joined_at,
    `huddle participant ${index} joined_at`,
  );
  return participant.left_at === undefined
    ? {
        userId: participant.user_id as UserId,
        status: "joined",
        joinedAt,
      }
    : {
        userId: participant.user_id as UserId,
        status: "left",
        joinedAt,
        leftAt: toIsoTimestamp(
          participant.left_at,
          `huddle participant ${index} left_at`,
        ),
      };
};

const stateFromRow = (
  row: StoredActiveHuddleSnapshotRow,
  conversationId: ConversationId,
): HuddleSessionState => {
  if (row.huddle_session_id === null) {
    return parseHuddleSessionState({ status: "inactive", conversationId });
  }
  if (
    (row.huddle_status !== "starting" && row.huddle_status !== "active") ||
    row.started_at === null ||
    !Array.isArray(row.participants)
  ) {
    throw new Error("Invalid live huddle snapshot returned by PostgreSQL");
  }

  return parseHuddleSessionState({
    status: row.huddle_status,
    conversationId,
    huddleSessionId: row.huddle_session_id,
    startedAt: toIsoTimestamp(row.started_at, "huddle started_at"),
    participants: row.participants.map(participantFromStored),
    screenShareOwnerUserId:
      row.active_screen_share_owner_user_id as UserId | null,
  });
};

/**
 * Loads the canonical public huddle snapshot for one actor-visible conversation.
 *
 * The single result row contains only provider-neutral huddle metadata. The
 * private recovery status `ending` and retained `ended` history both project as
 * inactive because neither is a live public contract state.
 */
export async function queryActiveHuddleSnapshot(
  options: ActiveHuddleSnapshotQueryOptions,
): Promise<HuddleSessionState> {
  const input = parseInput(options.input);
  validateActor(options.actor);

  const schema = validatePostgresSchema(
    options.schema ?? DEFAULT_POSTGRES_SCHEMA,
  );
  const prefix = quoteIdentifier(schema);
  const result = await options.database.query<StoredActiveHuddleSnapshotRow>(
    `WITH authorized_conversation AS (
       SELECT
         conversation.tenant_id,
         conversation.id,
         COALESCE(conversation.entity_type, parent.entity_type) AS entity_type,
         COALESCE(conversation.entity_id, parent.entity_id) AS entity_id
       FROM ${prefix}.chat_conversations AS conversation
       LEFT JOIN ${prefix}.chat_conversation_members AS current_member
         ON current_member.tenant_id = conversation.tenant_id
        AND current_member.conversation_id = conversation.id
        AND current_member.user_id = $2
       LEFT JOIN ${prefix}.chat_conversations AS parent
         ON parent.tenant_id = conversation.tenant_id
        AND parent.id = conversation.parent_conversation_id
       WHERE conversation.tenant_id = $1
         AND conversation.id = $3
         AND (
           (conversation.type = 'channel' AND conversation.visibility = 'public')
           OR current_member.state = 'active'
         )
       LIMIT 1
     )
     SELECT
       conversation.entity_type,
       conversation.entity_id,
       session.id AS huddle_session_id,
       session.status AS huddle_status,
       session.started_at,
       session.active_screen_share_owner_user_id,
       COALESCE(participant_data.items, '[]'::jsonb) AS participants
     FROM authorized_conversation AS conversation
     LEFT JOIN LATERAL (
       SELECT
         candidate.id,
         candidate.status,
         candidate.started_at,
         candidate.active_screen_share_owner_user_id
       FROM ${prefix}.chat_huddle_sessions AS candidate
       WHERE candidate.tenant_id = conversation.tenant_id
         AND candidate.conversation_id = conversation.id
         AND candidate.status IN ('starting', 'active')
       ORDER BY candidate.started_at DESC, candidate.id DESC
       LIMIT 1
     ) AS session ON true
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(
         jsonb_strip_nulls(jsonb_build_object(
           'user_id', participant.user_id,
           'joined_at', participant.joined_at,
           'left_at', participant.left_at
         ))
         ORDER BY participant.joined_at, participant.user_id
       ) AS items
       FROM ${prefix}.chat_huddle_participants AS participant
       WHERE participant.tenant_id = conversation.tenant_id
         AND participant.huddle_session_id = session.id
     ) AS participant_data ON session.id IS NOT NULL
     LIMIT 1`,
    [options.actor.tenantId, options.actor.userId, input.conversationId],
  );

  const row = result.rows[0];
  if (row === undefined) {
    throw new ChatAuthorizationError();
  }

  if ((row.entity_type === null) !== (row.entity_id === null)) {
    throw new ChatAuthorizationError();
  }
  if (row.entity_type !== null && row.entity_id !== null) {
    let authorized = false;
    try {
      authorized = await options.permissions.authorizeEntity({
        actor: options.actor,
        entity: { type: row.entity_type, id: row.entity_id },
        action: ACTIVE_HUDDLE_ENTITY_POLICY_ACTION,
      });
    } catch {
      throw new ChatAuthorizationError();
    }
    if (!authorized) {
      throw new ChatAuthorizationError();
    }
  }

  return stateFromRow(row, input.conversationId);
}
