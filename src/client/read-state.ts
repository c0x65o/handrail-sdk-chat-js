import type {
  ConversationId,
  IsoTimestamp,
  MessageSequence,
  UserId,
} from "../contracts/identifiers.js";
import type {
  NormalizedThreadSummary,
  ThreadSummaryFacts,
} from "../contracts/message.js";
import {
  deriveUnreadCount,
  hasDirectMessageRecipientRead,
  markRead as applyMarkRead,
  markUnread as applyMarkUnread,
  type ConversationReadState,
} from "../contracts/member-read-state.js";
import {
  applyReadCursorMutation,
  parseMarkReadInput,
  parseMarkUnreadInput,
  parseReadCursorMutationOutcome,
  parseReadCursorUpdatedEvent,
  parseReadCursorMutationResult,
  type MarkReadInput,
  type MarkReadResult,
  type MarkUnreadInput,
  type MarkUnreadResult,
  type ReadCursorMutationInput,
  type ReadCursorMutationResult,
} from "../contracts/read-cursor-mutation.js";
import type { ChatEvent } from "../contracts/realtime.js";
import {
  ApplicationChatStorageRecordKind,
  ApplicationChatStorageValidationError,
  createApplicationChatQueuedReadCursorIntent,
  createApplicationChatQueuedReadCursorIntentsRecord,
  type ApplicationChatQueuedReadCursorIntent,
  type ApplicationChatStorage,
  type ApplicationChatStorageIdentity,
} from "./application-chat-storage.js";
import type {
  ChatCommandClosed,
  ChatCommandDescriptor,
  ChatCommandDispatchOptions,
  ChatCommandMalformedResponse,
  ChatCommandResult,
  ChatCommandValidationFailure,
} from "./command-dispatcher.js";
import type {
  ChatTimelineMessage,
  NormalizedChatCache,
  NormalizedChatCacheState,
} from "./normalized-cache.js";

export interface ChatMarkReadInput {
  readonly conversationId: ConversationId;
  readonly throughSequence: MessageSequence;
}

export interface ChatMarkUnreadInput {
  readonly conversationId: ConversationId;
  readonly fromSequence: MessageSequence;
}

export type ChatMarkReadResult = ChatCommandResult<MarkReadResult>;
export type ChatMarkUnreadResult = ChatCommandResult<MarkUnreadResult>;

export interface DirectMessageReceiptInput {
  readonly conversationId: ConversationId;
  /** Supplied only after the host has authorized access to the other DM member. */
  readonly otherMemberReadState: ConversationReadState;
  readonly messageSequence: MessageSequence;
}

/**
 * Authority supplied for the current viewer and thread, within the caller's
 * current tenant scope. Membership and following must be established for this
 * exact identity; null means unknown. A missing cache/map entry establishes
 * neither inactive membership nor an explicit unfollow, nor a zero cursor.
 */
export interface ThreadSummaryViewerBasis {
  readonly expectedUserId: UserId;
  readonly expectedThreadId: ConversationId;
  readonly membershipActive: boolean | null;
  readonly following: boolean | null;
  /** Supply only an authoritative cursor for the expected viewer/thread. */
  readonly cursor?: ConversationReadState;
  /**
   * An explicit assertion of complete contiguous sequence coverage from 1
   * through latestSequence (0 for an established empty stream) for this thread.
   * replyCount, partial pages, or a latest-sequence value alone cannot establish
   * this assertion. Omit while coverage is unknown or invalidated.
   */
  readonly sequenceCoverage?: {
    readonly threadId: ConversationId;
    readonly complete: true;
    readonly latestSequence: MessageSequence;
  };
}

/** Pure, transient viewer projection; shared facts never supply unread authority. */
export const projectThreadSummaryForViewer = (
  facts: ThreadSummaryFacts,
  basis: ThreadSummaryViewerBasis,
): NormalizedThreadSummary => {
  let unreadCount: number | null = null;
  if (basis.expectedThreadId === facts.threadId) {
    if (basis.membershipActive === false && basis.following === false) {
      unreadCount = 0;
    } else if (basis.membershipActive === true || basis.following === true) {
      const { cursor, sequenceCoverage } = basis;
      if (
        cursor !== undefined &&
        cursor.userId === basis.expectedUserId &&
        cursor.conversationId === basis.expectedThreadId &&
        sequenceCoverage?.complete === true &&
        sequenceCoverage.threadId === basis.expectedThreadId
      ) {
        unreadCount = deriveUnreadCount(sequenceCoverage.latestSequence, cursor);
      }
    }
  }
  return { ...facts, unreadCount };
};

export const selectConversationUnreadCount = (
  state: NormalizedChatCacheState,
  conversationId: ConversationId,
): number | undefined => {
  const readState = state.currentUser.readStates[conversationId];
  const latestSequence = state.metadata.conversations[conversationId]?.latestSequence;
  return readState === undefined || latestSequence === undefined
    ? undefined
    : deriveUnreadCount(latestSequence, readState);
};

export const selectFirstUnreadSequence = (
  state: NormalizedChatCacheState,
  conversationId: ConversationId,
): MessageSequence | undefined => {
  const readState = state.currentUser.readStates[conversationId];
  const latestSequence = state.metadata.conversations[conversationId]?.latestSequence;
  if (readState === undefined || latestSequence === undefined) return undefined;
  const effectiveReadSequence =
    readState.manualUnreadFromSequence === undefined
      ? readState.lastReadSequence
      : Math.min(
          readState.lastReadSequence,
          readState.manualUnreadFromSequence - 1,
        );
  return effectiveReadSequence < latestSequence
    ? ((effectiveReadSequence + 1) as MessageSequence)
    : undefined;
};

/** Returns the first hydrated unread row; an unhydrated sequence remains undefined. */
export const selectFirstUnreadMessage = (
  state: NormalizedChatCacheState,
  conversationId: ConversationId,
): ChatTimelineMessage | undefined => {
  const firstSequence = selectFirstUnreadSequence(state, conversationId);
  const timeline = state.timelines[conversationId];
  if (firstSequence === undefined || timeline === undefined) return undefined;
  for (const messageId of timeline.messageIds) {
    const message = state.entities.messages[messageId];
    if (message?.sequence === firstSequence) return message;
  }
  return undefined;
};

export const selectManualUnreadFromSequence = (
  state: NormalizedChatCacheState,
  conversationId: ConversationId,
): MessageSequence | undefined =>
  state.currentUser.readStates[conversationId]?.manualUnreadFromSequence;

/**
 * Derives a one-to-one DM receipt from a supplied cursor. It intentionally
 * returns no value for channels, group DMs, threads, the actor's own cursor, or
 * a cursor from another conversation, and never stores the supplied cursor.
 */
export const selectDirectMessageOtherUserRead = (
  state: NormalizedChatCacheState,
  input: DirectMessageReceiptInput,
): boolean | undefined => {
  const conversation = state.entities.conversations[input.conversationId];
  const identity = state.identity;
  if (
    conversation?.type !== "direct" ||
    identity === null ||
    input.otherMemberReadState.conversationId !== input.conversationId ||
    input.otherMemberReadState.userId === identity.userId
  ) {
    return undefined;
  }
  return hasDirectMessageRecipientRead(input.otherMemberReadState, {
    sequence: input.messageSequence,
  });
};

export interface ChatReadStateRuntimeOptions {
  readonly cache: NormalizedChatCache;
  readonly dispatch: <Input, RequestBody, Result>(
    descriptor: ChatCommandDescriptor<Input, RequestBody, Result>,
    input: Input,
    options?: ChatCommandDispatchOptions,
  ) => Promise<ChatCommandResult<Result>>;
  readonly generateIdempotencyKey: () => string;
  /** Defaults to a microtask, allowing synchronous mark-read advances to coalesce. */
  readonly schedule?: (task: () => void) => void;
  /** Same-session durable intent boundary. Retained intent draining is separate. */
  readonly persistence?: {
    readonly storage: ApplicationChatStorage;
    readonly getActiveScope: () => ChatReadStatePersistenceScope | undefined;
    readonly isActiveScope: (scope: ChatReadStatePersistenceScope) => boolean;
    readonly now?: () => number;
    readonly isRecoveryReady?: () => boolean;
    readonly recovery?: ChatRetainedReadStateRecoveryOptions;
    readonly onDiagnostic?: (diagnostic: ChatReadStatePersistenceDiagnostic) => void;
    /** Runs only after the exact read intent is durably replace-committed. */
    readonly onPersistedIntent?: (command: string, idempotencyKey: string) => void;
  };
}

export interface ChatRetainedReadStateRecoveryOptions {
  readonly initialDelayMs?: number;
  readonly maximumDelayMs?: number;
  readonly multiplier?: number;
  readonly wait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

export interface ChatReadStatePersistenceDiagnostic {
  readonly code:
    | "read_intents_read_failed"
    | "read_intents_rejected"
    | "read_intents_quarantine_failed";
  readonly message: string;
}

export interface ChatReadStatePersistenceScope {
  readonly identity: ApplicationChatStorageIdentity;
  readonly generation: number;
}

export interface ChatReadStateRuntime {
  markRead(input: ChatMarkReadInput): Promise<ChatMarkReadResult>;
  markUnread(input: ChatMarkUnreadInput): Promise<ChatMarkUnreadResult>;
  /** Settles an exactly matching same-session durable intent. */
  handleCanonicalEvent(event: ChatEvent): void;
  /** Validates and settles an exactly correlated result relayed by the leader. */
  handleCoordinatedResult(command: string, idempotencyKey: string, value: unknown): void;
  /** Loads retained work for one exact trusted persistence generation. */
  activateRetained(
    scope: ChatReadStatePersistenceScope,
    authoritativeReadStates?: readonly ConversationReadState[],
  ): Promise<void>;
  /** Reloads all retained work, or one announced command correlation. */
  reloadRetained(
    scope: ChatReadStatePersistenceScope,
    announcement?: {
      readonly command: string;
      readonly idempotencyKey: string;
    },
  ): Promise<void>;
  /** Marks server/coordinator snapshot state safe as a retained-work baseline. */
  markAuthoritative(readStates: readonly ConversationReadState[]): void;
  resumeRetained(): void;
  pauseRetained(): void;
  /** Cancels queued logical work and restores the latest canonical projection. */
  closeActive(): void;
}

type MutationResult = ChatCommandResult<ReadCursorMutationResult>;
type MutationResolver = (result: MutationResult) => void;

interface QueuedMutation {
  input: ReadCursorMutationInput;
  readonly resolvers: MutationResolver[];
  phase: "pending" | "persisting" | "persisted";
  durable?: {
    readonly scope: ChatReadStatePersistenceScope;
    readonly intent: ApplicationChatQueuedReadCursorIntent;
  };
  settlement?: Promise<boolean>;
  settled: boolean;
  readonly retained: boolean;
  retryNumber: number;
}

interface ConversationQueue {
  canonical: ConversationReadState;
  readonly mutations: QueuedMutation[];
  active: QueuedMutation | undefined;
  scheduled: boolean;
  persistenceScheduled: boolean;
  persisting: boolean;
}

const VALIDATION_FAILURE = Object.freeze({
  status: "validation",
  message: "The command input is invalid.",
} as const satisfies ChatCommandValidationFailure);
const MALFORMED_RESPONSE = Object.freeze({
  status: "malformed_response",
  message: "The chat server returned an invalid command response.",
} as const satisfies ChatCommandMalformedResponse);
const CLOSED = Object.freeze({
  status: "closed",
  message: "The chat client was closed.",
} as const satisfies ChatCommandClosed);

const markReadDescriptor: ChatCommandDescriptor<
  MarkReadInput,
  MarkReadInput,
  MarkReadResult
> = Object.freeze({
  name: "conversation.mark_read",
  method: "PATCH",
  path: (input: MarkReadInput) =>
    `/conversations/${encodeURIComponent(input.conversationId)}/read-cursor`,
  retry: "safe",
  validateInput: parseMarkReadInput,
  parseResult(value: unknown) {
    const result = parseReadCursorMutationResult(value);
    if (result.operation !== "mark_read") throw new TypeError("unexpected operation");
    return result;
  },
});

const markUnreadDescriptor: ChatCommandDescriptor<
  MarkUnreadInput,
  MarkUnreadInput,
  MarkUnreadResult
> = Object.freeze({
  name: "conversation.mark_unread",
  method: "PATCH",
  path: (input: MarkUnreadInput) =>
    `/conversations/${encodeURIComponent(input.conversationId)}/read-cursor`,
  retry: "safe",
  validateInput: parseMarkUnreadInput,
  parseResult(value: unknown) {
    const result = parseReadCursorMutationResult(value);
    if (result.operation !== "mark_unread") throw new TypeError("unexpected operation");
    return result;
  },
});

const readCommandForOperation = (
  operation: ReadCursorMutationInput["operation"],
): string => operation === "mark_read"
  ? markReadDescriptor.name
  : markUnreadDescriptor.name;

const isSupportedReadCommand = (command: string): boolean =>
  command === markReadDescriptor.name || command === markUnreadDescriptor.name;

const canonicalIsNewer = (
  candidate: ConversationReadState,
  current: ConversationReadState,
): boolean =>
  candidate.lastReadSequence > current.lastReadSequence ||
  (candidate.lastReadSequence === current.lastReadSequence &&
    Date.parse(candidate.updatedAt) > Date.parse(current.updatedAt));

const readStatesEqual = (
  left: ConversationReadState,
  right: ConversationReadState,
): boolean =>
  left.conversationId === right.conversationId &&
  left.userId === right.userId &&
  left.lastReadSequence === right.lastReadSequence &&
  left.manualUnreadFromSequence === right.manualUnreadFromSequence &&
  left.updatedAt === right.updatedAt;

export function createChatReadStateRuntime(
  options: ChatReadStateRuntimeOptions,
): ChatReadStateRuntime {
  const queues = new Map<ConversationId, ConversationQueue>();
  const schedule = options.schedule ?? ((task: () => void) => queueMicrotask(task));
  const now = options.persistence?.now ?? Date.now;
  let suppressCanonicalObservation = 0;
  let epoch = 0;
  let storageMutationTail: Promise<void> = Promise.resolve();
  let retainedEpoch = 0;
  const retainedRetryControllers = new Set<AbortController>();
  const retainedByConversation = new Map<
    ConversationId,
    ApplicationChatQueuedReadCursorIntent[]
  >();
  const authoritativeReadStates = new Map<ConversationId, ConversationReadState>();
  let retainedScope: ChatReadStatePersistenceScope | undefined;
  const recovery = options.persistence?.recovery;
  const recoveryInitialDelayMs = recovery?.initialDelayMs ?? 250;
  const recoveryMaximumDelayMs = recovery?.maximumDelayMs ?? 30_000;
  const recoveryMultiplier = recovery?.multiplier ?? 2;
  const recoveryWait = recovery?.wait ?? ((delayMs: number, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, delayMs);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("retained read recovery aborted"));
      }, { once: true });
    }));

  const diagnose = (diagnostic: ChatReadStatePersistenceDiagnostic): void => {
    try {
      options.persistence?.onDiagnostic?.(Object.freeze(diagnostic));
    } catch {
      // Diagnostic observers cannot alter recovery or online startup.
    }
  };

  const recoveryReady = (): boolean =>
    options.persistence?.isRecoveryReady?.() !== false;

  const samePersistenceScope = (
    left: ChatReadStatePersistenceScope,
    right: ChatReadStatePersistenceScope,
  ): boolean => left.generation === right.generation &&
    left.identity.tenantId === right.identity.tenantId &&
    left.identity.userId === right.identity.userId &&
    left.identity.deviceId === right.identity.deviceId;

  const retainedDelay = (retryNumber: number): number => Math.min(
    recoveryMaximumDelayMs,
    Math.max(0, Math.round(
      recoveryInitialDelayMs * recoveryMultiplier ** Math.max(0, retryNumber - 1),
    )),
  );

  const serializeStorageMutation = <Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> => {
    const result = storageMutationTail.then(operation);
    storageMutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const writeResult = (result: ReadCursorMutationResult): void => {
    suppressCanonicalObservation += 1;
    try {
      options.cache.reconcileCurrentUserReadState(result);
    } finally {
      suppressCanonicalObservation -= 1;
    }
  };

  const projectionFor = (
    queue: ConversationQueue,
    includeUnpersisted = false,
  ): ReadCursorMutationResult => {
    const metadata = options.cache.getState().metadata.conversations[
      queue.canonical.conversationId
    ];
    if (metadata === undefined) throw new RangeError("conversation metadata is missing");
    let projected = queue.canonical;
    let operation: ReadCursorMutationResult["operation"] =
      projected.manualUnreadFromSequence === undefined ? "mark_read" : "mark_unread";
    for (const mutation of [
      ...(queue.active === undefined ? [] : [queue.active]),
      ...queue.mutations,
    ].filter((candidate) => includeUnpersisted || candidate.phase === "persisted")) {
      if (mutation.input.operation === "mark_read") {
        if (mutation.input.throughSequence < projected.lastReadSequence) continue;
        projected = applyMarkRead(
          projected,
          mutation.input.throughSequence,
          projected.updatedAt,
        );
        operation = "mark_read";
      } else {
        if (mutation.input.fromSequence > projected.lastReadSequence) continue;
        projected = applyMarkUnread(
          projected,
          mutation.input.fromSequence,
          projected.updatedAt,
        );
        operation = "mark_unread";
      }
    }
    return parseReadCursorMutationResult({
      operation,
      conversationId: projected.conversationId,
      readState: projected,
      latestSequence: metadata.latestSequence,
      unreadCount: deriveUnreadCount(metadata.latestSequence, projected),
    });
  };

  const project = (queue: ConversationQueue): void => {
    writeResult(projectionFor(queue));
  };

  const mutationMatchesCanonical = (
    mutation: QueuedMutation,
    result: ReadCursorMutationResult,
  ): boolean =>
    result.operation === mutation.input.operation &&
    result.conversationId === mutation.input.conversationId &&
    (mutation.input.operation === "mark_read"
      ? result.readState.lastReadSequence === mutation.input.throughSequence
      : result.readState.manualUnreadFromSequence === mutation.input.fromSequence);

  const mutationIsAttached = (
    queue: ConversationQueue,
    mutation: QueuedMutation,
  ): boolean => queue.active === mutation || queue.mutations.includes(mutation);

  const sameStoredRequest = (
    left: ReadCursorMutationInput,
    right: ReadCursorMutationInput,
  ): boolean =>
    left.operation === right.operation &&
    left.conversationId === right.conversationId &&
    left.idempotencyKey === right.idempotencyKey &&
    (left.operation === "mark_read" && right.operation === "mark_read"
      ? left.throughSequence === right.throughSequence
      : left.operation === "mark_unread" && right.operation === "mark_unread" &&
        left.fromSequence === right.fromSequence);

  const settleDurableMutation = (mutation: QueuedMutation): Promise<boolean> => {
    if (options.persistence === undefined || mutation.durable === undefined) {
      return Promise.resolve(true);
    }
    if (mutation.settled) return Promise.resolve(true);
    if (mutation.settlement !== undefined) return mutation.settlement;
    const durable = mutation.durable;
    const persistence = options.persistence;
    const settlement = serializeStorageMutation(async () => {
      if (!persistence.isActiveScope(durable.scope)) return false;
      const settlementState: {
        outcome: "absent" | "removed" | "mismatched";
      } = { outcome: "absent" };
      await persistence.storage.mutate(
        durable.scope.identity,
        ApplicationChatStorageRecordKind.queuedReadCursorIntents,
        (record) => {
          const exactIndex = record?.intents.findIndex((candidate) =>
            candidate.request.idempotencyKey === durable.intent.request.idempotencyKey) ?? -1;
          if (exactIndex < 0) {
            settlementState.outcome = "absent";
            return record;
          }
          const exact = record!.intents[exactIndex]!;
          if (!sameStoredRequest(exact.request, durable.intent.request)) {
            settlementState.outcome = "mismatched";
            return record;
          }
          settlementState.outcome = "removed";
          const remaining = record!.intents.filter((_, index) => index !== exactIndex);
          return remaining.length === 0
            ? null
            : createApplicationChatQueuedReadCursorIntentsRecord(
                durable.scope.identity,
                remaining,
              );
        },
      );
      if (!persistence.isActiveScope(durable.scope)) return false;
      return settlementState.outcome !== "mismatched";
    }).catch(() => false);
    mutation.settlement = settlement.then((settled) => {
      if (settled) mutation.settled = true;
      return settled;
    });
    return mutation.settlement;
  };

  const removeQueuedMutation = (
    queue: ConversationQueue,
    mutation: QueuedMutation,
  ): void => {
    if (queue.active === mutation) {
      queue.active = undefined;
      return;
    }
    const index = queue.mutations.indexOf(mutation);
    if (index >= 0) queue.mutations.splice(index, 1);
  };

  const settleFromCanonical = (
    result: ReadCursorMutationResult,
  ): void => {
    const queue = queues.get(result.conversationId);
    if (queue === undefined) return;
    const mutation = [
      ...(queue.active === undefined ? [] : [queue.active]),
      ...queue.mutations,
    ].find((candidate) =>
      candidate.phase === "persisted" &&
      !candidate.settled &&
      mutationMatchesCanonical(candidate, result));
    if (mutation?.durable === undefined) return;
    if (mutation.retained && !recoveryReady()) return;
    const observedEpoch = epoch;
    void settleDurableMutation(mutation).then((settled) => {
      if (
        !settled ||
        observedEpoch !== epoch ||
        !options.persistence?.isActiveScope(mutation.durable!.scope) ||
        queues.get(result.conversationId) !== queue ||
        !mutationIsAttached(queue, mutation)
      ) return;
      if (canonicalIsNewer(result.readState, queue.canonical)) {
        queue.canonical = result.readState;
      }
      removeQueuedMutation(queue, mutation);
      project(queue);
      resolveMutation(mutation, Object.freeze({ status: "success", value: result }));
      schedulePump(queue);
      schedulePersistence(queue);
    });
  };

  const parseCoordinatedMutationResult = (
    mutation: QueuedMutation,
    value: unknown,
  ): MutationResult | undefined => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
    const candidate = value as Record<string, unknown>;
    if (candidate.status === "success") {
      if (Object.keys(candidate).length !== 2 || !("value" in candidate)) return undefined;
      try {
        return Object.freeze({
          status: "success",
          value: parseReadCursorMutationOutcome(candidate.value, mutation.input),
        });
      } catch {
        return undefined;
      }
    }
    const terminalMessages = {
      validation: "The command input is invalid.",
      conflict: "The command conflicts with current server state.",
      authentication: "Chat authentication failed.",
      feature_disabled: "The requested chat feature is disabled.",
      unsupported: "The requested chat command is unsupported.",
      rejected: "The chat server rejected the command.",
    } as const;
    const status = candidate.status as keyof typeof terminalMessages;
    if (terminalMessages[status] === undefined || candidate.message !== terminalMessages[status]) {
      return undefined;
    }
    const keys = Object.keys(candidate);
    if (
      (keys.length !== 2 && keys.length !== 3) ||
      !keys.every((key) => key === "status" || key === "message" || key === "httpStatus") ||
      (keys.length === 3 &&
        (!Number.isInteger(candidate.httpStatus) ||
          (candidate.httpStatus as number) < 100 ||
          (candidate.httpStatus as number) > 599))
    ) return undefined;
    return Object.freeze({ ...candidate }) as unknown as MutationResult;
  };

  const observeCanonical = (readState: ConversationReadState): void => {
    const queue = queues.get(readState.conversationId);
    if (queue === undefined) return;
    if (canonicalIsNewer(readState, queue.canonical)) queue.canonical = readState;
    project(queue);
    const metadata = options.cache.getState().metadata.conversations[
      readState.conversationId
    ];
    if (metadata === undefined) return;
    for (const operation of ["mark_read", "mark_unread"] as const) {
      try {
        settleFromCanonical(parseReadCursorMutationResult({
          operation,
          conversationId: readState.conversationId,
          readState,
          latestSequence: metadata.latestSequence,
          unreadCount: deriveUnreadCount(metadata.latestSequence, readState),
        }));
      } catch {
        // Only the operation coherent with the canonical cursor can settle work.
      }
    }
  };

  const abandonQueues = (restoreProjection: boolean): void => {
    epoch += 1;
    // A superseded identity must not make its unresolved adapter operation a
    // prerequisite for the replacement identity's startup read.
    storageMutationTail = Promise.resolve();
    retainedEpoch += 1;
    for (const controller of retainedRetryControllers) controller.abort();
    retainedRetryControllers.clear();
    retainedByConversation.clear();
    authoritativeReadStates.clear();
    retainedScope = undefined;
    for (const queue of queues.values()) {
      const pending = [
        ...(queue.active === undefined ? [] : [queue.active]),
        ...queue.mutations,
      ];
      queue.active = undefined;
      queue.mutations.length = 0;
      queue.scheduled = false;
      queue.persistenceScheduled = false;
      queue.persisting = false;
      if (restoreProjection) project(queue);
      for (const mutation of pending) resolveMutation(mutation, CLOSED);
    }
    if (!restoreProjection) queues.clear();
  };

  options.cache.subscribe(
    (state) => state,
    (next, previous) => {
      if (suppressCanonicalObservation > 0) return;
      const identityChanged =
        next.identity?.tenantId !== previous.identity?.tenantId ||
        next.identity?.userId !== previous.identity?.userId ||
        next.identity?.sessionId !== previous.identity?.sessionId;
      const readStateRemoved = Object.keys(previous.currentUser.readStates).some(
        (conversationId) =>
          next.currentUser.readStates[conversationId as ConversationId] === undefined,
      );
      if (identityChanged || readStateRemoved) {
        abandonQueues(false);
        return;
      }
      for (const [conversationId, readState] of Object.entries(
        next.currentUser.readStates,
      )) {
        if (
          readState !==
          previous.currentUser.readStates[conversationId as ConversationId]
        ) {
          observeCanonical(readState);
        }
      }
    },
  );

  const queueFor = (conversationId: ConversationId): ConversationQueue => {
    const existing = queues.get(conversationId);
    if (existing !== undefined) return existing;
    const canonical = options.cache.getState().currentUser.readStates[conversationId];
    if (canonical === undefined) throw new RangeError("read state is missing");
    const created: ConversationQueue = {
      canonical,
      mutations: [],
      active: undefined,
      scheduled: false,
      persistenceScheduled: false,
      persisting: false,
    };
    queues.set(conversationId, created);
    return created;
  };

  const validateAuthored = (
    authored: ChatMarkReadInput | ChatMarkUnreadInput,
    idempotencyKey: string,
  ): { readonly queue: ConversationQueue; readonly input: ReadCursorMutationInput } => {
    const queue = queueFor(authored.conversationId);
    const state = options.cache.getState();
    const current = projectionFor(queue, true).readState;
    const latestSequence = state.metadata.conversations[authored.conversationId]?.latestSequence;
    if (current === undefined || latestSequence === undefined) {
      throw new RangeError("read state is not hydrated");
    }
    const input = "throughSequence" in authored
      ? parseMarkReadInput({
          operation: "mark_read",
          conversationId: authored.conversationId,
          throughSequence: authored.throughSequence,
          idempotencyKey,
        })
      : parseMarkUnreadInput({
          operation: "mark_unread",
          conversationId: authored.conversationId,
          fromSequence: authored.fromSequence,
          idempotencyKey,
        });
    applyReadCursorMutation(input, {
      currentReadState: current,
      latestSequence,
      updatedAt: current.updatedAt,
    });
    return { queue, input };
  };

  const validCanonicalResult = (
    mutation: QueuedMutation,
    result: ReadCursorMutationResult,
  ): boolean => {
    const identity = options.cache.getState().identity;
    return (
      identity !== null &&
      result.readState.userId === identity.userId &&
      mutationMatchesCanonical(mutation, result)
    );
  };

  const resolveMutation = (
    mutation: QueuedMutation,
    result: MutationResult,
  ): void => {
    for (const resolve of mutation.resolvers) resolve(result);
  };

  const attachRetained = (conversationId: ConversationId): void => {
    const scope = retainedScope;
    const intents = retainedByConversation.get(conversationId);
    const identity = options.cache.getState().identity;
    if (
      scope === undefined ||
      intents === undefined ||
      !authoritativeReadStates.has(conversationId) ||
      !options.persistence?.isActiveScope(scope) ||
      identity === null ||
      identity.tenantId !== scope.identity.tenantId ||
      identity.userId !== scope.identity.userId
    ) return;
    let queue: ConversationQueue;
    try {
      queue = queueFor(conversationId);
    } catch {
      return;
    }
    queue.canonical = authoritativeReadStates.get(conversationId)!;
    retainedByConversation.delete(conversationId);
    for (const intent of intents) {
      queue.mutations.push({
        input: intent.request,
        resolvers: [],
        phase: "persisted",
        durable: Object.freeze({ scope, intent }),
        settled: false,
        retained: true,
        retryNumber: 0,
      });
    }
    project(queue);
    schedulePump(queue);
  };

  const hasKnownRetainedIntent = (
    scope: ChatReadStatePersistenceScope,
    intent: ApplicationChatQueuedReadCursorIntent,
  ): boolean => {
    const matches = (mutation: QueuedMutation): boolean =>
      mutation.durable !== undefined &&
      samePersistenceScope(mutation.durable.scope, scope) &&
      mutation.input.idempotencyKey === intent.request.idempotencyKey;
    for (const queue of queues.values()) {
      if (queue.active !== undefined && matches(queue.active)) return true;
      if (queue.mutations.some(matches)) return true;
    }
    for (const pending of retainedByConversation.values()) {
      if (pending.some((candidate) =>
        candidate.request.idempotencyKey === intent.request.idempotencyKey)) return true;
    }
    return false;
  };

  const stageRetainedIntent = (
    scope: ChatReadStatePersistenceScope,
    intent: ApplicationChatQueuedReadCursorIntent,
  ): void => {
    if (hasKnownRetainedIntent(scope, intent)) return;
    const conversationId = intent.request.conversationId;
    const retained = retainedByConversation.get(conversationId) ?? [];
    retained.push(intent);
    retainedByConversation.set(conversationId, retained);
    attachRetained(conversationId);
  };

  const reconcileRetainedWithRecord = (
    scope: ChatReadStatePersistenceScope,
    intents: readonly ApplicationChatQueuedReadCursorIntent[],
  ): void => {
    const stored = new Map(intents.map((intent) => [
      intent.request.idempotencyKey,
      intent.request,
    ]));
    for (const [conversationId, pending] of retainedByConversation) {
      const remaining = pending.filter((intent) => {
        const request = stored.get(intent.request.idempotencyKey);
        return request !== undefined && sameStoredRequest(request, intent.request);
      });
      if (remaining.length === 0) retainedByConversation.delete(conversationId);
      else retainedByConversation.set(conversationId, remaining);
    }
    for (const queue of queues.values()) {
      let changed = false;
      for (let index = queue.mutations.length - 1; index >= 0; index -= 1) {
        const mutation = queue.mutations[index];
        if (
          mutation?.retained !== true ||
          mutation.durable === undefined ||
          !samePersistenceScope(mutation.durable.scope, scope)
        ) continue;
        const request = stored.get(mutation.input.idempotencyKey);
        if (request === undefined || !sameStoredRequest(request, mutation.input)) {
          queue.mutations.splice(index, 1);
          changed = true;
        }
      }
      if (changed) project(queue);
    }
  };

  const pump = async (
    queue: ConversationQueue,
    scheduledEpoch: number,
  ): Promise<void> => {
    queue.scheduled = false;
    if (scheduledEpoch !== epoch || queue.active !== undefined) return;
    const mutation = queue.mutations[0];
    if (mutation === undefined || mutation.phase !== "persisted") return;
    if (mutation.durable !== undefined && !recoveryReady()) return;
    queue.mutations.shift();
    queue.active = mutation;

    let result: MutationResult;
    if (mutation.input.operation === "mark_read") {
      const descriptor = mutation.durable === undefined
        ? markReadDescriptor
        : {
            ...markReadDescriptor,
            parseResult(value: unknown): MarkReadResult {
              const parsed = parseReadCursorMutationOutcome(
                value,
                mutation.input as MarkReadInput,
              );
              if (parsed.operation !== "mark_read") throw new TypeError("unexpected operation");
              return parsed;
            },
          };
      result = await options.dispatch(descriptor, mutation.input, {
        idempotencyKey: mutation.input.idempotencyKey,
      });
    } else {
      const descriptor = mutation.durable === undefined
        ? markUnreadDescriptor
        : {
            ...markUnreadDescriptor,
            parseResult(value: unknown): MarkUnreadResult {
              const parsed = parseReadCursorMutationOutcome(
                value,
                mutation.input as MarkUnreadInput,
              );
              if (parsed.operation !== "mark_unread") throw new TypeError("unexpected operation");
              return parsed;
            },
          };
      result = await options.dispatch(descriptor, mutation.input, {
        idempotencyKey: mutation.input.idempotencyKey,
      });
    }
    if (scheduledEpoch !== epoch || queue.active !== mutation) return;

    if (result.status === "success") {
      if (validCanonicalResult(mutation, result.value)) {
        const canonicalResult = parseReadCursorMutationResult({
          operation: result.value.operation,
          conversationId: result.value.conversationId,
          readState: result.value.readState,
          latestSequence: result.value.latestSequence,
          unreadCount: result.value.unreadCount,
        });
        const newer = canonicalIsNewer(canonicalResult.readState, queue.canonical);
        if (newer) {
          queue.canonical = canonicalResult.readState;
        }
        if (newer || readStatesEqual(canonicalResult.readState, queue.canonical)) {
          writeResult(canonicalResult);
        }
      } else {
        result = MALFORMED_RESPONSE;
      }
    }
    const terminal =
      result.status === "validation" ||
      result.status === "authentication" ||
      result.status === "conflict" ||
      result.status === "feature_disabled" ||
      result.status === "unsupported" ||
      result.status === "rejected";
    const retryable = result.status === "transport" || result.status === "malformed_response";
    if (mutation.retained && retryable) {
      queue.active = undefined;
      queue.mutations.unshift(mutation);
      project(queue);
      const observedRetainedEpoch = retainedEpoch;
      const controller = new AbortController();
      retainedRetryControllers.add(controller);
      try {
        mutation.retryNumber += 1;
        await recoveryWait(retainedDelay(mutation.retryNumber), controller.signal);
      } catch {
        // A lifecycle pause aborts the wait and leaves the exact intent queued.
      } finally {
        retainedRetryControllers.delete(controller);
      }
      if (
        scheduledEpoch === epoch &&
        observedRetainedEpoch === retainedEpoch &&
        recoveryReady()
      ) schedulePump(queue);
      return;
    }
    if (result.status === "success" || terminal) {
      await settleDurableMutation(mutation);
      if (scheduledEpoch !== epoch || queue.active !== mutation) return;
    }
    queue.active = undefined;
    project(queue);
    resolveMutation(mutation, result);
    schedulePump(queue);
    schedulePersistence(queue);
  };

  const schedulePump = (queue: ConversationQueue): void => {
    if (
      queue.scheduled ||
      queue.active !== undefined ||
      queue.mutations[0]?.phase !== "persisted" ||
      (queue.mutations[0]?.durable !== undefined && !recoveryReady())
    ) {
      return;
    }
    queue.scheduled = true;
    const scheduledEpoch = epoch;
    schedule(() => {
      void pump(queue, scheduledEpoch);
    });
  };

  const persistNext = async (
    queue: ConversationQueue,
    scheduledEpoch: number,
  ): Promise<void> => {
    queue.persistenceScheduled = false;
    const persistence = options.persistence;
    if (persistence === undefined || scheduledEpoch !== epoch || queue.persisting) return;
    const mutation = queue.mutations.find((candidate) => candidate.phase === "pending");
    if (mutation === undefined) return;
    const scope = persistence.getActiveScope();
    const cacheIdentity = options.cache.getState().identity;
    if (
      scope === undefined ||
      cacheIdentity === null ||
      cacheIdentity.tenantId !== scope.identity.tenantId ||
      cacheIdentity.userId !== scope.identity.userId ||
      !persistence.isActiveScope(scope)
    ) {
      removeQueuedMutation(queue, mutation);
      resolveMutation(mutation, VALIDATION_FAILURE);
      schedulePersistence(queue);
      return;
    }

    mutation.phase = "persisting";
    queue.persisting = true;
    try {
      const nowValue = now();
      if (!Number.isFinite(nowValue)) throw new TypeError("invalid read intent clock");
      const enqueuedAt = new Date(nowValue).toISOString() as IsoTimestamp;
      const acknowledgedReadState = queue.canonical;
      const intent = await serializeStorageMutation(async () => {
        if (!persistence.isActiveScope(scope)) throw new Error("inactive read scope");
        const committed = await persistence.storage.mutate(
          scope.identity,
          ApplicationChatStorageRecordKind.queuedReadCursorIntents,
          (currentRecord) => {
            const previousOrder = currentRecord?.intents.at(-1)?.enqueueOrder ?? 0;
            if (previousOrder >= Number.MAX_SAFE_INTEGER) {
              throw new RangeError("read intent enqueue order exhausted");
            }
            const candidate = createApplicationChatQueuedReadCursorIntent(
              mutation.input,
              acknowledgedReadState,
              { enqueueOrder: previousOrder + 1, enqueuedAt },
            );
            return createApplicationChatQueuedReadCursorIntentsRecord(
              scope.identity,
              [...(currentRecord?.intents ?? []), candidate],
            );
          },
        );
        const stored = committed?.intents.at(-1);
        if (
          stored === undefined ||
          stored.request.operation !== mutation.input.operation ||
          stored.request.conversationId !== mutation.input.conversationId
        ) throw new TypeError("persisted read intent could not be correlated");
        if (!persistence.isActiveScope(scope)) throw new Error("inactive read scope");
        return stored;
      });
      if (
        scheduledEpoch !== epoch ||
        !persistence.isActiveScope(scope) ||
        !mutationIsAttached(queue, mutation)
      ) return;
      mutation.input = intent.request;
      mutation.durable = Object.freeze({ scope, intent });
      mutation.phase = "persisted";
      try {
        persistence.onPersistedIntent?.(
          readCommandForOperation(intent.request.operation),
          intent.request.idempotencyKey,
        );
      } catch {
        // Cross-context availability is advisory; durability already succeeded.
      }
      project(queue);
      schedulePump(queue);
    } catch {
      if (
        scheduledEpoch === epoch &&
        persistence.isActiveScope(scope) &&
        mutationIsAttached(queue, mutation)
      ) {
        removeQueuedMutation(queue, mutation);
        project(queue);
        resolveMutation(mutation, VALIDATION_FAILURE);
      }
    } finally {
      queue.persisting = false;
      schedulePersistence(queue);
    }
  };

  const schedulePersistence = (queue: ConversationQueue): void => {
    if (
      options.persistence === undefined ||
      queue.persistenceScheduled ||
      queue.persisting ||
      !queue.mutations.some((mutation) => mutation.phase === "pending")
    ) return;
    queue.persistenceScheduled = true;
    const scheduledEpoch = epoch;
    schedule(() => {
      void persistNext(queue, scheduledEpoch);
    });
  };

  const enqueue = <Result extends MutationResult>(
    authored: ChatMarkReadInput | ChatMarkUnreadInput,
  ): Promise<Result> => {
    let validated: ReturnType<typeof validateAuthored>;
    try {
      validated = validateAuthored(authored, options.generateIdempotencyKey());
    } catch {
      return Promise.resolve(VALIDATION_FAILURE as Result);
    }

    return new Promise<Result>((resolve) => {
      const { queue, input } = validated;
      const last = queue.mutations.at(-1);
      if (
        input.operation === "mark_read" &&
        last?.input.operation === "mark_read" &&
        last.phase === (options.persistence === undefined ? "persisted" : "pending")
      ) {
        if (input.throughSequence > last.input.throughSequence) {
          last.input = Object.freeze({
            ...last.input,
            throughSequence: input.throughSequence,
          });
        }
        last.resolvers.push(resolve as MutationResolver);
      } else {
        queue.mutations.push({
          input,
          resolvers: [resolve as MutationResolver],
          phase: options.persistence === undefined ? "persisted" : "pending",
          settled: false,
          retained: false,
          retryNumber: 0,
        });
      }
      if (options.persistence === undefined) {
        project(queue);
        schedulePump(queue);
      } else {
        schedulePersistence(queue);
      }
    });
  };

  return Object.freeze({
    markRead: (input: ChatMarkReadInput) => enqueue<ChatMarkReadResult>(input),
    markUnread: (input: ChatMarkUnreadInput) =>
      enqueue<ChatMarkUnreadResult>(input),
    handleCanonicalEvent(event: ChatEvent) {
      const identity = options.cache.getState().identity;
      if (identity === null || event.type !== "conversation.read_cursor_updated") return;
      try {
        const parsed = parseReadCursorUpdatedEvent(event, identity.tenantId);
        if (parsed.payload.actorUserId === identity.userId) {
          authoritativeReadStates.set(
            parsed.payload.conversationId,
            parsed.payload.readState,
          );
          attachRetained(parsed.payload.conversationId);
          settleFromCanonical(parseReadCursorMutationResult({
            operation: parsed.payload.operation,
            conversationId: parsed.payload.conversationId,
            readState: parsed.payload.readState,
            latestSequence: parsed.payload.latestSequence,
            unreadCount: parsed.payload.unreadCount,
          }));
        }
      } catch {
        // Malformed or foreign canonical events cannot settle durable work.
      }
    },
    handleCoordinatedResult(command: string, idempotencyKey: string, value: unknown) {
      if (!isSupportedReadCommand(command)) return;
      let matchedQueue: ConversationQueue | undefined;
      let matchedMutation: QueuedMutation | undefined;
      for (const queue of queues.values()) {
        const mutation = [
          ...(queue.active === undefined ? [] : [queue.active]),
          ...queue.mutations,
        ].find((candidate) =>
          candidate.phase === "persisted" &&
          !candidate.settled &&
          candidate.durable !== undefined &&
          readCommandForOperation(candidate.input.operation) === command &&
          candidate.input.idempotencyKey === idempotencyKey);
        if (mutation !== undefined) {
          matchedQueue = queue;
          matchedMutation = mutation;
          break;
        }
      }
      if (
        matchedQueue === undefined ||
        matchedMutation?.durable === undefined ||
        !options.persistence?.isActiveScope(matchedMutation.durable.scope)
      ) return;
      const result = parseCoordinatedMutationResult(matchedMutation, value);
      if (result === undefined) return;
      if (result.status === "success" && !validCanonicalResult(matchedMutation, result.value)) {
        return;
      }
      const queue = matchedQueue;
      const mutation = matchedMutation;
      const observedEpoch = epoch;
      void settleDurableMutation(mutation).then((settled) => {
        if (
          !settled ||
          observedEpoch !== epoch ||
          mutation.durable === undefined ||
          !options.persistence?.isActiveScope(mutation.durable.scope) ||
          queues.get(mutation.input.conversationId) !== queue ||
          !mutationIsAttached(queue, mutation)
        ) return;
        if (result.status === "success") {
          const canonical = parseReadCursorMutationResult({
            operation: result.value.operation,
            conversationId: result.value.conversationId,
            readState: result.value.readState,
            latestSequence: result.value.latestSequence,
            unreadCount: result.value.unreadCount,
          });
          const newer = canonicalIsNewer(canonical.readState, queue.canonical);
          if (newer) {
            queue.canonical = canonical.readState;
          }
          if (newer || readStatesEqual(canonical.readState, queue.canonical)) {
            writeResult(canonical);
          }
        }
        removeQueuedMutation(queue, mutation);
        project(queue);
        resolveMutation(mutation, result);
        schedulePump(queue);
        schedulePersistence(queue);
      }).catch(() => undefined);
    },
    async activateRetained(
      scope: ChatReadStatePersistenceScope,
      initialAuthoritativeReadStates: readonly ConversationReadState[] = [],
    ) {
      const persistence = options.persistence;
      if (persistence === undefined || !persistence.isActiveScope(scope)) return;
      const activationEpoch = ++retainedEpoch;
      for (const controller of retainedRetryControllers) controller.abort();
      retainedRetryControllers.clear();
      retainedByConversation.clear();
      authoritativeReadStates.clear();
      retainedScope = scope;
      for (const readState of initialAuthoritativeReadStates) {
        authoritativeReadStates.set(readState.conversationId, readState);
      }
      let record;
      try {
        record = await serializeStorageMutation(() => persistence.storage.read(
          scope.identity,
          ApplicationChatStorageRecordKind.queuedReadCursorIntents,
        ));
      } catch (error) {
        if (activationEpoch !== retainedEpoch || !persistence.isActiveScope(scope)) return;
        if (error instanceof ApplicationChatStorageValidationError) {
          diagnose(Object.freeze({
            code: "read_intents_rejected",
            message: "The stored read-cursor intents were rejected and quarantined.",
          }));
        } else {
          diagnose(Object.freeze({
            code: "read_intents_read_failed",
            message: "The stored read-cursor intents could not be read.",
          }));
        }
        return;
      }
      if (
        record === null ||
        activationEpoch !== retainedEpoch ||
        !persistence.isActiveScope(scope)
      ) return;
      for (const intent of record.intents) {
        const retained = retainedByConversation.get(intent.request.conversationId) ?? [];
        retained.push(intent);
        retainedByConversation.set(intent.request.conversationId, retained);
      }
      for (const conversationId of authoritativeReadStates.keys()) attachRetained(conversationId);
    },
    async reloadRetained(
      scope: ChatReadStatePersistenceScope,
      announcement?: { readonly command: string; readonly idempotencyKey: string },
    ) {
      const persistence = options.persistence;
      if (
        persistence === undefined ||
        !persistence.isActiveScope(scope) ||
        retainedScope === undefined ||
        !samePersistenceScope(retainedScope, scope) ||
        (announcement !== undefined && !isSupportedReadCommand(announcement.command))
      ) return;
      const reloadEpoch = retainedEpoch;
      let record;
      try {
        record = await serializeStorageMutation(() => persistence.storage.read(
          scope.identity,
          ApplicationChatStorageRecordKind.queuedReadCursorIntents,
        ));
      } catch (error) {
        if (reloadEpoch !== retainedEpoch || !persistence.isActiveScope(scope)) return;
        if (error instanceof ApplicationChatStorageValidationError) {
          diagnose(Object.freeze({
            code: "read_intents_rejected",
            message: "The stored read-cursor intents were rejected and quarantined.",
          }));
        } else {
          diagnose(Object.freeze({
            code: "read_intents_read_failed",
            message: "The stored read-cursor intents could not be read.",
          }));
        }
        return;
      }
      if (
        reloadEpoch !== retainedEpoch ||
        !persistence.isActiveScope(scope) ||
        retainedScope === undefined ||
        !samePersistenceScope(retainedScope, scope)
      ) return;
      const intents = record?.intents ?? [];
      if (announcement === undefined) reconcileRetainedWithRecord(scope, intents);
      const matching = announcement === undefined
        ? intents
        : intents.filter((intent) =>
            readCommandForOperation(intent.request.operation) === announcement.command &&
            intent.request.idempotencyKey === announcement.idempotencyKey);
      for (const intent of matching) stageRetainedIntent(scope, intent);
      for (const queue of queues.values()) schedulePump(queue);
    },
    markAuthoritative(readStates: readonly ConversationReadState[]) {
      for (const readState of readStates) {
        authoritativeReadStates.set(readState.conversationId, readState);
        attachRetained(readState.conversationId);
      }
    },
    resumeRetained() {
      for (const queue of queues.values()) schedulePump(queue);
    },
    pauseRetained() {
      retainedEpoch += 1;
      for (const controller of retainedRetryControllers) controller.abort();
      retainedRetryControllers.clear();
      for (const queue of queues.values()) {
        if (queue.active?.retained === true) {
          queue.mutations.unshift(queue.active);
          queue.active = undefined;
          project(queue);
        }
        queue.scheduled = false;
      }
    },
    closeActive() {
      abandonQueues(true);
    },
  });
}
