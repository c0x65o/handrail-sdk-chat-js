import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";

import {
  createChatServer,
  type ChatAuditAdapter,
  type ChatDirectoryAdapter,
  type ChatMediaAdapter,
  type ChatNotificationAdapter,
  type ChatPermissionAdapter,
  type ChatStorageAdapter,
  type PostgresMigrationDatabase,
  type TrustedChatActorContext,
} from "@handrail/chat/server";

const CHAT_ROUTE_PREFIX = "/api/chat";
const CHAT_SOCKET_PATH = `${CHAT_ROUTE_PREFIX}/_realtime`;
const FIXTURE_CONVERSATION_ID = "fixture-general";

type FixtureActor = TrustedChatActorContext;

const tenantId = (value: string): FixtureActor["tenantId"] =>
  value as FixtureActor["tenantId"];
const userId = (value: string): FixtureActor["userId"] =>
  value as FixtureActor["userId"];

const fixtureTenants = new Map([
  ["fixture-tenant", { id: "fixture-tenant", name: "Fixture Company" }],
]);

const fixtureUsers = new Map([
  [
    "fixture-tenant:fixture-user",
    {
      tenantId: tenantId("fixture-tenant"),
      userId: userId("fixture-user"),
      displayName: "Ada Fixture",
      roles: Object.freeze(["employee", "orders.viewer"]),
    },
  ],
]);

const sessions = new Map<string, FixtureActor>();

const readCookie = (request: IncomingMessage, name: string): string | undefined => {
  const serialized = request.headers.cookie;
  if (serialized === undefined) {
    return undefined;
  }
  for (const pair of serialized.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0 || pair.slice(0, separator).trim() !== name) {
      continue;
    }
    return decodeURIComponent(pair.slice(separator + 1).trim());
  }
  return undefined;
};

const resolveHostActor = async (
  request: IncomingMessage,
): Promise<TrustedChatActorContext> => {
  const sessionId = readCookie(request, "host_session");
  const actor = sessionId === undefined ? undefined : sessions.get(sessionId);
  if (actor === undefined) {
    throw new Error("Host session is not authenticated");
  }

  // The session store is the only identity source. Request bodies, query
  // parameters, and caller-authored identity headers are never consulted.
  return actor;
};

const directory: ChatDirectoryAdapter = {
  async getUser({ actor, userId: requestedUserId }) {
    const user = fixtureUsers.get(`${actor.tenantId}:${requestedUserId}`);
    if (user === undefined) {
      return null;
    }
    return {
      tenantId: user.tenantId,
      userId: user.userId,
      displayName: user.displayName,
      status: { availability: "online" },
    };
  },
  async searchUsers({ actor, query, limit = 25 }) {
    const normalized = query.trim().toLocaleLowerCase();
    return [...fixtureUsers.values()]
      .filter(
        (user) =>
          user.tenantId === actor.tenantId &&
          user.displayName.toLocaleLowerCase().includes(normalized),
      )
      .slice(0, limit)
      .map((user) => ({
        tenantId: user.tenantId,
        userId: user.userId,
        displayName: user.displayName,
        status: { availability: "online" as const },
      }));
  },
};

const permissions: ChatPermissionAdapter<string, string> = {
  async getCapabilities({ actor }) {
    const capabilities = ["conversation.read", "message.read"];
    if (actor.roles.includes("orders.viewer")) {
      capabilities.push("order.read");
    }
    return capabilities;
  },
  async authorizeEntity({ actor, entity }) {
    if (entity.type === "handrail.chat.tenant-directory") {
      return entity.id === actor.tenantId;
    }
    if (entity.type === "order") {
      return (
        fixtureTenants.has(actor.tenantId) &&
        actor.roles.includes("orders.viewer") &&
        entity.id === "fixture-order"
      );
    }
    return false;
  },
};

// These adapters are deterministic process-local fixtures. They demonstrate
// the host boundaries without calling object storage, notification, or media
// providers.
const storedObjectKeys = new Set<string>();
const storage: ChatStorageAdapter = {
  async createUploadUrl({ attachmentId }) {
    const objectKey = `fixture/${attachmentId}`;
    storedObjectKeys.add(objectKey);
    return {
      url: `/fixture-storage/${encodeURIComponent(objectKey)}`,
      objectKey,
      method: "PUT",
      expiresAt: "2030-01-01T00:05:00.000Z",
    };
  },
  async verifyObject({ objectKey }) {
    if (!storedObjectKeys.has(objectKey)) {
      return { status: "rejected", reason: "missing_object" };
    }
    return {
      status: "verified",
      exists: true,
      sizeBytes: 1,
      checksum: "fixture-checksum",
      contentType: "application/octet-stream",
      safetyDisposition: "accepted",
    };
  },
  async createDownloadUrl({ objectKey }) {
    if (!storedObjectKeys.has(objectKey)) {
      throw new Error("Fixture object does not exist");
    }
    return {
      url: `/fixture-storage/${encodeURIComponent(objectKey)}`,
      expiresAt: "2030-01-01T00:05:00.000Z",
    };
  },
  async deleteObject({ objectKey }) {
    storedObjectKeys.delete(objectKey);
  },
};

const deliveredNotifications: unknown[] = [];
const notifications: ChatNotificationAdapter = {
  async send(input) {
    deliveredNotifications.push(input);
  },
};

const recordedAuditEvents: unknown[] = [];
const audit: ChatAuditAdapter = {
  async record(event) {
    recordedAuditEvents.push(event);
  },
};

const media: ChatMediaAdapter = {
  async createRoom({ conversationId }) {
    return { roomId: `fixture-room-${conversationId}` };
  },
  async createParticipantToken() {
    return {
      token: randomUUID(),
      expiresAt: "2030-01-01T00:05:00.000Z",
    };
  },
  async terminateRoom() {},
};

const conversationRow = {
  id: FIXTURE_CONVERSATION_ID,
  type: "channel",
  visibility: "public",
  name: "Fixture General",
  entity_type: null,
  entity_id: null,
  parent_conversation_id: null,
  root_message_id: null,
  current_message_sequence: 2,
  created_at: "2030-01-01T00:00:00.000Z",
  updated_at: "2030-01-01T00:02:00.000Z",
  activity_at: "2030-01-01T00:02:00.000000Z",
  has_active_huddle: false,
  active_member_user_ids: ["fixture-user"],
  unread_mention_count: 0,
  member_role: "member",
  member_state: "active",
  member_joined_at: "2030-01-01T00:00:00.000Z",
  member_updated_at: "2030-01-01T00:00:00.000Z",
  last_read_sequence: 1,
  manual_unread_from_sequence: null,
  read_updated_at: "2030-01-01T00:01:00.000Z",
  notification_level: "all",
  is_starred: false,
  preference_revision: 0,
  muted: false,
  muted_until: null,
  preference_updated_at: "2030-01-01T00:01:00.000Z",
};

const queryFixtureDatabase = async (
  query: unknown,
  values: readonly unknown[] = [],
): Promise<{ rows: readonly unknown[]; rowCount?: number }> => {
  const sql =
    typeof query === "string"
      ? query
      : typeof query === "object" && query !== null && "text" in query
        ? String((query as { readonly text: unknown }).text)
        : "";
  if (sql.includes("WITH claimable AS MATERIALIZED")) {
    return { rows: [], rowCount: 0 };
  }
  if (sql.includes("SELECT EXISTS")) {
    return { rows: [{ exists: false }] };
  }
  if (sql.includes("current_member.role AS member_role")) {
    const actorMatchesFixture =
      values[0] === "fixture-tenant" && values[1] === "fixture-user";
    return { rows: actorMatchesFixture ? [conversationRow] : [] };
  }
  throw new Error("Unexpected fixture database query");
};

const fixtureDatabase = {
  query: queryFixtureDatabase,
  async connect() {
    return {
      async query(query: unknown) {
        const sql = typeof query === "string" ? query : "";
        if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) {
          return { rows: [], rowCount: 0 };
        }
        if (
          sql.includes("INSERT INTO") &&
          sql.includes("chat_audit_deliveries")
        ) {
          return { rows: [], rowCount: 0 };
        }
        if (
          sql.includes("claimable AS MATERIALIZED") &&
          sql.includes("chat_audit_deliveries")
        ) {
          return { rows: [], rowCount: 0 };
        }
        if (
          sql.includes("chat_outbox_events") &&
          sql.includes("FOR UPDATE OF event SKIP LOCKED")
        ) {
          return { rows: [], rowCount: 0 };
        }
        throw new Error("Unexpected fixture database connection query");
      },
      release() {},
    };
  },
} as unknown as PostgresMigrationDatabase;

const writeHostError = (response: ServerResponse): void => {
  if (!response.headersSent) {
    response.statusCode = 500;
    response.setHeader("content-type", "application/json; charset=utf-8");
  }
  response.end(JSON.stringify({ error: "Host request failed" }));
};

export interface EmbeddedFixtureHost {
  readonly origin: string;
  readonly sessionCookie: string;
  readonly visibleConversationId: string;
  close(): Promise<void>;
}

export async function startEmbeddedFixtureHost(): Promise<EmbeddedFixtureHost> {
  const sessionId = randomUUID();
  sessions.set(
    sessionId,
    Object.freeze({
      tenantId: tenantId("fixture-tenant"),
      userId: userId("fixture-user"),
      roles: Object.freeze(["employee", "orders.viewer"]),
    }),
  );

  const chat = createChatServer<IncomingMessage>({
    database: { pool: fixtureDatabase },
    auth: { resolveActor: resolveHostActor },
    directory,
    permissions,
    storage,
    notifications,
    // This deterministic host has no device-token storage or push provider.
    // Real hosts supply protection backed by their own secret storage.
    pushTokenProtector: {
      async protect() {
        throw new Error("Device push tokens are not supported by the embedded fixture");
      },
      async unprotect() {
        throw new Error("Device push tokens are not supported by the embedded fixture");
      },
    },
    audit,
    media,
    // This fixture is one process. Horizontally scaled hosts must select
    // "clustered" and supply a shared realtime publish/subscribe adapter.
    realtimeDelivery: "single_process",
    features: {
      attachments: true,
      notifications: true,
      audit: true,
      media: true,
    },
    outbox: { pollIntervalMs: 60_000 },
    // Audit export is asynchronous and at-least-once. A real provider adapter
    // must deduplicate record calls by event.auditEventId.
    auditDelivery: { pollIntervalMs: 60_000 },
    webSocket: { path: CHAT_SOCKET_PATH },
  });

  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    const pathname = request.url?.split("?", 1)[0] ?? "";
    if (
      pathname !== CHAT_ROUTE_PREFIX &&
      !pathname.startsWith(`${CHAT_ROUTE_PREFIX}/`)
    ) {
      response.statusCode = 404;
      response.end();
      return;
    }

    request.url = request.url?.slice(CHAT_ROUTE_PREFIX.length) || "/";
    chat.router(request, response, (error) => {
      if (error !== undefined) {
        writeHostError(response);
        return;
      }
      if (!response.headersSent) {
        response.statusCode = 404;
      }
      response.end();
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  chat.attachWebSocket(server);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Fixture host did not bind a TCP port");
  }

  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    origin: `http://127.0.0.1:${address.port}`,
    sessionCookie: `host_session=${encodeURIComponent(sessionId)}`,
    visibleConversationId: FIXTURE_CONVERSATION_ID,
    close() {
      closePromise ??= (async () => {
        sessions.delete(sessionId);
        await chat.close();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error === undefined ? resolve() : reject(error)));
          server.closeAllConnections();
        });
        for (const socket of sockets) {
          socket.destroy();
        }
        sockets.clear();
      })();
      return closePromise;
    },
  });
}
