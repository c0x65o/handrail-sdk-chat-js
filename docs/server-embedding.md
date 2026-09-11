# Embedding the chat server safely

This guide is the operational contract for adding `@handrail/chat/server` to an
existing Node host. The [embedded-server example](../examples/embedded-server/README.md)
is executable fixture context; this guide explains the ownership and security
boundaries that a real host must preserve. The public definitions remain the
source of truth in [server contracts](../src/server/contracts.ts),
[server construction](../src/server/create-chat-server.ts), and the
[server entry point](../src/server/index.ts).

## Trust and host ownership

Trusted tenant ID, user ID, and roles come exclusively from the host's
authenticated server-side request/session. The `auth.resolveActor` adapter must
reject an unauthenticated request and return the session's
`TrustedChatActorContext` for an authenticated one.

Long-lived sockets may opt into fail-closed active-session checks by supplying
`auth.revalidateActiveSession`. The callback receives the original, already
authenticated upgrade request and the previously trusted actor; the runtime
never builds this input from a WebSocket handshake or subscription payload. It
must ignore client-authored request fields, consult authoritative host session
state, and return the current trusted actor, or `null` when the session is
revoked or expired. Attach a safe server-owned session handle during
`resolveActor`; do
not retain or replay bearer tokens, cookies, or other credentials merely to
implement periodic checks. When revalidation is enabled, the runtime removes
common credential headers from its retained request after `resolveActor`
finishes; the host-attached session boundary remains available.

Request bodies, query parameters, client-supplied tenant/user fields, and
caller-authored identity headers are never trusted as identity sources. This
also applies to WebSocket upgrades and subscription messages. Do not copy an
`x-tenant-id`, `x-user-id`, roles header, query value, or JSON identity field
into the trusted actor.

The host remains authoritative for its organizations, users, display names,
avatars, statuses, and directory filtering. It also remains authoritative for
application-entity access: `permissions.authorizeEntity` must decide whether
the resolved actor may access a host entity. Handrail Chat owns chat records,
but it does not become a second user directory or application authorization
system.

`permissions.authorizeThreadSend` is an optional host restriction for thread
sends. It may narrow existing send authority; it never grants access to an
inaccessible parent or bypasses membership, capability or lifecycle checks.
Omit it to retain the SDK's normal authorized thread-send policy.

## Complete embedding example

The following marked example is compiled by the documentation regression test
against `@handrail/chat/server`. It shows both database ownership modes, all
current adapter members, HTTP prefix removal, the original WebSocket path, and
idempotent shutdown. The declared services stand for existing host-owned
implementations; no provider credentials belong in this module.

<!-- server-embedding-example:start -->
```ts
import { createServer, type IncomingMessage } from "node:http";

import {
  createChatServer,
  type ChatAuditAdapter,
  type ChatAuthAdapter,
  type ChatDirectoryAdapter,
  type ChatMediaAdapter,
  type ChatNotificationAdapter,
  type ChatPermissionAdapter,
  type ChatRequestAdmissionAdapter,
  type ChatRealtimeAdapter,
  type ChatServerDatabaseConfig,
  type ChatStorageAdapter,
  type PostgresMigrationDatabase,
  type TrustedChatActorContext,
} from "@handrail/chat/server";

const CHAT_HTTP_PREFIX = "/api/chat";
const CHAT_WEBSOCKET_PATH = `${CHAT_HTTP_PREFIX}/_realtime`;

declare const applicationPool: PostgresMigrationDatabase;
declare const hostUsesSharedPool: boolean;
declare function readAuthenticatedHostSession(
  request: IncomingMessage,
): Promise<TrustedChatActorContext | null>;
declare function revalidateAuthenticatedHostSession(
  request: IncomingMessage,
  actor: TrustedChatActorContext,
): Promise<TrustedChatActorContext | null>;
declare const trustedChatTrafficAdmission:
  ChatRequestAdmissionAdapter<IncomingMessage>["admit"];

declare const applicationUsers: {
  getUser: ChatDirectoryAdapter["getUser"];
  searchUsers: ChatDirectoryAdapter["searchUsers"];
};
declare const applicationPermissions: {
  getCapabilities: ChatPermissionAdapter["getCapabilities"];
  authorizeEntity: ChatPermissionAdapter["authorizeEntity"];
};

declare const providerServices: {
  storage: {
    createUploadUrl: ChatStorageAdapter["createUploadUrl"];
    verifyObject: ChatStorageAdapter["verifyObject"];
    createDownloadUrl: ChatStorageAdapter["createDownloadUrl"];
    deleteObject: ChatStorageAdapter["deleteObject"];
  };
  notifications: { send: ChatNotificationAdapter["send"] };
  audit: { record: ChatAuditAdapter["record"] };
  realtime: {
    publish: ChatRealtimeAdapter["publish"];
    subscribe: NonNullable<ChatRealtimeAdapter["subscribe"]>;
  };
  media: {
    createRoom: ChatMediaAdapter["createRoom"];
    createParticipantToken: ChatMediaAdapter["createParticipantToken"];
    terminateRoom: ChatMediaAdapter["terminateRoom"];
  };
};
declare const applicationSessions: {
  isActive(input: {
    tenantId: string;
    recipientUserId: string;
    conversationId: string;
  }): boolean | Promise<boolean>;
};

const auth: ChatAuthAdapter<IncomingMessage> = {
  async resolveActor(request) {
    const actor = await readAuthenticatedHostSession(request);
    if (actor === null) {
      throw new Error("Host session is not authenticated");
    }
    return actor;
  },
  revalidateActiveSession: ({ request, actor }) =>
    revalidateAuthenticatedHostSession(request, actor),
};

const admission: ChatRequestAdmissionAdapter<IncomingMessage> = {
  // This calls host-trusted infrastructure; the SDK does not infer identity.
  admit: (input) => trustedChatTrafficAdmission(input),
};

const directory: ChatDirectoryAdapter = {
  getUser: (input) => applicationUsers.getUser(input),
  searchUsers: (input) => applicationUsers.searchUsers(input),
};

const permissions: ChatPermissionAdapter = {
  getCapabilities: (input) => applicationPermissions.getCapabilities(input),
  authorizeEntity: (input) => applicationPermissions.authorizeEntity(input),
};

const storage: ChatStorageAdapter = {
  createUploadUrl: (input) => providerServices.storage.createUploadUrl(input),
  verifyObject: (input) => providerServices.storage.verifyObject(input),
  createDownloadUrl: (input) =>
    providerServices.storage.createDownloadUrl(input),
  deleteObject: (input) => providerServices.storage.deleteObject(input),
};
const notifications: ChatNotificationAdapter = {
  send: (input) => providerServices.notifications.send(input),
};
const audit: ChatAuditAdapter = {
  record: (event) => providerServices.audit.record(event),
};
const realtime: ChatRealtimeAdapter = {
  publish: (event) => providerServices.realtime.publish(event),
  subscribe: (listener) => providerServices.realtime.subscribe(listener),
};
const media: ChatMediaAdapter = {
  createRoom: (input) => providerServices.media.createRoom(input),
  createParticipantToken: (input) =>
    providerServices.media.createParticipantToken(input),
  terminateRoom: (input) => providerServices.media.terminateRoom(input),
};

const connectionString = process.env.HANDRAIL_CHAT_DATABASE_URL;
if (connectionString === undefined) {
  throw new Error("HANDRAIL_CHAT_DATABASE_URL is required");
}

const ownedDatabase: ChatServerDatabaseConfig = {
  connectionString,
  schema: "handrail_chat",
};
const borrowedDatabase: ChatServerDatabaseConfig = {
  pool: applicationPool,
  schema: "handrail_chat",
};

const chat = createChatServer<IncomingMessage>({
  database: hostUsesSharedPool ? borrowedDatabase : ownedDatabase,
  admission,
  auth,
  directory,
  permissions,
  storage,
  notifications,
  audit,
  realtime,
  media,
  realtimeDelivery: "clustered",
  features: {
    attachments: true,
    notifications: true,
    audit: true,
    realtime: true,
    media: true,
  },
  auditDelivery: {
    batchSize: 25,
    pollIntervalMs: 1_000,
  },
  attachmentCleanup: {
    batchSize: 25,
    pollIntervalMs: 1_000,
  },
  notificationDelivery: {
    // Optional host signal; durable intents are created independently of it.
    isRecipientActive: ({ tenantId, recipientUserId, conversationId }) =>
      applicationSessions.isActive({ tenantId, recipientUserId, conversationId }),
  },
  webSocket: { path: CHAT_WEBSOCKET_PATH },
});

const httpServer = createServer((request, response) => {
  const pathname = new URL(
    request.url ?? "/",
    "http://handrail.invalid",
  ).pathname;
  if (
    pathname !== CHAT_HTTP_PREFIX &&
    !pathname.startsWith(`${CHAT_HTTP_PREFIX}/`)
  ) {
    response.statusCode = 404;
    response.end();
    return;
  }

  // ChatRouter expects its own route, with the host mount prefix removed.
  request.url = request.url?.slice(CHAT_HTTP_PREFIX.length) || "/";
  chat.router(request, response, (error) => {
    response.statusCode = error === undefined ? 404 : 500;
    response.end();
  });
});

// Upgrade requests retain their original URL, so this matches
// webSocket.path=/api/chat/_realtime above.
chat.attachWebSocket(httpServer);

// Optional deterministic drain; automatic polling is owned by the runtime.
export const drainChatAttachmentCleanup = () =>
  chat.dispatchAttachmentCleanupOnce();

const closeHttpServer = (): Promise<void> =>
  new Promise((resolve, reject) => {
    if (!httpServer.listening) {
      resolve();
      return;
    }
    httpServer.close((error) =>
      error === undefined ? resolve() : reject(error),
    );
  });

let shutdownPromise: Promise<void> | undefined;
export function closeChatHost(): Promise<void> {
  shutdownPromise ??= Promise.all([chat.close(), closeHttpServer()]).then(
    () => undefined,
  );
  return shutdownPromise;
}
```
<!-- server-embedding-example:end -->

A Connect/Express-style `app.use("/api/chat", chat.router)` mount normally
removes `/api/chat` before invoking the middleware. A custom Node dispatcher
must remove it as shown. WebSocket upgrades do not pass through that router;
`attachWebSocket` compares the original upgrade pathname to `webSocket.path`.
Use `/_realtime` when the upgrade URL is unprefixed, or configure the full host
path (as above) when it remains `/api/chat/_realtime`. Repeated attachment to
the same HTTP server and repeated detach/close operations are idempotent.

## Adapter and feature contract

`auth`, `directory`, and `permissions` are always required. Storage,
notifications, audit, realtime, media, and request admission are optional host
boundaries. All
storage, notification, audit, realtime, and media provider calls occur through
host-supplied adapters.

`ChatRequestAdmissionAdapter` independently protects recognized SDK chat HTTP
routes and the configured WebSocket upgrade path. It does not protect the host login endpoint.
The authoritative
authentication-API rule remains host-owned at **10 requests per 60 seconds**;
the host must enforce that rule in its authentication infrastructure.

When configured, `admission.admit` runs exactly once for a recognized method and
path before `auth.resolveActor`, permission checks, database/provider work, or
request-body reads. For WebSockets it also runs before browser credential
parsing and `WebSocketServer.handleUpgrade`. It receives the untouched host
request plus only the method and a low-cardinality template such as
`/conversations/:conversationId`. Every recognized WebSocket path, including a
host-prefixed configured path, reports canonical metadata `{ method: "GET",
routeTemplate: "/_realtime" }`; raw path identifiers and query strings are
never copied into admission metadata. Method/path combinations outside the exact
recognized shapes delegate to the next host handler without admission or
authentication.

The closed outcome contract accepts only `{ decision: "allow" }` or
`{ decision: "deny", retryAfterSeconds }`. Denial retry values must be finite
seconds from `1` through `3600`, inclusive, and the emitted `Retry-After` is
rounded up to integer seconds. HTTP denials return a sanitized JSON `429`;
upgrade denials write the same bounded `429` before closing the raw socket. A
thrown
or rejected adapter, an extra outcome field, an unknown decision, or an invalid
retry value fails closed with that same public error and a sanitized default
`Retry-After: 60`; exception and provider text are never copied to the response.

The SDK deliberately does not derive identity or a limiter key from headers,
IP addresses, cookies, query parameters, or bodies. The raw request exists so
the host adapter can consult its own trusted session, gateway, or distributed
admission infrastructure. Do not treat caller-authored request fields as
authoritative identity.

| Feature flag | Required adapter when enabled | Public members |
| --- | --- | --- |
| `attachments` | `storage` | `createUploadUrl`, `verifyObject`, `createDownloadUrl`, `deleteObject` |
| `notifications` | `notifications` | `send` |
| `audit` | `audit` | `record` |
| `realtime` | `realtime` | `publish`; `subscribe` is required in clustered delivery |
| `media` | `media` | `createRoom`, `createParticipantToken`, `terminateRoom` |

Enabling a feature without its matching adapter is a configuration error.
Leaving a feature disabled means the adapter is not required; it does not add
or remove adapter members. Required member sets and feature names are validated
during `createChatServer` construction.

`realtimeDelivery` is the explicit deployment boundary. It defaults to
`"single_process"` for compatibility. In that mode, the SDK guarantees only
delivery to sockets attached to the same runtime process; a publish-only
realtime adapter remains valid, but it does not establish cross-process socket
delivery. Do not horizontally scale a single-process configuration when live
event convergence is required.

Set `realtimeDelivery: "clustered"` before running multiple runtime instances.
Clustered mode fails construction unless `features.realtime` is `true` and the
realtime adapter provides callable `publish` and `subscribe` members. The SDK
validates this before allocating an owned database pool, starting workers, or
calling a provider. The host chooses and operates the shared fanout provider;
the SDK does not select or provision Redis or any other infrastructure.

`ChatAuthAdapter.revalidateActiveSession` is optional, so existing
`resolveActor`-only hosts retain upgrade-time authentication behavior and no
session timer is started. When present, it is validated during construction.
`webSocket.sessionRevalidationIntervalMs` defaults to `60000` and accepts safe
integers from `5000` through `3600000` milliseconds. Each socket schedules its
next check only after the preceding check completes, so slow host lookups never
overlap for that socket.

When notifications are enabled, the runtime derives recipient intents from
durable `message.created` outbox rows after commit. It excludes the actor,
inactive memberships, `none` preferences, unmentioned `mentions` preferences,
and active mutes. Missing preferences default to `all` and unmuted; expired
timed mutes are eligible. The optional `notificationDelivery.isRecipientActive`
host signal suppresses the adapter call only after the durable intent exists.

Each adapter call receives a stable `deliveryId`, source/conversation/message
identifiers, the actor and recipient IDs, sequence, event kind, timestamp, and
bounded safe metadata. It never receives the message body, message content,
credentials, secrets, or provider payloads. Hosts should enforce idempotency on
`deliveryId`. Throw `ChatNotificationDeliveryError` with `transient` or
`rate_limited` to request bounded retry; `permanent`, `rejected`, and
`configuration` are terminal. Unclassified errors retry only up to the configured maximum attempt
count. A disabled feature or absent adapter starts no notification dispatcher.

When `features.attachments` is `true`, `createChatServer` owns and starts one
attachment cleanup dispatcher backed by durable
`chat_attachment_cleanup_deliveries` rows. `attachmentCleanup` configures its
bounded batch, polling, lease, attempt, retry, and aggregate-only telemetry
options. The runtime exposes the owned worker as
`attachmentCleanupDispatcher` and exposes
`dispatchAttachmentCleanupOnce()` for a deterministic manual drain; concurrent
automatic and manual requests join the same in-flight batch instead of
duplicating object deletion.

`ChatStorageAdapter.deleteObject` delivery is at least once: the same cleanup
may be delivered again after an ambiguous settlement. The stable retry identity
is `(tenantId, attachmentId, objectKey)`. Hosts must make repeated deletion of
that object idempotent, so deleting an already-absent object resolves
successfully. Cleanup telemetry remains aggregate-only; provider messages and
object keys must never enter telemetry.

When attachments are disabled, `runtime.attachmentCleanupDispatcher` is
`undefined`, the manual drain returns an empty aggregate, and no attachment
cleanup polling query or storage deletion occurs. Construction does not query
the cleanup tables or call `storage.deleteObject`. `close()` stops cleanup
polling and awaits any in-flight automatic or manual cleanup batch before an
owned database is ended.

PostgreSQL rows in `chat_audit_events` are the authoritative audit record;
`chat_audit_deliveries` tracks asynchronous export attempts without replacing
that record. `ChatAuditAdapter` is an asynchronous at-least-once export
boundary. A delivery can be repeated after an acknowledgement failure, so the
provider must make `record` idempotent using the stable `auditEventId`.

When `features.audit` is `true`, the runtime creates and starts one audit
dispatcher. `auditDelivery` configures its `batchSize`, `pollIntervalMs`,
`leaseDurationMs`, `initialRetryDelayMs`, `maxRetryDelayMs`, `onError`, and
aggregate-only `onBatch` telemetry. Its defaults are `25`, `250`, `30000`,
`1000`, and `60000` milliseconds or rows, respectively. The optional
`monotonicNow` clock measures batch duration only. Invalid values and unknown
keys fail closed during configuration. The runtime exposes
`auditDispatcher.runOnce()` for a deterministic manual batch. When audit is disabled,
`runtime.auditDispatcher` is `undefined` and no audit polling query or adapter
call occurs, even if an adapter or valid `auditDelivery` options were supplied.

Construction, migration status, and migration application never call the audit
provider. Provider failures follow the dispatcher's retry/terminal contract and
remain isolated: they do not fail construction, stop unrelated workers, expose
provider details, or make runtime shutdown reject. `close()` stops polling and
awaits an in-flight automatic or manual audit batch before an owned database is
ended.

## PostgreSQL and migrations

The default and recommended schema name is `handrail_chat`. The database
configuration is an exclusive choice:

- `{ connectionString, schema }` creates an owned PostgreSQL pool. `close()`
  ends that pool.
- `{ pool, schema }` borrows a host pool. `close()` never ends it; the host
  closes it only after every borrower is finished.

The connection string and PostgreSQL credentials remain server-side. Check
migration status, review the result, and only then run the explicit apply
command against the selected database:

```sh
handrail-chat migrate status --connection-string "$HANDRAIL_CHAT_DATABASE_URL" --schema handrail_chat
handrail-chat migrate apply --connection-string "$HANDRAIL_CHAT_DATABASE_URL" --schema handrail_chat
```

`migrate status` is read-only and does not create the schema or migration
metadata. `migrate apply` is the only command above that changes database
objects. createChatServer startup never applies migrations, seeds data, or
preflights provider calls. Its outbox worker and, when enabled, notification and
audit workers begin polling after construction, so the host must finish the
explicit migration workflow before starting normal request processing.

### Expand-contract release policy

The supported sequence is expand before code, code and bounded backfill, then
contract. Apply additive schema changes before releasing code that requires
them. Every forward schema must remain compatible with runtime releases N and
N-1, so application rollback can restore N-1 while leaving the forward schema
in place.

Use these CLI usage strings as the release preflight contract:

```text
handrail-chat migrate status [--connection-string <url>] [--schema <name>]
handrail-chat doctor --config <module.mjs> [--json]
handrail-chat migrate apply  [--connection-string <url>] [--schema <name>]
handrail-chat serve --config <module.mjs> [--host <host>] [--port <port>]
```

`handrail-chat migrate status` is read-only and detects pending, out-of-order,
or checksum-incompatible migration history. `handrail-chat doctor --config
<module.mjs> [--json]` validates configuration and reports migration state
without applying it. Before apply, operators must create a recoverable backup
using their database platform's approved mechanism and verify through a tested
restore exercise that the documented restore procedure works. `handrail-chat
migrate apply` is the explicit compatible apply step. `handrail-chat serve`
refuses incompatible or pending migrations rather than applying them.

Run data backfills separately from schema migration transactions, in bounded,
restartable batches with measured lock and load impact. A destructive contract
migration is allowed only after the N/N-1 compatibility window has closed, all
N-1 instances and old jobs are retired, the backfill is verified, and no
supported code path depends on the object being removed. Repeat the status and
backup/restore gates before that contract migration.

Never edit SQL for an applied migration; its recorded checksum makes edited
history incompatible. Add a new forward migration instead. Application rollback
uses the already-forward schema. Routine rollback must not use a down migration;
restore and down operations are operator-owned emergency actions, not SDK
automation.

For example, use this checklist when adding a column and index:

1. Add an expansion migration whose nullable or safely defaulted column is
   ignored by N-1, and whose index has an assessed, bounded locking impact.
2. Verify N and N-1 against the forward schema; run `migrate status` and
   `doctor`, then satisfy the provider-neutral backup and tested-restore gate.
3. Explicitly apply the compatible expansion before releasing N code that can
   tolerate unfilled rows and use the new column/index.
4. Backfill existing rows separately in bounded, restartable batches, and
   verify completeness without editing the applied expansion SQL.
5. Keep application rollback compatible with the forward schema. Contract only
   after the compatibility window and dependency gates above; do not add a
   routine down-migration path.

## Routes, outbox, replay, and shutdown

The router currently mounts these paths after the host prefix has been removed:

| Method | Router path | Behavior |
| --- | --- | --- |
| `GET` | `/_meta` | Package, protocol, schema, and enabled-feature metadata. |
| `POST` | `/directory/users:batch` | Host-directory batch lookup. |
| `GET` | `/directory/users/search` | Host-directory search. |
| `GET` | `/conversations` | Actor-visible conversation snapshot. |
| `GET` | `/conversations/{conversationId}` | Authorized conversation detail snapshot. |

The WebSocket default is `/_realtime`; it is an upgrade path, not an HTTP
router route. Directory and conversation requests resolve the actor through
the host adapter. Admission occurs on the raw upgrade request before the
WebSocket exists, while upgrade authentication then uses the same server-side
request/session boundary.

For adapters that implement active-session revalidation, a `null` result, a
thrown error, malformed actor data, or a changed tenant ID or user ID closes the
socket with the sanitized `authentication_failed` reason. Tenant and user are
fixed for the lifetime of a socket; clients must establish a new socket after
an identity switch. A valid result may refresh roles. The runtime then resolves
capabilities again through `permissions.getCapabilities`, updates the frozen
public session's actor/capability getters, and revalidates every subscription
before further queued delivery. Newly unauthorized streams receive the normal
`access_revoked` subscription message while the valid socket and other streams
remain active. Capability lookup failures close with the sanitized
`authorization_failed` reason. Adapter messages, credentials, and provider
details are never copied into frames or close reasons.

Revalidation timeouts are cleared on socket close/error, rejection,
`detachWebSocket()`, and runtime `close()`. Results arriving after cleanup are
ignored and cannot restart timers or socket state. Hosts remain responsible for
making their callback cancellation-tolerant and for reading authoritative
active-session state from their own server boundary.

Durable chat mutations write their event to the transactional outbox with the
database change. The publisher leases ordered rows and publishes at most one
pending event per tenant/stream in a claim batch. Without a realtime adapter it
publishes to the runtime's process-local hub. With a host realtime adapter it
uses `publish`; live sockets in this process receive external fanout only when
the adapter also supplies `subscribe`. Clustered mode makes that inbound path
mandatory so a shared adapter can deliver an event to sockets connected to
every subscribed runtime instance.

Cursor replay is tenant-scoped, permission-filtered, ordered, and bounded by
`webSocket.maxReplayEvents` (default `500`). Typing and presence signals are
ephemeral and are not replayed. A missing, expired, incompatible, or overflowing
durable cursor produces `snapshot_required`; the client must fetch fresh
snapshots rather than requesting an unbounded history.

`close()` is idempotent. It marks the runtime closed, detaches the WebSocket
upgrade listener, closes runtime-owned socket resources, stops and awaits the
outbox publisher, notification dispatcher, and audit dispatcher (including
in-flight automatic or manual batches), and ends only a database pool
the runtime created. It does not close the host HTTP server or a borrowed pool;
the host lifecycle must close those separately, as the example does.

## Attachment and media boundaries

Attachment bytes stay in host-selected object storage. The storage adapter
creates narrowly scoped, expiring upload/download URLs and deletes objects by
the stored key; the chat runtime should never expose object-storage credentials
to a browser. Media transport remains with the host-selected WebRTC/SFU
provider. The media adapter creates/terminates rooms and returns only a narrowly
scoped, expiring participant token.

Provider and database secrets remain server-side. Only narrowly scoped
upload/download URLs or participant tokens cross the client boundary. Keep
provider SDK clients and credentials inside the host adapter implementations.

## Local diagnostics

Doctor validates the same configuration and adapter shapes, performs read-only
migration status queries, and does not start listeners, apply migrations, or
preflight provider calls:

```sh
handrail-chat doctor --config ./handrail-chat.config.mjs
handrail-chat doctor --config ./handrail-chat.config.mjs --json
```

For a focused local host, `serve` defaults to loopback `127.0.0.1:3000`. It
checks migration status and refuses pending migrations; it never applies them:

```sh
handrail-chat serve --config ./handrail-chat.config.mjs
handrail-chat serve --config ./handrail-chat.config.mjs --host 127.0.0.1 --port 0
```

Port `0` selects an ephemeral local port. A non-loopback bind occurs only when
the caller explicitly supplies one with `--host`.

<!-- server-embedding-contract
{
  "requiredAdapters": {
    "ChatAuthAdapter": ["resolveActor"],
    "ChatDirectoryAdapter": ["getUser", "searchUsers"],
    "ChatPermissionAdapter": ["getCapabilities", "authorizeEntity"]
  },
  "optionalAdapterMembers": {
    "ChatPermissionAdapter": ["authorizeThreadSend"],
    "ChatAuthAdapter": ["revalidateActiveSession"]
  },
  "optionalAdapters": {
    "ChatRequestAdmissionAdapter": ["admit"],
    "ChatStorageAdapter": ["createUploadUrl", "verifyObject", "createDownloadUrl", "deleteObject"],
    "ChatNotificationAdapter": ["send"],
    "ChatAuditAdapter": ["record"],
    "ChatRealtimeAdapter": ["publish", "subscribe"],
    "ChatMediaAdapter": ["createRoom", "createParticipantToken", "terminateRoom"]
  },
  "features": {
    "attachments": "storage",
    "notifications": "notifications",
    "audit": "audit",
    "realtime": "realtime",
    "media": "media"
  },
  "httpRoutes": [
    { "method": "GET", "path": "/_meta" },
    { "method": "POST", "path": "/directory/users:batch" },
    { "method": "GET", "path": "/directory/users/search" },
    { "method": "GET", "path": "/conversations" },
    { "method": "GET", "pathPrefix": "/conversations/" }
  ],
  "webSocketDefaultPath": "/_realtime",
  "realtimeDelivery": {
    "option": "realtimeDelivery",
    "default": "single_process",
    "values": ["single_process", "clustered"],
    "clusteredRequires": {
      "feature": "realtime",
      "adapterMembers": ["publish", "subscribe"]
    }
  },
  "requestAdmission": {
    "authenticationApiHostLimit": { "requests": 10, "windowSeconds": 60 },
    "minimumRetryAfterSeconds": 1,
    "maximumRetryAfterSeconds": 3600,
    "failureRetryAfterSeconds": 60,
    "failurePolicy": "fail_closed",
    "metadata": ["method", "routeTemplate"]
  },
  "webSocketSessionRevalidation": {
    "intervalOption": "sessionRevalidationIntervalMs",
    "defaultMs": 60000,
    "minimumMs": 5000,
    "maximumMs": 3600000
  },
  "auditDelivery": {
    "authoritativeTable": "chat_audit_events",
    "deliverySemantics": "at_least_once",
    "idempotencyKey": "auditEventId",
    "enabledFeature": "audit",
    "manualDrain": "auditDispatcher.runOnce",
    "defaults": {
      "batchSize": 25,
      "pollIntervalMs": 250,
      "leaseDurationMs": 30000,
      "initialRetryDelayMs": 1000,
      "maxRetryDelayMs": 60000
    }
  },
  "attachmentCleanup": {
    "authoritativeTable": "chat_attachment_cleanup_deliveries",
    "deliverySemantics": "at_least_once",
    "stableRetryIdentity": ["tenantId", "attachmentId", "objectKey"],
    "alreadyAbsentResult": "success",
    "telemetryExcludes": ["providerMessages", "objectKeys"],
    "enabledFeature": "attachments",
    "manualDrain": "dispatchAttachmentCleanupOnce",
    "defaults": {
      "batchSize": 25,
      "pollIntervalMs": 250,
      "leaseDurationMs": 30000,
      "maxAttempts": 5,
      "initialRetryDelayMs": 1000,
      "maxRetryDelayMs": 60000
    }
  },
  "postgresMigrationReleasePolicy": {
    "preflightCommands": [
      "handrail-chat migrate status [--connection-string <url>] [--schema <name>]",
      "handrail-chat doctor --config <module.mjs> [--json]",
      "handrail-chat migrate apply  [--connection-string <url>] [--schema <name>]",
      "handrail-chat serve --config <module.mjs> [--host <host>] [--port <port>]"
    ],
    "compatibilityGates": [
      "The supported sequence is expand before code, code and bounded backfill, then contract.",
      "Every forward schema must remain compatible with runtime releases N and N-1, so application rollback can restore N-1 while leaving the forward schema in place.",
      "Run data backfills separately from schema migration transactions, in bounded, restartable batches with measured lock and load impact.",
      "A destructive contract migration is allowed only after the N/N-1 compatibility window has closed, all N-1 instances and old jobs are retired, the backfill is verified, and no supported code path depends on the object being removed.",
      "Before apply, operators must create a recoverable backup using their database platform's approved mechanism and verify through a tested restore exercise that the documented restore procedure works."
    ],
    "preflightBehavior": [
      "handrail-chat migrate status is read-only and detects pending, out-of-order, or checksum-incompatible migration history.",
      "handrail-chat doctor --config <module.mjs> [--json] validates configuration and reports migration state without applying it.",
      "handrail-chat migrate apply is the explicit compatible apply step.",
      "handrail-chat serve refuses incompatible or pending migrations rather than applying them."
    ],
    "immutableAppliedMigrationRule": "Never edit SQL for an applied migration; its recorded checksum makes edited history incompatible.",
    "rollbackPolicy": "Routine rollback must not use a down migration; restore and down operations are operator-owned emergency actions, not SDK automation."
  },
  "cliUsage": [
    "handrail-chat doctor --config <module.mjs> [--json]",
    "handrail-chat serve --config <module.mjs> [--host <host>] [--port <port>]",
    "handrail-chat migrate status [--connection-string <url>] [--schema <name>]",
    "handrail-chat migrate apply  [--connection-string <url>] [--schema <name>]"
  ]
}
-->
