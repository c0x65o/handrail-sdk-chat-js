export type ChatCommandMethod = "POST" | "PUT" | "PATCH" | "DELETE";

export interface ChatClientFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export interface ChatClientFetchInit {
  readonly method: "GET" | ChatCommandMethod;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  readonly body?: string;
}

/** Browser fetch-compatible boundary, exposed for polyfills and focused tests. */
export type ChatClientFetch = (
  input: string,
  init: ChatClientFetchInit,
) => Promise<ChatClientFetchResponse>;

export type ChatCommandRetrySafety = "safe" | "never";

/**
 * One typed HTTP command boundary. Feature modules own these descriptors; the
 * client owns authentication, idempotency, retry, cancellation, and parsing.
 */
export interface ChatCommandDescriptor<Input, RequestBody, Result> {
  /** Stable non-sensitive diagnostic name, for example `message.send`. */
  readonly name: string;
  readonly method: ChatCommandMethod;
  readonly path: string | ((input: RequestBody) => string);
  /** Explicit opt-in required before a network or transient response is retried. */
  readonly retry: ChatCommandRetrySafety;
  /** Must validate and normalize all caller-authored data or throw. */
  readonly validateInput: (input: Input) => RequestBody;
  /** Must strictly parse and normalize the decoded successful JSON payload. */
  readonly parseResult: (value: unknown) => Result;
  /**
   * Optional domain-result parser for an otherwise non-success HTTP status.
   * Returning undefined leaves the response on the normal transport-error path.
   */
  readonly parseErrorResult?: (value: unknown, httpStatus: number) => Result | undefined;
}

export interface ChatCommandDispatchOptions {
  readonly idempotencyKey?: string;
  /** Optional non-sensitive logical key used only to deduplicate across tabs. */
  readonly coordinationKey?: string;
  readonly signal?: AbortSignal;
}

export type ChatCommandDiagnosticEvent =
  | "validation_failed"
  | "token_failed"
  | "request_failed"
  | "retry_scheduled"
  | "auth_refresh"
  | "response_rejected"
  | "response_malformed"
  | "completed"
  | "aborted"
  | "closed";

/** Structurally redacted: it cannot carry headers, bodies, tokens, or thrown values. */
export interface ChatCommandDiagnostic {
  readonly event: ChatCommandDiagnosticEvent;
  readonly command: string;
  readonly attempt: number;
  readonly category?:
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
  readonly httpStatus?: number;
  readonly delayMs?: number;
}

export interface ChatCommandRetryOptions {
  /** Total HTTP attempt budget, including an authentication refresh attempt. */
  readonly maxAttempts?: number;
  /** Strictly capped at one refresh. Defaults to one. */
  readonly maxAuthRefreshes?: 0 | 1;
  /** Receives a one-based retry number and must return a finite delay in ms. */
  readonly backoffMs?: (retryNumber: number) => number;
  /** Injectable wait boundary for deterministic clocks. */
  readonly wait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

export interface ChatCommandRuntimeOptions {
  readonly retry?: ChatCommandRetryOptions;
  /** Injectable for deterministic tests. The result is validated before use. */
  readonly generateIdempotencyKey?: () => string;
  readonly onDiagnostic?: (diagnostic: ChatCommandDiagnostic) => void;
}

export interface ChatCommandSuccess<Result> {
  readonly status: "success";
  readonly value: Result;
}

export interface ChatCommandValidationFailure {
  readonly status: "validation";
  readonly message: "The command input is invalid.";
}

export interface ChatCommandConflict {
  readonly status: "conflict";
  readonly message: "The command conflicts with current server state.";
  readonly httpStatus: number;
}

export interface ChatCommandAuthenticationFailure {
  readonly status: "authentication";
  readonly message: "Chat authentication failed.";
  readonly httpStatus?: number;
}

export interface ChatCommandFeatureDisabled {
  readonly status: "feature_disabled";
  readonly message: "The requested chat feature is disabled.";
  readonly httpStatus: number;
}

export interface ChatCommandUnsupported {
  readonly status: "unsupported";
  readonly message: "The requested chat command is unsupported.";
  readonly httpStatus: number;
}

export interface ChatCommandRejected {
  readonly status: "rejected";
  readonly message: "The chat server rejected the command.";
  readonly httpStatus: number;
}

export interface ChatCommandMalformedResponse {
  readonly status: "malformed_response";
  readonly message: "The chat server returned an invalid command response.";
  readonly httpStatus?: number;
}

export interface ChatCommandTransportFailure {
  readonly status: "transport";
  readonly message: "The chat command could not be completed.";
  readonly httpStatus?: number;
}

export interface ChatCommandAborted {
  readonly status: "aborted";
  readonly message: "The chat command was aborted.";
}

export interface ChatCommandClosed {
  readonly status: "closed";
  readonly message: "The chat client was closed.";
}

export type ChatCommandResult<Result> =
  | ChatCommandSuccess<Result>
  | ChatCommandValidationFailure
  | ChatCommandConflict
  | ChatCommandAuthenticationFailure
  | ChatCommandFeatureDisabled
  | ChatCommandUnsupported
  | ChatCommandRejected
  | ChatCommandMalformedResponse
  | ChatCommandTransportFailure
  | ChatCommandAborted
  | ChatCommandClosed;

interface DispatcherConfig {
  readonly endpoint: string;
  readonly getAccessToken: () => string | Promise<string>;
  readonly fetch: ChatClientFetch;
  readonly options?: ChatCommandRuntimeOptions;
}

interface ActiveCommand {
  readonly controller: AbortController;
  closed: boolean;
  callerAborted: boolean;
}

interface ParsedServerError {
  readonly code: string;
  readonly refreshable: boolean;
}

export interface ChatCommandDispatcher {
  dispatch<Input, RequestBody, Result>(
    descriptor: ChatCommandDescriptor<Input, RequestBody, Result>,
    input: Input,
    options?: ChatCommandDispatchOptions,
  ): Promise<ChatCommandResult<Result>>;
  /** Aborts currently active work as closed without making the reusable client terminal. */
  closeActive(): void;
}

const COMMAND_NAME_PATTERN = /^[a-z][a-z0-9._-]{0,79}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 502, 503, 504]);
const COMMAND_METHODS = new Set<ChatCommandMethod>([
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);
const ABORTED = Symbol("chat-command-aborted");

const freeze = <Value extends object>(value: Value): Readonly<Value> =>
  Object.freeze(value);

const VALIDATION_FAILURE = freeze({
  status: "validation",
  message: "The command input is invalid.",
} as const);
const AUTHENTICATION_FAILURE = freeze({
  status: "authentication",
  message: "Chat authentication failed.",
} as const);
const ABORTED_RESULT = freeze({
  status: "aborted",
  message: "The chat command was aborted.",
} as const);
const CLOSED_RESULT = freeze({
  status: "closed",
  message: "The chat client was closed.",
} as const);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isAbortSignal = (value: unknown): value is AbortSignal =>
  isRecord(value) &&
  typeof value.aborted === "boolean" &&
  typeof value.addEventListener === "function" &&
  typeof value.removeEventListener === "function";

const hasExactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean => {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
};

const defaultBackoffMs = (retryNumber: number): number =>
  Math.min(1_000, 100 * 2 ** (retryNumber - 1));

const defaultWait = (delayMs: number, signal: AbortSignal): Promise<void> => {
  if (signal.aborted) {
    return Promise.reject(ABORTED);
  }
  return new Promise<void>((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    const abort = () => {
      globalThis.clearTimeout(timer);
      reject(ABORTED);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
};

const generateBrowserIdempotencyKey = (): string => {
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

const raceWithAbort = <Value>(
  promise: Promise<Value>,
  signal: AbortSignal,
): Promise<Value> => {
  if (signal.aborted) {
    return Promise.reject(ABORTED);
  }
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

const commandInterruption = (active: ActiveCommand): ChatCommandAborted | ChatCommandClosed =>
  active.closed ? CLOSED_RESULT : ABORTED_RESULT;

const parseServerError = (value: unknown): ParsedServerError | undefined => {
  if (!isRecord(value) || !hasExactKeys(value, ["error"])) {
    return undefined;
  }
  const error = value.error;
  if (
    !isRecord(error) ||
    (!hasExactKeys(error, ["code", "message"]) &&
      !hasExactKeys(error, ["code", "message", "refreshable"]))
  ) {
    return undefined;
  }
  if (
    typeof error.code !== "string" ||
    error.code.trim().length === 0 ||
    typeof error.message !== "string" ||
    error.message.trim().length === 0 ||
    (error.refreshable !== undefined && typeof error.refreshable !== "boolean")
  ) {
    return undefined;
  }
  return { code: error.code, refreshable: error.refreshable === true };
};

const validatePath = (path: unknown): path is string =>
  typeof path === "string" &&
  path.startsWith("/") &&
  !path.startsWith("//") &&
  !/[\s?#]/.test(path) &&
  !path.split("/").includes("..");

const normalizeMaxAttempts = (value: unknown): number => {
  if (value === undefined) return 3;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 10) {
    throw new TypeError("commands.retry.maxAttempts must be an integer from 1 to 10");
  }
  return value as number;
};

const malformedResponse = (httpStatus?: number): ChatCommandMalformedResponse =>
  freeze({
    status: "malformed_response",
    message: "The chat server returned an invalid command response.",
    ...(httpStatus === undefined ? {} : { httpStatus }),
  });

const transportFailure = (httpStatus?: number): ChatCommandTransportFailure =>
  freeze({
    status: "transport",
    message: "The chat command could not be completed.",
    ...(httpStatus === undefined ? {} : { httpStatus }),
  });

/** Internal shared transport used by createChatClient and future feature commands. */
export function createChatCommandDispatcher(
  config: DispatcherConfig,
): ChatCommandDispatcher {
  const maxAttempts = normalizeMaxAttempts(config.options?.retry?.maxAttempts);
  const maxAuthRefreshes = config.options?.retry?.maxAuthRefreshes ?? 1;
  const backoffMs = config.options?.retry?.backoffMs ?? defaultBackoffMs;
  const wait = config.options?.retry?.wait ?? defaultWait;
  const generateIdempotencyKey =
    config.options?.generateIdempotencyKey ?? generateBrowserIdempotencyKey;
  const onDiagnostic = config.options?.onDiagnostic;

  if (maxAuthRefreshes !== 0 && maxAuthRefreshes !== 1) {
    throw new TypeError("commands.retry.maxAuthRefreshes must be zero or one");
  }
  if (typeof backoffMs !== "function" || typeof wait !== "function") {
    throw new TypeError("commands retry hooks must be functions");
  }
  if (typeof generateIdempotencyKey !== "function") {
    throw new TypeError("commands.generateIdempotencyKey must be a function");
  }
  if (onDiagnostic !== undefined && typeof onDiagnostic !== "function") {
    throw new TypeError("commands.onDiagnostic must be a function");
  }

  const activeCommands = new Set<ActiveCommand>();

  const diagnose = (diagnostic: ChatCommandDiagnostic): void => {
    try {
      onDiagnostic?.(freeze(diagnostic));
    } catch {
      // Diagnostics are observational and thrown values may contain secrets.
    }
  };

  const classify = (
    active: ActiveCommand,
    descriptorName: string,
    attempt: number,
    result: ChatCommandAborted | ChatCommandClosed,
  ): ChatCommandAborted | ChatCommandClosed => {
    diagnose({
      event: result.status,
      command: descriptorName,
      attempt,
      category: result.status,
    });
    return result;
  };

  const dispatcher: ChatCommandDispatcher = {
    async dispatch<Input, RequestBody, Result>(
      descriptor: ChatCommandDescriptor<Input, RequestBody, Result>,
      input: Input,
      options: ChatCommandDispatchOptions = {},
    ): Promise<ChatCommandResult<Result>> {
      const fallbackName = "invalid.command";
      const descriptorName =
        isRecord(descriptor) &&
        typeof descriptor.name === "string" &&
        COMMAND_NAME_PATTERN.test(descriptor.name)
          ? descriptor.name
          : fallbackName;

      let validatedInput: RequestBody;
      let body: string | undefined;
      let path: string;
      let idempotencyKey: string;
      try {
        if (
          !isRecord(descriptor) ||
          !COMMAND_NAME_PATTERN.test(descriptor.name as string) ||
          !COMMAND_METHODS.has(descriptor.method as ChatCommandMethod) ||
          (descriptor.retry !== "safe" && descriptor.retry !== "never") ||
          typeof descriptor.validateInput !== "function" ||
          typeof descriptor.parseResult !== "function" ||
          (descriptor.parseErrorResult !== undefined &&
            typeof descriptor.parseErrorResult !== "function") ||
          (typeof descriptor.path !== "string" && typeof descriptor.path !== "function")
        ) {
          throw new TypeError("Invalid command descriptor");
        }
        validatedInput = descriptor.validateInput(input);
        const serialized = JSON.stringify(validatedInput);
        if (validatedInput !== undefined && serialized === undefined) {
          throw new TypeError("Command input is not JSON serializable");
        }
        body = serialized;
        path =
          typeof descriptor.path === "function"
            ? descriptor.path(validatedInput)
            : descriptor.path;
        if (!validatePath(path)) {
          throw new TypeError("Invalid command path");
        }
        idempotencyKey = options.idempotencyKey ?? generateIdempotencyKey();
        if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
          throw new TypeError("Invalid idempotency key");
        }
        if (options.signal !== undefined && !isAbortSignal(options.signal)) {
          throw new TypeError("Invalid abort signal");
        }
      } catch {
        diagnose({
          event: "validation_failed",
          command: descriptorName,
          attempt: 0,
          category: "validation",
        });
        return VALIDATION_FAILURE;
      }

      const active: ActiveCommand = {
        controller: new AbortController(),
        callerAborted: options.signal?.aborted === true,
        closed: false,
      };
      const callerAbort = () => {
        active.callerAborted = true;
        active.controller.abort();
      };
      options.signal?.addEventListener("abort", callerAbort, { once: true });
      if (active.callerAborted) active.controller.abort();
      activeCommands.add(active);

      let attempt = 0;
      let retryNumber = 0;
      let authRefreshes = 0;
      let accessToken = "";
      let tokenFailure: ChatCommandAuthenticationFailure | ChatCommandTransportFailure = AUTHENTICATION_FAILURE;

      const interrupted = (): ChatCommandAborted | ChatCommandClosed | undefined =>
        active.controller.signal.aborted ? commandInterruption(active) : undefined;

      const obtainToken = async (): Promise<boolean> => {
        let token: unknown;
        try {
          token = await raceWithAbort(
            Promise.resolve().then(config.getAccessToken),
            active.controller.signal,
          );
        } catch {
          if (interrupted() !== undefined) return false;
          // A provider exception does not establish that credentials were rejected.
          // In particular, fetch rejects here when the browser is offline.
          tokenFailure = transportFailure();
          diagnose({
            event: "token_failed",
            command: descriptorName,
            attempt,
            category: "transport",
          });
          return false;
        }
        if (typeof token !== "string" || token.trim().length === 0) {
          tokenFailure = AUTHENTICATION_FAILURE;
          diagnose({
            event: "token_failed",
            command: descriptorName,
            attempt,
            category: "authentication",
          });
          return false;
        }
        accessToken = token;
        return true;
      };

      const scheduleRetry = async (): Promise<boolean> => {
        retryNumber += 1;
        let delayMs: number;
        try {
          delayMs = backoffMs(retryNumber);
        } catch {
          return false;
        }
        if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 60_000) {
          return false;
        }
        diagnose({
          event: "retry_scheduled",
          command: descriptorName,
          attempt,
          category: "transport",
          delayMs,
        });
        try {
          await raceWithAbort(
            Promise.resolve().then(() => wait(delayMs, active.controller.signal)),
            active.controller.signal,
          );
          return true;
        } catch {
          return false;
        }
      };

      try {
        if (!(await obtainToken())) {
          const stopped = interrupted();
          return stopped === undefined
            ? tokenFailure
            : classify(active, descriptorName, attempt, stopped);
        }

        while (attempt < maxAttempts) {
          const stopped = interrupted();
          if (stopped !== undefined) {
            return classify(active, descriptorName, attempt, stopped);
          }

          attempt += 1;
          let response: ChatClientFetchResponse;
          try {
            response = await raceWithAbort(
              config.fetch(`${config.endpoint}${path}`, {
                method: descriptor.method,
                headers: freeze({
                  accept: "application/json",
                  authorization: `Bearer ${accessToken}`,
                  "idempotency-key": idempotencyKey,
                  ...(body === undefined ? {} : { "content-type": "application/json" }),
                }),
                signal: active.controller.signal,
                ...(body === undefined ? {} : { body }),
              }),
              active.controller.signal,
            );
          } catch {
            const requestStopped = interrupted();
            if (requestStopped !== undefined) {
              return classify(active, descriptorName, attempt, requestStopped);
            }
            diagnose({
              event: "request_failed",
              command: descriptorName,
              attempt,
              category: "transport",
            });
            if (
              descriptor.retry === "safe" &&
              attempt < maxAttempts &&
              (await scheduleRetry())
            ) {
              continue;
            }
            const retryStopped = interrupted();
            return retryStopped === undefined
              ? transportFailure()
              : classify(active, descriptorName, attempt, retryStopped);
          }

          if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
            diagnose({
              event: "response_malformed",
              command: descriptorName,
              attempt,
              category: "malformed_response",
            });
            return malformedResponse();
          }

          if (!response.ok && TRANSIENT_HTTP_STATUSES.has(response.status)) {
            if (
              descriptor.retry === "safe" &&
              attempt < maxAttempts &&
              (await scheduleRetry())
            ) {
              continue;
            }
            const retryStopped = interrupted();
            return retryStopped === undefined
              ? transportFailure(response.status)
              : classify(active, descriptorName, attempt, retryStopped);
          }

          let decoded: unknown;
          try {
            decoded = await raceWithAbort(response.json(), active.controller.signal);
          } catch {
            const responseStopped = interrupted();
            if (responseStopped !== undefined) {
              return classify(active, descriptorName, attempt, responseStopped);
            }
            diagnose({
              event: "response_malformed",
              command: descriptorName,
              attempt,
              category: "malformed_response",
              httpStatus: response.status,
            });
            return malformedResponse(response.status);
          }

          if (response.ok) {
            try {
              const value = descriptor.parseResult(decoded);
              diagnose({ event: "completed", command: descriptorName, attempt });
              return freeze({ status: "success", value });
            } catch {
              diagnose({
                event: "response_malformed",
                command: descriptorName,
                attempt,
                category: "malformed_response",
                httpStatus: response.status,
              });
              return malformedResponse(response.status);
            }
          }

          if (descriptor.parseErrorResult !== undefined) {
            try {
              const value = descriptor.parseErrorResult(decoded, response.status);
              if (value !== undefined) {
                diagnose({ event: "completed", command: descriptorName, attempt });
                return freeze({ status: "success", value });
              }
            } catch {
              diagnose({
                event: "response_malformed",
                command: descriptorName,
                attempt,
                category: "malformed_response",
                httpStatus: response.status,
              });
              return malformedResponse(response.status);
            }
          }

          const serverError = parseServerError(decoded);
          if (serverError === undefined) {
            diagnose({
              event: "response_malformed",
              command: descriptorName,
              attempt,
              category: "malformed_response",
              httpStatus: response.status,
            });
            return malformedResponse(response.status);
          }

          if (
            response.status === 401 &&
            serverError.refreshable &&
            authRefreshes < maxAuthRefreshes &&
            attempt < maxAttempts
          ) {
            authRefreshes += 1;
            diagnose({
              event: "auth_refresh",
              command: descriptorName,
              attempt,
              category: "authentication",
              httpStatus: response.status,
            });
            if (await obtainToken()) continue;
            const refreshStopped = interrupted();
            return refreshStopped === undefined
              ? tokenFailure.status === "authentication"
                ? freeze({ ...tokenFailure, httpStatus: response.status })
                : tokenFailure
              : classify(active, descriptorName, attempt, refreshStopped);
          }

          const errorCode = serverError.code.toUpperCase();
          let result: ChatCommandResult<never>;
          let category: ChatCommandDiagnostic["category"];
          if (response.status === 409) {
            category = "conflict";
            result = freeze({
              status: "conflict",
              message: "The command conflicts with current server state.",
              httpStatus: response.status,
            });
          } else if (errorCode.includes("FEATURE_DISABLED")) {
            category = "feature_disabled";
            result = freeze({
              status: "feature_disabled",
              message: "The requested chat feature is disabled.",
              httpStatus: response.status,
            });
          } else if (
            response.status === 404 ||
            response.status === 405 ||
            response.status === 501 ||
            errorCode.includes("UNSUPPORTED")
          ) {
            category = "unsupported";
            result = freeze({
              status: "unsupported",
              message: "The requested chat command is unsupported.",
              httpStatus: response.status,
            });
          } else if (response.status === 401) {
            category = "authentication";
            result = freeze({
              status: "authentication",
              message: "Chat authentication failed.",
              httpStatus: response.status,
            });
          } else if (response.status >= 400 && response.status < 500) {
            category = "rejected";
            result = freeze({
              status: "rejected",
              message: "The chat server rejected the command.",
              httpStatus: response.status,
            });
          } else {
            category = "transport";
            result = transportFailure(response.status);
          }
          diagnose({
            event: "response_rejected",
            command: descriptorName,
            attempt,
            category,
            httpStatus: response.status,
          });
          return result;
        }

        return transportFailure();
      } finally {
        options.signal?.removeEventListener("abort", callerAbort);
        activeCommands.delete(active);
      }
    },
    closeActive() {
      for (const active of activeCommands) {
        active.closed = true;
        active.controller.abort();
      }
    },
  };

  return freeze(dispatcher);
}
