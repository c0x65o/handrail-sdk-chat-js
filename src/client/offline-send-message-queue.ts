import type { IsoTimestamp } from "../contracts/identifiers.js";
import type { MessageBlock } from "../contracts/message.js";
import type { SendMessageInput } from "../contracts/generated/send-message.js";
import {
  ApplicationChatStorageRecordKind,
  ApplicationChatStorageValidationError,
  createApplicationChatQueuedSendMessageIntent,
  createApplicationChatQueuedSendMessageIntentsRecord,
  parseApplicationChatStorageIdentity,
  type ApplicationChatQueuedSendMessageIntent,
  type ApplicationChatStorage,
  type ApplicationChatStorageIdentity,
} from "./application-chat-storage.js";

const VALIDATION_TIMESTAMP = "1970-01-01T00:00:00.000Z" as IsoTimestamp;

export type OfflineSendMessageQueueErrorCode =
  | "closed"
  | "identity_required"
  | "duplicate_client_message_id"
  | "duplicate_idempotency_key"
  | "enqueue_order_exhausted"
  | "invalid_clock";

/** A deterministic queue lifecycle or correlation failure. */
export class OfflineSendMessageQueueError extends Error {
  readonly code: OfflineSendMessageQueueErrorCode;

  constructor(code: OfflineSendMessageQueueErrorCode, message: string) {
    super(message);
    this.name = "OfflineSendMessageQueueError";
    this.code = code;
  }
}

/** One immutable durable send intent suitable for later replay. */
export interface OfflineSendMessageIntent<
  Block extends MessageBlock = MessageBlock,
> {
  readonly identity: ApplicationChatStorageIdentity;
  readonly request: SendMessageInput<Block>;
  readonly enqueueOrder: number;
  readonly enqueuedAt: IsoTimestamp;
  readonly conversationId: SendMessageInput<Block>["conversationId"];
  readonly content: SendMessageInput<Block>["content"];
  readonly clientMessageId: string;
  readonly idempotencyKey: string;
}

/** Immutable, framework-neutral state for the active storage identity. */
export interface OfflineSendMessageQueueState {
  readonly identity: ApplicationChatStorageIdentity | null;
  readonly isHydrated: boolean;
  readonly intents: readonly OfflineSendMessageIntent[];
}

export type OfflineSendMessageQueueListener = (
  state: OfflineSendMessageQueueState,
) => void;

export interface OfflineSendMessageQueue {
  getState(): OfflineSendMessageQueueState;
  /** Immediately receives the current state, then each successfully persisted state. */
  subscribe(listener: OfflineSendMessageQueueListener): () => void;
  /** Loads and activates exactly one trusted tenant/user/device queue. */
  activate(identity: ApplicationChatStorageIdentity): Promise<OfflineSendMessageQueueState>;
  /** Reloads the active identity after another browser context may have mutated it. */
  reload(): Promise<OfflineSendMessageQueueState>;
  /** Persists a complete validated request before publishing it. */
  enqueue(request: SendMessageInput): Promise<OfflineSendMessageIntent>;
  /** Removes one queued request by client message identity, if present. */
  cancel(clientMessageId: string): Promise<boolean>;
  /** Stops accepting operations, waits for accepted work, and removes listeners. */
  close(): Promise<void>;
}

export interface OfflineSendMessageQueueOptions {
  readonly storage: ApplicationChatStorage;
  readonly initialIdentity?: ApplicationChatStorageIdentity;
  readonly clock?: () => Date;
}

/**
 * Creates an identity-scoped persistent FIFO without coupling it to transport,
 * realtime, or client lifecycle behavior.
 */
export function createOfflineSendMessageQueue(
  options: OfflineSendMessageQueueOptions,
): OfflineSendMessageQueue {
  if (options === null || typeof options !== "object") {
    throw new TypeError("Offline send message queue options must be an object");
  }
  if (options.storage === null || typeof options.storage !== "object") {
    throw new TypeError("Offline send message queue storage must be an object");
  }
  for (const method of ["read", "replace", "remove", "mutate"] as const) {
    if (typeof options.storage[method] !== "function") {
      throw new TypeError(`Offline send message queue storage.${method} must be a function`);
    }
  }
  if (options.clock !== undefined && typeof options.clock !== "function") {
    throw new TypeError("Offline send message queue clock must be a function");
  }

  const storage = options.storage;
  const clock = options.clock ?? (() => new Date());
  const initialIdentity = options.initialIdentity === undefined
    ? null
    : parseApplicationChatStorageIdentity(options.initialIdentity);
  const listeners = new Set<OfflineSendMessageQueueListener>();
  let state = createState(initialIdentity, false, []);
  let operationTail: Promise<void> = Promise.resolve();
  let accepting = true;
  let closePromise: Promise<void> | undefined;

  const closedError = () => new OfflineSendMessageQueueError(
    "closed",
    "The offline send message queue is closed",
  );

  const serialize = <Result>(operation: () => Promise<Result>): Promise<Result> => {
    const result = operationTail.then(operation);
    operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const publish = (next: OfflineSendMessageQueueState): void => {
    state = next;
    for (const listener of [...listeners]) {
      try {
        listener(next);
      } catch {
        // One observer cannot roll back a state that is already durable or
        // prevent other observers from seeing it.
      }
    }
  };

  const load = async (
    identity: ApplicationChatStorageIdentity,
  ): Promise<OfflineSendMessageQueueState> => {
    let record;
    try {
      record = await storage.read(
        identity,
        ApplicationChatStorageRecordKind.queuedSendMessageIntents,
      );
    } catch (error) {
      if (!(error instanceof ApplicationChatStorageValidationError)) throw error;
      // The storage wrapper already conditionally quarantined the malformed
      // encoded value. Treat this read as empty without risking a valid value
      // that another context installed after that quarantine.
      record = null;
    }

    const next = createState(
      identity,
      true,
      record?.intents.map((intent) => createProjection(identity, intent)) ?? [],
    );
    publish(next);
    return next;
  };

  const ensureHydrated = async (): Promise<ApplicationChatStorageIdentity> => {
    const identity = state.identity;
    if (identity === null) {
      throw new OfflineSendMessageQueueError(
        "identity_required",
        "A trusted storage identity is required for offline sends",
      );
    }
    if (!state.isHydrated) await load(identity);
    return identity;
  };

  const rejectIfClosed = <Result>(): Promise<Result> | undefined =>
    accepting ? undefined : Promise.reject(closedError());

  return Object.freeze({
    getState: () => state,
    subscribe(listener: OfflineSendMessageQueueListener) {
      if (typeof listener !== "function") {
        throw new TypeError("Offline send message queue listener must be a function");
      }
      if (!accepting) throw closedError();
      listeners.add(listener);
      try {
        listener(state);
      } catch (error) {
        listeners.delete(listener);
        throw error;
      }
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        listeners.delete(listener);
      };
    },
    activate(identity: ApplicationChatStorageIdentity) {
      const closed = rejectIfClosed<OfflineSendMessageQueueState>();
      if (closed !== undefined) return closed;
      let trustedIdentity: ApplicationChatStorageIdentity;
      try {
        trustedIdentity = parseApplicationChatStorageIdentity(identity);
      } catch (error) {
        return Promise.reject(error);
      }
      return serialize(async () => {
        if (state.isHydrated && identitiesEqual(state.identity, trustedIdentity)) {
          return state;
        }
        return load(trustedIdentity);
      });
    },
    reload() {
      const closed = rejectIfClosed<OfflineSendMessageQueueState>();
      if (closed !== undefined) return closed;
      return serialize(async () => {
        const identity = state.identity;
        if (identity === null) {
          throw new OfflineSendMessageQueueError(
            "identity_required",
            "A trusted storage identity is required for offline sends",
          );
        }
        return load(identity);
      });
    },
    enqueue(request: SendMessageInput) {
      const closed = rejectIfClosed<OfflineSendMessageIntent>();
      if (closed !== undefined) return closed;

      let validatedRequest: SendMessageInput;
      try {
        // The storage contract owns complete send validation and secret/byte
        // rejection. This happens before the operation can reach persistence.
        validatedRequest = createApplicationChatQueuedSendMessageIntent(
          request,
          { enqueueOrder: 1, enqueuedAt: VALIDATION_TIMESTAMP },
        ).request;
      } catch (error) {
        return Promise.reject(error);
      }

      return serialize(async () => {
        const identity = await ensureHydrated();
        let enqueuedAt: IsoTimestamp | undefined;
        const committed = await storage.mutate(
          identity,
          ApplicationChatStorageRecordKind.queuedSendMessageIntents,
          (current) => {
            const currentIntents = current?.intents ?? [];
            if (currentIntents.some(
              (intent) =>
                intent.request.clientMessageId === validatedRequest.clientMessageId,
            )) {
              throw new OfflineSendMessageQueueError(
                "duplicate_client_message_id",
                "The clientMessageId is already queued",
              );
            }
            if (currentIntents.some(
              (intent) => intent.request.idempotencyKey === validatedRequest.idempotencyKey,
            )) {
              throw new OfflineSendMessageQueueError(
                "duplicate_idempotency_key",
                "The idempotencyKey is already queued",
              );
            }

            const previousOrder = currentIntents.at(-1)?.enqueueOrder ?? 0;
            if (previousOrder >= Number.MAX_SAFE_INTEGER) {
              throw new OfflineSendMessageQueueError(
                "enqueue_order_exhausted",
                "The offline send message queue enqueue order is exhausted",
              );
            }
            enqueuedAt ??= readClock(clock);
            return createApplicationChatQueuedSendMessageIntentsRecord(
              identity,
              [
                ...currentIntents,
                createApplicationChatQueuedSendMessageIntent(validatedRequest, {
                  enqueueOrder: previousOrder + 1,
                  enqueuedAt,
                }),
              ],
            );
          },
        );
        if (committed === null) {
          throw new Error("Offline send message queue enqueue committed no record");
        }
        const committedIntents = committed.intents.map(
          (intent) => createProjection(identity, intent),
        );
        const projection = committedIntents.find(
          (intent) => intent.clientMessageId === validatedRequest.clientMessageId,
        );
        if (projection === undefined) {
          throw new Error("Offline send message queue enqueue committed no matching intent");
        }
        publish(createState(identity, true, committedIntents));
        return projection;
      });
    },
    cancel(clientMessageId: string) {
      const closed = rejectIfClosed<boolean>();
      if (closed !== undefined) return closed;
      return serialize(async () => {
        if (typeof clientMessageId !== "string" || clientMessageId.trim().length === 0) {
          return false;
        }
        const identity = await ensureHydrated();
        let removed = false;
        const committed = await storage.mutate(
          identity,
          ApplicationChatStorageRecordKind.queuedSendMessageIntents,
          (current) => {
            if (current === null) {
              removed = false;
              return null;
            }
            const nextIntents = current.intents.filter(
              (intent) => intent.request.clientMessageId !== clientMessageId,
            );
            removed = nextIntents.length !== current.intents.length;
            if (!removed) return current;
            return nextIntents.length === 0
              ? null
              : createApplicationChatQueuedSendMessageIntentsRecord(
                  identity,
                  nextIntents,
                );
          },
        );
        publish(createState(
          identity,
          true,
          committed?.intents.map((intent) => createProjection(identity, intent)) ?? [],
        ));
        return removed;
      });
    },
    close() {
      if (closePromise !== undefined) return closePromise;
      accepting = false;
      closePromise = serialize(async () => {
        listeners.clear();
      });
      return closePromise;
    },
  });
}

function createState(
  identity: ApplicationChatStorageIdentity | null,
  isHydrated: boolean,
  intents: readonly OfflineSendMessageIntent[],
): OfflineSendMessageQueueState {
  return Object.freeze({
    identity,
    isHydrated,
    intents: Object.freeze([...intents]),
  });
}

function createProjection(
  identity: ApplicationChatStorageIdentity,
  intent: ApplicationChatQueuedSendMessageIntent,
): OfflineSendMessageIntent {
  return Object.freeze({
    identity,
    request: intent.request,
    enqueueOrder: intent.enqueueOrder,
    enqueuedAt: intent.enqueuedAt,
    conversationId: intent.request.conversationId,
    content: intent.request.content,
    clientMessageId: intent.request.clientMessageId,
    idempotencyKey: intent.request.idempotencyKey,
  });
}

function readClock(clock: () => Date): IsoTimestamp {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new OfflineSendMessageQueueError(
      "invalid_clock",
      "The offline send message queue clock returned an invalid Date",
    );
  }
  return value.toISOString() as IsoTimestamp;
}

function identitiesEqual(
  left: ApplicationChatStorageIdentity | null,
  right: ApplicationChatStorageIdentity,
): boolean {
  return left !== null &&
    left.tenantId === right.tenantId &&
    left.userId === right.userId &&
    left.deviceId === right.deviceId;
}
