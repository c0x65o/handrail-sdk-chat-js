import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { parseSendMessageInput } from "../contracts/message-mutations.js";
import type { TenantId, UserId } from "../contracts/identifiers.js";
import type { ChatDirectoryAdapter, ChatPermissionAdapter, TrustedChatActorContext } from "./contracts.js";
import type { PostgresMigrationDatabase } from "./postgres-migrations.js";
import { validatePostgresSchema } from "./postgres-migrations.js";
import { ChatAuthenticationError, ChatAuthorizationError } from "./request-context.js";
import { readBoundedJsonBody } from "./bounded-json-body.js";
import { sendMessage, SendMessageCommandError } from "./send-message-command.js";

export const NATIVE_TOKEN_MANAGE_CAPABILITY = "native_tokens.manage";
export class NativeTokenError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string) {
    super(code);
  }
}
const invalid = () => new NativeTokenError(400, "invalid_native_token_request");
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const object = (value: unknown, keys: string[]): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => !keys.includes(key))) throw invalid();
  return value as Record<string, unknown>;
};
const string = (value: unknown, max: number): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw invalid();
  return value;
};
interface Options {
  database: PostgresMigrationDatabase;
  schema: string;
  permissions: ChatPermissionAdapter;
  directory: ChatDirectoryAdapter;
}

/** Shared rolling-window counter; remoteAddress is socket identity, never an untrusted forwarding header. */
export async function limitNativeTokenAuthentication(options: Options, request: IncomingMessage) {
  const prefix = `"${validatePostgresSchema(options.schema)}"`;
  const key = digest(request.socket.remoteAddress ?? "unknown");
  const connection = await options.database.connect();
  try {
    await connection.query("BEGIN");
    await connection.query(`INSERT INTO ${prefix}.chat_native_auth_limits VALUES ($1, '{}') ON CONFLICT DO NOTHING`, [key]);
    await connection.query(`SELECT key FROM ${prefix}.chat_native_auth_limits WHERE key=$1 FOR UPDATE`, [key]);
    const result = await connection.query<{ count: number }>(
      `UPDATE ${prefix}.chat_native_auth_limits SET attempts = ARRAY(
        SELECT t FROM unnest(attempts) t WHERE t > clock_timestamp() - interval '60 seconds'
      ) WHERE key=$1 RETURNING cardinality(attempts) AS count`, [key]);
    const denied = result.rows[0]!.count >= 10;
    if (!denied) await connection.query(`UPDATE ${prefix}.chat_native_auth_limits SET attempts=array_append(attempts, clock_timestamp()) WHERE key=$1`, [key]);
    await connection.query("COMMIT");
    if (denied) throw new NativeTokenError(429, "native_token_rate_limited");
  } catch (error) {
    await connection.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { connection.release(); }
}

const metadataColumns = `id, name, sender_user_id AS "senderUserId", created_by_user_id AS "createdByUserId", created_at AS "createdAt", revoked_at AS "revokedAt"`;
export async function manageNativeTokens(options: Options, actor: TrustedChatActorContext, method: string, body?: unknown, tokenId?: string) {
  if (!(await options.permissions.getCapabilities({ actor })).includes(NATIVE_TOKEN_MANAGE_CAPABILITY)) throw new ChatAuthorizationError();
  const prefix = `"${validatePostgresSchema(options.schema)}"`;
  if (method === "GET") {
    const result = await options.database.query(`SELECT ${metadataColumns}, ARRAY(
      SELECT conversation_id FROM ${prefix}.chat_native_token_channels c
      WHERE c.tenant_id=t.tenant_id AND c.token_id=t.id ORDER BY conversation_id
    ) AS "channelIds" FROM ${prefix}.chat_native_tokens t WHERE tenant_id=$1 ORDER BY created_at DESC`, [actor.tenantId]);
    return { tokens: result.rows };
  }
  if (method === "DELETE") {
    const result = await options.database.query(`UPDATE ${prefix}.chat_native_tokens SET revoked_at=COALESCE(revoked_at, clock_timestamp()) WHERE tenant_id=$1 AND id=$2 RETURNING id`, [actor.tenantId, tokenId]);
    if (result.rowCount !== 1) throw new NativeTokenError(404, "native_token_not_found");
    return { revoked: true };
  }
  const input = object(body, ["name", "channelIds"]);
  const name = string(input.name, 80).trim();
  if (!Array.isArray(input.channelIds) || input.channelIds.length < 1 || input.channelIds.length > 50) throw invalid();
  const channelIds = [...new Set(input.channelIds.map(id => string(id, 200)))].sort();
  const id = randomUUID();
  const senderUserId = `native-integration:${id}`;
  const secret = `hrnt_${randomBytes(32).toString("base64url")}`;
  const connection = await options.database.connect();
  try {
    await connection.query("BEGIN");
    for (const channelId of channelIds) {
      const result = await connection.query<{ entity_type: string | null; entity_id: string | null }>(
        `SELECT c.entity_type, c.entity_id FROM ${prefix}.chat_conversations c
         JOIN ${prefix}.chat_conversation_members m ON m.tenant_id=c.tenant_id AND m.conversation_id=c.id
         WHERE c.tenant_id=$1 AND c.id=$2 AND c.type='channel' AND c.archived_at IS NULL
           AND m.user_id=$3 AND m.state='active' FOR UPDATE OF c, m`, [actor.tenantId, channelId, actor.userId]);
      const channel = result.rows[0];
      if (!channel) throw new ChatAuthorizationError();
      if (channel.entity_type && channel.entity_id && !await options.permissions.authorizeEntity({ actor, entity: { type: channel.entity_type, id: channel.entity_id }, action: "message.send" })) throw new ChatAuthorizationError();
    }
    const result = await connection.query(`INSERT INTO ${prefix}.chat_native_tokens
      (tenant_id,id,name,sender_user_id,verifier,created_by_user_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${metadataColumns}`,
      [actor.tenantId, id, name, senderUserId, digest(secret), actor.userId]);
    for (const channelId of channelIds) {
      await connection.query(`INSERT INTO ${prefix}.chat_native_token_channels VALUES ($1,$2,$3)`, [actor.tenantId, id, channelId]);
      await connection.query(`INSERT INTO ${prefix}.chat_conversation_members (tenant_id,conversation_id,user_id,role,state) VALUES ($1,$2,$3,'member','active')`, [actor.tenantId, channelId, senderUserId]);
      const revision = await connection.query(`UPDATE ${prefix}.chat_conversations SET
        member_list_revision=member_list_revision+1, updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND id=$2 AND member_list_revision < 9007199254740991`, [actor.tenantId, channelId]);
      if (revision.rowCount !== 1) throw new NativeTokenError(409, "membership_revision_exhausted");
    }
    await connection.query("COMMIT");
    return { token: { ...result.rows[0], channelIds }, secret };
  } catch (error) {
    await connection.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { connection.release(); }
}

export function parseNativeInboundMessage(body: unknown) {
  const input = object(body, ["channelId", "text", "idempotencyKey"]);
  const conversationId = string(input.channelId, 200);
  const text = string(input.text, 16000);
  const idempotencyKey = string(input.idempotencyKey, 200);
  return parseSendMessageInput({ operation: "send", conversationId,
    content: { format: "plain", text }, idempotencyKey, clientMessageId: digest(idempotencyKey) });
}

export async function postNativeMessage(options: Options, authorization: string | undefined, body: unknown) {
  if (!authorization || !/^Bearer hrnt_[A-Za-z0-9_-]{43}$/.test(authorization)) throw new ChatAuthenticationError();
  const verifier = digest(authorization.slice(7));
  const prefix = `"${validatePostgresSchema(options.schema)}"`;
  const found = await options.database.query<{ tenant_id: string; id: string; sender_user_id: string }>(
    `SELECT tenant_id,id,sender_user_id FROM ${prefix}.chat_native_tokens WHERE verifier=$1 AND revoked_at IS NULL`, [verifier]);
  const token = found.rows[0];
  if (!token) throw new ChatAuthenticationError();
  const input = parseNativeInboundMessage(body);
  try {
    return await sendMessage({
      ...options,
      actor: { tenantId: token.tenant_id as TenantId, userId: token.sender_user_id as UserId, roles: ["integration"] },
      permissions: {
        getCapabilities: async () => ["message.send"],
        authorizeEntity: input => options.permissions.authorizeEntity(input),
      },
      nativeTokenVerifier: verifier,
      input,
    });
  } catch (error) {
    if (error instanceof SendMessageCommandError) throw new NativeTokenError(error.statusCode, error.code);
    throw error;
  }
}

/** Metadata-only directory projection keeps existing React/Flutter user author contracts. */
export async function nativeIntegrationUser(options: Pick<Options, "database" | "schema">, tenantId: TenantId, userId: UserId) {
  if (!userId.startsWith("native-integration:")) return null;
  const prefix = `"${validatePostgresSchema(options.schema)}"`;
  const result = await options.database.query<{ name: string }>(`SELECT name FROM ${prefix}.chat_native_tokens WHERE tenant_id=$1 AND sender_user_id=$2`, [tenantId, userId]);
  return result.rows[0] ? { tenantId, userId, displayName: `${result.rows[0].name} (integration)` } : null;
}

export async function readNativeTokenBody(request: IncomingMessage) {
  if (!/^application\/json(?:\s*;.*)?$/i.test(request.headers["content-type"] ?? "")) throw invalid();
  return readBoundedJsonBody(request, 20000, invalid);
}
export function writeNativeTokenResult(response: ServerResponse, result: unknown) {
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(result));
}
