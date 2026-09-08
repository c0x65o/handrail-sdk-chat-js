import { createHash } from "node:crypto";

import {
  MESSAGE_SEARCH_MAX_CURSOR_LENGTH,
  MessageSearchParseError,
  parseMessageSearchRequest,
  parseMessageSearchResponse,
  type MessageSearchCursor,
  type MessageSearchRequest,
  type MessageSearchResponse,
} from "../contracts/message-search.js";
import type {
  ConversationId,
  IsoTimestamp,
  MessageId,
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

export const MESSAGE_SEARCH_ENTITY_POLICY_ACTION = "message.search" as const;
export const MESSAGE_SEARCH_CURSOR_VERSION = 1 as const;
export const MESSAGE_SEARCH_SNIPPET_MAX_LENGTH = 4_096 as const;
/** Maximum ranked database candidates inspected by one search request. */
export const MESSAGE_SEARCH_MAX_CANDIDATE_SCAN_COUNT = 500 as const;
const MESSAGE_SEARCH_AUTHOR_DISPLAY_NAME_MAX_LENGTH = 256;

export type MessageSearchQueryErrorCode = "invalid_cursor" | "invalid_result";

/** Stable query-boundary errors that are safe for the HTTP layer to classify. */
export class MessageSearchQueryError extends Error {
  public constructor(public readonly code: MessageSearchQueryErrorCode) {
    super(code === "invalid_cursor" ? "Invalid message-search cursor" : "Invalid message-search result");
    this.name = "MessageSearchQueryError";
  }
}

export interface MessageSearchQueryOptions {
  readonly database: PostgresMigrationDatabase;
  readonly permissions: Pick<
    ChatPermissionAdapter<string, typeof MESSAGE_SEARCH_ENTITY_POLICY_ACTION>,
    "authorizeEntity"
  >;
  /** Trusted host-session identity; caller input cannot override these values. */
  readonly actor: TrustedChatActorContext;
  /** JSON-decoded caller input, validated before database access. */
  readonly input: unknown;
  readonly schema?: string;
}

interface StoredConversationAuthorizationRow {
  readonly id: string;
  readonly entity_type: string | null;
  readonly entity_id: string | null;
}

interface StoredMessageSearchRow extends StoredConversationAuthorizationRow {
  readonly message_id: string;
  readonly author_user_id: string;
  readonly forwarded_author_display_name: string | null;
  readonly content_text: string;
  readonly conversation_name: string | null;
  readonly created_at: Date | string;
  readonly relevance: number | string;
}

interface MessageSearchPosition {
  readonly relevance: number;
  readonly createdAt: string;
  readonly messageId: string;
}

interface EncodedMessageSearchCursor {
  readonly v: typeof MESSAGE_SEARCH_CURSOR_VERSION;
  readonly f: string;
  readonly r: number;
  readonly t: string;
  readonly m: string;
}

const quoteIdentifier = (identifier: string): string =>
  `"${identifier.replaceAll('"', '""')}"`;

const cursorError = (): MessageSearchQueryError =>
  new MessageSearchQueryError("invalid_cursor");

const toIsoTimestamp = (value: Date | string): IsoTimestamp => {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.valueOf())) {
    throw new MessageSearchQueryError("invalid_result");
  }
  return date.toISOString() as IsoTimestamp;
};

const toRelevance = (value: number | string): number => {
  const relevance = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(relevance) || relevance < 0) {
    throw new MessageSearchQueryError("invalid_result");
  }
  return relevance;
};

const toAuthorDisplayName = (value: string | null): string | undefined =>
  value !== null &&
  value.trim().length > 0 &&
  value.length <= MESSAGE_SEARCH_AUTHOR_DISPLAY_NAME_MAX_LENGTH &&
  !value.includes("\u0000")
    ? value
    : undefined;

const canonicalRequestFingerprint = (
  actor: TrustedChatActorContext,
  request: MessageSearchRequest,
): string => {
  const filters = request.filters;
  const canonical = JSON.stringify({
    tenantId: actor.tenantId,
    userId: actor.userId,
    query: request.query,
    filters: {
      conversationIds: [...(filters?.conversationIds ?? [])].sort(),
      authorUserIds: [...(filters?.authorUserIds ?? [])].sort(),
      sentAfter: filters?.sentAfter ?? null,
      sentBefore: filters?.sentBefore ?? null,
    },
  });
  return createHash("sha256").update(canonical).digest("hex");
};

const encodeCursor = (
  fingerprint: string,
  position: MessageSearchPosition,
): MessageSearchCursor => {
  const value: EncodedMessageSearchCursor = {
    v: MESSAGE_SEARCH_CURSOR_VERSION,
    f: fingerprint,
    r: position.relevance,
    t: position.createdAt,
    m: position.messageId,
  };
  const cursor = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  if (cursor.length > MESSAGE_SEARCH_MAX_CURSOR_LENGTH) {
    throw new MessageSearchQueryError("invalid_result");
  }
  return cursor as MessageSearchCursor;
};

const decodeCursor = (
  cursor: MessageSearchCursor,
  expectedFingerprint: string,
): MessageSearchPosition => {
  try {
    if (!/^[A-Za-z0-9_-]+$/u.test(cursor)) throw cursorError();
    const decoded = Buffer.from(cursor, "base64url");
    if (decoded.toString("base64url") !== cursor) throw cursorError();
    const value = JSON.parse(decoded.toString("utf8")) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw cursorError();
    }
    const candidate = value as Record<string, unknown>;
    if (
      Object.keys(candidate).sort().join(",") !== "f,m,r,t,v" ||
      candidate.v !== MESSAGE_SEARCH_CURSOR_VERSION ||
      candidate.f !== expectedFingerprint ||
      typeof candidate.r !== "number" ||
      !Number.isFinite(candidate.r) ||
      candidate.r < 0 ||
      typeof candidate.t !== "string" ||
      new Date(candidate.t).toISOString() !== candidate.t ||
      typeof candidate.m !== "string" ||
      candidate.m.length === 0 ||
      candidate.m.length > 255
    ) {
      throw cursorError();
    }
    return {
      relevance: candidate.r,
      createdAt: candidate.t,
      messageId: candidate.m,
    };
  } catch (error) {
    if (error instanceof MessageSearchQueryError) throw error;
    throw cursorError();
  }
};

/** Removes common markup constructs and collapses whitespace for display-only snippets. */
const toPlainTextSnippet = (value: string): string => {
  const snippet = value
    .replaceAll("\u0000", "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
    .replace(/<[^>]*>/gu, " ")
    .replace(/`{1,3}([^`]*)`{1,3}/gu, "$1")
    .replace(/(^|\n)\s{0,3}(?:#{1,6}|>|[-+*]|\d+[.)])\s+/gu, "$1")
    .replace(/[*_~]/gu, "")
    .replaceAll(/\s+/gu, " ")
    .trim()
    .slice(0, MESSAGE_SEARCH_SNIPPET_MAX_LENGTH);
  if (snippet.length === 0) {
    throw new MessageSearchQueryError("invalid_result");
  }
  return snippet;
};

const authorizeConversationEntity = async (
  options: MessageSearchQueryOptions,
  row: StoredConversationAuthorizationRow,
): Promise<boolean> => {
  if (row.entity_type === null && row.entity_id === null) return true;
  if (row.entity_type === null || row.entity_id === null) {
    throw new ChatAuthorizationError();
  }
  try {
    return (
      (await options.permissions.authorizeEntity({
        actor: options.actor,
        entity: { type: row.entity_type, id: row.entity_id },
        action: MESSAGE_SEARCH_ENTITY_POLICY_ACTION,
      })) === true
    );
  } catch {
    throw new ChatAuthorizationError();
  }
};

/**
 * Set-based equivalent of authorizeThreadAccess(operation: "read"): a thread
 * uses its current, unarchived, non-thread parent for membership and entity
 * policy. Child participation never grants or limits read access. Keeping this
 * join shared by both search paths avoids a helper query for every thread.
 * Search additionally excludes administratively archived children below.
 */
const conversationAccessJoins = (prefix: string): string => `
     INNER JOIN ${prefix}.chat_conversations AS access_conversation
       ON access_conversation.tenant_id = conversation.tenant_id
      AND access_conversation.id = CASE WHEN conversation.type = 'thread'
        THEN conversation.parent_conversation_id ELSE conversation.id END
      AND (conversation.type <> 'thread' OR (
        access_conversation.type IN ('channel', 'direct', 'group_direct')
        AND access_conversation.archived_at IS NULL
      ))
     LEFT JOIN ${prefix}.chat_conversation_members AS current_member
       ON current_member.tenant_id = access_conversation.tenant_id
      AND current_member.conversation_id = access_conversation.id
      AND current_member.user_id = $2`;

const conversationAccessPredicate = `(
  (access_conversation.type = 'channel' AND access_conversation.visibility = 'public')
  OR current_member.state = 'active'
)`;

const authorizeFilteredConversations = async (
  options: MessageSearchQueryOptions,
  request: MessageSearchRequest,
  prefix: string,
  authorizationByConversation: Map<string, boolean>,
): Promise<void> => {
  const conversationIds = request.filters?.conversationIds;
  if (conversationIds === undefined || conversationIds.length === 0) return;

  const result = await options.database.query<StoredConversationAuthorizationRow>(
    `SELECT conversation.id, access_conversation.entity_type, access_conversation.entity_id
     FROM ${prefix}.chat_conversations AS conversation
     ${conversationAccessJoins(prefix)}
     WHERE conversation.tenant_id = $1
       AND conversation.id = ANY($3::text[])
       AND conversation.archived_at IS NULL
       AND ${conversationAccessPredicate}`,
    [options.actor.tenantId, options.actor.userId, conversationIds],
  );
  const rowsById = new Map(result.rows.map((row) => [row.id, row]));
  for (const conversationId of conversationIds) {
    const row = rowsById.get(conversationId);
    if (row === undefined) throw new ChatAuthorizationError();
    const authorized = await authorizeConversationEntity(options, row);
    authorizationByConversation.set(conversationId, authorized);
    if (!authorized) throw new ChatAuthorizationError();
  }
};

const loadCandidateBatch = async (
  options: MessageSearchQueryOptions,
  request: MessageSearchRequest,
  prefix: string,
  position: MessageSearchPosition | undefined,
  limit: number,
): Promise<readonly StoredMessageSearchRow[]> => {
  const values: unknown[] = [
    options.actor.tenantId,
    options.actor.userId,
    request.query,
  ];
  const predicates = [
    "message.tenant_id = $1",
    "message.deleted_at IS NULL",
    "conversation.archived_at IS NULL",
    conversationAccessPredicate,
    "message.search_vector @@ search_input.query",
  ];

  const filters = request.filters;
  if (filters?.conversationIds !== undefined) {
    values.push(filters.conversationIds);
    predicates.push(`message.conversation_id = ANY($${values.length}::text[])`);
  }
  if (filters?.authorUserIds !== undefined) {
    values.push(filters.authorUserIds);
    predicates.push(`message.author_user_id = ANY($${values.length}::text[])`);
  }
  if (filters?.sentAfter !== undefined) {
    values.push(filters.sentAfter);
    predicates.push(`message.created_at > $${values.length}::timestamptz`);
  }
  if (filters?.sentBefore !== undefined) {
    values.push(filters.sentBefore);
    predicates.push(`message.created_at < $${values.length}::timestamptz`);
  }

  let cursorPredicate = "";
  if (position !== undefined) {
    values.push(position.relevance, position.createdAt, position.messageId);
    cursorPredicate = `WHERE
      (ranked.relevance, ranked.created_at, ranked.message_id) <
      ($${values.length - 2}::real, $${values.length - 1}::timestamptz, $${values.length}::text)`;
  }
  values.push(limit);

  const result = await options.database.query<StoredMessageSearchRow>(
    `WITH search_input AS (
       SELECT pg_catalog.websearch_to_tsquery('simple', $3) AS query
     ), ranked AS (
       SELECT
         conversation.id,
         access_conversation.entity_type,
         access_conversation.entity_id,
         conversation.name AS conversation_name,
         message.id AS message_id,
         message.author_user_id,
         CASE
           WHEN pg_catalog.jsonb_typeof(
             message.content #> '{forwarded,originalAuthor,displayName}'
           ) = 'string'
           THEN message.content #>> '{forwarded,originalAuthor,displayName}'
           ELSE NULL
         END AS forwarded_author_display_name,
         message.content ->> 'text' AS content_text,
         message.created_at,
         pg_catalog.ts_rank_cd(message.search_vector, search_input.query) AS relevance
       FROM ${prefix}.chat_messages AS message
       INNER JOIN ${prefix}.chat_conversations AS conversation
         ON conversation.tenant_id = message.tenant_id
        AND conversation.id = message.conversation_id
       ${conversationAccessJoins(prefix)}
       CROSS JOIN search_input
       WHERE ${predicates.join("\n         AND ")}
     )
     SELECT *
     FROM ranked
     ${cursorPredicate}
     ORDER BY ranked.relevance DESC, ranked.created_at DESC, ranked.message_id DESC
     LIMIT $${values.length}`,
    values,
  );
  return result.rows;
};

/**
 * Searches actor-visible messages with tenant-scoped PostgreSQL FTS and
 * authorization-aware keyset pagination.
 * At most 10 candidate batch queries (minimum batch size 50, scan cap 500),
 * plus one query for explicit conversation filters. Parent access adds no
 * queries; entity authorization is cached per conversation for this request.
 */
export async function queryMessageSearch(
  options: MessageSearchQueryOptions,
): Promise<MessageSearchResponse> {
  let request: MessageSearchRequest;
  try {
    request = parseMessageSearchRequest(options.input);
  } catch (error) {
    if (error instanceof MessageSearchParseError) throw error;
    throw new MessageSearchQueryError("invalid_result");
  }
  if (!options.actor.tenantId || !options.actor.userId) {
    throw new TypeError("A trusted tenant and user are required");
  }

  const schema = validatePostgresSchema(options.schema ?? DEFAULT_POSTGRES_SCHEMA);
  const prefix = quoteIdentifier(schema);
  const fingerprint = canonicalRequestFingerprint(options.actor, request);
  const requestPosition =
    request.cursor === undefined
      ? undefined
      : decodeCursor(request.cursor, fingerprint);
  const authorizationByConversation = new Map<string, boolean>();
  await authorizeFilteredConversations(
    options,
    request,
    prefix,
    authorizationByConversation,
  );

  const authorizedRows: Array<{
    row: StoredMessageSearchRow;
    position: MessageSearchPosition;
  }> = [];
  const batchSize = Math.max(50, Math.min(500, request.pageSize * 4));
  let scanPosition = requestPosition;
  let candidateScanCount = 0;

  while (
    authorizedRows.length <= request.pageSize &&
    candidateScanCount < MESSAGE_SEARCH_MAX_CANDIDATE_SCAN_COUNT
  ) {
    const candidateScanRemaining =
      MESSAGE_SEARCH_MAX_CANDIDATE_SCAN_COUNT - candidateScanCount;
    const candidateBatchSize = Math.min(batchSize, candidateScanRemaining);
    const rows = await loadCandidateBatch(
      options,
      request,
      prefix,
      scanPosition,
      candidateBatchSize,
    );
    if (rows.length === 0) break;

    for (const row of rows) {
      candidateScanCount += 1;
      const position = {
        relevance: toRelevance(row.relevance),
        createdAt: toIsoTimestamp(row.created_at),
        messageId: row.message_id,
      };
      scanPosition = position;

      let authorized = authorizationByConversation.get(row.id);
      if (authorized === undefined) {
        authorized = await authorizeConversationEntity(options, row);
        authorizationByConversation.set(row.id, authorized);
      }
      if (authorized) authorizedRows.push({ row, position });
      if (authorizedRows.length > request.pageSize) break;
    }
    if (
      authorizedRows.length > request.pageSize ||
      rows.length < candidateBatchSize
    ) {
      break;
    }
  }

  const pageRows = authorizedRows.slice(0, request.pageSize);
  const hits = pageRows.map(({ row }) => {
    const authorDisplayName = toAuthorDisplayName(
      row.forwarded_author_display_name,
    );
    return {
      type: "message" as const,
      conversationId: row.id as ConversationId,
      messageId: row.message_id as MessageId,
      ...(row.conversation_name === null || row.conversation_name.trim().length === 0
        ? {}
        : { title: row.conversation_name.slice(0, 512) }),
      snippet: toPlainTextSnippet(row.content_text),
      authorUserId: row.author_user_id as UserId,
      ...(authorDisplayName === undefined ? {} : { authorDisplayName }),
      sentAt: toIsoTimestamp(row.created_at),
    };
  });
  const hasAuthorizedLookahead = authorizedRows.length > request.pageSize;
  const cursorPosition = hasAuthorizedLookahead
    ? pageRows.at(-1)?.position
    : candidateScanCount === MESSAGE_SEARCH_MAX_CANDIDATE_SCAN_COUNT
      ? scanPosition
      : undefined;
  const response = {
    hits,
    ...(cursorPosition !== undefined
      ? { nextCursor: encodeCursor(fingerprint, cursorPosition) }
      : {}),
  };

  try {
    return parseMessageSearchResponse(response);
  } catch (error) {
    if (error instanceof MessageSearchParseError) {
      throw new MessageSearchQueryError("invalid_result");
    }
    throw error;
  }
}
