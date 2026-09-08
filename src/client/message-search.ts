import {
  normalizeMessageSearchQuery,
  parseMessageSearchRequest,
  parseMessageSearchResponse,
  type MessageSearchCursor,
  type MessageSearchFilters,
  type MessageSearchHit,
  type MessageSearchRequest,
} from "../contracts/message-search.js";
import type {
  ChatClientFetch,
  ChatClientFetchResponse,
} from "./command-dispatcher.js";
import type {
  ChatCacheIdentity,
  NormalizedChatCache,
} from "./normalized-cache.js";

export const DEFAULT_MESSAGE_SEARCH_DEBOUNCE_MS = 250;
export const MAX_MESSAGE_SEARCH_DEBOUNCE_MS = 5_000;

export interface ChatMessageSearchQueryOptions {
  readonly signal?: AbortSignal;
}

export type ChatMessageSearchDiagnosticEvent =
  | "validation_failed"
  | "identity_required"
  | "token_failed"
  | "auth_refresh"
  | "request_failed"
  | "response_rejected"
  | "response_malformed"
  | "completed"
  | "aborted"
  | "closed"
  | "scope_reset";

export interface ChatMessageSearchDiagnostic {
  readonly event: ChatMessageSearchDiagnosticEvent;
  readonly operation: "messages.search";
  readonly attempt: number;
  readonly httpStatus?: number;
}

export interface ChatMessageSearchRuntimeOptions {
  readonly debounceMs?: number;
  /** Returns a cancellation function and is injectable for deterministic tests. */
  readonly schedule?: (task: () => void, delayMs: number) => () => void;
  readonly onDiagnostic?: (diagnostic: ChatMessageSearchDiagnostic) => void;
}

export interface ChatMessageSearchSuccess {
  readonly status: "success";
  readonly value: ChatMessageSearchPage;
}

export interface ChatMessageSearchValidationFailure {
  readonly status: "validation";
  readonly message: "The message search input is invalid.";
}

export interface ChatMessageSearchAuthenticationFailure {
  readonly status: "authentication";
  readonly message: "Chat authentication failed.";
  readonly httpStatus?: number;
}

export interface ChatMessageSearchRejected {
  readonly status: "rejected";
  readonly message: "The chat server rejected the message search request.";
  readonly httpStatus: number;
}

export interface ChatMessageSearchTransportFailure {
  readonly status: "transport";
  readonly message: "The message search request could not be completed.";
  readonly httpStatus?: number;
}

export interface ChatMessageSearchMalformedResponse {
  readonly status: "malformed_response";
  readonly message: "The chat server returned an invalid message search response.";
  readonly httpStatus?: number;
}

export interface ChatMessageSearchAborted {
  readonly status: "aborted";
  readonly message: "The message search request was aborted.";
}

export interface ChatMessageSearchClosed {
  readonly status: "closed";
  readonly message: "The chat client was closed.";
}

export type ChatMessageSearchFailure =
  | ChatMessageSearchValidationFailure
  | ChatMessageSearchAuthenticationFailure
  | ChatMessageSearchRejected
  | ChatMessageSearchTransportFailure
  | ChatMessageSearchMalformedResponse
  | ChatMessageSearchAborted
  | ChatMessageSearchClosed;

export type ChatMessageSearchResult =
  | ChatMessageSearchSuccess
  | ChatMessageSearchFailure;

export interface ChatMessageSearchPage {
  readonly query: string;
  readonly filters?: MessageSearchFilters;
  readonly pageSize: number;
  /** Accumulated, deduplicated hits in server relevance order. */
  readonly hits: readonly MessageSearchHit[];
  readonly nextCursor?: MessageSearchCursor;
}

interface ChatMessageSearchPendingState extends ChatMessageSearchPage {
  readonly state: "scheduled" | "loading";
  readonly cursor?: MessageSearchCursor;
}

export interface ChatMessageSearchSuccessState extends ChatMessageSearchPage {
  readonly state: "success";
}

export interface ChatMessageSearchErrorState extends ChatMessageSearchPage {
  readonly state: "error";
  readonly cursor?: MessageSearchCursor;
  readonly failure: ChatMessageSearchFailure;
}

export interface ChatMessageSearchIdleState {
  readonly state: "idle";
}

export type ChatMessageSearchState =
  | ChatMessageSearchIdleState
  | ChatMessageSearchPendingState
  | ChatMessageSearchSuccessState
  | ChatMessageSearchErrorState;

export type ChatMessageSearchListener = (
  state: ChatMessageSearchState,
  previous: ChatMessageSearchState,
) => void;

export interface CreateChatMessageSearchRuntimeConfig {
  readonly endpoint: string;
  readonly getAccessToken: () => string | Promise<string>;
  readonly fetch: ChatClientFetch;
  readonly cache: NormalizedChatCache;
  readonly options?: ChatMessageSearchRuntimeOptions;
}

export interface ChatMessageSearchRuntime {
  search(
    input: MessageSearchRequest,
    options?: ChatMessageSearchQueryOptions,
  ): Promise<ChatMessageSearchResult>;
  getState(): ChatMessageSearchState;
  subscribe(listener: ChatMessageSearchListener): () => void;
  cancel(): void;
  /** Clears identity-bound pages and aborts work; the runtime remains reusable. */
  resetScope(): void;
  /** Closes current work without making a subsequent client start terminal. */
  closeActive(): void;
}

interface ActiveSearch {
  readonly controller: AbortController;
  readonly generation: number;
  readonly identityKey: string;
  readonly input: MessageSearchRequest;
  readonly scopeKey: string;
  readonly baseHits: readonly MessageSearchHit[];
  readonly baseNextCursor?: MessageSearchCursor;
  readonly promise: Promise<ChatMessageSearchResult>;
  resolve(result: ChatMessageSearchResult): void;
  cancelScheduled: (() => void) | undefined;
  interruption?: "aborted" | "closed";
  settled: boolean;
}

const freeze = <Value extends object>(value: Value): Readonly<Value> =>
  Object.freeze(value);
const EMPTY_HITS = freeze([] as MessageSearchHit[]);
const IDLE_STATE = freeze({ state: "idle" } as const);
const VALIDATION_FAILURE = freeze({
  status: "validation",
  message: "The message search input is invalid.",
} as const);
const AUTHENTICATION_FAILURE = freeze({
  status: "authentication",
  message: "Chat authentication failed.",
} as const);
const ABORTED_RESULT = freeze({
  status: "aborted",
  message: "The message search request was aborted.",
} as const);
const CLOSED_RESULT = freeze({
  status: "closed",
  message: "The chat client was closed.",
} as const);
const ABORTED = Symbol("message-search-aborted");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isAbortSignal = (value: unknown): value is AbortSignal =>
  isRecord(value) &&
  typeof value.aborted === "boolean" &&
  typeof value.addEventListener === "function" &&
  typeof value.removeEventListener === "function";

const exactOptions = (value: unknown): value is ChatMessageSearchQueryOptions =>
  isRecord(value) &&
  Object.keys(value).every((key) => key === "signal") &&
  (value.signal === undefined || isAbortSignal(value.signal));

const defaultSchedule = (task: () => void, delayMs: number): (() => void) => {
  const handle = globalThis.setTimeout(task, delayMs);
  return () => globalThis.clearTimeout(handle);
};

const identityKey = (identity: ChatCacheIdentity | null): string | undefined =>
  identity === null
    ? undefined
    : JSON.stringify([identity.tenantId, identity.userId, identity.sessionId]);

const raceWithAbort = <Value>(
  promise: Promise<Value>,
  signal: AbortSignal,
): Promise<Value> => {
  if (signal.aborted) return Promise.reject(ABORTED);
  return new Promise<Value>((resolve, reject) => {
    const abort = () => reject(ABORTED);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
};

const immutableFilters = (
  filters: MessageSearchFilters | undefined,
): MessageSearchFilters | undefined => filters === undefined
  ? undefined
  : freeze({
      ...(filters.conversationIds === undefined
        ? {}
        : { conversationIds: freeze([...filters.conversationIds]) }),
      ...(filters.authorUserIds === undefined
        ? {}
        : { authorUserIds: freeze([...filters.authorUserIds]) }),
      ...(filters.sentAfter === undefined ? {} : { sentAfter: filters.sentAfter }),
      ...(filters.sentBefore === undefined ? {} : { sentBefore: filters.sentBefore }),
    });

const immutableRequest = (request: MessageSearchRequest): MessageSearchRequest => {
  const filters = request.filters === undefined
    ? undefined
    : immutableFilters(request.filters) as MessageSearchFilters;
  return freeze({
    query: request.query,
    pageSize: request.pageSize,
    ...(filters === undefined ? {} : { filters }),
    ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
  });
};

const immutableHit = (hit: MessageSearchHit): MessageSearchHit => hit.type === "conversation"
  ? freeze({
      type: "conversation",
      conversationId: hit.conversationId,
      ...(hit.title === undefined ? {} : { title: hit.title }),
      snippet: hit.snippet,
    })
  : freeze({
      type: "message",
      conversationId: hit.conversationId,
      messageId: hit.messageId,
      ...(hit.title === undefined ? {} : { title: hit.title }),
      snippet: hit.snippet,
      ...(hit.authorUserId === undefined ? {} : { authorUserId: hit.authorUserId }),
      ...(hit.authorDisplayName === undefined
        ? {}
        : { authorDisplayName: hit.authorDisplayName }),
      ...(hit.sentAt === undefined ? {} : { sentAt: hit.sentAt }),
    });

const immutableHits = (
  hits: readonly MessageSearchHit[],
): readonly MessageSearchHit[] => freeze(hits.map(immutableHit));

const hitIdentity = (hit: MessageSearchHit): string => hit.type === "conversation"
  ? `conversation:${hit.conversationId}`
  : `message:${hit.messageId}`;

const mergeHits = (
  previous: readonly MessageSearchHit[],
  page: readonly MessageSearchHit[],
): readonly MessageSearchHit[] => {
  const identities = new Set(previous.map(hitIdentity));
  const merged = [...previous];
  for (const hit of page) {
    const key = hitIdentity(hit);
    if (identities.has(key)) continue;
    identities.add(key);
    merged.push(hit);
  }
  return freeze(merged);
};

const scopeKey = (request: MessageSearchRequest): string => JSON.stringify([
  request.query,
  request.filters ?? null,
  request.pageSize,
]);

const interruptedResult = (
  active: ActiveSearch,
): ChatMessageSearchAborted | ChatMessageSearchClosed =>
  active.interruption === "closed" ? CLOSED_RESULT : ABORTED_RESULT;

const malformedResponse = (
  httpStatus?: number,
): ChatMessageSearchMalformedResponse => freeze({
  status: "malformed_response",
  message: "The chat server returned an invalid message search response.",
  ...(httpStatus === undefined ? {} : { httpStatus }),
});

const transportFailure = (
  httpStatus?: number,
): ChatMessageSearchTransportFailure => freeze({
  status: "transport",
  message: "The message search request could not be completed.",
  ...(httpStatus === undefined ? {} : { httpStatus }),
});

/** Creates an authorized, transient, identity-scoped browser message-search runtime. */
export function createChatMessageSearchRuntime(
  config: CreateChatMessageSearchRuntimeConfig,
): ChatMessageSearchRuntime {
  if (!isRecord(config) || typeof config.endpoint !== "string" ||
      typeof config.getAccessToken !== "function" || typeof config.fetch !== "function" ||
      !isRecord(config.cache)) {
    throw new TypeError("Invalid message search runtime configuration");
  }
  const rawOptions: unknown = config.options;
  if (rawOptions !== undefined && (!isRecord(rawOptions) ||
      (rawOptions.debounceMs !== undefined &&
        (!Number.isSafeInteger(rawOptions.debounceMs) ||
          (rawOptions.debounceMs as number) < 0 ||
          (rawOptions.debounceMs as number) > MAX_MESSAGE_SEARCH_DEBOUNCE_MS)) ||
      (rawOptions.schedule !== undefined && typeof rawOptions.schedule !== "function") ||
      (rawOptions.onDiagnostic !== undefined && typeof rawOptions.onDiagnostic !== "function"))) {
    throw new TypeError("messageSearch options are invalid");
  }
  const options = config.options;
  const debounceMs = options?.debounceMs ?? DEFAULT_MESSAGE_SEARCH_DEBOUNCE_MS;
  const schedule = options?.schedule ?? defaultSchedule;
  const onDiagnostic = options?.onDiagnostic;
  const listeners = new Set<ChatMessageSearchListener>();
  let state: ChatMessageSearchState = IDLE_STATE;
  let generation = 0;
  let activeIdentityKey = identityKey(config.cache.getState().identity);
  let current: ActiveSearch | undefined;
  let currentScopeKey: string | undefined;

  const diagnose = (diagnostic: ChatMessageSearchDiagnostic): void => {
    try {
      onDiagnostic?.(freeze(diagnostic));
    } catch {
      // Diagnostics cannot alter transport and never receive thrown values or bodies.
    }
  };

  const setState = (next: ChatMessageSearchState): void => {
    const previous = state;
    if (next === previous) return;
    state = next;
    for (const listener of [...listeners]) {
      try {
        listener(next, previous);
      } catch {
        // Observers cannot alter identity-scoped state.
      }
    }
  };

  const stillCurrent = (active: ActiveSearch): boolean =>
    current === active && active.generation === generation &&
    active.identityKey === activeIdentityKey && !active.controller.signal.aborted;

  const runHttp = async (active: ActiveSearch): Promise<ChatMessageSearchResult | {
    readonly status: "decoded";
    readonly value: unknown;
    readonly httpStatus: number;
  }> => {
    let token = "";
    let attempt = 0;
    const obtainToken = async (): Promise<boolean> => {
      try {
        const value = await raceWithAbort(
          Promise.resolve().then(config.getAccessToken),
          active.controller.signal,
        );
        if (typeof value !== "string" || value.trim().length === 0) {
          throw new TypeError("Invalid access token");
        }
        token = value;
        return true;
      } catch {
        if (!active.controller.signal.aborted) {
          diagnose({ event: "token_failed", operation: "messages.search", attempt });
        }
        return false;
      }
    };

    if (!(await obtainToken())) {
      return active.controller.signal.aborted
        ? interruptedResult(active)
        : AUTHENTICATION_FAILURE;
    }
    for (let refreshes = 0; refreshes <= 1; refreshes += 1) {
      attempt += 1;
      let response: ChatClientFetchResponse;
      try {
        response = await raceWithAbort(config.fetch(`${config.endpoint}/messages/search`, {
          method: "POST",
          headers: freeze({
            accept: "application/json",
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          }),
          signal: active.controller.signal,
          body: JSON.stringify(active.input),
        }), active.controller.signal);
      } catch {
        if (active.controller.signal.aborted) return interruptedResult(active);
        diagnose({ event: "request_failed", operation: "messages.search", attempt });
        return transportFailure();
      }
      if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
        diagnose({ event: "response_malformed", operation: "messages.search", attempt });
        return malformedResponse();
      }
      if (!response.ok && response.status === 401 && refreshes === 0) {
        diagnose({
          event: "auth_refresh",
          operation: "messages.search",
          attempt,
          httpStatus: response.status,
        });
        if (await obtainToken()) continue;
        return active.controller.signal.aborted
          ? interruptedResult(active)
          : freeze({ ...AUTHENTICATION_FAILURE, httpStatus: response.status });
      }
      if (!response.ok) {
        diagnose({
          event: "response_rejected",
          operation: "messages.search",
          attempt,
          httpStatus: response.status,
        });
        if (response.status === 401 || response.status === 403) {
          return freeze({ ...AUTHENTICATION_FAILURE, httpStatus: response.status });
        }
        if (response.status >= 400 && response.status < 500) {
          return freeze({
            status: "rejected",
            message: "The chat server rejected the message search request.",
            httpStatus: response.status,
          } as const);
        }
        return transportFailure(response.status);
      }
      try {
        return freeze({
          status: "decoded",
          value: await raceWithAbort(response.json(), active.controller.signal),
          httpStatus: response.status,
        } as const);
      } catch {
        if (active.controller.signal.aborted) return interruptedResult(active);
        diagnose({
          event: "response_malformed",
          operation: "messages.search",
          attempt,
          httpStatus: response.status,
        });
        return malformedResponse(response.status);
      }
    }
    return transportFailure();
  };

  const settle = (active: ActiveSearch, result: ChatMessageSearchResult): void => {
    if (active.settled) return;
    const isCurrent = stillCurrent(active);
    active.settled = true;
    active.cancelScheduled?.();
    active.cancelScheduled = undefined;
    if (current === active) current = undefined;
    if (isCurrent) {
      if (result.status === "success") {
        currentScopeKey = active.scopeKey;
        setState(freeze({ state: "success", ...result.value }));
      } else if (result.status !== "aborted" && result.status !== "closed") {
        setState(freeze({
          state: "error",
          query: active.input.query,
          ...(active.input.filters === undefined ? {} : { filters: active.input.filters }),
          pageSize: active.input.pageSize,
          hits: active.baseHits,
          ...(active.baseNextCursor === undefined
            ? {}
            : { nextCursor: active.baseNextCursor }),
          ...(active.input.cursor === undefined ? {} : { cursor: active.input.cursor }),
          failure: result,
        }));
      }
    }
    active.resolve(result);
  };

  const cancelActive = (closed: boolean): void => {
    const active = current;
    if (active === undefined || active.settled) return;
    active.interruption = closed ? "closed" : "aborted";
    active.controller.abort();
    settle(active, closed ? CLOSED_RESULT : ABORTED_RESULT);
  };

  const run = async (active: ActiveSearch): Promise<void> => {
    if (active.settled || active.controller.signal.aborted) return;
    setState(freeze({
      state: "loading",
      query: active.input.query,
      ...(active.input.filters === undefined ? {} : { filters: active.input.filters }),
      pageSize: active.input.pageSize,
      hits: active.baseHits,
      ...(active.baseNextCursor === undefined ? {} : { nextCursor: active.baseNextCursor }),
      ...(active.input.cursor === undefined ? {} : { cursor: active.input.cursor }),
    }));
    const response = await runHttp(active);
    if (response.status !== "decoded") {
      settle(active, response);
      return;
    }
    try {
      const parsed = parseMessageSearchResponse(response.value);
      if (parsed.hits.length > active.input.pageSize) {
        throw new TypeError("Message search response exceeds requested page size");
      }
      const pageHits = immutableHits(parsed.hits);
      if (!stillCurrent(active)) {
        settle(active, interruptedResult(active));
        return;
      }
      const page = freeze({
        query: active.input.query,
        ...(active.input.filters === undefined ? {} : { filters: active.input.filters }),
        pageSize: active.input.pageSize,
        hits: mergeHits(active.baseHits, pageHits),
        ...(parsed.nextCursor === undefined ? {} : { nextCursor: parsed.nextCursor }),
      });
      diagnose({ event: "completed", operation: "messages.search", attempt: 1 });
      settle(active, freeze({ status: "success", value: page }));
    } catch {
      diagnose({ event: "response_malformed", operation: "messages.search", attempt: 1 });
      settle(active, malformedResponse(response.httpStatus));
    }
  };

  const createSearch = (
    input: MessageSearchRequest,
    key: string,
  ): ActiveSearch => {
    const previous = state;
    const previousPage = previous.state === "idle" ? undefined : previous;
    const canAccumulate = input.cursor !== undefined && currentScopeKey === key &&
      previousPage?.nextCursor === input.cursor;
    const baseHits = canAccumulate && previousPage !== undefined
      ? previousPage.hits
      : EMPTY_HITS;
    const baseNextCursor = canAccumulate && previousPage !== undefined
      ? previousPage.nextCursor
      : undefined;
    let resolve!: (result: ChatMessageSearchResult) => void;
    const promise = new Promise<ChatMessageSearchResult>((complete) => { resolve = complete; });
    const active: ActiveSearch = {
      controller: new AbortController(),
      generation,
      identityKey: activeIdentityKey as string,
      input,
      scopeKey: key,
      baseHits,
      ...(baseNextCursor === undefined ? {} : { baseNextCursor }),
      promise,
      resolve,
      cancelScheduled: undefined,
      settled: false,
    };
    current = active;
    if (!canAccumulate) currentScopeKey = undefined;
    setState(freeze({
      state: "scheduled",
      query: input.query,
      ...(input.filters === undefined ? {} : { filters: input.filters }),
      pageSize: input.pageSize,
      hits: baseHits,
      ...(baseNextCursor === undefined ? {} : { nextCursor: baseNextCursor }),
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    }));
    try {
      active.cancelScheduled = schedule(
        () => { void run(active); },
        input.cursor === undefined ? debounceMs : 0,
      );
      if (typeof active.cancelScheduled !== "function") {
        throw new TypeError("messageSearch.schedule must return a cancellation function");
      }
    } catch {
      settle(active, transportFailure());
    }
    return active;
  };

  const clearScope = (closed: boolean): void => {
    generation += 1;
    cancelActive(closed);
    currentScopeKey = undefined;
    setState(IDLE_STATE);
    diagnose({
      event: closed ? "closed" : "scope_reset",
      operation: "messages.search",
      attempt: 0,
    });
  };

  config.cache.subscribe(
    (cacheState) => identityKey(cacheState.identity),
    (nextKey) => {
      if (nextKey === activeIdentityKey) return;
      clearScope(false);
      activeIdentityKey = nextKey;
    },
  );

  return freeze({
    search(input, queryOptions = {}) {
      if (!exactOptions(queryOptions)) {
        diagnose({ event: "validation_failed", operation: "messages.search", attempt: 0 });
        return Promise.resolve(VALIDATION_FAILURE);
      }
      if (queryOptions.signal?.aborted === true) return Promise.resolve(ABORTED_RESULT);
      if (isRecord(input) && typeof input.query === "string" &&
          normalizeMessageSearchQuery(input.query).length === 0) {
        cancelActive(false);
        currentScopeKey = undefined;
        setState(IDLE_STATE);
        return Promise.resolve(freeze({
          status: "success",
          value: freeze({ query: "", pageSize: 1, hits: EMPTY_HITS }),
        }));
      }
      let validated: MessageSearchRequest;
      try {
        validated = immutableRequest(parseMessageSearchRequest(input));
      } catch {
        diagnose({ event: "validation_failed", operation: "messages.search", attempt: 0 });
        return Promise.resolve(VALIDATION_FAILURE);
      }
      if (activeIdentityKey === undefined) {
        diagnose({ event: "identity_required", operation: "messages.search", attempt: 0 });
        return Promise.resolve(AUTHENTICATION_FAILURE);
      }
      cancelActive(false);
      const active = createSearch(validated, scopeKey(validated));
      if (queryOptions.signal !== undefined) {
        const abort = () => {
          if (current !== active || active.settled) return;
          diagnose({ event: "aborted", operation: "messages.search", attempt: 0 });
          cancelActive(false);
          currentScopeKey = undefined;
          setState(IDLE_STATE);
        };
        queryOptions.signal.addEventListener("abort", abort, { once: true });
        active.promise.finally(() => queryOptions.signal?.removeEventListener("abort", abort));
      }
      return active.promise;
    },
    getState: () => state,
    subscribe(listener) {
      if (typeof listener !== "function") {
        throw new TypeError("Message search listener must be a function");
      }
      listeners.add(listener);
      let subscribed = true;
      return () => {
        if (!subscribed) return;
        subscribed = false;
        listeners.delete(listener);
      };
    },
    cancel() {
      cancelActive(false);
      currentScopeKey = undefined;
      setState(IDLE_STATE);
    },
    resetScope() {
      clearScope(false);
      activeIdentityKey = identityKey(config.cache.getState().identity);
    },
    closeActive() {
      clearScope(true);
      activeIdentityKey = identityKey(config.cache.getState().identity);
    },
  });
}
