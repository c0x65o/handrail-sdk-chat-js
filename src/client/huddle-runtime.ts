import {
  parseEndHuddleInput,
  parseHuddleCommandResult,
  parseHuddleSessionState,
  parseJoinHuddleInput,
  parseLeaveHuddleInput,
  parseSetHuddleScreenShareInput,
  parseStartHuddleInput,
  validateHuddleStateTransition,
  type HuddleCommandInput,
  type HuddleCommandOperation,
  type HuddleCommandResult,
  type HuddleMediaJoinDescriptor,
  type HuddleSessionId,
  type HuddleSessionState,
  type HuddleScreenShareIntent,
} from "../contracts/huddle-session.js";
import type { ConversationId, IsoTimestamp } from "../contracts/identifiers.js";
import {
  ApplicationChatStorageRecordKind,
  ApplicationChatStorageValidationError,
  createApplicationChatQueuedHuddleCommandIntent,
  createApplicationChatQueuedHuddleCommandIntentsRecord,
  type ApplicationChatQueuedHuddleCommandIntent,
  type ApplicationChatStorage,
  type ApplicationChatStorageIdentity,
} from "./application-chat-storage.js";
import type {
  ChatClientFetch,
  ChatCommandDescriptor,
  ChatCommandDispatchOptions,
  ChatCommandResult,
} from "./command-dispatcher.js";
import type { NormalizedChatCache } from "./normalized-cache.js";

export type ChatHuddleHydrationStatus = "idle" | "loading" | "ready" | "error";

export type ChatHuddleMediaState =
  | Readonly<{ state: "idle" }>
  | Readonly<{
      state: "ready";
      huddleSessionId: HuddleSessionId;
      expiresAt: IsoTimestamp;
    }>
  | Readonly<{
      state: "rejoin_required";
      reason: "not_joined" | "realtime_disconnected" | "descriptor_expired" | "session_replaced";
    }>
  | Readonly<{
      state: "unavailable";
      reason: "feature_disabled";
    }>
  | Readonly<{
      state: "error";
      code: ChatHuddleErrorCode;
      message: string;
      retryable: boolean;
      httpStatus?: number;
    }>;

export interface ChatHuddleViewState {
  readonly conversationId: ConversationId;
  readonly canonicalState?: HuddleSessionState;
  readonly hydrationStatus: ChatHuddleHydrationStatus;
  readonly media: ChatHuddleMediaState;
  readonly pendingOperation?: HuddleCommandOperation;
  readonly recovery?: Readonly<{
    state: "pending" | "conflict";
    operation: HuddleCommandOperation;
  }>;
}

export type ChatHuddleErrorCode =
  | "validation"
  | "authentication"
  | "conflict"
  | "feature_disabled"
  | "unsupported"
  | "rejected"
  | "malformed_response"
  | "transport"
  | "aborted"
  | "closed";

export type ChatHuddleActionOperation = "hydrate" | "retry" | HuddleCommandOperation;

export interface ChatHuddleActionSuccess {
  readonly status: "success";
  readonly operation: ChatHuddleActionOperation;
  readonly state: HuddleSessionState;
  /** False means a newer event or action already supplied the canonical state. */
  readonly applied: boolean;
  readonly reconciliationStatus?: "applied" | "replayed";
}

export interface ChatHuddleActionFeatureDisabled {
  readonly status: "feature_disabled";
  readonly operation: HuddleCommandOperation;
  readonly state: HuddleSessionState;
  readonly message: "Huddle media is unavailable.";
}

export interface ChatHuddleActionFailure {
  readonly status: "error";
  readonly operation: ChatHuddleActionOperation;
  readonly code: ChatHuddleErrorCode;
  /** Stable renderer-safe text. Response bodies and thrown values are discarded. */
  readonly message: string;
  readonly retryable: boolean;
  readonly httpStatus?: number;
}

export type ChatHuddleActionResult =
  | ChatHuddleActionSuccess
  | ChatHuddleActionFeatureDisabled
  | ChatHuddleActionFailure;

export type ChatHuddleListener = (
  state: ChatHuddleViewState,
  previous: ChatHuddleViewState,
) => void;

export interface ChatHuddleRuntimeOptions {
  readonly generateIdempotencyKey?: () => string;
  readonly now?: () => number;
  readonly setTimeout?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
  /** Deterministic, bounded scheduling for retained huddle-command recovery. */
  readonly retainedRecovery?: ChatHuddleRetainedRecoveryOptions;
  /** Injectable host-document boundary. Recovery requires a visible, active host. */
  readonly hostActivity?: ChatHuddleHostActivity;
}

export interface ChatHuddleRetainedRecoveryOptions {
  /** Defaults to 250ms. */
  readonly initialDelayMs?: number;
  /** Defaults to 30 seconds and always bounds calculated delays. */
  readonly maximumDelayMs?: number;
  /** Defaults to 2. */
  readonly multiplier?: number;
  /** Injectable abort-aware wait boundary for deterministic clocks. */
  readonly wait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

export interface ChatHuddleHostActivity {
  isActive(): boolean;
  addEventListener(type: "visibilitychange" | "focus" | "blur", listener: () => void): void;
  removeEventListener(type: "visibilitychange" | "focus" | "blur", listener: () => void): void;
}

export interface ChatHuddleNetwork {
  isOnline(): boolean;
  addEventListener(type: "online" | "offline", listener: () => void): void;
  removeEventListener(type: "online" | "offline", listener: () => void): void;
}

export interface ChatHuddlePersistenceScope {
  readonly identity: ApplicationChatStorageIdentity;
  readonly generation: number;
}

export type ChatHuddlePersistenceDiagnosticCode =
  | "huddle_intents_read_failed"
  | "huddle_intents_rejected"
  | "huddle_intents_quarantine_failed"
  | "huddle_intents_write_failed";

export interface ChatHuddlePersistenceDiagnostic {
  readonly code: ChatHuddlePersistenceDiagnosticCode;
  readonly message: string;
}

export interface ChatHuddleRuntime {
  getState(conversationId: ConversationId): ChatHuddleViewState;
  subscribe(conversationId: ConversationId, listener: ChatHuddleListener): () => void;
  hydrate(conversationId: ConversationId): Promise<ChatHuddleActionResult>;
  start(conversationId: ConversationId): Promise<ChatHuddleActionResult>;
  join(conversationId: ConversationId): Promise<ChatHuddleActionResult>;
  leave(conversationId: ConversationId): Promise<ChatHuddleActionResult>;
  setScreenShare(
    conversationId: ConversationId,
    intent: HuddleScreenShareIntent,
  ): Promise<ChatHuddleActionResult>;
  end(conversationId: ConversationId): Promise<ChatHuddleActionResult>;
  retry(conversationId: ConversationId): Promise<ChatHuddleActionResult>;
  rejoin(conversationId: ConversationId): Promise<ChatHuddleActionResult>;
  /** The only API that can reveal opaque join material; it is never enumerable client state. */
  getMediaJoinDescriptor(
    conversationId: ConversationId,
  ): HuddleMediaJoinDescriptor | undefined;
  handleRealtimeState(state: string): void;
  activateRetained(scope: ChatHuddlePersistenceScope): Promise<void>;
  reloadRetained(
    scope: ChatHuddlePersistenceScope,
    announcement?: Readonly<{ command: string; idempotencyKey: string }>,
  ): Promise<void>;
  announceRetained(): void;
  handleCoordinatedResult(
    command: string,
    idempotencyKey: string,
    result: unknown,
  ): void;
  resumeRetained(): void;
  pauseRetained(): void;
  closeActive(): void;
}

interface CreateChatHuddleRuntimeOptions {
  readonly endpoint: string;
  readonly getAccessToken: () => string | Promise<string>;
  readonly fetch: ChatClientFetch;
  readonly cache: NormalizedChatCache;
  readonly dispatch: <Input, RequestBody, Result>(
    descriptor: ChatCommandDescriptor<Input, RequestBody, Result>,
    input: Input,
    options?: ChatCommandDispatchOptions,
  ) => Promise<ChatCommandResult<Result>>;
  readonly generateDefaultIdempotencyKey: () => string;
  readonly options?: ChatHuddleRuntimeOptions;
  readonly persistence?: Readonly<{
    storage: ApplicationChatStorage;
    getActiveScope: () => ChatHuddlePersistenceScope | undefined;
    isActiveScope: (scope: ChatHuddlePersistenceScope) => boolean;
    isRecoveryReady: () => boolean;
    network?: ChatHuddleNetwork;
    onPersistedIntent?: (command: string, idempotencyKey: string) => void;
    onDiagnostic?: (diagnostic: ChatHuddlePersistenceDiagnostic) => void;
  }>;
}

interface LocalHuddleState {
  hydrationStatus: ChatHuddleHydrationStatus;
  media: ChatHuddleMediaState;
  pendingOperation?: HuddleCommandOperation;
  recovery?: Readonly<{
    state: "pending" | "conflict";
    operation: HuddleCommandOperation;
  }>;
}

interface StoredDescriptor {
  readonly huddleSessionId: HuddleSessionId;
  readonly value: HuddleMediaJoinDescriptor;
  readonly timer: unknown;
}

interface RetryableCommand {
  readonly conversationId: ConversationId;
  readonly input: HuddleCommandInput;
}

type DurableHuddleIntent = ApplicationChatQueuedHuddleCommandIntent;

const IDLE_MEDIA = Object.freeze({ state: "idle" } as const);
const HUDDLE_MEDIA_UNAVAILABLE_MESSAGE = "Huddle media is unavailable." as const;
const SNAPSHOT_FAILURE_MESSAGE = "Huddle state could not be loaded.";
const COMMAND_FAILURE_MESSAGE = "The huddle action could not be completed.";
const RETAINED_INITIAL_DELAY_MS = 250;
const RETAINED_MAXIMUM_DELAY_MS = 30_000;
const RETAINED_RETRY_MULTIPLIER = 2;

const defaultRetainedWait = (
  delayMs: number,
  signal: AbortSignal,
): Promise<void> => new Promise((resolve, reject) => {
  if (signal.aborted) {
    reject(new Error("aborted"));
    return;
  }
  const handle = globalThis.setTimeout(resolve, delayMs);
  signal.addEventListener("abort", () => {
    globalThis.clearTimeout(handle);
    reject(new Error("aborted"));
  }, { once: true });
});

const defaultHostActivity = (): ChatHuddleHostActivity => {
  const target = globalThis as typeof globalThis & {
    document?: {
      readonly visibilityState?: string;
      hasFocus?: () => boolean;
      addEventListener?: (type: string, listener: () => void) => void;
      removeEventListener?: (type: string, listener: () => void) => void;
    };
  };
  return {
    isActive: () => target.document?.visibilityState !== "hidden" &&
      (target.document?.hasFocus?.() ?? true),
    addEventListener: (type, listener) => target.document?.addEventListener?.(type, listener),
    removeEventListener: (type, listener) =>
      target.document?.removeEventListener?.(type, listener),
  };
};

const sameValue = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
};

const isAuthorityRefreshResult = (value: unknown): boolean =>
  isRecord(value) &&
  hasExactKeys(value, ["status", "value"]) &&
  value.status === "success" &&
  isRecord(value.value) &&
  hasExactKeys(value.value, ["authorityRefresh"]) &&
  value.value.authorityRefresh === true;

const parseCoordinatedFailure = (
  value: unknown,
): Exclude<ChatCommandResult<unknown>, { status: "success" }> | undefined => {
  if (!isRecord(value) || typeof value.status !== "string") return undefined;
  const definitions = {
    validation: ["The command input is invalid.", false],
    conflict: ["The command conflicts with current server state.", true],
    authentication: ["Chat authentication failed.", "optional"],
    feature_disabled: ["The requested chat feature is disabled.", true],
    unsupported: ["The requested chat command is unsupported.", true],
    rejected: ["The chat server rejected the command.", true],
    malformed_response: ["The chat server returned an invalid command response.", "optional"],
    transport: ["The chat command could not be completed.", "optional"],
    aborted: ["The chat command was aborted.", false],
    closed: ["The chat client was closed.", false],
  } as const;
  const definition = definitions[value.status as keyof typeof definitions];
  if (definition === undefined || value.message !== definition[0]) return undefined;
  const http = definition[1];
  const keys = http === true || (http === "optional" && value.httpStatus !== undefined)
    ? ["status", "message", "httpStatus"]
    : ["status", "message"];
  if (
    !hasExactKeys(value, keys) ||
    (keys.length === 3 &&
      (!Number.isInteger(value.httpStatus) ||
        (value.httpStatus as number) < 100 ||
        (value.httpStatus as number) > 599))
  ) return undefined;
  return value as unknown as Exclude<
    ChatCommandResult<unknown>,
    { status: "success" }
  >;
};

const isLive = (
  state: HuddleSessionState | undefined,
): state is Extract<HuddleSessionState, { status: "starting" | "active" }> =>
  state?.status === "starting" || state?.status === "active";

const isValidConversationId = (value: unknown): value is ConversationId =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value === value.trim() &&
  !/[\u0000-\u0020\u007f/?#]/u.test(value);

const errorResult = (
  operation: ChatHuddleActionOperation,
  code: ChatHuddleErrorCode,
  message: string,
  retryable: boolean,
  httpStatus?: number,
): ChatHuddleActionFailure => Object.freeze({
  status: "error",
  operation,
  code,
  message,
  retryable,
  ...(httpStatus === undefined ? {} : { httpStatus }),
});

const mapCommandFailure = (
  operation: HuddleCommandOperation,
  result: Exclude<ChatCommandResult<unknown>, { status: "success" }>,
): ChatHuddleActionFailure => errorResult(
  operation,
  result.status,
  COMMAND_FAILURE_MESSAGE,
  result.status === "transport" ||
    result.status === "authentication" ||
    result.status === "conflict" ||
    result.status === "malformed_response" ||
    result.status === "aborted",
  "httpStatus" in result ? result.httpStatus : undefined,
);

const descriptorFor = (
  input: HuddleCommandInput,
  now: () => number,
): ChatCommandDescriptor<HuddleCommandInput, HuddleCommandInput, HuddleCommandResult> => {
  const path = input.operation === "start_huddle"
    ? `/conversations/${encodeURIComponent(input.conversationId)}/huddles`
    : input.operation === "join_huddle"
      ? `/huddles/${encodeURIComponent(input.huddleSessionId)}/join`
      : input.operation === "leave_huddle"
        ? `/huddles/${encodeURIComponent(input.huddleSessionId)}/leave`
        : input.operation === "set_huddle_screen_share"
          ? `/huddles/${encodeURIComponent(input.huddleSessionId)}/screen-share`
          : `/huddles/${encodeURIComponent(input.huddleSessionId)}/end`;
  return Object.freeze({
    name: `huddle.${input.operation.replace("_huddle", "")}`,
    method: input.operation === "set_huddle_screen_share" ? "PATCH" : "POST",
    path,
    retry: "safe",
    validateInput(value: HuddleCommandInput) {
      if (value.operation === "start_huddle") return parseStartHuddleInput(value);
      if (value.operation === "join_huddle") return parseJoinHuddleInput(value);
      if (value.operation === "leave_huddle") return parseLeaveHuddleInput(value);
      if (value.operation === "set_huddle_screen_share") {
        return parseSetHuddleScreenShareInput(value);
      }
      return parseEndHuddleInput(value);
    },
    parseResult: (value: unknown) =>
      parseHuddleCommandResult(value, input, { now: now() }),
  });
};

/** Headless huddle orchestration. Join descriptors remain private closure state. */
export function createChatHuddleRuntime(
  config: CreateChatHuddleRuntimeOptions,
): ChatHuddleRuntime {
  const now = config.options?.now ?? Date.now;
  const schedule = config.options?.setTimeout ??
    ((callback: () => void, delayMs: number) => globalThis.setTimeout(callback, delayMs));
  const cancel = config.options?.clearTimeout ??
    ((handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
  const generateIdempotencyKey =
    config.options?.generateIdempotencyKey ?? config.generateDefaultIdempotencyKey;
  const retainedRecovery = config.options?.retainedRecovery;
  const retainedInitialDelayMs = retainedRecovery?.initialDelayMs ?? RETAINED_INITIAL_DELAY_MS;
  const retainedMaximumDelayMs =
    retainedRecovery?.maximumDelayMs ?? RETAINED_MAXIMUM_DELAY_MS;
  const retainedRetryMultiplier =
    retainedRecovery?.multiplier ?? RETAINED_RETRY_MULTIPLIER;
  const retainedWait = retainedRecovery?.wait ?? defaultRetainedWait;
  const hostActivity = config.options?.hostActivity ?? defaultHostActivity();
  if (
    typeof now !== "function" ||
    typeof schedule !== "function" ||
    typeof cancel !== "function" ||
    typeof generateIdempotencyKey !== "function" ||
    typeof hostActivity?.isActive !== "function" ||
    typeof hostActivity?.addEventListener !== "function" ||
    typeof hostActivity?.removeEventListener !== "function" ||
    typeof retainedWait !== "function" ||
    !Number.isFinite(retainedInitialDelayMs) || retainedInitialDelayMs < 0 ||
    retainedInitialDelayMs > 60_000 ||
    !Number.isFinite(retainedMaximumDelayMs) || retainedMaximumDelayMs < retainedInitialDelayMs ||
    retainedMaximumDelayMs > 60_000 ||
    !Number.isFinite(retainedRetryMultiplier) || retainedRetryMultiplier <= 0
  ) {
    throw new TypeError("Huddle runtime options are invalid");
  }

  const local = new Map<ConversationId, LocalHuddleState>();
  const listeners = new Map<ConversationId, Set<ChatHuddleListener>>();
  const descriptors = new Map<ConversationId, StoredDescriptor>();
  const watermarks = new Map<ConversationId, number>();
  const queues = new Map<ConversationId, Promise<ChatHuddleActionResult>>();
  const retries = new Map<ConversationId, RetryableCommand>();
  const hydrations = new Map<
    ConversationId,
    { readonly controller: AbortController; readonly promise: Promise<ChatHuddleActionResult> }
  >();
  let generation = 0;
  let retainedIntents: readonly DurableHuddleIntent[] = Object.freeze([]);
  let retainedMutationChain: Promise<void> = Promise.resolve();
  let retainedController: AbortController | undefined;
  let retainedRunning = false;

  const canonical = (conversationId: ConversationId): HuddleSessionState | undefined =>
    config.cache.getState().huddles[conversationId];
  const needsMediaJoin = (conversationId: ConversationId): boolean => {
    const state = canonical(conversationId);
    if (!isLive(state)) return false;
    const currentUserId = config.cache.getState().identity?.userId;
    return state.participants.find(
      (participant) => participant.userId === currentUserId,
    )?.status !== "left";
  };
  const bump = (conversationId: ConversationId): number => {
    const next = (watermarks.get(conversationId) ?? 0) + 1;
    watermarks.set(conversationId, next);
    return next;
  };
  const defaultMedia = (conversationId: ConversationId): ChatHuddleMediaState =>
    needsMediaJoin(conversationId)
      ? Object.freeze({ state: "rejoin_required", reason: "not_joined" })
      : IDLE_MEDIA;
  const localFor = (conversationId: ConversationId): LocalHuddleState => {
    let value = local.get(conversationId);
    if (value === undefined) {
      value = { hydrationStatus: "idle", media: defaultMedia(conversationId) };
      local.set(conversationId, value);
    }
    return value;
  };
  const view = (conversationId: ConversationId): ChatHuddleViewState => {
    const value = localFor(conversationId);
    const canonicalState = canonical(conversationId);
    return Object.freeze({
      conversationId,
      ...(canonicalState === undefined ? {} : { canonicalState }),
      hydrationStatus: value.hydrationStatus,
      media: value.media,
      ...(value.pendingOperation === undefined
        ? {}
        : { pendingOperation: value.pendingOperation }),
      ...(value.recovery === undefined ? {} : { recovery: value.recovery }),
    });
  };
  const viewWithCanonical = (
    conversationId: ConversationId,
    canonicalState: HuddleSessionState | undefined,
  ): ChatHuddleViewState => {
    const value = localFor(conversationId);
    return Object.freeze({
      conversationId,
      ...(canonicalState === undefined ? {} : { canonicalState }),
      hydrationStatus: value.hydrationStatus,
      media: value.media,
      ...(value.pendingOperation === undefined
        ? {}
        : { pendingOperation: value.pendingOperation }),
      ...(value.recovery === undefined ? {} : { recovery: value.recovery }),
    });
  };
  const notify = (
    conversationId: ConversationId,
    previous: ChatHuddleViewState,
  ): void => {
    const next = view(conversationId);
    if (sameValue(previous, next)) return;
    for (const listener of listeners.get(conversationId) ?? []) {
      try {
        listener(next, previous);
      } catch {
        // Renderer observers cannot alter canonical huddle work.
      }
    }
  };
  const mutateLocal = (
    conversationId: ConversationId,
    mutation: (state: LocalHuddleState) => void,
  ): void => {
    const previous = view(conversationId);
    mutation(localFor(conversationId));
    notify(conversationId, previous);
  };
  const clearDescriptor = (conversationId: ConversationId): void => {
    const stored = descriptors.get(conversationId);
    if (stored === undefined) return;
    try {
      cancel(stored.timer);
    } catch {
      // A failing clock boundary cannot keep opaque material reachable.
    } finally {
      descriptors.delete(conversationId);
    }
  };
  const setDescriptor = (
    conversationId: ConversationId,
    huddleSessionId: HuddleSessionId,
    value: HuddleMediaJoinDescriptor,
  ): void => {
    clearDescriptor(conversationId);
    const privateValue = Object.freeze({ ...value });
    let delay: number;
    try {
      delay = Date.parse(privateValue.expiresAt) - now();
    } catch {
      delay = 0;
    }
    if (!(delay > 0)) {
      mutateLocal(conversationId, (state) => {
        state.media = Object.freeze({
          state: "rejoin_required",
          reason: "descriptor_expired",
        });
      });
      return;
    }
    let timer: unknown;
    try {
      timer = schedule(() => {
        const current = descriptors.get(conversationId);
        if (current?.value !== privateValue) return;
        descriptors.delete(conversationId);
        mutateLocal(conversationId, (state) => {
          state.media = isLive(canonical(conversationId))
            ? Object.freeze({ state: "rejoin_required", reason: "descriptor_expired" })
            : IDLE_MEDIA;
        });
      }, delay);
    } catch {
      mutateLocal(conversationId, (state) => {
        state.media = Object.freeze({
          state: "rejoin_required",
          reason: "descriptor_expired",
        });
      });
      return;
    }
    descriptors.set(conversationId, {
      huddleSessionId,
      value: privateValue,
      timer,
    });
    mutateLocal(conversationId, (state) => {
      state.media = Object.freeze({
        state: "ready",
        huddleSessionId,
        expiresAt: privateValue.expiresAt,
      });
    });
  };

  const reportPersistenceDiagnostic = (
    code: ChatHuddlePersistenceDiagnosticCode,
    message: string,
  ): void => {
    try {
      config.persistence?.onDiagnostic?.(Object.freeze({ code, message }));
    } catch {
      // Diagnostic observers cannot alter durable recovery.
    }
  };
  const activeScope = (): ChatHuddlePersistenceScope | undefined =>
    config.persistence?.getActiveScope();
  const scopeIsActive = (scope: ChatHuddlePersistenceScope): boolean =>
    config.persistence?.isActiveScope(scope) === true;
  const serializedRetainedMutation = async <Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> => {
    let resolveResult!: (value: Result | PromiseLike<Result>) => void;
    let rejectResult!: (reason?: unknown) => void;
    const result = new Promise<Result>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    retainedMutationChain = retainedMutationChain.then(async () => {
      try {
        resolveResult(await operation());
      } catch (error) {
        rejectResult(error);
      }
    });
    await retainedMutationChain;
    return result;
  };
  const persistInput = async (input: HuddleCommandInput): Promise<boolean> => {
    const persistence = config.persistence;
    if (persistence === undefined) return true;
    const scope = activeScope();
    if (scope === undefined || !scopeIsActive(scope)) return false;
    return serializedRetainedMutation(async () => {
      if (!scopeIsActive(scope)) return false;
      try {
        const enqueuedAt = new Date(now()).toISOString() as IsoTimestamp;
        const next = await persistence.storage.mutate(
          scope.identity,
          ApplicationChatStorageRecordKind.queuedHuddleCommandIntents,
          (current) => {
            if (!scopeIsActive(scope)) return current;
            const currentIntents = current?.intents ?? [];
            const intent = createApplicationChatQueuedHuddleCommandIntent(input, {
              enqueueOrder: (currentIntents.at(-1)?.enqueueOrder ?? 0) + 1,
              enqueuedAt,
            });
            return createApplicationChatQueuedHuddleCommandIntentsRecord(
              scope.identity,
              [...currentIntents, intent],
            );
          },
        );
        if (!scopeIsActive(scope)) return false;
        if (next === null) return false;
        retainedIntents = next.intents;
        try {
          persistence.onPersistedIntent?.(
            "huddle.command",
            input.idempotencyKey,
          );
        } catch {
          // Coordination announcements cannot invalidate durable local work.
        }
        return true;
      } catch {
        if (scopeIsActive(scope)) {
          reportPersistenceDiagnostic(
            "huddle_intents_write_failed",
            "The queued huddle command could not be stored.",
          );
        }
        return false;
      }
    });
  };
  const removeRetained = async (
    idempotencyKey: string,
    expectedScope?: ChatHuddlePersistenceScope,
  ): Promise<boolean> => {
    const persistence = config.persistence;
    if (persistence === undefined) {
      retries.forEach((retry, conversationId) => {
        if (retry.input.idempotencyKey === idempotencyKey) retries.delete(conversationId);
      });
      return true;
    }
    const scope = expectedScope ?? activeScope();
    if (scope === undefined || !scopeIsActive(scope)) return false;
    return serializedRetainedMutation(async () => {
      if (!scopeIsActive(scope)) return false;
      try {
        const next = await persistence.storage.mutate(
          scope.identity,
          ApplicationChatStorageRecordKind.queuedHuddleCommandIntents,
          (current) => {
            if (!scopeIsActive(scope) || current === null) return current;
            const nextIntents = current.intents.filter(
              (intent) => intent.request.idempotencyKey !== idempotencyKey,
            );
            if (nextIntents.length === current.intents.length) return current;
            return nextIntents.length === 0
              ? null
              : createApplicationChatQueuedHuddleCommandIntentsRecord(
                  scope.identity,
                  nextIntents,
                );
          },
        );
        if (!scopeIsActive(scope)) return false;
        retainedIntents = next?.intents ?? Object.freeze([]);
        return true;
      } catch {
        if (scopeIsActive(scope)) {
          reportPersistenceDiagnostic(
            "huddle_intents_write_failed",
            "The queued huddle command could not be settled.",
          );
        }
        return false;
      }
    });
  };
  const conversationForInput = (
    input: HuddleCommandInput,
  ): ConversationId | undefined => {
    if (input.operation === "start_huddle") return input.conversationId;
    for (const state of Object.values(config.cache.getState().huddles)) {
      if (state.status !== "inactive" && state.huddleSessionId === input.huddleSessionId) {
        return state.conversationId;
      }
    }
    return undefined;
  };
  const authorityDecision = (
    input: HuddleCommandInput,
    state: HuddleSessionState | undefined,
  ): "equal" | "replay" | "conflict" => {
    if (input.operation === "start_huddle") {
      if (state?.status === "inactive" || state === undefined) return "replay";
      return isLive(state) ? "equal" : "conflict";
    }
    if (state === undefined || state.status === "inactive") {
      return input.operation === "leave_huddle" || input.operation === "end_huddle"
        ? "equal"
        : "conflict";
    }
    if (state.huddleSessionId !== input.huddleSessionId) return "conflict";
    if (state.status === "ended") {
      return input.operation === "leave_huddle" || input.operation === "end_huddle"
        ? "equal"
        : "conflict";
    }
    const actorUserId = config.cache.getState().identity?.userId;
    const participant = state.participants.find(({ userId }) => userId === actorUserId);
    if (input.operation === "join_huddle") {
      if (participant?.status === "joined") return "equal";
      return participant?.status === "left" ? "conflict" : "replay";
    }
    if (input.operation === "leave_huddle") {
      return participant?.status === "joined" ? "replay" : "equal";
    }
    if (input.operation === "end_huddle") return "replay";
    if (input.intent === "set") {
      if (state.screenShareOwnerUserId === actorUserId) return "equal";
      return state.screenShareOwnerUserId === null ? "replay" : "conflict";
    }
    if (state.screenShareOwnerUserId === null) return "equal";
    return state.screenShareOwnerUserId === actorUserId ? "replay" : "conflict";
  };
  const markRecovery = (
    conversationId: ConversationId,
    operation: HuddleCommandOperation,
    state: "pending" | "conflict",
  ): void => mutateLocal(conversationId, (localState) => {
    localState.recovery = Object.freeze({ state, operation });
    if (state === "pending") localState.pendingOperation = operation;
    else delete localState.pendingOperation;
  });
  const clearRecovery = (
    conversationId: ConversationId,
    operation: HuddleCommandOperation,
  ): void => mutateLocal(conversationId, (localState) => {
    if (localState.pendingOperation === operation) delete localState.pendingOperation;
    if (localState.recovery?.operation === operation) delete localState.recovery;
  });
  interface AuthoritySettlement {
    readonly promise: Promise<ChatHuddleActionResult>;
    readonly resolve: (result: ChatHuddleActionResult) => void;
  }
  const authoritySettlements = new Map<string, AuthoritySettlement>();
  const authoritySettlementFor = (idempotencyKey: string): AuthoritySettlement => {
    const current = authoritySettlements.get(idempotencyKey);
    if (current !== undefined) return current;
    let resolve!: (result: ChatHuddleActionResult) => void;
    const promise = new Promise<ChatHuddleActionResult>((settle) => {
      resolve = settle;
    });
    const settlement = Object.freeze({ promise, resolve });
    authoritySettlements.set(idempotencyKey, settlement);
    return settlement;
  };
  const settleFromAuthority = (
    idempotencyKey: string,
    result: ChatHuddleActionResult,
  ): void => {
    const settlement = authoritySettlements.get(idempotencyKey);
    if (settlement === undefined) return;
    authoritySettlements.delete(idempotencyKey);
    settlement.resolve(result);
  };
  const recoveryHydrations = new Set<ConversationId>();
  const issuingMediaCommands = new Set<string>();
  let requestRetainedRecovery = (): void => {};

  const unsubscribeCache = config.cache.subscribe(
    (state) => state,
    (next, previous) => {
      const identityChanged = !sameValue(next.identity, previous.identity);
      if (identityChanged) {
        generation += 1;
        pauseRetainedRecovery();
        const actorChanged = next.identity?.tenantId !== previous.identity?.tenantId ||
          next.identity?.userId !== previous.identity?.userId;
        if (actorChanged) retainedIntents = Object.freeze([]);
        authoritySettlements.clear();
        for (const conversationId of [...descriptors.keys()]) {
          clearDescriptor(conversationId);
        }
        if (actorChanged) retries.clear();
      }
      const ids = new Set<ConversationId>([
        ...Object.keys(previous.huddles) as ConversationId[],
        ...Object.keys(next.huddles) as ConversationId[],
        ...local.keys(),
      ]);
      for (const conversationId of ids) {
        if (!identityChanged && previous.huddles[conversationId] === next.huddles[conversationId]) {
          continue;
        }
        const before = viewWithCanonical(
          conversationId,
          previous.huddles[conversationId],
        );
        bump(conversationId);
        const nextCanonical = next.huddles[conversationId];
        const stored = descriptors.get(conversationId);
        if (
          stored !== undefined &&
          (!isLive(nextCanonical) ||
            nextCanonical.huddleSessionId !== stored.huddleSessionId ||
            !needsMediaJoin(conversationId))
        ) {
          clearDescriptor(conversationId);
          localFor(conversationId).media = needsMediaJoin(conversationId)
            ? Object.freeze({ state: "rejoin_required", reason: "session_replaced" })
            : IDLE_MEDIA;
        } else if (stored === undefined && !needsMediaJoin(conversationId)) {
          localFor(conversationId).media = IDLE_MEDIA;
        } else if (stored === undefined && localFor(conversationId).media.state === "idle") {
          localFor(conversationId).media = Object.freeze({
            state: "rejoin_required",
            reason: "not_joined",
          });
        }
        notify(conversationId, before);
      }
      if (!identityChanged && retainedIntents.length > 0) {
        for (const intent of retainedIntents) {
          // A live local join still needs its HTTP credential. A realtime
          // membership update must not settle it early and discard that token.
          if (issuingMediaCommands.has(intent.request.idempotencyKey)) continue;
          const conversationId = conversationForInput(intent.request);
          if (conversationId === undefined || next.huddles[conversationId] === previous.huddles[conversationId]) {
            continue;
          }
          const decision = authorityDecision(intent.request, next.huddles[conversationId]);
          if (decision === "conflict") {
            markRecovery(conversationId, intent.request.operation, "conflict");
            continue;
          }
          if (decision !== "equal") {
            requestRetainedRecovery();
            continue;
          }
          const scope = activeScope();
          void removeRetained(intent.request.idempotencyKey, scope).then((removed) => {
            if (!removed || (scope !== undefined && !scopeIsActive(scope))) return;
            clearRecovery(conversationId, intent.request.operation);
            if (intent.request.operation === "start_huddle" ||
              intent.request.operation === "join_huddle") {
              clearDescriptor(conversationId);
              mutateLocal(conversationId, (localState) => {
                localState.media = Object.freeze({
                  state: "rejoin_required",
                  reason: "not_joined",
                });
              });
            }
            const authoritative = canonical(conversationId);
            if (authoritative !== undefined) {
              settleFromAuthority(intent.request.idempotencyKey, Object.freeze({
                status: "success",
                operation: intent.request.operation,
                state: authoritative,
                applied: false,
                reconciliationStatus: "replayed",
              }));
            }
            requestRetainedRecovery();
          });
        }
      }
    },
  );

  const applyCanonical = (
    conversationId: ConversationId,
    expectedWatermark: number,
    state: HuddleSessionState,
  ): boolean => {
    if ((watermarks.get(conversationId) ?? 0) !== expectedWatermark) return false;
    try {
      config.cache.setHuddleState(state);
      return true;
    } catch {
      return false;
    }
  };

  const shouldKeepDescriptor = (
    conversationId: ConversationId,
    huddleSessionId: HuddleSessionId,
  ): boolean => {
    const state = canonical(conversationId);
    if (!isLive(state) || state.huddleSessionId !== huddleSessionId) return false;
    const identity = config.cache.getState().identity;
    if (identity === null) return false;
    const participant = state.participants.find(
      (candidate) => candidate.userId === identity.userId,
    );
    return participant?.status !== "left";
  };

  const executeCommandInternal = async (
    conversationId: ConversationId,
    input: HuddleCommandInput,
    persisted = false,
    recovered = false,
    signal?: AbortSignal,
  ): Promise<ChatHuddleActionResult> => {
    const operation = input.operation;
    const previousState = canonical(conversationId) ??
      (operation === "start_huddle"
        ? parseHuddleSessionState({ status: "inactive", conversationId })
        : undefined);
    if (previousState === undefined) {
      return errorResult(operation, "validation", COMMAND_FAILURE_MESSAGE, false);
    }
    const requestGeneration = generation;
    const authoritySettlement = authoritySettlementFor(input.idempotencyKey);
    if (!persisted && !(await persistInput(input))) {
      const failure = requestGeneration === generation
        ? errorResult(operation, "transport", COMMAND_FAILURE_MESSAGE, true)
        : errorResult(operation, "closed", COMMAND_FAILURE_MESSAGE, false);
      settleFromAuthority(input.idempotencyKey, failure);
      return failure;
    }
    if (requestGeneration !== generation) {
      const failure = errorResult(operation, "closed", COMMAND_FAILURE_MESSAGE, false);
      settleFromAuthority(input.idempotencyKey, failure);
      return failure;
    }
    const expectedWatermark = bump(conversationId);
    mutateLocal(conversationId, (state) => {
      state.pendingOperation = operation;
      if (recovered) state.recovery = Object.freeze({ state: "pending", operation });
      if (operation === "leave_huddle" || operation === "end_huddle") {
        clearDescriptor(conversationId);
        state.media = IDLE_MEDIA;
      }
    });
    if (config.persistence !== undefined && !config.persistence.isRecoveryReady()) {
      return authoritySettlement.promise;
    }
    const dispatched = config.dispatch(descriptorFor(input, now), input, {
      idempotencyKey: input.idempotencyKey,
      coordinationKey: `huddle:${input.idempotencyKey}`,
      ...(signal === undefined ? {} : { signal }),
    });
    const outcome = await Promise.race([
      dispatched.then((result) => Object.freeze({ source: "http" as const, result })),
      authoritySettlement.promise.then((result) =>
        Object.freeze({ source: "authority" as const, result })),
    ]);
    if (requestGeneration !== generation) {
      const failure = errorResult(operation, "closed", COMMAND_FAILURE_MESSAGE, false);
      settleFromAuthority(input.idempotencyKey, failure);
      return failure;
    }
    if (outcome.source === "authority") return outcome.result;
    const result = outcome.result;
    mutateLocal(conversationId, (state) => {
      if (state.pendingOperation === operation) delete state.pendingOperation;
    });

    if (result.status !== "success") {
      const failure = mapCommandFailure(operation, result);
      const terminal = result.status === "validation" ||
        result.status === "feature_disabled" ||
        result.status === "unsupported" ||
        result.status === "rejected" ||
        (result.status === "authentication" && result.httpStatus === 403);
      if (terminal) {
        await removeRetained(input.idempotencyKey);
        clearRecovery(conversationId, operation);
      } else {
        retries.set(conversationId, { conversationId, input });
        if (result.status === "conflict") markRecovery(conversationId, operation, "conflict");
      }
      if (operation === "start_huddle" || operation === "join_huddle" ||
          operation === "leave_huddle" || operation === "end_huddle") {
        clearDescriptor(conversationId);
        mutateLocal(conversationId, (state) => {
          state.media = Object.freeze({
            state: "error",
            code: failure.code,
            message: failure.message,
            retryable: failure.retryable,
            ...(failure.httpStatus === undefined ? {} : { httpStatus: failure.httpStatus }),
          });
        });
      }
      settleFromAuthority(input.idempotencyKey, failure);
      return failure;
    }

    const command = result.value;
    if (command.outcome === "feature_disabled") {
      if (!sameValue(previousState, command.state)) {
        const failure = errorResult(
          operation,
          "malformed_response",
          COMMAND_FAILURE_MESSAGE,
          true,
        );
        retries.set(conversationId, { conversationId, input });
        clearDescriptor(conversationId);
        mutateLocal(conversationId, (state) => {
          state.media = Object.freeze({
            state: "error",
            code: failure.code,
            message: failure.message,
            retryable: true,
          });
        });
        settleFromAuthority(input.idempotencyKey, failure);
        return failure;
      }
      applyCanonical(conversationId, expectedWatermark, command.state);
      await removeRetained(input.idempotencyKey);
      retries.delete(conversationId);
      clearRecovery(conversationId, operation);
      clearDescriptor(conversationId);
      mutateLocal(conversationId, (state) => {
        state.media = Object.freeze({ state: "unavailable", reason: "feature_disabled" });
      });
      const featureDisabled = Object.freeze({
        status: "feature_disabled",
        operation,
        state: canonical(conversationId) ?? command.state,
        message: HUDDLE_MEDIA_UNAVAILABLE_MESSAGE,
      });
      settleFromAuthority(input.idempotencyKey, featureDisabled);
      return featureDisabled;
    }

    try {
      if (command.reconciliationStatus === "applied") {
        if (input.operation === "start_huddle") {
          validateHuddleStateTransition(previousState, command.state, input, "applied");
        } else {
          // The local snapshot may predate other participants' mutations. Exact
          // one-participant deltas are validated inside the server transaction,
          // not against an asynchronously delivered client snapshot.
          const next = command.state;
          if (next.conversationId !== conversationId ||
              next.huddleSessionId !== input.huddleSessionId) throw new Error("Session mismatch");
          const actor = config.cache.getState().identity?.userId;
          const participant = next.participants.find((value) => value.userId === actor);
          if (input.operation === "join_huddle" &&
              (next.status !== "active" || participant?.status !== "joined")) throw new Error("Join mismatch");
          if (input.operation === "leave_huddle" &&
              (next.status !== "active" || participant?.status !== "left")) throw new Error("Leave mismatch");
          if (input.operation === "end_huddle" && next.status !== "ended") throw new Error("End mismatch");
          if (input.operation === "set_huddle_screen_share" &&
              (next.status !== "active" || next.screenShareOwnerUserId !==
                (input.intent === "set" ? actor : null))) throw new Error("Share mismatch");
        }
      }
    } catch {
      clearDescriptor(conversationId);
      const failure = errorResult(
        operation,
        "malformed_response",
        COMMAND_FAILURE_MESSAGE,
        true,
      );
      retries.set(conversationId, { conversationId, input });
      mutateLocal(conversationId, (state) => {
        state.media = Object.freeze({
          state: "error",
          code: failure.code,
          message: failure.message,
          retryable: true,
        });
      });
      settleFromAuthority(input.idempotencyKey, failure);
      return failure;
    }

    let responseWatermark = expectedWatermark;
    const currentBeforeApply = canonical(conversationId);
    if (command.operation === "join_huddle" && isLive(currentBeforeApply) &&
        currentBeforeApply.huddleSessionId === command.state.huddleSessionId) {
      const joined = command.state.participants.find((value) =>
        value.userId === config.cache.getState().identity?.userId);
      const confirmedAt = Math.max(Date.parse(currentBeforeApply.startedAt),
        ...currentBeforeApply.participants.map((value) => Date.parse(
          value.status === "left" ? value.leftAt : value.joinedAt)));
      // An older leave event may arrive during the new join request. Its
      // watermark must not discard the later, server-confirmed join snapshot.
      if (joined?.status === "joined" && Date.parse(joined.joinedAt) > confirmedAt) {
        responseWatermark = watermarks.get(conversationId) ?? expectedWatermark;
      }
    }
    const applied = applyCanonical(
      conversationId,
      responseWatermark,
      command.state,
    );
    await removeRetained(input.idempotencyKey);
    retries.delete(conversationId);
    clearRecovery(conversationId, operation);
    if (
      !recovered &&
      (command.operation === "start_huddle" || command.operation === "join_huddle") &&
      shouldKeepDescriptor(conversationId, command.state.huddleSessionId)
    ) {
      setDescriptor(
        conversationId,
        command.state.huddleSessionId,
        command.mediaJoin,
      );
    } else if (
      recovered &&
      (command.operation === "start_huddle" || command.operation === "join_huddle") &&
      needsMediaJoin(conversationId)
    ) {
      clearDescriptor(conversationId);
      mutateLocal(conversationId, (state) => {
        state.media = Object.freeze({ state: "rejoin_required", reason: "not_joined" });
      });
    }
    const success = Object.freeze({
      status: "success",
      operation,
      state: canonical(conversationId) ?? command.state,
      applied,
      reconciliationStatus: command.reconciliationStatus,
    });
    settleFromAuthority(input.idempotencyKey, success);
    return success;
  };

  const executeCommand = async (...args: Parameters<typeof executeCommandInternal>): Promise<ChatHuddleActionResult> => {
    const input = args[1];
    const retainsCredential = args[3] !== true && input.operation === "join_huddle" &&
      config.persistence?.isRecoveryReady() !== false;
    if (retainsCredential) issuingMediaCommands.add(input.idempotencyKey);
    try { return await executeCommandInternal(...args); }
    finally { if (retainsCredential) issuingMediaCommands.delete(input.idempotencyKey); }
  };

  const enqueue = (
    conversationId: ConversationId,
    task: () => Promise<ChatHuddleActionResult>,
  ): Promise<ChatHuddleActionResult> => {
    const previous = queues.get(conversationId);
    const promise = previous === undefined
      ? Promise.resolve().then(task)
      : previous.then(task, task);
    const tracked = promise.finally(() => {
      if (queues.get(conversationId) === tracked) queues.delete(conversationId);
    });
    queues.set(conversationId, tracked);
    return tracked;
  };

  const invalidConversation = (
    operation: ChatHuddleActionOperation,
  ): Promise<ChatHuddleActionResult> => Promise.resolve(
    errorResult(operation, "validation", COMMAND_FAILURE_MESSAGE, false),
  );
  const makeInput = (
    conversationId: ConversationId,
    operation: HuddleCommandOperation,
    intent?: HuddleScreenShareIntent,
  ): HuddleCommandInput | undefined => {
    const state = canonical(conversationId);
    const idempotencyKey = generateIdempotencyKey();
    try {
      if (operation === "start_huddle") {
        if (state !== undefined && state.status !== "inactive") return undefined;
        return parseStartHuddleInput({ operation, conversationId, idempotencyKey });
      }
      if (!isLive(state)) return undefined;
      if (operation === "join_huddle") {
        return parseJoinHuddleInput({ operation, huddleSessionId: state.huddleSessionId, idempotencyKey });
      }
      if (operation === "leave_huddle") {
        if (state.status !== "active") return undefined;
        return parseLeaveHuddleInput({ operation, huddleSessionId: state.huddleSessionId, idempotencyKey });
      }
      if (operation === "set_huddle_screen_share") {
        if (state.status !== "active" || (intent !== "set" && intent !== "clear")) return undefined;
        return parseSetHuddleScreenShareInput({
          operation,
          huddleSessionId: state.huddleSessionId,
          intent,
          idempotencyKey,
        });
      }
      return parseEndHuddleInput({ operation, huddleSessionId: state.huddleSessionId, idempotencyKey });
    } catch {
      return undefined;
    }
  };
  const begin = (
    conversationId: ConversationId,
    operation: HuddleCommandOperation,
    intent?: HuddleScreenShareIntent,
  ): Promise<ChatHuddleActionResult> => {
    if (
      !isValidConversationId(conversationId) ||
      config.cache.getState().identity === null
    ) return invalidConversation(operation);
    let input: HuddleCommandInput | undefined;
    try {
      input = makeInput(conversationId, operation, intent);
    } catch {
      input = undefined;
    }
    return input === undefined
      ? invalidConversation(operation)
      : enqueue(conversationId, () => executeCommand(conversationId, input));
  };

  const recoveryGateIsOpen = (): boolean => {
    if (config.persistence === undefined || !config.persistence.isRecoveryReady()) return false;
    try {
      if (config.persistence.network?.isOnline() === false) return false;
      return hostActivity.isActive();
    } catch {
      return false;
    }
  };
  const pauseRetainedRecovery = (): void => {
    retainedController?.abort();
  };
  const runRetainedRecovery = async (): Promise<void> => {
    if (retainedRunning || !recoveryGateIsOpen()) return;
    const scope = activeScope();
    if (scope === undefined || !scopeIsActive(scope)) return;
    const controller = new AbortController();
    retainedController = controller;
    retainedRunning = true;
    let delay = retainedInitialDelayMs;
    try {
      while (!controller.signal.aborted && scopeIsActive(scope) && recoveryGateIsOpen()) {
        const retained = retainedIntents[0];
        if (retained === undefined) return;
        const conversationId = conversationForInput(retained.request);
        if (conversationId === undefined) {
          try {
            await retainedWait(delay, controller.signal);
          } catch {
            return;
          }
          delay = Math.min(retainedMaximumDelayMs, delay * retainedRetryMultiplier);
          continue;
        }
        markRecovery(conversationId, retained.request.operation, "pending");
        recoveryHydrations.add(conversationId);
        let hydrated: ChatHuddleActionResult;
        try {
          hydrated = await runtime.hydrate(conversationId);
        } finally {
          recoveryHydrations.delete(conversationId);
        }
        if (controller.signal.aborted || !scopeIsActive(scope)) return;
        if (hydrated.status === "success") {
          const decision = authorityDecision(retained.request, canonical(conversationId));
          if (decision === "equal") {
            if (await removeRetained(retained.request.idempotencyKey, scope)) {
              clearRecovery(conversationId, retained.request.operation);
              if (retained.request.operation === "start_huddle" ||
                retained.request.operation === "join_huddle") {
                clearDescriptor(conversationId);
                mutateLocal(conversationId, (state) => {
                  state.media = Object.freeze({
                    state: "rejoin_required",
                    reason: "not_joined",
                  });
                });
              }
              delay = retainedInitialDelayMs;
              continue;
            }
          } else if (decision === "conflict") {
            markRecovery(conversationId, retained.request.operation, "conflict");
            return;
          } else {
            const result = await enqueue(conversationId, () => executeCommand(
              conversationId,
              retained.request,
              true,
              true,
              controller.signal,
            ));
            if (controller.signal.aborted || !scopeIsActive(scope)) return;
            if (result.status === "success" || result.status === "feature_disabled") {
              delay = retainedInitialDelayMs;
              continue;
            }
            if (result.code === "conflict") {
              markRecovery(conversationId, retained.request.operation, "conflict");
              return;
            }
          }
        } else if (hydrated.status === "error" && (
          hydrated.code === "validation" ||
          hydrated.code === "feature_disabled" ||
          hydrated.code === "unsupported" ||
          hydrated.httpStatus === 403 ||
          hydrated.httpStatus === 404
        )) {
          if (await removeRetained(retained.request.idempotencyKey, scope)) {
            clearRecovery(conversationId, retained.request.operation);
            delay = retainedInitialDelayMs;
            continue;
          }
        }
        if (!recoveryGateIsOpen()) return;
        try {
          await retainedWait(delay, controller.signal);
        } catch {
          return;
        }
        delay = Math.min(retainedMaximumDelayMs, delay * retainedRetryMultiplier);
      }
    } finally {
      if (retainedController === controller) retainedController = undefined;
      retainedRunning = false;
      if (controller.signal.aborted && retainedIntents.length > 0 && recoveryGateIsOpen()) {
        void Promise.resolve().then(requestRetainedRecovery);
      }
    }
  };
  requestRetainedRecovery = (): void => {
    if (!recoveryGateIsOpen()) return;
    void runRetainedRecovery().catch(() => undefined);
  };
  const onNetworkOnline = (): void => requestRetainedRecovery();
  const onNetworkOffline = (): void => pauseRetainedRecovery();
  const onHostActivityChange = (): void => {
    if (hostActivity.isActive()) requestRetainedRecovery();
    else pauseRetainedRecovery();
  };
  config.persistence?.network?.addEventListener("online", onNetworkOnline);
  config.persistence?.network?.addEventListener("offline", onNetworkOffline);
  hostActivity.addEventListener("visibilitychange", onHostActivityChange);
  hostActivity.addEventListener("focus", onHostActivityChange);
  hostActivity.addEventListener("blur", onHostActivityChange);

  const runtime: ChatHuddleRuntime = {
    getState(conversationId) {
      if (!isValidConversationId(conversationId)) {
        throw new TypeError("Huddle conversation id is invalid");
      }
      return view(conversationId);
    },
    subscribe(conversationId, listener) {
      if (!isValidConversationId(conversationId) || typeof listener !== "function") {
        throw new TypeError("Huddle subscription is invalid");
      }
      let selected = listeners.get(conversationId);
      if (selected === undefined) {
        selected = new Set();
        listeners.set(conversationId, selected);
      }
      selected.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        selected?.delete(listener);
        if (selected?.size === 0) listeners.delete(conversationId);
      };
    },
    hydrate(conversationId) {
      if (
        !isValidConversationId(conversationId) ||
        config.cache.getState().identity === null
      ) return invalidConversation("hydrate");
      const active = hydrations.get(conversationId);
      if (active !== undefined) return active.promise;
      const controller = new AbortController();
      const requestGeneration = generation;
      const expectedWatermark = watermarks.get(conversationId) ?? 0;
      mutateLocal(conversationId, (state) => {
        state.hydrationStatus = "loading";
      });
      const request = (async (): Promise<ChatHuddleActionResult> => {
        let token: string;
        try {
          token = await config.getAccessToken();
          if (typeof token !== "string" || token.trim().length === 0) throw new TypeError();
        } catch {
          return errorResult("hydrate", "authentication", SNAPSHOT_FAILURE_MESSAGE, true);
        }
        let response;
        try {
          response = await config.fetch(
            `${config.endpoint}/conversations/${encodeURIComponent(conversationId)}/huddle`,
            {
              method: "GET",
              headers: Object.freeze({
                accept: "application/json",
                authorization: `Bearer ${token}`,
              }),
              signal: controller.signal,
            },
          );
        } catch {
          return errorResult(
            "hydrate",
            controller.signal.aborted ? "closed" : "transport",
            SNAPSHOT_FAILURE_MESSAGE,
            !controller.signal.aborted,
          );
        }
        if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
          return errorResult("hydrate", "malformed_response", SNAPSHOT_FAILURE_MESSAGE, true);
        }
        if (!response.ok) {
          const code: ChatHuddleErrorCode = response.status === 401 || response.status === 403
            ? "authentication"
            : response.status >= 500
              ? "transport"
              : "rejected";
          return errorResult("hydrate", code, SNAPSHOT_FAILURE_MESSAGE, code !== "rejected", response.status);
        }
        let state: HuddleSessionState;
        try {
          state = parseHuddleSessionState(await response.json());
          if (state.conversationId !== conversationId) throw new TypeError();
        } catch {
          return errorResult("hydrate", "malformed_response", SNAPSHOT_FAILURE_MESSAGE, true, response.status);
        }
        const applied = requestGeneration === generation &&
          (localFor(conversationId).pendingOperation === undefined ||
            recoveryHydrations.has(conversationId)) &&
          applyCanonical(conversationId, expectedWatermark, state);
        return Object.freeze({
          status: "success",
          operation: "hydrate",
          state: canonical(conversationId) ?? state,
          applied,
        });
      })().then((result) => {
        if (requestGeneration !== generation) return result;
        mutateLocal(conversationId, (state) => {
          state.hydrationStatus = result.status === "error" ? "error" : "ready";
          if (result.status === "error") {
            state.media = Object.freeze({
              state: "error",
              code: result.code,
              message: result.message,
              retryable: result.retryable,
              ...(result.httpStatus === undefined ? {} : { httpStatus: result.httpStatus }),
            });
          } else if (state.media.state === "idle" && isLive(canonical(conversationId))) {
            state.media = Object.freeze({ state: "rejoin_required", reason: "not_joined" });
          }
        });
        return result;
      }).finally(() => {
        if (hydrations.get(conversationId)?.promise === request) {
          hydrations.delete(conversationId);
        }
      });
      hydrations.set(conversationId, { controller, promise: request });
      return request;
    },
    start: (conversationId) => begin(conversationId, "start_huddle"),
    join: (conversationId) => begin(conversationId, "join_huddle"),
    leave: (conversationId) => begin(conversationId, "leave_huddle"),
    setScreenShare: (conversationId, intent) =>
      begin(conversationId, "set_huddle_screen_share", intent),
    end: (conversationId) => begin(conversationId, "end_huddle"),
    retry(conversationId) {
      if (!isValidConversationId(conversationId)) return invalidConversation("retry");
      const retry = retries.get(conversationId);
      const retained = retainedIntents.find(
        (intent) => conversationForInput(intent.request) === conversationId,
      );
      if (retry === undefined && retained === undefined) return invalidConversation("retry");
      const input = retry?.input ?? retained!.request;
      return enqueue(conversationId, () => executeCommand(
        conversationId,
        input,
        retained !== undefined,
        retained !== undefined,
      ));
    },
    rejoin: (conversationId) => begin(conversationId, "join_huddle"),
    getMediaJoinDescriptor(conversationId) {
      if (!isValidConversationId(conversationId)) {
        throw new TypeError("Huddle conversation id is invalid");
      }
      const stored = descriptors.get(conversationId);
      if (stored === undefined) return undefined;
      if (Date.parse(stored.value.expiresAt) <= now()) {
        clearDescriptor(conversationId);
        mutateLocal(conversationId, (state) => {
          state.media = needsMediaJoin(conversationId)
            ? Object.freeze({ state: "rejoin_required", reason: "descriptor_expired" })
            : IDLE_MEDIA;
        });
        return undefined;
      }
      return stored.value;
    },
    handleRealtimeState(state) {
      if (state === "connected") {
        requestRetainedRecovery();
        return;
      }
      pauseRetainedRecovery();
      if (state !== "reconnecting" && state !== "offline" && state !== "hydrating_snapshot") {
        return;
      }
      for (const [conversationId] of descriptors) {
        clearDescriptor(conversationId);
        mutateLocal(conversationId, (localState) => {
          localState.media = needsMediaJoin(conversationId)
            ? Object.freeze({ state: "rejoin_required", reason: "realtime_disconnected" })
            : IDLE_MEDIA;
        });
      }
    },
    async activateRetained(scope) {
      await runtime.reloadRetained(scope);
      if (scopeIsActive(scope)) requestRetainedRecovery();
    },
    async reloadRetained(scope, announcement) {
      if (config.persistence === undefined || !scopeIsActive(scope)) return;
      if (announcement !== undefined && announcement.command !== "huddle.command") return;
      pauseRetainedRecovery();
      let record;
      try {
        record = await config.persistence.storage.read(
          scope.identity,
          ApplicationChatStorageRecordKind.queuedHuddleCommandIntents,
        );
      } catch (error) {
        if (!scopeIsActive(scope)) return;
        if (error instanceof ApplicationChatStorageValidationError) {
          reportPersistenceDiagnostic(
            "huddle_intents_rejected",
            "The stored huddle-command intents were rejected and quarantined.",
          );
        } else {
          reportPersistenceDiagnostic(
            "huddle_intents_read_failed",
            "The stored huddle-command intents could not be read.",
          );
        }
        return;
      }
      if (!scopeIsActive(scope)) return;
      retainedIntents = record?.intents ?? Object.freeze([]);
      for (const state of local.values()) {
        if (state.recovery !== undefined) {
          delete state.recovery;
          delete state.pendingOperation;
        }
      }
      for (const intent of retainedIntents) {
        const conversationId = conversationForInput(intent.request);
        if (conversationId !== undefined && localFor(conversationId).recovery === undefined) {
          markRecovery(conversationId, intent.request.operation, "pending");
        }
      }
    },
    announceRetained() {
      for (const intent of retainedIntents) {
        try {
          config.persistence?.onPersistedIntent?.(
            "huddle.command",
            intent.request.idempotencyKey,
          );
        } catch {
          // Coordination announcements cannot alter retained huddle state.
        }
      }
    },
    handleCoordinatedResult(command, idempotencyKey, value) {
      if (command !== "huddle.command") return;
      const intent = retainedIntents.find(
        (candidate) => candidate.request.idempotencyKey === idempotencyKey,
      );
      if (intent === undefined) return;
      const conversationId = conversationForInput(intent.request);
      if (conversationId === undefined) return;
      const failure = parseCoordinatedFailure(value);
      if (failure !== undefined) {
        const mapped = mapCommandFailure(intent.request.operation, failure);
        const terminal = failure.status === "validation" ||
          failure.status === "feature_disabled" ||
          failure.status === "unsupported" ||
          failure.status === "rejected" ||
          (failure.status === "authentication" && failure.httpStatus === 403);
        if (terminal) {
          const scope = activeScope();
          void removeRetained(idempotencyKey, scope).then((removed) => {
            if (removed) clearRecovery(conversationId, intent.request.operation);
          });
        } else if (failure.status === "conflict") {
          markRecovery(conversationId, intent.request.operation, "conflict");
        }
        settleFromAuthority(idempotencyKey, mapped);
        return;
      }
      if (!isAuthorityRefreshResult(value)) return;
      const scope = activeScope();
      if (scope === undefined || !scopeIsActive(scope)) return;
      recoveryHydrations.add(conversationId);
      void runtime.hydrate(conversationId).then(async (hydrated) => {
        if (!scopeIsActive(scope) || hydrated.status !== "success") return;
        const state = canonical(conversationId);
        if (state === undefined) return;
        const decision = authorityDecision(intent.request, state);
        if (decision === "conflict") {
          markRecovery(conversationId, intent.request.operation, "conflict");
          return;
        }
        if (decision !== "equal") return;
        if (!(await removeRetained(idempotencyKey, scope)) || !scopeIsActive(scope)) return;
        clearRecovery(conversationId, intent.request.operation);
        settleFromAuthority(idempotencyKey, Object.freeze({
          status: "success",
          operation: intent.request.operation,
          state,
          applied: hydrated.applied,
          reconciliationStatus: "replayed",
        }));
      }).catch(() => undefined).finally(() => {
        recoveryHydrations.delete(conversationId);
      });
    },
    resumeRetained() {
      requestRetainedRecovery();
    },
    pauseRetained() {
      pauseRetainedRecovery();
    },
    closeActive() {
      generation += 1;
      pauseRetainedRecovery();
      for (const active of hydrations.values()) active.controller.abort();
      hydrations.clear();
      for (const conversationId of [...descriptors.keys()]) {
        clearDescriptor(conversationId);
      }
      retries.clear();
      retainedIntents = Object.freeze([]);
      for (const [idempotencyKey, settlement] of authoritySettlements) {
        authoritySettlements.delete(idempotencyKey);
        settlement.resolve(errorResult(
          "retry",
          "closed",
          COMMAND_FAILURE_MESSAGE,
          false,
        ));
      }
      authoritySettlements.clear();
      queues.clear();
      for (const [conversationId, state] of local) {
        const previous = view(conversationId);
        state.hydrationStatus = "idle";
        state.media = defaultMedia(conversationId);
        delete state.pendingOperation;
        delete state.recovery;
        notify(conversationId, previous);
      }
    },
  };

  // Kept alive for the reusable client lifetime. The cache owns teardown with the client process.
  void unsubscribeCache;
  return Object.freeze(runtime);
}
