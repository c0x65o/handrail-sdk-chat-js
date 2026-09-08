import type {
  ChatEvent,
  EventCursor,
  SnapshotRequiredReason,
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
import {
  authorizeChatWebSocketStream,
  type ChatWebSocketStreamId,
} from "./websocket-subscriptions.js";

export const DEFAULT_CHAT_WEBSOCKET_MAX_REPLAY_EVENTS = 500 as const;

// Cap serial authorization work independently of the event page size: denied
// streams may outnumber permitted events, even for a small replay limit.
const CHAT_WEBSOCKET_REPLAY_CANDIDATE_BUDGET = 1_000;

export const CHAT_EPHEMERAL_EVENT_TYPES = Object.freeze([
  "typing.signal",
  "presence.signal",
] as const);

// Durable notification intents are private server work, not client events.
const CHAT_INTERNAL_EVENT_TYPES = Object.freeze(["message.reminder"] as const);
const CHAT_REPLAY_EXCLUDED_EVENT_TYPES = Object.freeze([
  ...CHAT_EPHEMERAL_EVENT_TYPES,
  ...CHAT_INTERNAL_EVENT_TYPES,
]);

/** Shared by server delivery paths; not part of the public package contract. */
export const isInternalChatEventType = (type: string): boolean =>
  CHAT_INTERNAL_EVENT_TYPES.includes(
    type as (typeof CHAT_INTERNAL_EVENT_TYPES)[number],
  );

interface StoredReplayCursorRow {
  readonly replay_position: string | number;
  readonly protocol_version: string | number;
  readonly expires_at: Date | string;
  readonly type: string;
}

interface StoredReplayStreamRow {
  readonly stream_id: string;
}

interface StoredReplayEventRow {
  readonly replay_position: string | number;
  readonly event_id: string;
  readonly protocol_version: string | number;
  readonly tenant_id: string;
  readonly stream_id: string;
  readonly type: string;
  readonly occurred_at: Date | string;
  readonly payload: unknown;
  readonly expires_at: Date | string;
}

export interface PositionedChatEvent {
  readonly replayPosition: number;
  readonly event: ChatEvent;
}

export type ChatWebSocketReplayResult =
  | Readonly<{
      state: "accepted";
      cursorPosition: number;
      events: readonly PositionedChatEvent[];
      streamIds: readonly ChatWebSocketStreamId[];
    }>
  | Readonly<{
      state: "snapshot_required";
      reason: SnapshotRequiredReason;
    }>;

export interface ReadChatWebSocketReplayOptions<
  Capability extends string = string,
  EntityAction extends string = string,
> {
  readonly database: PostgresMigrationDatabase;
  readonly schema?: string;
  readonly permissions: ChatPermissionAdapter<Capability, EntityAction>;
  readonly actor: TrustedChatActorContext;
  readonly cursor: EventCursor;
  readonly protocolVersion: number;
  readonly limit?: number;
}

const quoteIdentifier = (identifier: string): string =>
  `"${identifier.replaceAll('"', '""')}"`;

const toSafePosition = (value: string | number): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new RangeError("Stored replay position is not a positive safe integer");
  }
  return parsed;
};

const toProtocolVersion = (value: string | number): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new RangeError("Stored replay protocol version is invalid");
  }
  return parsed;
};

const isExpired = (value: Date | string): boolean => {
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
  return !Number.isFinite(timestamp) || timestamp <= Date.now();
};

const isEphemeralType = (type: string): boolean =>
  CHAT_EPHEMERAL_EVENT_TYPES.includes(
    type as (typeof CHAT_EPHEMERAL_EVENT_TYPES)[number],
  );

const toPositionedEvent = (row: StoredReplayEventRow): PositionedChatEvent => {
  const occurredAt =
    row.occurred_at instanceof Date
      ? row.occurred_at.toISOString()
      : new Date(row.occurred_at).toISOString();
  return Object.freeze({
    replayPosition: toSafePosition(row.replay_position),
    event: Object.freeze({
      eventId: row.event_id,
      protocolVersion: toProtocolVersion(row.protocol_version),
      tenantId: row.tenant_id as ChatEvent["tenantId"],
      streamId: row.stream_id,
      type: row.type,
      occurredAt,
      payload: row.payload,
    }),
  });
};

/**
 * Resolves one cursor without querying outside the trusted tenant, then reads
 * a strict, bounded, currently-authorized page. All unusable cursor shapes
 * collapse to typed snapshot outcomes rather than revealing row ownership.
 */
export async function readChatWebSocketReplay<
  Capability extends string = string,
  EntityAction extends string = string,
>(
  options: ReadChatWebSocketReplayOptions<Capability, EntityAction>,
): Promise<ChatWebSocketReplayResult> {
  const schema = validatePostgresSchema(
    options.schema ?? DEFAULT_POSTGRES_SCHEMA,
  );
  const table = `${quoteIdentifier(schema)}.chat_outbox_events`;
  const limit = options.limit ?? DEFAULT_CHAT_WEBSOCKET_MAX_REPLAY_EVENTS;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError("replay limit must be a positive safe integer");
  }

  const cursorResult = await options.database.query<StoredReplayCursorRow>(
    `SELECT replay_position, protocol_version, expires_at, type
     FROM ${table}
     WHERE tenant_id = $1
       AND event_id = $2
     LIMIT 1`,
    [options.actor.tenantId, options.cursor.eventId],
  );
  const cursor = cursorResult.rows[0];
  if (cursor === undefined) {
    return Object.freeze({
      state: "snapshot_required",
      reason: "replay_unavailable",
    });
  }

  let cursorPosition: number;
  let cursorProtocol: number;
  try {
    cursorPosition = toSafePosition(cursor.replay_position);
    cursorProtocol = toProtocolVersion(cursor.protocol_version);
  } catch {
    return Object.freeze({
      state: "snapshot_required",
      reason: "replay_unavailable",
    });
  }
  if (isEphemeralType(cursor.type) || isInternalChatEventType(cursor.type)) {
    return Object.freeze({
      state: "snapshot_required",
      reason: "replay_unavailable",
    });
  }
  if (isExpired(cursor.expires_at)) {
    return Object.freeze({
      state: "snapshot_required",
      reason: "replay_expired",
    });
  }
  if (cursorProtocol !== options.protocolVersion) {
    return Object.freeze({
      state: "snapshot_required",
      reason: "replay_incompatible",
    });
  }

  const candidateResult = await options.database.query<StoredReplayStreamRow>(
    `SELECT DISTINCT stream_id
     FROM ${table}
     WHERE tenant_id = $1
       AND replay_position > $2
       AND type <> ALL($3::text[])
     ORDER BY stream_id
     LIMIT $4`,
    [
      options.actor.tenantId,
      cursorPosition,
      CHAT_REPLAY_EXCLUDED_EVENT_TYPES,
      CHAT_WEBSOCKET_REPLAY_CANDIDATE_BUDGET + 1,
    ],
  );
  // The extra row detects overflow before any per-stream authorization. Never
  // accept a truncated candidate set: it could silently omit permitted events.
  if (candidateResult.rows.length > CHAT_WEBSOCKET_REPLAY_CANDIDATE_BUDGET) {
    return Object.freeze({
      state: "snapshot_required",
      reason: "replay_overflow",
    });
  }
  const authorizedStreams: ChatWebSocketStreamId[] = [];
  for (const row of candidateResult.rows) {
    const streamId = row.stream_id as ChatWebSocketStreamId;
    const authorization = await authorizeChatWebSocketStream({
      database: options.database,
      permissions: options.permissions,
      actor: options.actor,
      streamId,
      schema,
    });
    if (authorization.authorized) {
      authorizedStreams.push(streamId);
    }
  }

  if (authorizedStreams.length === 0) {
    return Object.freeze({
      state: "accepted",
      cursorPosition,
      events: Object.freeze([]),
      streamIds: Object.freeze([]),
    });
  }

  const replayResult = await options.database.query<StoredReplayEventRow>(
    `SELECT replay_position, event_id, protocol_version, tenant_id, stream_id,
            type, occurred_at, payload, expires_at
     FROM ${table}
     WHERE tenant_id = $1
       AND replay_position > $2
       AND stream_id = ANY($3::text[])
       AND type <> ALL($4::text[])
     ORDER BY replay_position
     LIMIT $5`,
    [
      options.actor.tenantId,
      cursorPosition,
      authorizedStreams,
      CHAT_REPLAY_EXCLUDED_EVENT_TYPES,
      limit + 1,
    ],
  );
  if (replayResult.rows.some((row) => isExpired(row.expires_at))) {
    return Object.freeze({
      state: "snapshot_required",
      reason: "replay_expired",
    });
  }
  if (
    replayResult.rows.some(
      (row) => toProtocolVersion(row.protocol_version) !== options.protocolVersion,
    )
  ) {
    return Object.freeze({
      state: "snapshot_required",
      reason: "replay_incompatible",
    });
  }
  if (replayResult.rows.length > limit) {
    return Object.freeze({
      state: "snapshot_required",
      reason: "replay_overflow",
    });
  }

  return Object.freeze({
    state: "accepted",
    cursorPosition,
    events: Object.freeze(replayResult.rows.map(toPositionedEvent)),
    streamIds: Object.freeze(authorizedStreams),
  });
}

export interface ResolveBufferedReplayEventsOptions<
  Capability extends string = string,
  EntityAction extends string = string,
> {
  readonly database: PostgresMigrationDatabase;
  readonly schema?: string;
  readonly permissions: ChatPermissionAdapter<Capability, EntityAction>;
  readonly actor: TrustedChatActorContext;
  readonly protocolVersion: number;
  readonly cursorPosition: number;
  readonly events: readonly ChatEvent[];
}

/** Resolves buffered live events back to durable positions at the replay edge. */
export async function resolveBufferedReplayEvents<
  Capability extends string = string,
  EntityAction extends string = string,
>(
  options: ResolveBufferedReplayEventsOptions<Capability, EntityAction>,
): Promise<readonly PositionedChatEvent[]> {
  const durable = options.events.filter(
    (event) => !isEphemeralType(event.type) && !isInternalChatEventType(event.type),
  );
  if (durable.length === 0) {
    return Object.freeze([]);
  }
  const schema = validatePostgresSchema(
    options.schema ?? DEFAULT_POSTGRES_SCHEMA,
  );
  const table = `${quoteIdentifier(schema)}.chat_outbox_events`;
  const result = await options.database.query<StoredReplayEventRow>(
    `SELECT replay_position, event_id, protocol_version, tenant_id, stream_id,
            type, occurred_at, payload, expires_at
     FROM ${table}
     WHERE tenant_id = $1
       AND event_id = ANY($2::text[])
     ORDER BY replay_position`,
    [options.actor.tenantId, durable.map((event) => event.eventId)],
  );
  const byEventId = new Map(result.rows.map((row) => [row.event_id, row]));
  const authorized = new Map<string, boolean>();
  const positioned: PositionedChatEvent[] = [];
  for (const buffered of durable) {
    const row = byEventId.get(buffered.eventId);
    if (
      row === undefined ||
      isEphemeralType(row.type) ||
      isInternalChatEventType(row.type) ||
      toSafePosition(row.replay_position) <= options.cursorPosition ||
      isExpired(row.expires_at) ||
      toProtocolVersion(row.protocol_version) !== options.protocolVersion
    ) {
      continue;
    }
    let allowed = authorized.get(row.stream_id);
    if (allowed === undefined) {
      allowed = (
        await authorizeChatWebSocketStream({
          database: options.database,
          permissions: options.permissions,
          actor: options.actor,
          streamId: row.stream_id as ChatWebSocketStreamId,
          schema,
        })
      ).authorized;
      authorized.set(row.stream_id, allowed);
    }
    if (allowed) {
      positioned.push(toPositionedEvent(row));
    }
  }
  positioned.sort((left, right) => left.replayPosition - right.replayPosition);
  return Object.freeze(positioned);
}
