import { createServer, type IncomingMessage, type Server } from "node:http";

import { WebSocket } from "ws";

import {
  CHAT_CLIENT_PACKAGE_VERSION,
  createChatClient,
  type ChatClient,
} from "../client/create-chat-client.js";
import { createNormalizedChatCache } from "../client/normalized-cache.js";
import type { ChatEvent, ClientHandshakeInput } from "../contracts/realtime.js";
import { CHAT_PROTOCOL_VERSION } from "../contracts/realtime.js";
import { MAX_HUDDLE_MEDIA_JOIN_DESCRIPTOR_TTL_MS } from "../contracts/huddle-session.js";
import type {
  IsoTimestamp,
  SessionId,
  TenantId,
  UserId,
} from "../contracts/identifiers.js";
import type {
  ChatAuditEvent,
  ChatCapabilityResolutionInput,
  ChatDirectoryLookupInput,
  ChatDirectorySearchInput,
  ChatDirectoryUser,
  ChatEntityAuthorizationInput,
  ChatHostAdapters,
  ChatHttpObservabilityOptions,
  ChatMediaAdapter,
  ChatMediaCreateRoomInput,
  ChatMediaParticipantTokenInput,
  ChatMediaTerminateRoomInput,
  ChatNotificationInput,
  ChatPushTokenProtectInput,
  ChatPushTokenProtector,
  ChatPushTokenUnprotectInput,
  ChatStorageAdapter,
  ChatStorageDownloadInput,
  ChatStorageObjectInput,
  ChatStorageUploadInput,
  TrustedChatActorContext,
} from "../server/contracts.js";
import {
  createChatServer,
  type ChatServerFeatures,
  type ChatServerRuntime,
} from "../server/create-chat-server.js";
import type { ChatThreadInactivityPolicyResolver } from "../server/thread-list-handler-options.js";
import {
  createPostgresMigrationRunner,
  type PostgresMigrationApplyResult,
} from "../server/postgres-migrations.js";
import { handrailChatPostgresMigrations } from "../server/postgres-schema-migrations.js";
import type {
  PostgresTestBackend,
  PostgresTestBackendKind,
  PostgresTestBackendOptions,
  PostgresTestHarness,
  PostgresTestHarnessOptions,
} from "./index.js";

export type ChatTestAdapterBoundary =
  | "auth.resolveActor"
  | "directory.getUser"
  | "directory.searchUsers"
  | "permissions.getCapabilities"
  | "permissions.authorizeEntity"
  | "storage.createUploadUrl"
  | "storage.verifyObject"
  | "storage.createDownloadUrl"
  | "storage.deleteObject"
  | "notifications.send"
  | "audit.record"
  | "realtime.publish"
  | "media.createRoom"
  | "media.createParticipantToken"
  | "media.terminateRoom";

export interface ChatTestActorInput {
  /** Opaque credential sent to the trusted auth fake as a Bearer token. */
  readonly credential: string;
  readonly actor: TrustedChatActorContext;
  readonly capabilities?: readonly string[];
  /** Optional tenant-scoped directory entry registered with the actor. */
  readonly user?: ChatDirectoryUser;
}

export interface ChatTestActor {
  readonly credential: string;
  readonly actor: TrustedChatActorContext;
  readonly capabilities: readonly string[];
}

export interface ChatTestClock {
  now(): Date;
  iso(): IsoTimestamp;
  set(value: Date | string): void;
  advance(milliseconds: number): Date;
}

export interface ChatTestAdapterCall {
  readonly boundary: ChatTestAdapterBoundary;
  readonly occurredAt: IsoTimestamp;
  readonly input: unknown;
}

export interface ChatTestCallLog {
  all(boundary?: ChatTestAdapterBoundary): readonly ChatTestAdapterCall[];
  count(boundary?: ChatTestAdapterBoundary): number;
  reset(): void;
}

export interface ChatTestFailureQueue {
  /** Queues one failure, consumed by the next call to this boundary. */
  failNext(boundary: ChatTestAdapterBoundary, failure?: Error | string): void;
  /** Appends failures in deterministic invocation order. */
  queue(
    boundary: ChatTestAdapterBoundary,
    failures: readonly (Error | string)[],
  ): void;
  pending(boundary: ChatTestAdapterBoundary): number;
  snapshot(): Readonly<Partial<Record<ChatTestAdapterBoundary, number>>>;
  reset(boundary?: ChatTestAdapterBoundary): void;
}

export interface ChatTestWebSocketConnection {
  readonly socket: WebSocket;
  readonly accepted: Readonly<Record<string, unknown>>;
}

export interface CreateChatTestHarnessOptions
  extends PostgresTestBackendOptions,
    PostgresTestHarnessOptions {
  /** Reuses this backend without taking ownership of it. */
  readonly backend?: PostgresTestBackend;
  readonly actors?: readonly ChatTestActorInput[];
  /** Defaults to a fixed instant so adapter output is deterministic. */
  readonly initialTime?: Date | string;
  /** Defaults to the test clock; live labs may supply wall time for expiring media material. */
  readonly mediaTokenNow?: () => Date;
  /** Optional real media edge for browser labs. Its lifecycle belongs to the caller. */
  readonly media?: ChatMediaAdapter;
  /** Optional storage edge override. The harness owns and tears down this test adapter. */
  readonly storage?: ChatStorageAdapter & {
    teardown?(): void | Promise<void>;
  };
  /** All fake-backed features default to enabled. */
  readonly features?: ChatServerFeatures;
  /** Optional real host policy for thread discovery in integration tests/labs. */
  readonly threadInactivityPolicy?: false | ChatThreadInactivityPolicyResolver;
  /** Optional host request telemetry, also used by the live Chat Lab. */
  readonly httpObservability?: ChatHttpObservabilityOptions<IncomingMessage>;
}

export interface ChatTestHarness {
  readonly backendKind: PostgresTestBackendKind;
  readonly connectionString: string;
  readonly schema: string;
  readonly pool: PostgresTestHarness["pool"];
  readonly migrationResult: PostgresMigrationApplyResult;
  readonly endpoint: string;
  readonly webSocketEndpoint: string;
  readonly httpServer: Server;
  readonly runtime: ChatServerRuntime<IncomingMessage>;
  readonly adapters: ChatHostAdapters<IncomingMessage> & {
    readonly pushTokenProtector: ChatPushTokenProtector;
  };
  readonly clock: ChatTestClock;
  readonly calls: ChatTestCallLog;
  readonly failures: ChatTestFailureQueue;
  addActor(input: ChatTestActorInput): ChatTestActor;
  removeActor(credential: string): boolean;
  setCapabilities(actor: ChatTestActor, capabilities: readonly string[]): void;
  setEntityAuthorization(allowed: boolean): void;
  setDirectoryUser(user: ChatDirectoryUser): void;
  removeDirectoryUser(tenantId: TenantId, userId: UserId): boolean;
  directoryUsers(tenantId: TenantId): readonly ChatDirectoryUser[];
  /** Creates and tracks a client whose token is bound to a registered actor. */
  createClient(actor: ChatTestActor | string): ChatClient;
  /** Opens, authenticates, handshakes, and tracks a test WebSocket. */
  connectWebSocket(
    actor: ChatTestActor | string,
    handshake?: ClientHandshakeInput,
  ): Promise<ChatTestWebSocketConnection>;
  /** Idempotently releases only resources owned by this harness. */
  teardown(): Promise<void>;
}

export type PostgresTestBackendFactory = (
  options?: PostgresTestBackendOptions,
) => Promise<PostgresTestBackend>;

const DEFAULT_TEST_TIME = "2026-01-01T00:00:00.000Z";
const TEST_MEDIA_JOIN_DESCRIPTOR_TTL_MS =
  MAX_HUDDLE_MEDIA_JOIN_DESCRIPTOR_TTL_MS - 1_000;
const ALL_FEATURES: Required<ChatServerFeatures> = Object.freeze({
  threadDiscovery: true,
  reply_style_preference_v1: true,
  inlineReplies: true,
  namedThreads: true,
  threadInactivity: true,
  threadLifecycle: true,
  attachments: true,
  notifications: true,
  audit: true,
  realtime: true,
  media: true,
  typing: true,
  presence: true,
});

const actorKey = (actor: TrustedChatActorContext): string =>
  JSON.stringify([actor.tenantId, actor.userId]);

const directoryKey = (tenantId: TenantId, userId: UserId): string =>
  JSON.stringify([tenantId, userId]);

const freezeActor = (
  actor: TrustedChatActorContext,
): TrustedChatActorContext =>
  Object.freeze({
    tenantId: actor.tenantId,
    userId: actor.userId,
    roles: Object.freeze([...actor.roles]),
  });

const validateCredential = (credential: string): string => {
  if (
    typeof credential !== "string" ||
    credential.length === 0 ||
    /\s|[\r\n]/.test(credential)
  ) {
    throw new TypeError("test actor credentials must be non-empty opaque tokens");
  }
  return credential;
};

const readInstant = (value: Date | string): number => {
  const instant = value instanceof Date ? value.valueOf() : Date.parse(value);
  if (!Number.isFinite(instant)) {
    throw new TypeError("test clock values must be valid dates");
  }
  return instant;
};

const createClock = (initialTime: Date | string): ChatTestClock => {
  let instant = readInstant(initialTime);
  return Object.freeze({
    now() {
      return new Date(instant);
    },
    iso() {
      return new Date(instant).toISOString();
    },
    set(value: Date | string) {
      instant = readInstant(value);
    },
    advance(milliseconds: number) {
      if (!Number.isSafeInteger(milliseconds)) {
        throw new TypeError("clock advance must be a safe integer number of milliseconds");
      }
      const next = instant + milliseconds;
      if (!Number.isFinite(new Date(next).valueOf())) {
        throw new RangeError("clock advance is outside the supported date range");
      }
      instant = next;
      return new Date(instant);
    },
  });
};

const createCallLog = (clock: ChatTestClock) => {
  const entries: ChatTestAdapterCall[] = [];
  const capture = (boundary: ChatTestAdapterBoundary, input: unknown): void => {
    entries.push(Object.freeze({ boundary, occurredAt: clock.iso(), input }));
  };
  const log: ChatTestCallLog = Object.freeze({
    all(boundary?: ChatTestAdapterBoundary) {
      const selected =
        boundary === undefined
          ? entries
          : entries.filter((entry) => entry.boundary === boundary);
      return Object.freeze([...selected]);
    },
    count(boundary?: ChatTestAdapterBoundary) {
      return boundary === undefined
        ? entries.length
        : entries.filter((entry) => entry.boundary === boundary).length;
    },
    reset() {
      entries.length = 0;
    },
  });
  return { capture, log };
};

const createFailureQueue = () => {
  const queues = new Map<ChatTestAdapterBoundary, Error[]>();
  const normalize = (
    boundary: ChatTestAdapterBoundary,
    failure?: Error | string,
  ): Error =>
    failure instanceof Error
      ? failure
      : new Error(failure ?? `Injected ${boundary} failure`);
  const consume = (boundary: ChatTestAdapterBoundary): void => {
    const queue = queues.get(boundary);
    const failure = queue?.shift();
    if (queue?.length === 0) {
      queues.delete(boundary);
    }
    if (failure !== undefined) {
      throw failure;
    }
  };
  const controller: ChatTestFailureQueue = Object.freeze({
    failNext(boundary: ChatTestAdapterBoundary, failure?: Error | string) {
      const queue = queues.get(boundary) ?? [];
      queue.push(normalize(boundary, failure));
      queues.set(boundary, queue);
    },
    queue(
      boundary: ChatTestAdapterBoundary,
      failures: readonly (Error | string)[],
    ) {
      const queue = queues.get(boundary) ?? [];
      queue.push(
        ...failures.map((failure: Error | string) =>
          normalize(boundary, failure),
        ),
      );
      if (queue.length > 0) {
        queues.set(boundary, queue);
      }
    },
    pending(boundary: ChatTestAdapterBoundary) {
      return queues.get(boundary)?.length ?? 0;
    },
    snapshot() {
      return Object.freeze(
        Object.fromEntries(
          [...queues].map(([boundary, queue]) => [boundary, queue.length]),
        ),
      );
    },
    reset(boundary?: ChatTestAdapterBoundary) {
      if (boundary === undefined) {
        queues.clear();
      } else {
        queues.delete(boundary);
      }
    },
  });
  return { consume, controller };
};

const closeHttpServer = async (server: Server): Promise<void> => {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
};

const terminateWebSocket = async (socket: WebSocket): Promise<void> => {
  if (socket.readyState === WebSocket.CLOSED) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const onClose = () => {
      socket.off("error", onError);
      resolve();
    };
    // A connecting socket can report an expected error while being terminated.
    const onError = () => undefined;
    socket.once("close", onClose);
    socket.once("error", onError);
    try {
      socket.terminate();
    } catch (error) {
      socket.off("close", onClose);
      socket.off("error", onError);
      reject(error);
    }
  });
};

const listenOnLoopback = async (server: Server): Promise<number> => {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The chat test server did not expose a TCP address");
  }
  return address.port;
};

/** Internal factory wired to the public PostgreSQL helper by testing/index.ts. */
export async function createChatTestHarnessInternal(
  options: CreateChatTestHarnessOptions,
  createBackend: PostgresTestBackendFactory,
): Promise<ChatTestHarness> {
  const ownsBackend = options.backend === undefined;
  const backend =
    options.backend ??
    (await createBackend({
      ...(options.testDatabaseUrl === undefined
        ? {}
        : { testDatabaseUrl: options.testDatabaseUrl }),
      ...(options.containerImage === undefined
        ? {}
        : { containerImage: options.containerImage }),
    }));
  let postgresHarness: PostgresTestHarness | undefined;
  let runtime: ChatServerRuntime<IncomingMessage> | undefined;
  let httpServer: Server | undefined;

  try {
    postgresHarness = await backend.createHarness({
      ...(options.schemaPrefix === undefined
        ? { schemaPrefix: "handrail_chat_test" }
        : { schemaPrefix: options.schemaPrefix }),
    });

    const migrationResult = await createPostgresMigrationRunner({
      database: postgresHarness.pool,
      schema: postgresHarness.schema,
      migrations: handrailChatPostgresMigrations,
    }).apply();

    const clock = createClock(options.initialTime ?? DEFAULT_TEST_TIME);
    const mediaTokenNow = options.mediaTokenNow ?? clock.now;
    if (typeof mediaTokenNow !== "function") {
      throw new TypeError("mediaTokenNow must be a function");
    }
    const { capture, log: calls } = createCallLog(clock);
    const { consume, controller: failures } = createFailureQueue();
    const actors = new Map<string, ChatTestActor>();
    const capabilities = new Map<string, readonly string[]>();
    const directory = new Map<string, ChatDirectoryUser>();
    let entityAuthorization = true;
    let mediaRoomSequence = 0;
    let mediaTokenSequence = 0;
    let pushTokenSequence = 0;
    const protectedPushTokens = new Map<
      string,
      Parameters<ChatPushTokenProtector["protect"]>[0]
    >();
    const ciphertextByPushToken = new Map<string, string>();
    const realtimeListeners = new Set<(event: ChatEvent) => void | Promise<void>>();

    const pushTokenProtector: ChatPushTokenProtector = Object.freeze({
      async protect(input: ChatPushTokenProtectInput) {
        const identity = JSON.stringify([
          input.tenantId,
          input.userId,
          input.deviceId,
          input.token,
        ]);
        let ciphertext = ciphertextByPushToken.get(identity);
        if (ciphertext === undefined) {
          pushTokenSequence += 1;
          ciphertext = `test-push-token-${pushTokenSequence}`;
          ciphertextByPushToken.set(identity, ciphertext);
          protectedPushTokens.set(ciphertext, input);
        }
        return Object.freeze({
          ciphertext,
          keyId: "handrail-chat-test-v1",
        });
      },
      async unprotect(input: ChatPushTokenUnprotectInput) {
        const protectedInput = protectedPushTokens.get(
          input.protectedToken.ciphertext,
        );
        if (
          input.protectedToken.keyId !== "handrail-chat-test-v1" ||
          protectedInput === undefined ||
          protectedInput.tenantId !== input.tenantId ||
          protectedInput.userId !== input.userId ||
          protectedInput.deviceId !== input.deviceId
        ) {
          throw new Error("Unknown protected test push token");
        }
        return protectedInput.token;
      },
    });

    const defaultStorage: ChatStorageAdapter = Object.freeze({
      async createUploadUrl(input: ChatStorageUploadInput) {
        const objectKey = `test/${input.actor.tenantId}/${input.attachmentId}/${encodeURIComponent(input.fileName)}`;
        return {
          objectKey,
          method: "PUT" as const,
          url: `https://storage.test.invalid/${encodeURIComponent(objectKey)}`,
          expiresAt: new Date(clock.now().valueOf() + 15 * 60_000).toISOString(),
        };
      },
      async verifyObject() {
        return {
          status: "verified" as const,
          exists: true as const,
          sizeBytes: 0,
          checksum: `sha256:${"0".repeat(64)}`,
          contentType: "text/plain",
          safetyDisposition: "accepted" as const,
        };
      },
      async createDownloadUrl(input: ChatStorageDownloadInput) {
        return {
          url: `https://storage.test.invalid/${encodeURIComponent(input.objectKey)}`,
          expiresAt: new Date(clock.now().valueOf() + 5 * 60_000).toISOString(),
        };
      },
      async deleteObject() {},
    });
    const storage = options.storage ?? defaultStorage;

    const setDirectoryUser = (user: ChatDirectoryUser): void => {
      if (!user.tenantId || !user.userId || !user.displayName) {
        throw new TypeError("directory users require tenantId, userId, and displayName");
      }
      directory.set(
        directoryKey(user.tenantId, user.userId),
        Object.freeze({ ...user }),
      );
    };

    const addActor = (input: ChatTestActorInput): ChatTestActor => {
      const credential = validateCredential(input.credential);
      if (actors.has(credential)) {
        throw new Error("test actor credential is already registered");
      }
      const actor = freezeActor(input.actor);
      if (input.user !== undefined) {
        if (
          input.user.tenantId !== actor.tenantId ||
          input.user.userId !== actor.userId
        ) {
          throw new TypeError("an actor's directory user must have the same tenantId and userId");
        }
        setDirectoryUser(input.user);
      }
      const actorCapabilities = Object.freeze([...(input.capabilities ?? [])]);
      const registered = Object.freeze({
        credential,
        actor,
        capabilities: actorCapabilities,
      });
      actors.set(credential, registered);
      capabilities.set(actorKey(actor), actorCapabilities);
      return registered;
    };

    for (const actor of options.actors ?? []) {
      addActor(actor);
    }

    const adapters: ChatHostAdapters<IncomingMessage> & {
      readonly pushTokenProtector: ChatPushTokenProtector;
    } = Object.freeze({
      auth: Object.freeze({
        async resolveActor(request: IncomingMessage) {
          capture(
            "auth.resolveActor",
            Object.freeze({ authorizationPresent: request.headers.authorization !== undefined }),
          );
          consume("auth.resolveActor");
          const authorization = request.headers.authorization;
          const credential = authorization?.startsWith("Bearer ")
            ? authorization.slice("Bearer ".length)
            : undefined;
          const registered = credential === undefined ? undefined : actors.get(credential);
          if (registered === undefined) {
            throw new Error("Unknown test credential");
          }
          return registered.actor;
        },
      }),
      directory: Object.freeze({
        async getUser(input: ChatDirectoryLookupInput) {
          capture("directory.getUser", Object.freeze({ ...input }));
          consume("directory.getUser");
          return directory.get(directoryKey(input.actor.tenantId, input.userId)) ?? null;
        },
        async searchUsers(input: ChatDirectorySearchInput) {
          capture("directory.searchUsers", Object.freeze({ ...input }));
          consume("directory.searchUsers");
          const normalizedQuery = input.query.toLocaleLowerCase();
          const matching = [...directory.values()]
            .filter(
              (user) =>
                user.tenantId === input.actor.tenantId &&
                (user.displayName.toLocaleLowerCase().includes(normalizedQuery) ||
                  user.userId.toLocaleLowerCase().includes(normalizedQuery)),
            )
            .sort((left, right) => left.userId.localeCompare(right.userId));
          const offset =
            input.continuation === undefined ? 0 : Number(input.continuation);
          if (!Number.isSafeInteger(offset) || offset < 0) {
            throw new Error("Invalid test directory continuation");
          }
          const limit = input.limit ?? matching.length;
          const users = matching.slice(offset, offset + limit);
          const nextOffset = offset + users.length;
          return nextOffset < matching.length
            ? { users, continuation: String(nextOffset) }
            : { users };
        },
      }),
      permissions: Object.freeze({
        async getCapabilities(input: ChatCapabilityResolutionInput) {
          capture("permissions.getCapabilities", Object.freeze({ ...input }));
          consume("permissions.getCapabilities");
          return capabilities.get(actorKey(input.actor)) ?? Object.freeze([]);
        },
        async authorizeEntity(input: ChatEntityAuthorizationInput) {
          capture("permissions.authorizeEntity", Object.freeze({ ...input }));
          consume("permissions.authorizeEntity");
          return entityAuthorization;
        },
      }),
      storage: Object.freeze({
        async createUploadUrl(input: ChatStorageUploadInput) {
          capture("storage.createUploadUrl", Object.freeze({ ...input }));
          consume("storage.createUploadUrl");
          return storage.createUploadUrl(input);
        },
        async verifyObject(input: ChatStorageObjectInput) {
          capture("storage.verifyObject", Object.freeze({ ...input }));
          consume("storage.verifyObject");
          return storage.verifyObject(input);
        },
        async createDownloadUrl(input: ChatStorageDownloadInput) {
          capture("storage.createDownloadUrl", Object.freeze({ ...input }));
          consume("storage.createDownloadUrl");
          return storage.createDownloadUrl(input);
        },
        async deleteObject(input: ChatStorageObjectInput) {
          capture("storage.deleteObject", Object.freeze({ ...input }));
          consume("storage.deleteObject");
          await storage.deleteObject(input);
        },
      }),
      notifications: Object.freeze({
        async send(input: ChatNotificationInput) {
          capture("notifications.send", Object.freeze({ ...input }));
          consume("notifications.send");
        },
      }),
      pushTokenProtector,
      audit: Object.freeze({
        async record(input: ChatAuditEvent) {
          capture("audit.record", Object.freeze({ ...input }));
          consume("audit.record");
        },
      }),
      realtime: Object.freeze({
        subscribe(listener: (event: ChatEvent) => void | Promise<void>) {
          realtimeListeners.add(listener);
          return () => realtimeListeners.delete(listener);
        },
        async publish(input: ChatEvent) {
          capture("realtime.publish", Object.freeze({ ...input }));
          consume("realtime.publish");
          await Promise.all([...realtimeListeners].map((listener) => listener(input)));
        },
      }),
      media: options.media ?? Object.freeze({
        async createRoom(input: ChatMediaCreateRoomInput) {
          capture("media.createRoom", Object.freeze({ ...input }));
          consume("media.createRoom");
          mediaRoomSequence += 1;
          return { roomId: `test-room-${mediaRoomSequence}` };
        },
        async createParticipantToken(input: ChatMediaParticipantTokenInput) {
          capture("media.createParticipantToken", Object.freeze({ ...input }));
          consume("media.createParticipantToken");
          mediaTokenSequence += 1;
          const now = mediaTokenNow();
          if (!(now instanceof Date) || !Number.isFinite(now.valueOf())) {
            throw new TypeError("mediaTokenNow must return a valid Date");
          }
          return {
            token: `test-media-token-${mediaTokenSequence}`,
            expiresAt: new Date(
              now.valueOf() + TEST_MEDIA_JOIN_DESCRIPTOR_TTL_MS,
            ).toISOString(),
          };
        },
        async terminateRoom(input: ChatMediaTerminateRoomInput) {
          capture("media.terminateRoom", Object.freeze({ ...input }));
          consume("media.terminateRoom");
        },
      }),
    });

    runtime = createChatServer<IncomingMessage>({
      database: { pool: postgresHarness.pool, schema: postgresHarness.schema },
      ...adapters,
      features: { ...ALL_FEATURES, ...options.features },
      ...(options.threadInactivityPolicy === undefined
        ? {}
        : { threadInactivityPolicy: options.threadInactivityPolicy }),
      ...(options.httpObservability === undefined
        ? {}
        : { httpObservability: options.httpObservability }),
    });
    httpServer = createServer(runtime.router);
    runtime.attachWebSocket(httpServer);
    const port = await listenOnLoopback(httpServer);
    const endpoint = `http://127.0.0.1:${port}`;
    const webSocketEndpoint = `ws://127.0.0.1:${port}${runtime.config.webSocket.path}`;
    const clients = new Set<ChatClient>();
    const sockets = new Set<WebSocket>();

    const resolveRegistered = (value: ChatTestActor | string): ChatTestActor => {
      const credential = typeof value === "string" ? value : value.credential;
      const registered = actors.get(validateCredential(credential));
      if (registered === undefined) {
        throw new Error("test actor credential is not registered");
      }
      return registered;
    };

    const connectWebSocket = async (
      actor: ChatTestActor | string,
      handshake: ClientHandshakeInput = {
        clientPackageVersion: CHAT_CLIENT_PACKAGE_VERSION,
        protocolVersion: CHAT_PROTOCOL_VERSION,
      },
    ): Promise<ChatTestWebSocketConnection> => {
      const registered = resolveRegistered(actor);
      const socket = new WebSocket(webSocketEndpoint, {
        headers: { authorization: `Bearer ${registered.credential}` },
      });
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      try {
        await new Promise<void>((resolve, reject) => {
          const onOpen = () => {
            socket.off("error", onError);
            resolve();
          };
          const onError = (error: Error) => {
            socket.off("open", onOpen);
            reject(error);
          };
          socket.once("open", onOpen);
          socket.once("error", onError);
        });
        socket.send(JSON.stringify(handshake));
        const accepted = await new Promise<Readonly<Record<string, unknown>>>(
          (resolve, reject) => {
            const cleanup = () => {
              socket.off("message", onMessage);
              socket.off("error", onError);
              socket.off("close", onClose);
            };
            const onMessage = (data: WebSocket.RawData) => {
              cleanup();
              try {
                const value = JSON.parse(data.toString()) as unknown;
                if (
                  typeof value !== "object" ||
                  value === null ||
                  Array.isArray(value) ||
                  (value as Record<string, unknown>).type !== "chat.session.accepted"
                ) {
                  throw new Error("The chat WebSocket did not accept the test session");
                }
                resolve(Object.freeze(value as Record<string, unknown>));
              } catch (error) {
                reject(error);
              }
            };
            const onError = (error: Error) => {
              cleanup();
              reject(error);
            };
            const onClose = (code: number, reason: Buffer) => {
              cleanup();
              reject(
                new Error(
                  `The chat WebSocket closed before acceptance (${code}: ${reason.toString()})`,
                ),
              );
            };
            socket.once("message", onMessage);
            socket.once("error", onError);
            socket.once("close", onClose);
          },
        );
        return Object.freeze({ socket, accepted });
      } catch (error) {
        await terminateWebSocket(socket);
        throw error;
      }
    };

    let teardownPromise: Promise<void> | undefined;
    const harness: ChatTestHarness = {
      backendKind: postgresHarness.backendKind,
      connectionString: postgresHarness.connectionString,
      schema: postgresHarness.schema,
      pool: postgresHarness.pool,
      migrationResult,
      endpoint,
      webSocketEndpoint,
      httpServer,
      runtime,
      adapters,
      clock,
      calls,
      failures,
      addActor,
      removeActor(credential) {
        return actors.delete(credential);
      },
      setCapabilities(actor, values) {
        const registered = resolveRegistered(actor);
        capabilities.set(actorKey(registered.actor), Object.freeze([...values]));
      },
      setEntityAuthorization(allowed) {
        if (typeof allowed !== "boolean") {
          throw new TypeError("entity authorization must be a boolean");
        }
        entityAuthorization = allowed;
      },
      setDirectoryUser,
      removeDirectoryUser(tenantId, userId) {
        return directory.delete(directoryKey(tenantId, userId));
      },
      directoryUsers(tenantId) {
        return Object.freeze(
          [...directory.values()].filter((user) => user.tenantId === tenantId),
        );
      },
      createClient(actor) {
        const registered = resolveRegistered(actor);
        const client = createChatClient({
          endpoint,
          getAccessToken: () => registered.credential,
          cache: createNormalizedChatCache({
            tenantId: registered.actor.tenantId,
            userId: registered.actor.userId,
            sessionId: `test-session:${registered.actor.tenantId}:${registered.actor.userId}` as SessionId,
          }),
        });
        clients.add(client);
        return client;
      },
      connectWebSocket,
      teardown() {
        teardownPromise ??= (async () => {
          const errors: unknown[] = [];
          for (const client of clients) {
            try {
              client.close();
            } catch (error) {
              errors.push(error);
            }
          }
          clients.clear();
          const socketResults = await Promise.allSettled(
            [...sockets].map(terminateWebSocket),
          );
          for (const result of socketResults) {
            if (result.status === "rejected") {
              errors.push(result.reason);
            }
          }
          sockets.clear();
          try {
            runtime?.detachWebSocket();
          } catch (error) {
            errors.push(error);
          }
          try {
            await runtime?.close();
          } catch (error) {
            errors.push(error);
          }
          try {
            if (httpServer !== undefined) {
              await closeHttpServer(httpServer);
            }
          } catch (error) {
            errors.push(error);
          }
          try {
            await options.storage?.teardown?.();
          } catch (error) {
            errors.push(error);
          }
          try {
            await postgresHarness?.teardown();
          } catch (error) {
            errors.push(error);
          }
          if (ownsBackend) {
            try {
              await backend.teardown();
            } catch (error) {
              errors.push(error);
            }
          }
          if (errors.length > 0) {
            throw new AggregateError(errors, "Failed to tear down chat test harness");
          }
        })();
        return teardownPromise;
      },
    };
    return Object.freeze(harness);
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    try {
      runtime?.detachWebSocket();
      await runtime?.close();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      if (httpServer !== undefined) {
        await closeHttpServer(httpServer);
      }
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    try {
      await postgresHarness?.teardown();
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (ownsBackend) {
      try {
        await backend.teardown();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "Chat test harness setup and cleanup both failed",
      );
    }
    throw error;
  }
}
