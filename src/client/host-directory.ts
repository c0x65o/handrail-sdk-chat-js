import {
  MAX_HOST_DIRECTORY_BATCH_SIZE,
  decodeHostDirectorySearchCursor,
  parseHostDirectoryBatchLookupInput,
  parseHostDirectoryBatchLookupResult,
  parseHostDirectorySearchInput,
  parseHostDirectorySearchResult,
  type HostDirectorySearchCursor,
  type HostDirectorySearchInput,
  type HostDirectoryUserSummary,
} from "../contracts/host-directory-snapshot.js";
import type { UserId } from "../contracts/identifiers.js";
import type {
  ChatClientFetch,
  ChatClientFetchResponse,
} from "./command-dispatcher.js";
import type {
  ChatCacheIdentity,
  NormalizedChatCache,
} from "./normalized-cache.js";

export const DEFAULT_HOST_DIRECTORY_CACHE_TTL_MS = 5 * 60_000;
export const MIN_HOST_DIRECTORY_CACHE_TTL_MS = 1_000;
export const MAX_HOST_DIRECTORY_CACHE_TTL_MS = 60 * 60_000;
export const DEFAULT_HOST_DIRECTORY_SEARCH_DEBOUNCE_MS = 250;
export const MAX_HOST_DIRECTORY_SEARCH_DEBOUNCE_MS = 5_000;

export interface ChatHostDirectoryQueryOptions {
  readonly signal?: AbortSignal;
}

export type ChatHostDirectoryDiagnosticEvent =
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

export interface ChatHostDirectoryDiagnostic {
  readonly event: ChatHostDirectoryDiagnosticEvent;
  readonly operation: "directory.batch" | "directory.search";
  readonly attempt: number;
  readonly httpStatus?: number;
}

export interface ChatHostDirectoryRuntimeOptions {
  /** Applies to active, redacted, missing, and temporarily-unavailable projections. */
  readonly cacheTtlMs?: number;
  readonly searchDebounceMs?: number;
  readonly now?: () => number;
  /** Returns a cancellation function and is injectable for deterministic tests. */
  readonly schedule?: (task: () => void, delayMs: number) => () => void;
  readonly onDiagnostic?: (diagnostic: ChatHostDirectoryDiagnostic) => void;
}

export interface ChatHostDirectorySuccess<Value> {
  readonly status: "success";
  readonly value: Value;
}

export interface ChatHostDirectoryValidationFailure {
  readonly status: "validation";
  readonly message: "The directory request input is invalid.";
}

export interface ChatHostDirectoryAuthenticationFailure {
  readonly status: "authentication";
  readonly message: "Chat authentication failed.";
  readonly httpStatus?: number;
}

export interface ChatHostDirectoryRejected {
  readonly status: "rejected";
  readonly message: "The chat server rejected the directory request.";
  readonly httpStatus: number;
}

export interface ChatHostDirectoryTransportFailure {
  readonly status: "transport";
  readonly message: "The chat directory request could not be completed.";
  readonly httpStatus?: number;
}

export interface ChatHostDirectoryMalformedResponse {
  readonly status: "malformed_response";
  readonly message: "The chat server returned an invalid directory response.";
  readonly httpStatus?: number;
}

export interface ChatHostDirectoryAborted {
  readonly status: "aborted";
  readonly message: "The directory request was aborted.";
}

export interface ChatHostDirectoryClosed {
  readonly status: "closed";
  readonly message: "The chat client was closed.";
}

export type ChatHostDirectoryFailure =
  | ChatHostDirectoryValidationFailure
  | ChatHostDirectoryAuthenticationFailure
  | ChatHostDirectoryRejected
  | ChatHostDirectoryTransportFailure
  | ChatHostDirectoryMalformedResponse
  | ChatHostDirectoryAborted
  | ChatHostDirectoryClosed;

export type ChatHostDirectoryResult<Value> =
  | ChatHostDirectorySuccess<Value>
  | ChatHostDirectoryFailure;

export interface ChatHostDirectoryHydration {
  /** Deduplicated projections in first-requested order. */
  readonly users: readonly HostDirectoryUserSummary[];
}

export interface ChatHostDirectorySearchPage {
  readonly query: string;
  readonly users: readonly HostDirectoryUserSummary[];
  readonly nextCursor?: HostDirectorySearchCursor;
}

export interface ChatHostDirectorySearchIdleState {
  readonly state: "idle";
}

export interface ChatHostDirectorySearchPendingState {
  readonly state: "scheduled" | "loading";
  readonly query: string;
  readonly cursor?: HostDirectorySearchCursor;
}

export interface ChatHostDirectorySearchSuccessState
  extends ChatHostDirectorySearchPage {
  readonly state: "success";
}

export interface ChatHostDirectorySearchErrorState {
  readonly state: "error";
  readonly query: string;
  readonly cursor?: HostDirectorySearchCursor;
  readonly failure: ChatHostDirectoryFailure;
}

export type ChatHostDirectorySearchState =
  | ChatHostDirectorySearchIdleState
  | ChatHostDirectorySearchPendingState
  | ChatHostDirectorySearchSuccessState
  | ChatHostDirectorySearchErrorState;

export type ChatHostDirectorySearchListener = (
  state: ChatHostDirectorySearchState,
  previous: ChatHostDirectorySearchState,
) => void;

export interface CreateChatHostDirectoryRuntimeConfig {
  readonly endpoint: string;
  readonly getAccessToken: () => string | Promise<string>;
  readonly fetch: ChatClientFetch;
  readonly cache: NormalizedChatCache;
  readonly options?: ChatHostDirectoryRuntimeOptions;
}

interface CacheEntry {
  readonly value: HostDirectoryUserSummary;
  readonly expiresAt: number;
}

interface ActiveRequest {
  readonly controller: AbortController;
  readonly generation: number;
  readonly identityKey: string;
  interruption?: "aborted" | "closed";
}

interface ActiveBatch extends ActiveRequest {
  readonly ids: readonly UserId[];
  readonly consumers: Set<symbol>;
  promise: Promise<ChatHostDirectoryResult<readonly HostDirectoryUserSummary[]>>;
  settled: boolean;
}

interface ActiveSearch extends ActiveRequest {
  readonly input: HostDirectorySearchInput;
  readonly key: string;
  readonly consumers: Set<symbol>;
  readonly promise: Promise<ChatHostDirectoryResult<ChatHostDirectorySearchPage>>;
  resolve(result: ChatHostDirectoryResult<ChatHostDirectorySearchPage>): void;
  cancelScheduled: (() => void) | undefined;
  settled: boolean;
}

export interface ChatHostDirectoryRuntime {
  hydrateVisibleUsers(
    userIds: readonly UserId[],
    options?: ChatHostDirectoryQueryOptions,
  ): Promise<ChatHostDirectoryResult<ChatHostDirectoryHydration>>;
  /** Returns only a validated immutable shared-contract projection, or undefined. */
  selectUser(userId: UserId): HostDirectoryUserSummary | undefined;
  search(
    input: HostDirectorySearchInput,
    options?: ChatHostDirectoryQueryOptions,
  ): Promise<ChatHostDirectoryResult<ChatHostDirectorySearchPage>>;
  getSearchState(): ChatHostDirectorySearchState;
  subscribeSearch(listener: ChatHostDirectorySearchListener): () => void;
  cancelSearch(): void;
  /** Clears identity-bound memory and aborts work; the runtime remains reusable. */
  resetScope(): void;
  /** Closes current work without making a subsequent client start terminal. */
  closeActive(): void;
}

const freeze = <Value extends object>(value: Value): Readonly<Value> =>
  Object.freeze(value);
const IDLE_SEARCH_STATE = freeze({ state: "idle" } as const);
const VALIDATION_FAILURE = freeze({
  status: "validation",
  message: "The directory request input is invalid.",
} as const);
const AUTHENTICATION_FAILURE = freeze({
  status: "authentication",
  message: "Chat authentication failed.",
} as const);
const ABORTED_RESULT = freeze({
  status: "aborted",
  message: "The directory request was aborted.",
} as const);
const CLOSED_RESULT = freeze({
  status: "closed",
  message: "The chat client was closed.",
} as const);
const ABORTED = Symbol("host-directory-aborted");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isAbortSignal = (value: unknown): value is AbortSignal =>
  isRecord(value) &&
  typeof value.aborted === "boolean" &&
  typeof value.addEventListener === "function" &&
  typeof value.removeEventListener === "function";

const exactOptions = (value: unknown): value is ChatHostDirectoryQueryOptions =>
  isRecord(value) &&
  Object.keys(value).every((key) => key === "signal") &&
  (value.signal === undefined || isAbortSignal(value.signal));

const normalizeBoundedInteger = (
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number => {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
};

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

/** Copies and freezes only fields admitted by the strict shared parser. */
const immutableSummary = (
  value: HostDirectoryUserSummary,
): HostDirectoryUserSummary => {
  if (value.kind === "redacted") {
    return freeze({ kind: "redacted", userId: value.userId });
  }
  if (value.kind === "unavailable") {
    return freeze({ kind: "unavailable", userId: value.userId, reason: value.reason });
  }
  const avatar = value.avatar.kind === "none"
    ? freeze({ kind: "none" } as const)
    : value.avatar.kind === "initials"
      ? freeze({ kind: "initials", initials: value.avatar.initials } as const)
      : freeze({
          kind: "image",
          url: value.avatar.url,
          ...(value.avatar.altText === undefined ? {} : { altText: value.avatar.altText }),
        } as const);
  const status = value.status === undefined
    ? undefined
    : freeze({
        ...(value.status.availability === undefined ? {} : { availability: value.status.availability }),
        ...(value.status.text === undefined ? {} : { text: value.status.text }),
        ...(value.status.emoji === undefined ? {} : { emoji: value.status.emoji }),
        ...(value.status.expiresAt === undefined ? {} : { expiresAt: value.status.expiresAt }),
      });
  return freeze({
    kind: "active",
    userId: value.userId,
    displayName: value.displayName,
    avatar,
    ...(status === undefined ? {} : { status }),
  });
};

const immutableUsers = (
  users: readonly HostDirectoryUserSummary[],
): readonly HostDirectoryUserSummary[] =>
  freeze(users.map(immutableSummary));

const interruptedResult = (
  active: ActiveRequest,
): ChatHostDirectoryAborted | ChatHostDirectoryClosed =>
  active.interruption === "closed" ? CLOSED_RESULT : ABORTED_RESULT;

const malformedResponse = (
  httpStatus?: number,
): ChatHostDirectoryMalformedResponse => freeze({
  status: "malformed_response",
  message: "The chat server returned an invalid directory response.",
  ...(httpStatus === undefined ? {} : { httpStatus }),
});

const transportFailure = (
  httpStatus?: number,
): ChatHostDirectoryTransportFailure => freeze({
  status: "transport",
  message: "The chat directory request could not be completed.",
  ...(httpStatus === undefined ? {} : { httpStatus }),
});

/** Creates the browser-safe identity-scoped directory cache and HTTP runtime. */
export function createChatHostDirectoryRuntime(
  config: CreateChatHostDirectoryRuntimeConfig,
): ChatHostDirectoryRuntime {
  if (!isRecord(config) || typeof config.endpoint !== "string" ||
      typeof config.getAccessToken !== "function" || typeof config.fetch !== "function" ||
      !isRecord(config.cache)) {
    throw new TypeError("Invalid host directory runtime configuration");
  }
  const options: ChatHostDirectoryRuntimeOptions | undefined = config.options;
  if (options !== undefined && (!isRecord(options) ||
      (options.now !== undefined && typeof options.now !== "function") ||
      (options.schedule !== undefined && typeof options.schedule !== "function") ||
      (options.onDiagnostic !== undefined && typeof options.onDiagnostic !== "function"))) {
    throw new TypeError("directory options are invalid");
  }
  const cacheTtlMs = normalizeBoundedInteger(
    options?.cacheTtlMs,
    DEFAULT_HOST_DIRECTORY_CACHE_TTL_MS,
    MIN_HOST_DIRECTORY_CACHE_TTL_MS,
    MAX_HOST_DIRECTORY_CACHE_TTL_MS,
    "directory.cacheTtlMs",
  );
  const searchDebounceMs = normalizeBoundedInteger(
    options?.searchDebounceMs,
    DEFAULT_HOST_DIRECTORY_SEARCH_DEBOUNCE_MS,
    0,
    MAX_HOST_DIRECTORY_SEARCH_DEBOUNCE_MS,
    "directory.searchDebounceMs",
  );
  const now = (options?.now as (() => number) | undefined) ?? Date.now;
  const schedule = (options?.schedule as
    | ((task: () => void, delayMs: number) => () => void)
    | undefined) ?? defaultSchedule;
  const onDiagnostic = options?.onDiagnostic as
    | ((diagnostic: ChatHostDirectoryDiagnostic) => void)
    | undefined;
  const entries = new Map<UserId, CacheEntry>();
  const activeById = new Map<UserId, ActiveBatch>();
  const searchListeners = new Set<ChatHostDirectorySearchListener>();
  let generation = 0;
  let activeIdentityKey = identityKey(config.cache.getState().identity);
  let currentSearch: ActiveSearch | undefined;
  let searchState: ChatHostDirectorySearchState = IDLE_SEARCH_STATE;

  const diagnose = (diagnostic: ChatHostDirectoryDiagnostic): void => {
    try {
      onDiagnostic?.(freeze(diagnostic));
    } catch {
      // Diagnostics cannot alter transport and never receive thrown values or bodies.
    }
  };

  const setSearchState = (next: ChatHostDirectorySearchState): void => {
    const previous = searchState;
    if (previous === next) return;
    searchState = next;
    for (const listener of [...searchListeners]) {
      try {
        listener(next, previous);
      } catch {
        // Search observers cannot alter identity-bound state.
      }
    }
  };

  const readNow = (): number => {
    const value = now();
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError("directory.now returned an invalid time");
    }
    return value;
  };

  const stillCurrent = (active: ActiveRequest): boolean =>
    active.generation === generation &&
    active.identityKey === activeIdentityKey &&
    !active.controller.signal.aborted;

  const runHttp = async (
    operation: ChatHostDirectoryDiagnostic["operation"],
    active: ActiveRequest,
    method: "GET" | "POST",
    url: string,
    body?: string,
  ): Promise<ChatHostDirectoryResult<unknown>> => {
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
          diagnose({ event: "token_failed", operation, attempt });
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
        response = await raceWithAbort(config.fetch(url, {
          method,
          headers: freeze({
            accept: "application/json",
            authorization: `Bearer ${token}`,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          }),
          signal: active.controller.signal,
          ...(body === undefined ? {} : { body }),
        }), active.controller.signal);
      } catch {
        if (active.controller.signal.aborted) return interruptedResult(active);
        diagnose({ event: "request_failed", operation, attempt });
        return transportFailure();
      }
      if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
        diagnose({ event: "response_malformed", operation, attempt });
        return malformedResponse();
      }
      if (!response.ok && response.status === 401 && refreshes === 0) {
        diagnose({ event: "auth_refresh", operation, attempt, httpStatus: response.status });
        if (await obtainToken()) continue;
        return active.controller.signal.aborted
          ? interruptedResult(active)
          : freeze({ ...AUTHENTICATION_FAILURE, httpStatus: response.status });
      }
      if (!response.ok) {
        diagnose({ event: "response_rejected", operation, attempt, httpStatus: response.status });
        if (response.status === 401 || response.status === 403) {
          return freeze({ ...AUTHENTICATION_FAILURE, httpStatus: response.status });
        }
        if (response.status >= 400 && response.status < 500) {
          return freeze({
            status: "rejected",
            message: "The chat server rejected the directory request.",
            httpStatus: response.status,
          } as const);
        }
        return transportFailure(response.status);
      }
      try {
        const decoded = await raceWithAbort(response.json(), active.controller.signal);
        return freeze({ status: "success", value: decoded });
      } catch {
        if (active.controller.signal.aborted) return interruptedResult(active);
        diagnose({ event: "response_malformed", operation, attempt, httpStatus: response.status });
        return malformedResponse(response.status);
      }
    }
    return transportFailure();
  };

  const storeUsers = (
    active: ActiveRequest,
    users: readonly HostDirectoryUserSummary[],
  ): boolean => {
    if (!stillCurrent(active)) return false;
    const expiresAt = readNow() + cacheTtlMs;
    for (const user of users) entries.set(user.userId, { value: user, expiresAt });
    return true;
  };

  const runBatch = async (
    active: ActiveBatch,
  ): Promise<ChatHostDirectoryResult<readonly HostDirectoryUserSummary[]>> => {
    const response = await runHttp(
      "directory.batch",
      active,
      "POST",
      `${config.endpoint}/directory/users:batch`,
      JSON.stringify({ userIds: active.ids }),
    );
    if (response.status !== "success") return response;
    let users: readonly HostDirectoryUserSummary[];
    try {
      const parsed = parseHostDirectoryBatchLookupResult(response.value);
      const requested = new Set(active.ids);
      if (parsed.users.length !== requested.size ||
          parsed.users.some((user) => !requested.has(user.userId))) {
        throw new TypeError("Directory batch response scope mismatch");
      }
      users = immutableUsers(parsed.users);
      if (!storeUsers(active, users)) return interruptedResult(active);
    } catch {
      diagnose({ event: "response_malformed", operation: "directory.batch", attempt: 1 });
      return malformedResponse();
    }
    diagnose({ event: "completed", operation: "directory.batch", attempt: 1 });
    return freeze({ status: "success", value: users });
  };

  const createBatch = (ids: readonly UserId[], key: string): ActiveBatch => {
    const active = {
      controller: new AbortController(),
      generation,
      identityKey: key,
      ids: freeze([...ids]),
      consumers: new Set<symbol>(),
      settled: false,
    } as ActiveBatch;
    for (const id of ids) activeById.set(id, active);
    active.promise = runBatch(active)
      .catch(() => active.controller.signal.aborted
        ? interruptedResult(active)
        : transportFailure())
      .finally(() => {
        active.settled = true;
        for (const id of active.ids) {
          if (activeById.get(id) === active) activeById.delete(id);
        }
      });
    return active;
  };

  const consumeBatch = (
    active: ActiveBatch,
    signal: AbortSignal | undefined,
  ): Promise<ChatHostDirectoryResult<readonly HostDirectoryUserSummary[]>> => {
    const consumer = Symbol("directory-batch-consumer");
    active.consumers.add(consumer);
    return new Promise((resolve) => {
      let done = false;
      const release = () => {
        if (done) return;
        done = true;
        signal?.removeEventListener("abort", abort);
        active.consumers.delete(consumer);
        if (active.consumers.size === 0 && !active.settled) {
          active.interruption = "aborted";
          active.controller.abort();
        }
      };
      const abort = () => {
        release();
        diagnose({ event: "aborted", operation: "directory.batch", attempt: 0 });
        resolve(ABORTED_RESULT);
      };
      signal?.addEventListener("abort", abort, { once: true });
      active.promise.then((result) => {
        if (done) return;
        release();
        resolve(result);
      });
    });
  };

  const selectUser = (userId: UserId): HostDirectoryUserSummary | undefined => {
    try {
      parseHostDirectoryBatchLookupInput({ userIds: [userId] });
      const entry = entries.get(userId);
      if (entry === undefined) return undefined;
      if (entry.expiresAt <= readNow()) {
        entries.delete(userId);
        return undefined;
      }
      return entry.value;
    } catch {
      return undefined;
    }
  };

  const settleSearch = (
    active: ActiveSearch,
    result: ChatHostDirectoryResult<ChatHostDirectorySearchPage>,
  ): void => {
    if (active.settled) return;
    active.settled = true;
    active.cancelScheduled?.();
    active.cancelScheduled = undefined;
    if (currentSearch === active) currentSearch = undefined;
    if (stillCurrent(active)) {
      if (result.status === "success") {
        setSearchState(freeze({ state: "success", ...result.value }));
      } else if (result.status !== "aborted" && result.status !== "closed") {
        setSearchState(freeze({
          state: "error",
          query: active.input.query,
          ...(active.input.cursor === undefined ? {} : { cursor: active.input.cursor }),
          failure: result,
        }));
      }
    }
    active.resolve(result);
  };

  const cancelActiveSearch = (closed: boolean): void => {
    const active = currentSearch;
    if (active === undefined || active.settled) return;
    active.interruption = closed ? "closed" : "aborted";
    active.controller.abort();
    settleSearch(active, closed ? CLOSED_RESULT : ABORTED_RESULT);
  };

  const runSearch = async (active: ActiveSearch): Promise<void> => {
    if (active.settled || active.controller.signal.aborted) return;
    setSearchState(freeze({
      state: "loading",
      query: active.input.query,
      ...(active.input.cursor === undefined ? {} : { cursor: active.input.cursor }),
    }));
    const parameters = new URLSearchParams();
    parameters.set("query", active.input.query);
    if (active.input.cursor !== undefined) parameters.set("cursor", active.input.cursor);
    if (active.input.limit !== undefined) parameters.set("limit", String(active.input.limit));
    const response = await runHttp(
      "directory.search",
      active,
      "GET",
      `${config.endpoint}/directory/users/search?${parameters.toString()}`,
    );
    if (response.status !== "success") {
      settleSearch(active, response);
      return;
    }
    try {
      const parsed = parseHostDirectorySearchResult(response.value);
      if (active.input.limit !== undefined && parsed.users.length > active.input.limit) {
        throw new TypeError("Directory search response exceeds the requested limit");
      }
      if (parsed.page.nextCursor !== undefined &&
          decodeHostDirectorySearchCursor(parsed.page.nextCursor).query !== active.input.query) {
        throw new TypeError("Directory search cursor scope mismatch");
      }
      const users = immutableUsers(parsed.users);
      if (!storeUsers(active, users)) {
        settleSearch(active, interruptedResult(active));
        return;
      }
      const page = freeze({
        query: active.input.query,
        users,
        ...(parsed.page.nextCursor === undefined ? {} : { nextCursor: parsed.page.nextCursor }),
      });
      diagnose({ event: "completed", operation: "directory.search", attempt: 1 });
      settleSearch(active, freeze({ status: "success", value: page }));
    } catch {
      diagnose({ event: "response_malformed", operation: "directory.search", attempt: 1 });
      settleSearch(active, malformedResponse());
    }
  };

  const createSearch = (input: HostDirectorySearchInput, key: string): ActiveSearch => {
    let resolve!: (result: ChatHostDirectoryResult<ChatHostDirectorySearchPage>) => void;
    const promise = new Promise<ChatHostDirectoryResult<ChatHostDirectorySearchPage>>(
      (complete) => { resolve = complete; },
    );
    const active: ActiveSearch = {
      controller: new AbortController(),
      generation,
      identityKey: activeIdentityKey as string,
      input,
      key,
      consumers: new Set(),
      promise,
      resolve,
      cancelScheduled: undefined,
      settled: false,
    };
    currentSearch = active;
    setSearchState(freeze({
      state: "scheduled",
      query: input.query,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    }));
    try {
      active.cancelScheduled = schedule(
        () => { void runSearch(active); },
        input.cursor === undefined ? searchDebounceMs : 0,
      );
      if (typeof active.cancelScheduled !== "function") {
        throw new TypeError("directory.schedule must return a cancellation function");
      }
    } catch {
      settleSearch(active, transportFailure());
    }
    return active;
  };

  const consumeSearch = (
    active: ActiveSearch,
    signal: AbortSignal | undefined,
  ): Promise<ChatHostDirectoryResult<ChatHostDirectorySearchPage>> => {
    const consumer = Symbol("directory-search-consumer");
    active.consumers.add(consumer);
    return new Promise((resolve) => {
      let done = false;
      const release = () => {
        if (done) return;
        done = true;
        signal?.removeEventListener("abort", abort);
        active.consumers.delete(consumer);
        if (active.consumers.size === 0 && !active.settled) {
          cancelActiveSearch(false);
          setSearchState(IDLE_SEARCH_STATE);
        }
      };
      const abort = () => {
        release();
        diagnose({ event: "aborted", operation: "directory.search", attempt: 0 });
        resolve(ABORTED_RESULT);
      };
      signal?.addEventListener("abort", abort, { once: true });
      active.promise.then((result) => {
        if (done) return;
        release();
        resolve(result);
      });
    });
  };

  const clearScope = (closed: boolean): void => {
    generation += 1;
    entries.clear();
    const batches = new Set(activeById.values());
    activeById.clear();
    for (const active of batches) {
      active.interruption = closed ? "closed" : "aborted";
      active.controller.abort();
    }
    cancelActiveSearch(closed);
    setSearchState(IDLE_SEARCH_STATE);
    diagnose({
      event: closed ? "closed" : "scope_reset",
      operation: "directory.batch",
      attempt: 0,
    });
  };

  config.cache.subscribe(
    (state) => identityKey(state.identity),
    (nextKey) => {
      if (nextKey === activeIdentityKey) return;
      clearScope(false);
      activeIdentityKey = nextKey;
    },
  );

  const runtime: ChatHostDirectoryRuntime = {
    async hydrateVisibleUsers(userIds, queryOptions = {}) {
      if (!exactOptions(queryOptions)) {
        diagnose({ event: "validation_failed", operation: "directory.batch", attempt: 0 });
        return VALIDATION_FAILURE;
      }
      if (queryOptions.signal?.aborted === true) return ABORTED_RESULT;
      if (!Array.isArray(userIds)) return VALIDATION_FAILURE;
      const unique = [...new Set(userIds)];
      try {
        for (let index = 0; index < unique.length; index += MAX_HOST_DIRECTORY_BATCH_SIZE) {
          parseHostDirectoryBatchLookupInput({
            userIds: unique.slice(index, index + MAX_HOST_DIRECTORY_BATCH_SIZE),
          });
        }
      } catch {
        diagnose({ event: "validation_failed", operation: "directory.batch", attempt: 0 });
        return VALIDATION_FAILURE;
      }
      const key = activeIdentityKey;
      if (key === undefined) {
        diagnose({ event: "identity_required", operation: "directory.batch", attempt: 0 });
        return AUTHENTICATION_FAILURE;
      }
      if (unique.length === 0) {
        return freeze({ status: "success", value: freeze({ users: freeze([]) }) });
      }
      const pendingIds = unique.filter((userId) => selectUser(userId) === undefined);
      const batches = new Set<ActiveBatch>();
      const missing: UserId[] = [];
      for (const userId of pendingIds) {
        const active = activeById.get(userId);
        if (
          active === undefined ||
          active.settled ||
          active.controller.signal.aborted ||
          active.generation !== generation ||
          active.identityKey !== key
        ) {
          missing.push(userId);
        } else {
          batches.add(active);
        }
      }
      for (let index = 0; index < missing.length; index += MAX_HOST_DIRECTORY_BATCH_SIZE) {
        batches.add(createBatch(missing.slice(index, index + MAX_HOST_DIRECTORY_BATCH_SIZE), key));
      }
      const results = await Promise.all(
        [...batches].map((active) => consumeBatch(active, queryOptions.signal)),
      );
      const failure = results.find((result) => result.status !== "success");
      if (failure !== undefined) return failure;
      const users = unique.map(selectUser);
      if (users.some((user) => user === undefined)) return malformedResponse();
      return freeze({
        status: "success",
        value: freeze({ users: freeze(users as HostDirectoryUserSummary[]) }),
      });
    },
    selectUser,
    search(input, queryOptions = {}) {
      if (!exactOptions(queryOptions)) {
        diagnose({ event: "validation_failed", operation: "directory.search", attempt: 0 });
        return Promise.resolve(VALIDATION_FAILURE);
      }
      if (queryOptions.signal?.aborted === true) return Promise.resolve(ABORTED_RESULT);
      let validated: HostDirectorySearchInput;
      try {
        validated = parseHostDirectorySearchInput(input);
      } catch {
        diagnose({ event: "validation_failed", operation: "directory.search", attempt: 0 });
        return Promise.resolve(VALIDATION_FAILURE);
      }
      if (activeIdentityKey === undefined) {
        diagnose({ event: "identity_required", operation: "directory.search", attempt: 0 });
        return Promise.resolve(AUTHENTICATION_FAILURE);
      }
      const key = JSON.stringify([
        validated.query,
        validated.cursor ?? null,
        validated.limit ?? null,
      ]);
      let active = currentSearch;
      if (active === undefined || active.settled || active.key !== key) {
        if (active !== undefined && !active.settled) cancelActiveSearch(false);
        active = createSearch(validated, key);
      }
      return consumeSearch(active, queryOptions.signal);
    },
    getSearchState: () => searchState,
    subscribeSearch(listener) {
      if (typeof listener !== "function") {
        throw new TypeError("Directory search listener must be a function");
      }
      searchListeners.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        searchListeners.delete(listener);
      };
    },
    cancelSearch() {
      cancelActiveSearch(false);
      setSearchState(IDLE_SEARCH_STATE);
    },
    resetScope() {
      clearScope(false);
      activeIdentityKey = identityKey(config.cache.getState().identity);
    },
    closeActive() {
      clearScope(true);
      activeIdentityKey = identityKey(config.cache.getState().identity);
    },
  };
  return freeze(runtime);
}
