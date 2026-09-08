import {
  parseConversationDraftUpdatedEvent,
  parseSynchronizeDraftInput,
  parseSynchronizeDraftResult,
  type CanonicalDraftState,
  type DraftContent,
  type SynchronizeDraftInput,
  type SynchronizeDraftResult,
} from "../contracts/draft-mutation.js";
import type { ConversationDraftSnapshot } from "../contracts/private-user-state-snapshot.js";
import type { ConversationId } from "../contracts/identifiers.js";
import type { MessageMention } from "../contracts/message.js";
import type {
  ChatCommandDescriptor,
  ChatCommandResult,
} from "./command-dispatcher.js";
import {
  ApplicationChatStorageRecordKind,
  ApplicationChatStorageValidationError,
  createApplicationChatQueuedDraftIntent,
  createApplicationChatQueuedDraftIntentsRecord,
  type ApplicationChatStorage,
  type ApplicationChatStorageIdentity,
} from "./application-chat-storage.js";
import type { NormalizedChatCache } from "./normalized-cache.js";
import type {
  ChatSnapshotQueryResult,
} from "./snapshot-reader.js";

export const DEFAULT_CHAT_DRAFT_DEBOUNCE_MS = 750;

export type ChatDraftSynchronizationStatus =
  | "idle"
  | "hydrating"
  | "ready"
  | "debouncing"
  | "saving"
  | "retryable"
  | "conflict"
  | "error";

export type ChatDraftConflictCode = "stale_base" | "incompatible_revision";

export interface ChatDraftConflict {
  readonly code: ChatDraftConflictCode;
  readonly canonicalRevision: number;
  /** Renderer-safe. Draft bodies and attachment references are deliberately absent. */
  readonly message: "This draft changed in another session. Your local draft was preserved.";
}

export interface ChatConversationDraftState {
  readonly conversationId: ConversationId;
  readonly status: ChatDraftSynchronizationStatus;
  /** Current renderer projection. Undefined means no draft has ever been observed. */
  readonly draft?: CanonicalDraftState;
  readonly authoritativeRevision: number;
  readonly dirty: boolean;
  readonly conflict?: ChatDraftConflict;
  readonly message?:
    | "The draft could not be loaded."
    | "The draft could not be synchronized.";
}

export type ChatDraftStateListener = (
  state: ChatConversationDraftState,
  previous: ChatConversationDraftState,
) => void;

export type ChatDraftFlushResult =
  | { readonly status: "success"; readonly state: ChatConversationDraftState }
  | { readonly status: "retryable"; readonly state: ChatConversationDraftState }
  | { readonly status: "conflict"; readonly state: ChatConversationDraftState }
  | { readonly status: "validation"; readonly message: "The draft input is invalid." }
  | { readonly status: "closed"; readonly message: "The draft lifecycle is closed." };

export interface ChatReplaceDraftInput {
  readonly conversationId: ConversationId;
  readonly content: DraftContent;
}

export interface ChatCloseDraftOptions {
  /** Defaults to `flush`; `abort` restores the last authoritative projection. */
  readonly policy?: "flush" | "abort";
}

export interface ChatDraftDiagnostic {
  readonly event:
    | "hydration_failed"
    | "mutation_failed"
    | "mutation_retryable"
    | "conflict"
    | "aborted";
  readonly conversationId: ConversationId;
  readonly category?:
    | "validation"
    | "authentication"
    | "transport"
    | "malformed_response"
    | "aborted"
    | "conflict"
    | "rejected"
    | "closed";
  readonly httpStatus?: number;
  /** No content, attachment references, response body, token, or thrown value is carried. */
  readonly message: string;
}

export interface ChatDraftTimer {
  readonly schedule: (task: () => void, delayMs: number) => unknown;
  readonly cancel: (handle: unknown) => void;
}

export interface ChatDraftRuntimeOptions {
  readonly debounceMs?: number;
  readonly timer?: ChatDraftTimer;
  readonly generateDeviceMutationId?: () => string;
  readonly generateIdempotencyKey?: () => string;
  readonly onDiagnostic?: (diagnostic: ChatDraftDiagnostic) => void;
  readonly retainedRecovery?: ChatRetainedDraftRecoveryOptions;
}

export interface ChatRetainedDraftRecoveryOptions {
  /** Defaults to 250ms. */
  readonly initialDelayMs?: number;
  /** Defaults to 30 seconds and always bounds calculated delays. */
  readonly maximumDelayMs?: number;
  /** Defaults to 2. */
  readonly multiplier?: number;
  /** Injectable abort-aware wait boundary for deterministic tests. */
  readonly wait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

export interface ChatDraftSnapshotBoundary {
  getConversationDraft(input: {
    readonly conversationId: ConversationId;
  }, options?: { readonly signal?: AbortSignal }): Promise<
    ChatSnapshotQueryResult<ConversationDraftSnapshot>
  >;
}

export interface ChatDraftRuntimeConfig {
  readonly cache: NormalizedChatCache;
  readonly snapshots: ChatDraftSnapshotBoundary;
  readonly dispatch: <Input, RequestBody, Result>(
    descriptor: ChatCommandDescriptor<Input, RequestBody, Result>,
    input: Input,
    options?: { readonly idempotencyKey?: string; readonly signal?: AbortSignal },
  ) => Promise<ChatCommandResult<Result>>;
  readonly options?: ChatDraftRuntimeOptions;
  /** Identity-scoped durability and retained-intent recovery boundary. */
  readonly persistence?: {
    readonly storage: ApplicationChatStorage;
    readonly getActiveScope: () => ChatDraftPersistenceScope | undefined;
    readonly isActiveScope: (scope: ChatDraftPersistenceScope) => boolean;
    readonly isRecoveryReady?: () => boolean;
    readonly onPersistedIntent?: (command: string, idempotencyKey: string) => void;
    readonly now?: () => number;
    readonly onDiagnostic?: (diagnostic: ChatDraftPersistenceDiagnostic) => void;
  };
}

export interface ChatDraftPersistenceScope {
  readonly identity: ApplicationChatStorageIdentity;
  readonly generation: number;
}

export interface ChatDraftPersistenceDiagnostic {
  readonly code:
    | "draft_intents_read_failed"
    | "draft_intents_rejected"
    | "draft_intents_quarantine_failed"
    | "draft_intents_write_failed";
  /** Static, redacted text. Drafts, records, identities, and thrown values are omitted. */
  readonly message: string;
}

export interface ChatDraftCanonicalCheckpoint {
  readonly drafts: Readonly<Record<ConversationId, CanonicalDraftState>>;
  readonly draftRevisions: Readonly<Record<ConversationId, number>>;
}

export interface ChatDraftRuntime {
  open(conversationId: ConversationId): Promise<ChatConversationDraftState>;
  select(conversationId: ConversationId): ChatConversationDraftState;
  subscribe(conversationId: ConversationId, listener: ChatDraftStateListener): () => void;
  replace(input: ChatReplaceDraftInput): ChatConversationDraftState;
  clear(conversationId: ConversationId): ChatConversationDraftState;
  flush(conversationId: ConversationId): Promise<ChatDraftFlushResult>;
  retry(conversationId: ConversationId): Promise<ChatDraftFlushResult>;
  closeConversation(
    conversationId: ConversationId,
    options?: ChatCloseDraftOptions,
  ): Promise<ChatDraftFlushResult>;
  handleCanonicalEvent(event: unknown): void;
  handleCoordinatedResult(command: string, idempotencyKey: string, value: unknown): void;
  activateRetained(scope: ChatDraftPersistenceScope): Promise<void>;
  reloadRetained(
    scope: ChatDraftPersistenceScope,
    announcement?: { readonly command: string; readonly idempotencyKey: string },
  ): Promise<void>;
  resumeRetained(): void;
  pauseRetained(): void;
  announceRetained(): void;
  /** Removes optimistic draft overlays from a normalized-cache checkpoint. */
  createCanonicalCheckpoint(): ChatDraftCanonicalCheckpoint;
  /** Client close and identity replacement abort private work and restore canonical state. */
  closeActive(): void;
}

interface PreparedMutation {
  readonly desired: CanonicalDraftState;
  readonly version: number;
  readonly deviceMutationId: string;
  readonly idempotencyKey: string;
  readonly resolveConflict?: boolean;
}

interface DispatchMutation extends PreparedMutation {
  readonly input: SynchronizeDraftInput;
  readonly persistenceScope?: ChatDraftPersistenceScope;
  readonly retained: boolean;
  retryNumber: number;
}

interface PersistedMutation extends DispatchMutation {
  readonly persistenceScope: ChatDraftPersistenceScope;
}

interface ActiveMutation extends DispatchMutation {
  readonly controller: AbortController;
  promise: Promise<ChatCommandResult<SynchronizeDraftResult>>;
  acknowledged: boolean;
}

interface DraftEntry {
  readonly conversationId: ConversationId;
  readonly listeners: Set<ChatDraftStateListener>;
  identityKey: string;
  generation: number;
  localVersion: number;
  status: ChatDraftSynchronizationStatus;
  authoritativeRevision: number;
  authoritativeDraft: CanonicalDraftState | undefined;
  desired: CanonicalDraftState | undefined;
  pendingPersistence: PreparedMutation | undefined;
  persisting: PreparedMutation | undefined;
  persistencePromise: Promise<void> | undefined;
  persistenceFailed: boolean;
  queued: PreparedMutation | PersistedMutation | undefined;
  active: ActiveMutation | undefined;
  retry: DispatchMutation | undefined;
  timer: unknown;
  hydration: Promise<ChatConversationDraftState> | undefined;
  hydrationController: AbortController | undefined;
  flushPromise: Promise<ChatDraftFlushResult> | undefined;
  conflict: ChatDraftConflict | undefined;
  message: ChatConversationDraftState["message"] | undefined;
  lastSettled: {
    readonly deviceMutationId: string;
    readonly idempotencyKey: string;
    readonly canonicalRevision: number;
  } | undefined;
  view: ChatConversationDraftState;
}

const CONFLICT_MESSAGE =
  "This draft changed in another session. Your local draft was preserved." as const;
const INVALID_RESULT = Object.freeze({
  status: "validation",
  message: "The draft input is invalid.",
} as const);
const CLOSED_RESULT = Object.freeze({
  status: "closed",
  message: "The draft lifecycle is closed.",
} as const);
const TRANSPORT_RESULT = Object.freeze({
  status: "transport",
  message: "The chat command could not be completed.",
} as const);

const defaultTimer: ChatDraftTimer = Object.freeze({
  schedule: (task: () => void, delayMs: number) => setTimeout(task, delayMs),
  cancel: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
});

const defaultRecoveryWait = (delayMs: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const handle = setTimeout(resolve, delayMs);
    signal.addEventListener("abort", () => {
      clearTimeout(handle);
      reject(new Error("retained draft recovery aborted"));
    }, { once: true });
  });

const samePersistenceScope = (
  left: ChatDraftPersistenceScope,
  right: ChatDraftPersistenceScope,
): boolean => left.generation === right.generation &&
  left.identity.tenantId === right.identity.tenantId &&
  left.identity.userId === right.identity.userId &&
  left.identity.deviceId === right.identity.deviceId;

const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
};

const mentionEqual = (left: MessageMention, right: MessageMention): boolean => {
  if (left.type !== right.type) return false;
  switch (left.type) {
    case "user":
      return left.userId === (right as typeof left).userId;
    case "conversation":
      return left.conversationId === (right as typeof left).conversationId;
    case "entity": {
      const rightEntity = (right as typeof left).entity;
      return left.entity.type === rightEntity.type && left.entity.id === rightEntity.id;
    }
  }
};

const mentionsEqual = (
  left: readonly MessageMention[] | undefined,
  right: readonly MessageMention[] | undefined,
): boolean => left === undefined
  ? right === undefined
  : right !== undefined &&
    left.length === right.length &&
    left.every((mention, index) => mentionEqual(mention, right[index]!));

const stateEqual = (left: CanonicalDraftState | undefined, right: CanonicalDraftState | undefined): boolean => {
  if (left === right) return true;
  if (left === undefined || right === undefined || left.kind !== right.kind) return false;
  if (left.kind === "clear_tombstone" || right.kind === "clear_tombstone") return true;
  return left.content.format === right.content.format &&
    left.content.text === right.content.text &&
    (left.content.replyTo === undefined
      ? right.content.replyTo === undefined
      : right.content.replyTo !== undefined &&
        left.content.replyTo.messageId === right.content.replyTo.messageId &&
        left.content.replyTo.notifyAuthor === right.content.replyTo.notifyAuthor) &&
    mentionsEqual(left.content.mentions, right.content.mentions) &&
    left.content.attachments.length === right.content.attachments.length &&
    left.content.attachments.every(
      (attachment, index) =>
        attachment.attachmentId === right.content.attachments[index]?.attachmentId,
    );
};

const freezeMention = (mention: MessageMention): MessageMention => {
  switch (mention.type) {
    case "user":
      return Object.freeze({ type: "user", userId: mention.userId });
    case "conversation":
      return Object.freeze({
        type: "conversation",
        conversationId: mention.conversationId,
      });
    case "entity":
      return Object.freeze({
        type: "entity",
        entity: Object.freeze({
          type: mention.entity.type,
          id: mention.entity.id,
        }),
      });
  }
};

const freezeDraft = (draft: CanonicalDraftState): CanonicalDraftState =>
  draft.kind === "clear_tombstone"
    ? Object.freeze({ kind: "clear_tombstone", content: null })
    : Object.freeze({
        kind: "replaced",
        content: Object.freeze({
          format: draft.content.format,
          text: draft.content.text,
          ...(draft.content.replyTo === undefined
            ? {}
            : { replyTo: Object.freeze({ ...draft.content.replyTo }) }),
          ...(draft.content.mentions === undefined
            ? {}
            : {
                mentions: Object.freeze(
                  draft.content.mentions.map(freezeMention),
                ),
              }),
          attachments: Object.freeze(
            draft.content.attachments.map((attachment) =>
              Object.freeze({ attachmentId: attachment.attachmentId })),
          ),
        }),
      });

const identityKey = (cache: NormalizedChatCache): string | undefined => {
  const identity = cache.getState().identity;
  return identity === null
    ? undefined
    : `${identity.tenantId}\u0000${identity.userId}\u0000${identity.sessionId}`;
};

const validConversationId = (value: unknown): value is ConversationId =>
  typeof value === "string" && value.trim().length > 0 && value === value.trim();

const draftFromSnapshot = (
  snapshot: ConversationDraftSnapshot,
): CanonicalDraftState | undefined =>
  snapshot.state === "present"
    ? freezeDraft({ kind: "replaced", content: snapshot.content.value })
    : snapshot.canonicalRevision === 0
      ? undefined
      : freezeDraft({ kind: "clear_tombstone", content: null });

const retryableStatus = (status: ChatCommandResult<unknown>["status"]): boolean =>
  status === "transport" ||
  status === "authentication" ||
  status === "malformed_response" ||
  status === "aborted" ||
  status === "closed";

const diagnosticCategory = (
  status: Exclude<ChatCommandResult<unknown>["status"], "success">,
): NonNullable<ChatDraftDiagnostic["category"]> =>
  status === "feature_disabled" || status === "unsupported"
    ? "rejected"
    : status;

const createDescriptor = (
  expected: SynchronizeDraftInput,
): ChatCommandDescriptor<SynchronizeDraftInput, SynchronizeDraftInput, SynchronizeDraftResult> =>
  Object.freeze({
    name: "conversation.draft.synchronize",
    method: "PATCH",
    path: `/conversations/${encodeURIComponent(expected.conversationId)}/draft`,
    retry: "safe",
    validateInput: (input: SynchronizeDraftInput) => parseSynchronizeDraftInput(input),
    parseResult: (value: unknown) => parseSynchronizeDraftResult(value, expected),
    parseErrorResult: (value: unknown, httpStatus: number) => {
      if (httpStatus !== 409) return undefined;
      try {
        const result = parseSynchronizeDraftResult(value, expected);
        return result.reconciliationStatus === "stale_base" ? result : undefined;
      } catch {
        return undefined;
      }
    },
  });

const generateDraftCorrelationId = (): string => {
  const browserCrypto = globalThis.crypto;
  if (typeof browserCrypto?.randomUUID === "function") {
    return browserCrypto.randomUUID();
  }
  if (typeof browserCrypto?.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    browserCrypto.getRandomValues(bytes);
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
    const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0"));
    return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
      .slice(6, 8)
      .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
  }
  throw new TypeError("Secure browser crypto is unavailable");
};

export function createChatDraftRuntime(config: ChatDraftRuntimeConfig): ChatDraftRuntime {
  if (
    config.options !== undefined &&
    (typeof config.options !== "object" || config.options === null ||
      (config.options.generateDeviceMutationId !== undefined &&
        typeof config.options.generateDeviceMutationId !== "function") ||
      (config.options.generateIdempotencyKey !== undefined &&
        typeof config.options.generateIdempotencyKey !== "function") ||
      (config.options.onDiagnostic !== undefined &&
        typeof config.options.onDiagnostic !== "function") ||
      (config.options.retainedRecovery !== undefined &&
        (typeof config.options.retainedRecovery !== "object" ||
          config.options.retainedRecovery === null)))
  ) {
    throw new TypeError("Draft runtime options are invalid");
  }
  const debounceMs = config.options?.debounceMs ?? DEFAULT_CHAT_DRAFT_DEBOUNCE_MS;
  if (!Number.isSafeInteger(debounceMs) || debounceMs < 0) {
    throw new TypeError("Draft debounce must be a non-negative integer");
  }
  const timer = config.options?.timer ?? defaultTimer;
  if (typeof timer.schedule !== "function" || typeof timer.cancel !== "function") {
    throw new TypeError("Draft timer boundary is invalid");
  }
  const generateDeviceMutationId =
    config.options?.generateDeviceMutationId ?? generateDraftCorrelationId;
  const generateIdempotencyKey =
    config.options?.generateIdempotencyKey ?? generateDraftCorrelationId;
  const recovery = config.options?.retainedRecovery;
  const recoveryInitialDelayMs = recovery?.initialDelayMs ?? 250;
  const recoveryMaximumDelayMs = recovery?.maximumDelayMs ?? 30_000;
  const recoveryMultiplier = recovery?.multiplier ?? 2;
  const recoveryWait = recovery?.wait ?? defaultRecoveryWait;
  if (
    !Number.isFinite(recoveryInitialDelayMs) || recoveryInitialDelayMs < 0 ||
    !Number.isFinite(recoveryMaximumDelayMs) ||
    recoveryMaximumDelayMs < recoveryInitialDelayMs ||
    !Number.isFinite(recoveryMultiplier) || recoveryMultiplier <= 0 ||
    typeof recoveryWait !== "function"
  ) throw new TypeError("Retained draft recovery options are invalid");
  const entries = new Map<ConversationId, DraftEntry>();
  let suppressCacheObservation = false;
  let storageMutationTail: Promise<void> = Promise.resolve();
  let retainedEpoch = 0;
  let retainedScope: ChatDraftPersistenceScope | undefined;
  const retainedRetryControllers = new Set<AbortController>();

  const diagnose = (diagnostic: ChatDraftDiagnostic): void => {
    try {
      config.options?.onDiagnostic?.(Object.freeze(diagnostic));
    } catch {
      // Diagnostics cannot affect private-state reliability.
    }
  };

  const diagnosePersistence = (diagnostic: ChatDraftPersistenceDiagnostic): void => {
    try {
      config.persistence?.onDiagnostic?.(Object.freeze(diagnostic));
    } catch {
      // Diagnostics cannot affect private-state reliability.
    }
  };

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

  const resultHttpStatus = (value: object): number | undefined =>
    "httpStatus" in value && typeof value.httpStatus === "number"
      ? value.httpStatus
      : undefined;

  const currentProjection = (entry: DraftEntry): CanonicalDraftState | undefined =>
    entry.desired ?? entry.authoritativeDraft;

  const isPersistedMutation = (
    value: PreparedMutation | DispatchMutation | undefined,
  ): value is PersistedMutation => value !== undefined && "input" in value &&
    value.persistenceScope !== undefined;

  const isRetainedMutation = (
    value: PreparedMutation | DispatchMutation | undefined,
  ): value is DispatchMutation => value !== undefined && "input" in value && value.retained;

  const hasRetainedMutation = (entry: DraftEntry): boolean =>
    isRetainedMutation(entry.queued) || isRetainedMutation(entry.active) ||
    isRetainedMutation(entry.retry);

  const recoveryReady = (): boolean => retainedScope !== undefined &&
    config.persistence?.isActiveScope(retainedScope) === true &&
    config.persistence.isRecoveryReady?.() !== false;

  const retainedDelay = (retryNumber: number): number => Math.min(
    recoveryMaximumDelayMs,
    recoveryInitialDelayMs * recoveryMultiplier ** Math.max(0, retryNumber - 1),
  );

  const dirty = (entry: DraftEntry): boolean =>
    entry.desired !== undefined || entry.queued !== undefined ||
    entry.active !== undefined || entry.retry !== undefined;

  const buildView = (entry: DraftEntry): ChatConversationDraftState => {
    const draft = currentProjection(entry);
    return Object.freeze({
      conversationId: entry.conversationId,
      status: entry.status,
      ...(draft === undefined ? {} : { draft }),
      authoritativeRevision: entry.authoritativeRevision,
      dirty: dirty(entry),
      ...(entry.conflict === undefined ? {} : { conflict: entry.conflict }),
      ...(entry.message === undefined ? {} : { message: entry.message }),
    });
  };

  const publish = (entry: DraftEntry): void => {
    const previous = entry.view;
    const next = buildView(entry);
    entry.view = next;
    for (const listener of [...entry.listeners]) {
      try {
        listener(next, previous);
      } catch {
        // Renderer observers cannot interrupt synchronization.
      }
    }
  };

  const cacheReconcile = (
    entry: DraftEntry,
    preserveProjection: boolean,
  ): void => {
    suppressCacheObservation = true;
    try {
      config.cache.reconcileConversationDraft(
        entry.conversationId,
        entry.authoritativeRevision,
        entry.authoritativeDraft,
        preserveProjection,
      );
      if (preserveProjection && entry.desired !== undefined) {
        config.cache.projectConversationDraft(entry.conversationId, entry.desired);
      }
    } finally {
      suppressCacheObservation = false;
    }
  };

  const getEntry = (conversationId: ConversationId): DraftEntry => {
    if (!validConversationId(conversationId)) throw new TypeError("Draft conversation id is invalid");
    const key = identityKey(config.cache);
    if (key === undefined) throw new TypeError("Draft identity is required");
    const existing = entries.get(conversationId);
    if (existing !== undefined && existing.identityKey === key) return existing;
    const state = config.cache.getState();
    const authoritativeRevision = state.currentUser.draftRevisions[conversationId] ?? 0;
    const authoritativeDraft = state.currentUser.drafts[conversationId];
    const view = Object.freeze({
      conversationId,
      status: "idle",
      ...(authoritativeDraft === undefined ? {} : { draft: authoritativeDraft }),
      authoritativeRevision,
      dirty: false,
    } as const);
    const entry: DraftEntry = {
      conversationId,
      listeners: new Set(),
      identityKey: key,
      generation: 0,
      localVersion: 0,
      status: "idle",
      authoritativeRevision,
      authoritativeDraft,
      desired: undefined,
      pendingPersistence: undefined,
      persisting: undefined,
      persistencePromise: undefined,
      persistenceFailed: false,
      queued: undefined,
      active: undefined,
      retry: undefined,
      timer: undefined,
      hydration: undefined,
      hydrationController: undefined,
      flushPromise: undefined,
      conflict: undefined,
      message: undefined,
      lastSettled: undefined,
      view,
    };
    entries.set(conversationId, entry);
    return entry;
  };

  const clearTimer = (entry: DraftEntry): void => {
    if (entry.timer === undefined) return;
    timer.cancel(entry.timer);
    entry.timer = undefined;
  };

  const setConflict = (
    entry: DraftEntry,
    code: ChatDraftConflictCode,
    canonicalRevision: number,
  ): void => {
    clearTimer(entry);
    entry.status = "conflict";
    entry.conflict = Object.freeze({ code, canonicalRevision, message: CONFLICT_MESSAGE });
    entry.message = undefined;
    if (entry.desired !== undefined) cacheReconcile(entry, true);
    publish(entry);
    diagnose({
      event: "conflict",
      conversationId: entry.conversationId,
      message: "Draft synchronization requires explicit conflict resolution.",
    });
  };

  const observeCanonical = (
    entry: DraftEntry,
    canonicalRevision: number,
    canonicalDraft: CanonicalDraftState | undefined,
    correlation?: { readonly deviceMutationId: string; readonly idempotencyKey: string },
  ): void => {
    if (canonicalRevision < entry.authoritativeRevision) {
      if (correlation !== undefined) {
        const matched = [entry.active, entry.retry, entry.queued].find((mutation) =>
          correlationsMatch(
            mutation,
            correlation.deviceMutationId,
            correlation.idempotencyKey,
          ));
        if (isPersistedMutation(matched)) {
          void finishSuccessfulMutation(
            entry,
            matched,
            canonicalRevision,
            canonicalDraft ?? matched.desired,
          );
        }
      }
      return;
    }
    if (
      canonicalRevision === entry.authoritativeRevision &&
      !stateEqual(entry.authoritativeDraft, canonicalDraft)
    ) {
      setConflict(entry, "incompatible_revision", canonicalRevision);
      return;
    }
    entry.authoritativeRevision = canonicalRevision;
    entry.authoritativeDraft = canonicalDraft;
    const matches = (value: PreparedMutation | DispatchMutation | undefined): boolean =>
      value !== undefined && correlation !== undefined &&
      value.deviceMutationId === correlation.deviceMutationId &&
      value.idempotencyKey === correlation.idempotencyKey;
    const settledPreviously = correlation !== undefined &&
      entry.lastSettled?.deviceMutationId === correlation.deviceMutationId &&
      entry.lastSettled.idempotencyKey === correlation.idempotencyKey &&
      entry.lastSettled.canonicalRevision === canonicalRevision;
    const inferredActive = entry.active !== undefined &&
      !entry.active.retained &&
      canonicalRevision === entry.active.input.baseRevision + 1 &&
      stateEqual(entry.active.desired, canonicalDraft);
    const inferredRetry = entry.retry !== undefined &&
      !entry.retry.retained &&
      canonicalRevision === entry.retry.input.baseRevision + 1 &&
      stateEqual(entry.retry.desired, canonicalDraft);
    const ownMutation = matches(entry.active) || matches(entry.retry) ||
      inferredActive || inferredRetry || settledPreviously;
    const exactlyMatched = matches(entry.active)
      ? entry.active
      : matches(entry.retry)
        ? entry.retry
        : matches(entry.queued) && isPersistedMutation(entry.queued)
          ? entry.queued
          : undefined;
    if (matches(entry.active) || inferredActive) entry.active!.acknowledged = true;

    if (exactlyMatched !== undefined && isPersistedMutation(exactlyMatched)) {
      cacheReconcile(entry, true);
      publish(entry);
      void finishSuccessfulMutation(
        entry,
        exactlyMatched,
        canonicalRevision,
        canonicalDraft ?? exactlyMatched.desired,
      );
      return;
    }
    if (matches(entry.retry) || inferredRetry) entry.retry = undefined;

    if (ownMutation) {
      if (entry.queued === undefined && stateEqual(entry.desired, canonicalDraft)) {
        entry.desired = undefined;
        entry.conflict = undefined;
        entry.message = undefined;
        entry.status = entry.active === undefined ? "ready" : "saving";
        cacheReconcile(entry, false);
      } else {
        cacheReconcile(entry, true);
      }
      publish(entry);
      return;
    }
    if (dirty(entry)) {
      if (hasRetainedMutation(entry)) {
        cacheReconcile(entry, true);
        publish(entry);
        return;
      }
      if (stateEqual(entry.desired, canonicalDraft)) {
        entry.queued = undefined;
        entry.retry = undefined;
        entry.desired = undefined;
        entry.conflict = undefined;
        entry.status = entry.active === undefined ? "ready" : "saving";
        cacheReconcile(entry, false);
        publish(entry);
      } else {
        setConflict(entry, "stale_base", canonicalRevision);
      }
      return;
    }
    entry.status = "ready";
    entry.conflict = undefined;
    entry.message = undefined;
    cacheReconcile(entry, false);
    publish(entry);
  };

  const prepare = (
    entry: DraftEntry,
    desired: CanonicalDraftState,
    current: PreparedMutation | undefined = entry.queued,
  ): PreparedMutation => {
    // A durable request may already be replaying in another runtime. New content
    // needs new correlation; only edits not yet persisted can share a request.
    const reusable = isPersistedMutation(current) ? undefined : current;
    return Object.freeze({
      desired,
      version: entry.localVersion,
      deviceMutationId: reusable?.deviceMutationId ?? generateDeviceMutationId(),
      idempotencyKey: reusable?.idempotencyKey ?? generateIdempotencyKey(),
    });
  };

  const project = (
    entry: DraftEntry,
    prepared: PreparedMutation | PersistedMutation,
  ): ChatConversationDraftState => {
    const desired = prepared.desired;
    entry.desired = desired;
    entry.queued = prepared;
    if (prepared.resolveConflict === true) {
      entry.conflict = undefined;
      entry.status = "debouncing";
    } else {
      entry.conflict = entry.status === "conflict" ? entry.conflict : undefined;
    }
    entry.message = undefined;
    suppressCacheObservation = true;
    try {
      config.cache.projectConversationDraft(entry.conversationId, desired);
    } finally {
      suppressCacheObservation = false;
    }
    if (entry.status !== "conflict") {
      entry.status = entry.active === undefined ? "debouncing" : "saving";
      clearTimer(entry);
      entry.timer = timer.schedule(() => {
        entry.timer = undefined;
        void flushEntry(entry);
      }, debounceMs);
    }
    publish(entry);
    return entry.view;
  };

  const buildInput = (
    entry: DraftEntry,
    prepared: PreparedMutation,
  ): SynchronizeDraftInput => parseSynchronizeDraftInput(
    prepared.desired.kind === "replaced"
      ? {
          operation: "synchronize_draft",
          intent: "replace",
          conversationId: entry.conversationId,
          baseRevision: entry.authoritativeRevision,
          deviceMutationId: prepared.deviceMutationId,
          idempotencyKey: prepared.idempotencyKey,
          content: prepared.desired.content,
        }
      : {
          operation: "synchronize_draft",
          intent: "clear",
          conversationId: entry.conversationId,
          baseRevision: entry.authoritativeRevision,
          deviceMutationId: prepared.deviceMutationId,
          idempotencyKey: prepared.idempotencyKey,
        },
  );

  const persistenceScopeIsUsable = (
    scope: ChatDraftPersistenceScope,
  ): boolean => {
    const cacheIdentity = config.cache.getState().identity;
    return cacheIdentity !== null &&
      cacheIdentity.tenantId === scope.identity.tenantId &&
      cacheIdentity.userId === scope.identity.userId &&
      config.persistence?.isActiveScope(scope) === true;
  };

  const persistPrepared = async (
    entry: DraftEntry,
    prepared: PreparedMutation,
    generation: number,
  ): Promise<PersistedMutation | undefined> => {
    const persistence = config.persistence;
    const scope = persistence?.getActiveScope();
    if (persistence === undefined || scope === undefined || !persistenceScopeIsUsable(scope)) {
      throw new TypeError("inactive draft persistence scope");
    }
    const stored = await serializeStorageMutation(async () => {
      if (
        entry.generation !== generation ||
        !persistenceScopeIsUsable(scope)
      ) return undefined;
      const input = buildInput(entry, prepared);
      const nowValue = persistence.now?.() ?? Date.now();
      if (!Number.isFinite(nowValue)) throw new TypeError("invalid draft intent clock");
      const enqueuedAt = new Date(nowValue).toISOString();
      const nextRecord = await persistence.storage.mutate(
        scope.identity,
        ApplicationChatStorageRecordKind.queuedDraftIntents,
        (currentRecord) => {
          if (
            entry.generation !== generation ||
            !persistenceScopeIsUsable(scope)
          ) return currentRecord;
          const previousOrder = currentRecord?.intents.at(-1)?.enqueueOrder ?? 0;
          if (previousOrder >= Number.MAX_SAFE_INTEGER) {
            throw new RangeError("draft intent enqueue order exhausted");
          }
          const candidate = createApplicationChatQueuedDraftIntent(input, {
            enqueueOrder: previousOrder + 1,
            enqueuedAt,
          });
          return createApplicationChatQueuedDraftIntentsRecord(
            scope.identity,
            [...(currentRecord?.intents ?? []), candidate],
          );
        },
      );
      if (
        entry.generation !== generation ||
        !persistenceScopeIsUsable(scope)
      ) return undefined;
      const persisted = nextRecord?.intents.find((intent) =>
        intent.request.conversationId === entry.conversationId);
      if (
        persisted === undefined ||
        persisted.request.deviceMutationId !== prepared.deviceMutationId ||
        persisted.request.idempotencyKey !== prepared.idempotencyKey
      ) throw new TypeError("persisted draft intent could not be correlated");
      return persisted.request;
    });
    return stored === undefined
      ? undefined
      : Object.freeze({
          ...prepared,
          input: stored,
          persistenceScope: scope,
          retained: false,
          retryNumber: 0,
        });
  };

  const schedulePersistence = (entry: DraftEntry): void => {
    if (config.persistence === undefined || entry.persistencePromise !== undefined) return;
    const generation = entry.generation;
    const operation = Promise.resolve().then(async () => {
      while (entry.generation === generation && entry.pendingPersistence !== undefined) {
        if (entry.active !== undefined) {
          await entry.active.promise;
          continue;
        }
        const prepared = entry.pendingPersistence;
        entry.pendingPersistence = undefined;
        entry.persisting = prepared;
        try {
          const persisted = await persistPrepared(entry, prepared, generation);
          if (
            persisted !== undefined &&
            entry.generation === generation &&
            prepared.version === entry.localVersion &&
            entry.pendingPersistence === undefined
          ) {
            if (persisted.input.baseRevision !== entry.authoritativeRevision) {
              entry.pendingPersistence = Object.freeze({
                desired: persisted.desired,
                version: entry.localVersion,
                deviceMutationId: generateDeviceMutationId(),
                idempotencyKey: generateIdempotencyKey(),
                ...(persisted.resolveConflict === true ? { resolveConflict: true } : {}),
              });
              continue;
            }
            entry.persistenceFailed = false;
            project(entry, persisted);
            try {
              config.persistence?.onPersistedIntent?.(
                "conversation.draft.synchronize",
                persisted.input.idempotencyKey,
              );
            } catch {
              // Coordination announcements cannot invalidate durable local work.
            }
          }
        } catch {
          if (
            entry.generation === generation &&
            prepared.version === entry.localVersion &&
            entry.pendingPersistence === undefined
          ) {
            entry.persistenceFailed = true;
            diagnosePersistence({
              code: "draft_intents_write_failed",
              message: "The draft intent could not be stored.",
            });
          }
        } finally {
          if (entry.persisting === prepared) entry.persisting = undefined;
        }
      }
    }).finally(() => {
      if (entry.generation === generation) {
        entry.persistencePromise = undefined;
        if (entry.pendingPersistence !== undefined) schedulePersistence(entry);
      }
    });
    entry.persistencePromise = operation;
  };

  const stageProject = (
    entry: DraftEntry,
    desired: CanonicalDraftState,
  ): ChatConversationDraftState => {
    entry.localVersion += 1;
    entry.persistenceFailed = false;
    if (config.persistence === undefined) {
      const prepared = prepare(entry, desired);
      return project(entry, prepared);
    }
    clearTimer(entry);
    const prepared = prepare(entry, desired, entry.pendingPersistence);
    entry.pendingPersistence = prepared;
    schedulePersistence(entry);
    return entry.view;
  };

  const correlationsMatch = (
    mutation: PreparedMutation | DispatchMutation | undefined,
    deviceMutationId: string,
    idempotencyKey: string,
  ): boolean => mutation?.deviceMutationId === deviceMutationId &&
    mutation.idempotencyKey === idempotencyKey;

  const settleStoredMutation = async (
    mutation: DispatchMutation,
  ): Promise<boolean> => {
    const persistence = config.persistence;
    const scope = mutation.persistenceScope;
    if (persistence === undefined || scope === undefined) return true;
    try {
      return await serializeStorageMutation(async () => {
        if (!persistenceScopeIsUsable(scope)) return false;
        await persistence.storage.mutate(
          scope.identity,
          ApplicationChatStorageRecordKind.queuedDraftIntents,
          (currentRecord) => {
            if (!persistenceScopeIsUsable(scope) || currentRecord === null) {
              return currentRecord;
            }
            const normalized = createApplicationChatQueuedDraftIntentsRecord(
              scope.identity,
              currentRecord.intents,
            );
            const remaining = normalized.intents.filter((intent) =>
              intent.request.deviceMutationId !== mutation.deviceMutationId ||
              intent.request.idempotencyKey !== mutation.idempotencyKey);
            if (remaining.length === normalized.intents.length) return normalized;
            return remaining.length === 0
              ? null
              : createApplicationChatQueuedDraftIntentsRecord(scope.identity, remaining);
          },
        );
        if (!persistenceScopeIsUsable(scope)) return false;
        return true;
      });
    } catch {
      if (persistenceScopeIsUsable(scope)) {
        diagnosePersistence({
          code: "draft_intents_write_failed",
          message: "The settled draft intent could not be removed.",
        });
      }
      return false;
    }
  };

  const clearMatchingMutation = (
    entry: DraftEntry,
    mutation: DispatchMutation,
  ): void => {
    if (correlationsMatch(entry.active, mutation.deviceMutationId, mutation.idempotencyKey)) {
      entry.active = undefined;
    }
    if (correlationsMatch(entry.retry, mutation.deviceMutationId, mutation.idempotencyKey)) {
      entry.retry = undefined;
    }
    if (correlationsMatch(entry.queued, mutation.deviceMutationId, mutation.idempotencyKey)) {
      entry.queued = undefined;
    }
  };

  const retainForRetry = (entry: DraftEntry, mutation: DispatchMutation): void => {
    clearMatchingMutation(entry, mutation);
    const retry = Object.freeze({ ...mutation, retryNumber: mutation.retryNumber + 1 });
    entry.retry = retry;
    entry.status = "retryable";
    entry.message = "The draft could not be synchronized.";
    publish(entry);
    if (retry.retained) scheduleRetainedRetry(entry, retry);
  };

  const finishSuccessfulMutation = async (
    entry: DraftEntry,
    mutation: DispatchMutation,
    canonicalRevision: number,
    canonicalDraft: CanonicalDraftState,
  ): Promise<void> => {
    const generation = entry.generation;
    const settled = await settleStoredMutation(mutation);
    if (
      entry.generation !== generation ||
      entry.identityKey !== identityKey(config.cache) ||
      (mutation.persistenceScope !== undefined &&
        !persistenceScopeIsUsable(mutation.persistenceScope))
    ) return;
    if (!settled) {
      retainForRetry(entry, mutation);
      return;
    }
    clearMatchingMutation(entry, mutation);
    entry.lastSettled = Object.freeze({
      deviceMutationId: mutation.deviceMutationId,
      idempotencyKey: mutation.idempotencyKey,
      canonicalRevision,
    });
    entry.authoritativeRevision = Math.max(entry.authoritativeRevision, canonicalRevision);
    if (canonicalRevision >= entry.authoritativeRevision) entry.authoritativeDraft = canonicalDraft;
    if (
      entry.queued === undefined && entry.retry === undefined && entry.active === undefined &&
      entry.pendingPersistence === undefined &&
      (entry.desired === undefined || stateEqual(entry.desired, mutation.desired))
    ) {
      entry.desired = undefined;
      entry.conflict = undefined;
      entry.message = undefined;
      entry.status = "ready";
      cacheReconcile(entry, false);
    } else {
      entry.status = entry.active === undefined ? "debouncing" : "saving";
      cacheReconcile(entry, true);
    }
    publish(entry);
    if (entry.pendingPersistence !== undefined) schedulePersistence(entry);
  };

  async function scheduleRetainedRetry(
    entry: DraftEntry,
    mutation: DispatchMutation,
  ): Promise<void> {
    const controller = new AbortController();
    const epoch = retainedEpoch;
    const generation = entry.generation;
    retainedRetryControllers.add(controller);
    try {
      await recoveryWait(retainedDelay(mutation.retryNumber), controller.signal);
    } catch {
      return;
    } finally {
      retainedRetryControllers.delete(controller);
    }
    if (
      controller.signal.aborted || epoch !== retainedEpoch ||
      entry.generation !== generation || entry.retry !== mutation || !recoveryReady()
    ) return;
    entry.retry = undefined;
    entry.queued = mutation;
    drainRetainedEntry(entry);
  }

  const normalizeSuccessfulResult = (
    result: ChatCommandResult<SynchronizeDraftResult>,
    expected: SynchronizeDraftInput,
  ): ChatCommandResult<SynchronizeDraftResult> => {
    if (result.status !== "success") return result;
    try {
      return Object.freeze({
        status: "success",
        value: parseSynchronizeDraftResult(result.value, expected),
      });
    } catch {
      return Object.freeze({
        status: "malformed_response",
        message: "The chat server returned an invalid command response.",
      });
    }
  };

  const processResult = async (
    entry: DraftEntry,
    active: ActiveMutation,
    result: ChatCommandResult<SynchronizeDraftResult>,
  ): Promise<void> => {
    if (entry.active !== active || active.controller.signal.aborted) return;
    result = normalizeSuccessfulResult(result, active.input);
    if (active.acknowledged) {
      await finishSuccessfulMutation(
        entry,
        active,
        entry.authoritativeRevision,
        entry.authoritativeDraft ?? active.desired,
      );
      return;
    }
    if (result.status === "success") {
      const value = result.value;
      if (value.reconciliationStatus === "stale_base") {
        entry.active = undefined;
        entry.authoritativeRevision = value.canonicalRevision;
        entry.authoritativeDraft = freezeDraft(value.draft);
        if (entry.queued === undefined) entry.desired = active.desired;
        cacheReconcile(entry, true);
        setConflict(entry, "stale_base", value.canonicalRevision);
        return;
      }
      await finishSuccessfulMutation(
        entry,
        active,
        value.canonicalRevision,
        freezeDraft(value.draft),
      );
      return;
    }
    entry.active = undefined;
    if (retryableStatus(result.status)) {
      const httpStatus = resultHttpStatus(result);
      retainForRetry(entry, active);
      diagnose({
        event: "mutation_retryable",
        conversationId: entry.conversationId,
        category: diagnosticCategory(result.status),
        ...(httpStatus === undefined ? {} : { httpStatus }),
        message: "Draft synchronization can be retried safely.",
      });
      return;
    }
    entry.status = "error";
    entry.message = "The draft could not be synchronized.";
    publish(entry);
    const httpStatus = resultHttpStatus(result);
    diagnose({
      event: "mutation_failed",
      conversationId: entry.conversationId,
      category: diagnosticCategory(result.status),
      ...(httpStatus === undefined ? {} : { httpStatus }),
      message: "Draft synchronization failed.",
    });
  };

  const startMutation = (
    entry: DraftEntry,
    prepared: PreparedMutation | DispatchMutation,
    retryInput?: SynchronizeDraftInput,
  ): Promise<ChatCommandResult<SynchronizeDraftResult>> => {
    const input = retryInput ?? buildInput(entry, prepared);
    const controller = new AbortController();
    let promise: Promise<ChatCommandResult<SynchronizeDraftResult>>;
    try {
      promise = Promise.resolve(config.dispatch(createDescriptor(input), input, {
        idempotencyKey: input.idempotencyKey,
        signal: controller.signal,
      })).catch(() => TRANSPORT_RESULT);
    } catch {
      promise = Promise.resolve(TRANSPORT_RESULT);
    }
    const active: ActiveMutation = {
      ...prepared,
      input,
      ...(isPersistedMutation(prepared) ? { persistenceScope: prepared.persistenceScope } : {}),
      retained: isRetainedMutation(prepared),
      retryNumber: "retryNumber" in prepared ? prepared.retryNumber : 0,
      controller,
      promise,
      acknowledged: false,
    };
    entry.active = active;
    entry.status = "saving";
    entry.message = undefined;
    publish(entry);
    active.promise = promise.then(async (result) => {
      await processResult(entry, active, result);
      return result;
    });
    return active.promise;
  };

  function drainRetainedEntry(entry: DraftEntry): void {
    if (!recoveryReady() || entry.active !== undefined) return;
    const mutation = isRetainedMutation(entry.retry)
      ? entry.retry
      : isRetainedMutation(entry.queued)
        ? entry.queued
        : undefined;
    if (mutation === undefined) return;
    if (entry.retry === mutation) entry.retry = undefined;
    if (entry.queued === mutation) entry.queued = undefined;
    startMutation(entry, mutation, mutation.input);
  }

  async function flushEntry(entry: DraftEntry): Promise<ChatDraftFlushResult> {
    if (entry.flushPromise !== undefined) return entry.flushPromise;
    const generation = entry.generation;
    const operation = (async (): Promise<ChatDraftFlushResult> => {
      clearTimer(entry);
      while (entry.generation === generation) {
        if (entry.persistencePromise !== undefined) {
          await entry.persistencePromise;
          continue;
        }
        if (entry.persistenceFailed) return INVALID_RESULT;
        if (entry.status === "conflict") {
          return Object.freeze({ status: "conflict", state: entry.view });
        }
        if (entry.active !== undefined) {
          await entry.active.promise;
          continue;
        }
        if (entry.retry !== undefined) {
          return Object.freeze({ status: "retryable", state: entry.view });
        }
        if (entry.queued !== undefined) {
          const queued = entry.queued;
          if (isRetainedMutation(queued) && !recoveryReady()) {
            return Object.freeze({ status: "retryable", state: entry.view });
          }
          entry.queued = undefined;
          try {
            await startMutation(
              entry,
              queued,
              isPersistedMutation(queued) ? queued.input : undefined,
            );
          } catch {
            entry.queued = queued;
            entry.status = "error";
            entry.message = "The draft could not be synchronized.";
            publish(entry);
            diagnose({
              event: "mutation_failed",
              conversationId: entry.conversationId,
              category: "validation",
              message: "Draft synchronization failed validation.",
            });
            return INVALID_RESULT;
          }
          continue;
        }
        if (entry.status === "retryable") {
          return Object.freeze({ status: "retryable", state: entry.view });
        }
        if (entry.status === "error") {
          return Object.freeze({ status: "validation", message: "The draft input is invalid." });
        }
        return Object.freeze({ status: "success", state: entry.view });
      }
      return CLOSED_RESULT;
    })().finally(() => {
      if (entry.generation === generation) entry.flushPromise = undefined;
    });
    entry.flushPromise = operation;
    return operation;
  }

  const abortEntry = (entry: DraftEntry): void => {
    entry.generation += 1;
    clearTimer(entry);
    entry.active?.controller.abort();
    entry.hydrationController?.abort();
    entry.active = undefined;
    entry.retry = undefined;
    entry.pendingPersistence = undefined;
    entry.persisting = undefined;
    entry.persistencePromise = undefined;
    entry.persistenceFailed = false;
    entry.queued = undefined;
    entry.desired = undefined;
    entry.hydration = undefined;
    entry.hydrationController = undefined;
    entry.flushPromise = undefined;
    entry.conflict = undefined;
    entry.message = undefined;
    entry.status = "idle";
    cacheReconcile(entry, false);
    publish(entry);
    diagnose({
      event: "aborted",
      conversationId: entry.conversationId,
      category: "closed",
      message: "Draft lifecycle work was aborted.",
    });
  };

  const desiredFromInput = (input: SynchronizeDraftInput): CanonicalDraftState =>
    input.intent === "replace"
      ? freezeDraft({ kind: "replaced", content: input.content })
      : freezeDraft({ kind: "clear_tombstone", content: null });

  const restoreRetainedMutation = (
    scope: ChatDraftPersistenceScope,
    input: SynchronizeDraftInput,
  ): void => {
    const entry = getEntry(input.conversationId);
    const alreadyLoaded = [entry.queued, entry.retry, entry.active].some((mutation) =>
      correlationsMatch(mutation, input.deviceMutationId, input.idempotencyKey));
    if (alreadyLoaded || dirty(entry)) return;
    entry.localVersion += 1;
    const desired = desiredFromInput(input);
    const retained: PersistedMutation = Object.freeze({
      desired,
      version: entry.localVersion,
      deviceMutationId: input.deviceMutationId,
      idempotencyKey: input.idempotencyKey,
      input,
      persistenceScope: scope,
      retained: true,
      retryNumber: 0,
    });
    entry.desired = desired;
    entry.queued = retained;
    entry.status = "retryable";
    entry.conflict = undefined;
    entry.message = undefined;
    suppressCacheObservation = true;
    try {
      config.cache.projectConversationDraft(entry.conversationId, desired);
    } finally {
      suppressCacheObservation = false;
    }
    publish(entry);
  };

  const loadRetained = async (
    scope: ChatDraftPersistenceScope,
    announcement?: { readonly command: string; readonly idempotencyKey: string },
  ): Promise<void> => {
    const persistence = config.persistence;
    if (
      persistence === undefined || retainedScope === undefined ||
      !samePersistenceScope(retainedScope, scope) || !persistenceScopeIsUsable(scope)
    ) return;
    const epoch = retainedEpoch;
    let record;
    try {
      const stored = await persistence.storage.read(
        scope.identity,
        ApplicationChatStorageRecordKind.queuedDraftIntents,
      );
      if (
        epoch !== retainedEpoch || retainedScope === undefined ||
        !samePersistenceScope(retainedScope, scope) || !persistenceScopeIsUsable(scope) ||
        stored === null
      ) return;
      record = createApplicationChatQueuedDraftIntentsRecord(scope.identity, stored.intents);
    } catch (error) {
      if (
        epoch !== retainedEpoch || retainedScope === undefined ||
        !samePersistenceScope(retainedScope, scope) || !persistenceScopeIsUsable(scope)
      ) return;
      if (error instanceof ApplicationChatStorageValidationError) {
        diagnosePersistence({
          code: "draft_intents_rejected",
          message: "The stored draft intent record was rejected and quarantined.",
        });
      } else {
        diagnosePersistence({
          code: "draft_intents_read_failed",
          message: "The stored draft intents could not be read.",
        });
      }
      return;
    }
    if (
      epoch !== retainedEpoch || retainedScope === undefined ||
      !samePersistenceScope(retainedScope, scope) || !persistenceScopeIsUsable(scope)
    ) return;
    for (const intent of record.intents) {
      if (
        announcement !== undefined &&
        (announcement.command !== "conversation.draft.synchronize" ||
          announcement.idempotencyKey !== intent.request.idempotencyKey)
      ) continue;
      restoreRetainedMutation(scope, intent.request);
    }
    if (recoveryReady()) {
      for (const entry of entries.values()) drainRetainedEntry(entry);
    }
  };

  const parseCoordinatedSuccess = (
    value: unknown,
    expected: SynchronizeDraftInput,
  ): SynchronizeDraftResult | undefined => {
    if (
      typeof value !== "object" || value === null || Array.isArray(value) ||
      !exactKeys(value as Record<string, unknown>, ["status", "value"]) ||
      (value as Record<string, unknown>).status !== "success"
    ) return undefined;
    try {
      return parseSynchronizeDraftResult(
        (value as Record<string, unknown>).value,
        expected,
      );
    } catch {
      return undefined;
    }
  };

  const runtime: ChatDraftRuntime = {
    async open(conversationId) {
      let entry: DraftEntry;
      try {
        entry = getEntry(conversationId);
      } catch {
        return Object.freeze({
          conversationId,
          status: "error",
          authoritativeRevision: 0,
          dirty: false,
          message: "The draft could not be loaded.",
        });
      }
      if (entry.hydration !== undefined) return entry.hydration;
      const generation = entry.generation;
      const openedAtVersion = entry.localVersion;
      const openedAtRevision = entry.authoritativeRevision;
      const hydrationController = new AbortController();
      entry.hydrationController = hydrationController;
      if (!dirty(entry)) entry.status = "hydrating";
      publish(entry);
      const hydration = config.snapshots.getConversationDraft(
        { conversationId },
        { signal: hydrationController.signal },
      ).then(
        (result): ChatConversationDraftState => {
          if (entry.generation !== generation || entry.identityKey !== identityKey(config.cache)) {
            return entry.view;
          }
          if (result.status !== "success") {
            const httpStatus = resultHttpStatus(result);
            if (!dirty(entry)) {
              entry.status = "error";
              entry.message = "The draft could not be loaded.";
              publish(entry);
            }
            diagnose({
              event: "hydration_failed",
              conversationId,
              category: result.status,
              ...(httpStatus === undefined ? {} : { httpStatus }),
              message: "Draft hydration failed.",
            });
            return entry.view;
          }
          const snapshot = result.value;
          const canonical = draftFromSnapshot(snapshot);
          if (snapshot.canonicalRevision < entry.authoritativeRevision) return entry.view;
          if (
            snapshot.canonicalRevision === entry.authoritativeRevision &&
            entry.authoritativeRevision > 0 &&
            !stateEqual(entry.authoritativeDraft, canonical)
          ) {
            setConflict(entry, "incompatible_revision", snapshot.canonicalRevision);
            return entry.view;
          }
          entry.authoritativeRevision = snapshot.canonicalRevision;
          entry.authoritativeDraft = canonical;
          const newerPrivateState = entry.localVersion !== openedAtVersion ||
            entry.authoritativeRevision > openedAtRevision && dirty(entry);
          if (newerPrivateState || dirty(entry)) {
            cacheReconcile(entry, true);
          } else {
            entry.status = "ready";
            entry.message = undefined;
            cacheReconcile(entry, false);
          }
          publish(entry);
          return entry.view;
        },
        (): ChatConversationDraftState => {
          if (entry.generation === generation && !dirty(entry)) {
            entry.status = "error";
            entry.message = "The draft could not be loaded.";
            publish(entry);
          }
          diagnose({
            event: "hydration_failed",
            conversationId,
            category: "transport",
            message: "Draft hydration failed.",
          });
          return entry.view;
        },
      ).finally(() => {
        if (entry.generation === generation) {
          entry.hydration = undefined;
          entry.hydrationController = undefined;
        }
      });
      entry.hydration = hydration;
      return hydration;
    },
    select(conversationId) {
      return getEntry(conversationId).view;
    },
    subscribe(conversationId, listener) {
      if (typeof listener !== "function") throw new TypeError("Draft listener is invalid");
      const entry = getEntry(conversationId);
      entry.listeners.add(listener);
      return () => entry.listeners.delete(listener);
    },
    replace(input) {
      try {
        const entry = getEntry(input.conversationId);
        const validated = parseSynchronizeDraftInput({
          operation: "synchronize_draft",
          intent: "replace",
          conversationId: input.conversationId,
          baseRevision: entry.authoritativeRevision,
          deviceMutationId: "draft-validation",
          idempotencyKey: "draft-validation",
          content: input.content,
        });
        if (validated.intent !== "replace") throw new TypeError("Invalid draft intent");
        return stageProject(entry, freezeDraft({ kind: "replaced", content: validated.content }));
      } catch {
        throw new TypeError("Draft input is invalid");
      }
    },
    clear(conversationId) {
      return stageProject(
        getEntry(conversationId),
        freezeDraft({ kind: "clear_tombstone", content: null }),
      );
    },
    flush(conversationId) {
      try {
        return flushEntry(getEntry(conversationId));
      } catch {
        return Promise.resolve(INVALID_RESULT);
      }
    },
    retry(conversationId) {
      try {
        const entry = getEntry(conversationId);
        if (entry.status === "conflict") {
          const desired = entry.desired;
          if (desired === undefined) return Promise.resolve(INVALID_RESULT);
          entry.active?.controller.abort();
          entry.active = undefined;
          entry.retry = undefined;
          const prepared = Object.freeze({
            desired,
            version: entry.localVersion,
            deviceMutationId: generateDeviceMutationId(),
            idempotencyKey: generateIdempotencyKey(),
            resolveConflict: true,
          });
          if (config.persistence === undefined) {
            entry.queued = prepared;
            entry.conflict = undefined;
            entry.status = "debouncing";
            publish(entry);
          } else {
            entry.pendingPersistence = prepared;
            schedulePersistence(entry);
          }
        } else if (entry.status !== "retryable") {
          return Promise.resolve(INVALID_RESULT);
        }
        if (entry.retry !== undefined) {
          const retry = entry.retry;
          if (retry.retained && !recoveryReady()) {
            return Promise.resolve(Object.freeze({ status: "retryable", state: entry.view }));
          }
          entry.retry = undefined;
          startMutation(entry, retry, retry.input);
        }
        return flushEntry(entry);
      } catch {
        return Promise.resolve(INVALID_RESULT);
      }
    },
    async closeConversation(conversationId, options = {}) {
      let entry: DraftEntry;
      try {
        entry = getEntry(conversationId);
      } catch {
        return INVALID_RESULT;
      }
      if (options.policy === "abort") {
        abortEntry(entry);
        return Object.freeze({ status: "success", state: entry.view });
      }
      const result = await flushEntry(entry);
      if (result.status !== "success") return result;
      abortEntry(entry);
      return Object.freeze({ status: "success", state: entry.view });
    },
    handleCanonicalEvent(event) {
      const identity = config.cache.getState().identity;
      if (identity === null) return;
      try {
        const parsed = parseConversationDraftUpdatedEvent(event, identity.tenantId);
        if (parsed.payload.actorUserId !== identity.userId) return;
        const result = parsed.payload.result;
        const entry = entries.get(result.conversationId);
        if (entry === undefined || entry.identityKey !== identityKey(config.cache)) return;
        observeCanonical(entry, result.canonicalRevision, freezeDraft(result.draft), {
          deviceMutationId: result.deviceMutationId,
          idempotencyKey: result.idempotencyKey,
        });
      } catch {
        // The durable reducer owns recovery diagnostics for malformed payloads.
      }
    },
    handleCoordinatedResult(command, idempotencyKey, value) {
      if (command !== "conversation.draft.synchronize") return;
      for (const entry of entries.values()) {
        const mutation = [entry.active, entry.retry, entry.queued].find((candidate) =>
          isRetainedMutation(candidate) && candidate.idempotencyKey === idempotencyKey);
        if (!isRetainedMutation(mutation)) continue;
        const result = parseCoordinatedSuccess(value, mutation.input);
        if (result === undefined || result.reconciliationStatus !== "applied") return;
        void finishSuccessfulMutation(
          entry,
          mutation,
          result.canonicalRevision,
          freezeDraft(result.draft),
        );
        return;
      }
    },
    async activateRetained(scope) {
      retainedEpoch += 1;
      for (const controller of retainedRetryControllers) controller.abort();
      retainedRetryControllers.clear();
      retainedScope = scope;
      if (!persistenceScopeIsUsable(scope)) return;
      await loadRetained(scope);
    },
    reloadRetained(scope, announcement) {
      if (
        retainedScope === undefined || !samePersistenceScope(retainedScope, scope) ||
        !persistenceScopeIsUsable(scope)
      ) return Promise.resolve();
      return loadRetained(scope, announcement);
    },
    resumeRetained() {
      if (!recoveryReady()) return;
      for (const entry of entries.values()) drainRetainedEntry(entry);
    },
    pauseRetained() {
      retainedEpoch += 1;
      for (const controller of retainedRetryControllers) controller.abort();
      retainedRetryControllers.clear();
      for (const entry of entries.values()) {
        const active = entry.active;
        if (active?.retained !== true) continue;
        active.controller.abort();
        entry.active = undefined;
        entry.retry = Object.freeze({ ...active });
        entry.status = "retryable";
        entry.message = undefined;
        cacheReconcile(entry, true);
        publish(entry);
      }
    },
    announceRetained() {
      for (const entry of entries.values()) {
        const mutation = isRetainedMutation(entry.active)
          ? entry.active
          : isRetainedMutation(entry.retry)
            ? entry.retry
            : isRetainedMutation(entry.queued)
              ? entry.queued
              : undefined;
        if (mutation === undefined) continue;
        try {
          config.persistence?.onPersistedIntent?.(
            "conversation.draft.synchronize",
            mutation.idempotencyKey,
          );
        } catch {
          // Coordination announcements cannot alter retained draft state.
        }
      }
    },
    createCanonicalCheckpoint() {
      const state = config.cache.getState();
      const drafts: Record<ConversationId, CanonicalDraftState> = {
        ...state.currentUser.drafts,
      };
      const draftRevisions: Record<ConversationId, number> = {
        ...state.currentUser.draftRevisions,
      };
      const key = identityKey(config.cache);
      for (const entry of entries.values()) {
        if (entry.identityKey !== key || !dirty(entry)) continue;
        if (entry.authoritativeDraft === undefined) delete drafts[entry.conversationId];
        else drafts[entry.conversationId] = entry.authoritativeDraft;
        if (entry.authoritativeRevision === 0) delete draftRevisions[entry.conversationId];
        else draftRevisions[entry.conversationId] = entry.authoritativeRevision;
      }
      return Object.freeze({
        drafts: Object.freeze(drafts),
        draftRevisions: Object.freeze(draftRevisions),
      });
    },
    closeActive() {
      runtime.pauseRetained();
      retainedScope = undefined;
      for (const entry of entries.values()) abortEntry(entry);
    },
  };

  config.cache.subscribe(
    (state) => state.currentUser,
    (currentUser) => {
      if (suppressCacheObservation) return;
      for (const entry of entries.values()) {
        if (entry.identityKey !== identityKey(config.cache)) continue;
        const revision = currentUser.draftRevisions[entry.conversationId] ?? 0;
        if (revision <= entry.authoritativeRevision) continue;
        observeCanonical(
          entry,
          revision,
          currentUser.drafts[entry.conversationId],
        );
      }
    },
  );
  config.cache.subscribePrivateStateBoundary(() => {
    retainedEpoch += 1;
    retainedScope = undefined;
    for (const controller of retainedRetryControllers) controller.abort();
    retainedRetryControllers.clear();
    for (const entry of entries.values()) {
      entry.generation += 1;
      clearTimer(entry);
      entry.active?.controller.abort();
      entry.hydrationController?.abort();
    }
    entries.clear();
  });

  return Object.freeze(runtime);
}
