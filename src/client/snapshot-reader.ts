import { parseGetReplyStylePreferenceInput, parseReplyStylePreferenceState, type GetReplyStylePreferenceInput, type ReplyStylePreferenceState } from "../contracts/reply-style-preference.js";
import { THREAD_LIST_PATH, parseThreadListRequest, parseThreadListResult, serializeThreadListQuery, type ThreadListRequest, type ThreadListResult } from "../contracts/thread-list.js";
import { MESSAGE_CONTEXT_PATH, parseMessageContextRequest, parseMessageContextResult,
  type MessageContextRequest, type MessageContextResult } from "../contracts/message-context.js";
import {
  parseConversationDetailSnapshot,
  parseConversationDetailSnapshotInput,
  parseConversationListSnapshot,
  parseConversationListSnapshotInput,
  type ConversationDetailSnapshot,
  type ConversationDetailSnapshotInput,
  type ConversationListSnapshot,
  type ConversationListSnapshotInput,
} from "../contracts/conversation-snapshot.js";
import {
  createMessageTimelinePage,
  type MessageTimelinePage,
  type MessageTimelinePageInput,
  type MessageTimelineRequest,
} from "../contracts/message-timeline.js";
import {
  parseConversationDraftSnapshot,
  parseConversationDraftSnapshotInput,
  parseMessageReminderListSnapshot,
  parseMessageReminderListSnapshotInput,
  parseSavedMessageListSnapshot,
  parseSavedMessageListSnapshotInput,
  type ConversationDraftSnapshot,
  type ConversationDraftSnapshotInput,
  type MessageReminderListSnapshot,
  type MessageReminderListSnapshotInput,
  type SavedMessageListSnapshot,
  type SavedMessageListSnapshotInput,
} from "../contracts/private-user-state-snapshot.js";
import type {
  ChatClientFetch,
  ChatClientFetchResponse,
} from "./command-dispatcher.js";
import type { NormalizedChatCache } from "./normalized-cache.js";

export interface ChatSnapshotQueryOptions {
  readonly signal?: AbortSignal;
}

export type ChatSnapshotQueryDiagnosticEvent =
  | "validation_failed"
  | "token_failed"
  | "auth_refresh"
  | "request_failed"
  | "response_rejected"
  | "response_malformed"
  | "completed"
  | "aborted"
  | "closed";

/** Structurally redacted: URLs, headers, bodies, tokens, and thrown values are absent. */
export interface ChatSnapshotQueryDiagnostic {
  readonly event: ChatSnapshotQueryDiagnosticEvent;
  readonly query:
    | "conversation.list"
    | "conversation.detail"
    | "message.timeline"
    | "message.context"
    | "reply.style.preference"
    | "thread.list"
    | "conversation.draft"
    | "saved_message.list"
    | "message_reminder.list";
  readonly attempt: number;
  readonly httpStatus?: number;
}

export interface ChatSnapshotQueryRuntimeOptions {
  readonly onDiagnostic?: (diagnostic: ChatSnapshotQueryDiagnostic) => void;
}

export interface ChatSnapshotQuerySuccess<Value> {
  readonly status: "success";
  readonly value: Value;
}

export interface ChatSnapshotQueryValidationFailure {
  readonly status: "validation";
  readonly message: "The snapshot query input is invalid.";
}

export interface ChatSnapshotQueryAuthenticationFailure {
  readonly status: "authentication";
  readonly message: "Chat authentication failed.";
  readonly httpStatus?: number;
}

export interface ChatSnapshotQueryRejected {
  readonly status: "rejected";
  readonly message: "The chat server rejected the snapshot query.";
  readonly httpStatus: number;
}

export interface ChatSnapshotQueryMalformedResponse {
  readonly status: "malformed_response";
  readonly message: "The chat server returned an invalid snapshot response.";
  readonly httpStatus?: number;
}

export interface ChatSnapshotQueryTransportFailure {
  readonly status: "transport";
  readonly message: "The chat snapshot query could not be completed.";
  readonly httpStatus?: number;
}

export interface ChatSnapshotQueryAborted {
  readonly status: "aborted";
  readonly message: "The chat snapshot query was aborted.";
}

export interface ChatSnapshotQueryClosed {
  readonly status: "closed";
  readonly message: "The chat client was closed.";
}

export type ChatSnapshotQueryResult<Value> =
  | ChatSnapshotQuerySuccess<Value>
  | ChatSnapshotQueryValidationFailure
  | ChatSnapshotQueryAuthenticationFailure
  | ChatSnapshotQueryRejected
  | ChatSnapshotQueryMalformedResponse
  | ChatSnapshotQueryTransportFailure
  | ChatSnapshotQueryAborted
  | ChatSnapshotQueryClosed;

interface SnapshotReaderConfig {
  readonly endpoint: string;
  readonly getAccessToken: () => string | Promise<string>;
  readonly fetch: ChatClientFetch;
  readonly cache?: NormalizedChatCache;
  readonly options?: ChatSnapshotQueryRuntimeOptions;
}

interface PreparedRead<Value> {
  readonly expectedStatus?: number;
  readonly key: string;
  readonly query: ChatSnapshotQueryDiagnostic["query"];
  readonly url: string;
  readonly parse: (value: unknown) => Value;
  readonly hydrate: (value: Value) => void;
  readonly privateState?: boolean;
}

interface ActiveRead<Value = unknown> {
  readonly controller: AbortController;
  readonly consumers: Set<symbol>;
  readonly privateState: boolean;
  promise: Promise<ChatSnapshotQueryResult<Value>>;
  closed: boolean;
  settled: boolean;
}

export interface ChatSnapshotReader {
  getReplyStylePreference(input: GetReplyStylePreferenceInput, options?: ChatSnapshotQueryOptions): Promise<ChatSnapshotQueryResult<ReplyStylePreferenceState>>;
  listThreads(input: ThreadListRequest, options?: ChatSnapshotQueryOptions): Promise<ChatSnapshotQueryResult<ThreadListResult>>;
  getMessageContext(input: MessageContextRequest, options?: ChatSnapshotQueryOptions): Promise<ChatSnapshotQueryResult<MessageContextResult>>;
  listConversations<Feature extends string = string>(
    input: ConversationListSnapshotInput,
    options?: ChatSnapshotQueryOptions,
  ): Promise<ChatSnapshotQueryResult<ConversationListSnapshot<Feature>>>;
  getConversation<Feature extends string = string>(
    input: ConversationDetailSnapshotInput,
    options?: ChatSnapshotQueryOptions,
  ): Promise<ChatSnapshotQueryResult<ConversationDetailSnapshot<Feature>>>;
  getMessageTimeline(
    input: MessageTimelineRequest,
    options?: ChatSnapshotQueryOptions,
  ): Promise<ChatSnapshotQueryResult<MessageTimelinePage>>;
  getConversationDraft(
    input: ConversationDraftSnapshotInput,
    options?: ChatSnapshotQueryOptions,
  ): Promise<ChatSnapshotQueryResult<ConversationDraftSnapshot>>;
  listSavedMessages(
    input: SavedMessageListSnapshotInput,
    options?: ChatSnapshotQueryOptions,
  ): Promise<ChatSnapshotQueryResult<SavedMessageListSnapshot>>;
  listMessageReminders(
    input: MessageReminderListSnapshotInput,
    options?: ChatSnapshotQueryOptions,
  ): Promise<ChatSnapshotQueryResult<MessageReminderListSnapshot>>;
  closeActive(): void;
}

const ABORTED = Symbol("chat-snapshot-query-aborted");
const MAX_MESSAGE_TIMELINE_LIMIT = 100;
const freeze = <Value extends object>(value: Value): Readonly<Value> =>
  Object.freeze(value);
const VALIDATION_FAILURE = freeze({
  status: "validation",
  message: "The snapshot query input is invalid.",
} as const);
const AUTHENTICATION_FAILURE = freeze({
  status: "authentication",
  message: "Chat authentication failed.",
} as const);
const ABORTED_RESULT = freeze({
  status: "aborted",
  message: "The chat snapshot query was aborted.",
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

const malformedResponse = (
  httpStatus?: number,
): ChatSnapshotQueryMalformedResponse =>
  freeze({
    status: "malformed_response",
    message: "The chat server returned an invalid snapshot response.",
    ...(httpStatus === undefined ? {} : { httpStatus }),
  });

const transportFailure = (
  httpStatus?: number,
): ChatSnapshotQueryTransportFailure =>
  freeze({
    status: "transport",
    message: "The chat snapshot query could not be completed.",
    ...(httpStatus === undefined ? {} : { httpStatus }),
  });

const sameScope = (
  left: ConversationListSnapshotInput["scope"],
  right: ConversationListSnapshotInput["scope"],
): boolean =>
  left.type === right.type &&
  (left.type === "organization" ||
    (right.type === "entity" &&
      left.entity.type === right.entity.type &&
      left.entity.id === right.entity.id));

const validateTimelineRequest = (value: unknown): MessageTimelineRequest => {
  if (!isRecord(value) || !hasExactKeys(value, [
    "conversationId",
    "direction",
    ...(Object.hasOwn(value, "cursor") ? ["cursor"] : []),
    "limit",
  ])) {
    throw new TypeError("Invalid timeline request");
  }
  if (
    typeof value.conversationId !== "string" ||
    value.conversationId.trim().length === 0 ||
    (value.direction !== "backward" && value.direction !== "forward") ||
    !Number.isSafeInteger(value.limit) ||
    (value.limit as number) < 1 ||
    (value.limit as number) > MAX_MESSAGE_TIMELINE_LIMIT ||
    (value.cursor !== undefined &&
      (!Number.isSafeInteger(value.cursor) || (value.cursor as number) < 0))
  ) {
    throw new TypeError("Invalid timeline request");
  }
  return value as unknown as MessageTimelineRequest;
};

const parseTimelinePage = (
  request: MessageTimelineRequest,
  value: unknown,
): MessageTimelinePage => {
  if (!isRecord(value) || !hasExactKeys(value, [
    "conversationId",
    "messages",
    "pagination",
    "replay",
  ])) {
    throw new TypeError("Invalid timeline response");
  }
  if (value.conversationId !== request.conversationId || !Array.isArray(value.messages)) {
    throw new TypeError("Invalid timeline response");
  }
  return createMessageTimelinePage(request, {
    messages: value.messages,
    pagination: value.pagination,
    replay: value.replay,
  } as MessageTimelinePageInput);
};

/** Creates the shared, browser-safe GET transport used by createChatClient. */
export function createChatSnapshotReader(config: SnapshotReaderConfig): ChatSnapshotReader {
  const activeReads = new Map<string, ActiveRead>();
  const onDiagnostic = config.options?.onDiagnostic;
  if (onDiagnostic !== undefined && typeof onDiagnostic !== "function") {
    throw new TypeError("queries.onDiagnostic must be a function");
  }

  const diagnose = (diagnostic: ChatSnapshotQueryDiagnostic): void => {
    try {
      onDiagnostic?.(freeze(diagnostic));
    } catch {
      // Observers cannot affect transport, and their thrown values may contain secrets.
    }
  };

  const runTransport = async <Value>(
    prepared: PreparedRead<Value>,
    active: ActiveRead<Value>,
  ): Promise<ChatSnapshotQueryResult<Value>> => {
    let accessToken = "";
    let attempt = 0;
    const obtainToken = async (): Promise<boolean> => {
      try {
        const token = await raceWithAbort(
          Promise.resolve().then(config.getAccessToken),
          active.controller.signal,
        );
        if (typeof token !== "string" || token.trim().length === 0) {
          throw new TypeError("Invalid access token");
        }
        accessToken = token;
        return true;
      } catch {
        if (!active.controller.signal.aborted) {
          diagnose({ event: "token_failed", query: prepared.query, attempt });
        }
        return false;
      }
    };

    if (!(await obtainToken())) {
      return active.controller.signal.aborted
        ? active.closed ? CLOSED_RESULT : ABORTED_RESULT
        : AUTHENTICATION_FAILURE;
    }

    for (let authRefreshes = 0; authRefreshes <= 1; authRefreshes += 1) {
      attempt += 1;
      let response: ChatClientFetchResponse;
      try {
        response = await raceWithAbort(
          config.fetch(prepared.url, {
            method: "GET",
            headers: freeze({
              accept: "application/json",
              authorization: `Bearer ${accessToken}`,
            }),
            signal: active.controller.signal,
          }),
          active.controller.signal,
        );
      } catch {
        if (active.controller.signal.aborted) {
          return active.closed ? CLOSED_RESULT : ABORTED_RESULT;
        }
        diagnose({ event: "request_failed", query: prepared.query, attempt });
        return transportFailure();
      }

      if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
        diagnose({ event: "response_malformed", query: prepared.query, attempt });
        return malformedResponse();
      }
      if (!response.ok && response.status === 401 && authRefreshes === 0) {
        diagnose({
          event: "auth_refresh",
          query: prepared.query,
          attempt,
          httpStatus: response.status,
        });
        if (await obtainToken()) continue;
        return active.controller.signal.aborted
          ? active.closed ? CLOSED_RESULT : ABORTED_RESULT
          : freeze({ ...AUTHENTICATION_FAILURE, httpStatus: response.status });
      }
      if (!response.ok) {
        const result: ChatSnapshotQueryResult<never> =
          response.status === 401 || response.status === 403
            ? freeze({ ...AUTHENTICATION_FAILURE, httpStatus: response.status })
            : response.status >= 400 && response.status < 500
              ? freeze({
                  status: "rejected",
                  message: "The chat server rejected the snapshot query.",
                  httpStatus: response.status,
                } as const)
              : transportFailure(response.status);
        diagnose({
          event: "response_rejected",
          query: prepared.query,
          attempt,
          httpStatus: response.status,
        });
        return result;
      }

      let decoded: unknown;
      try {
        decoded = await raceWithAbort(response.json(), active.controller.signal);
      } catch {
        if (active.controller.signal.aborted) {
          return active.closed ? CLOSED_RESULT : ABORTED_RESULT;
        }
        diagnose({
          event: "response_malformed",
          query: prepared.query,
          attempt,
          httpStatus: response.status,
        });
        return malformedResponse(response.status);
      }

      try {
        if (prepared.expectedStatus !== undefined && response.status !== prepared.expectedStatus) {
          return malformedResponse(response.status);
        }
        const value = prepared.parse(decoded);
        if (active.controller.signal.aborted) {
          return active.closed ? CLOSED_RESULT : ABORTED_RESULT;
        }
        prepared.hydrate(value);
        diagnose({ event: "completed", query: prepared.query, attempt });
        return freeze({ status: "success", value });
      } catch {
        diagnose({
          event: "response_malformed",
          query: prepared.query,
          attempt,
          httpStatus: response.status,
        });
        return malformedResponse(response.status);
      }
    }
    return transportFailure();
  };

  const consume = <Value>(
    prepared: PreparedRead<Value>,
    options: ChatSnapshotQueryOptions,
  ): Promise<ChatSnapshotQueryResult<Value>> => {
    if (!isRecord(options) || !hasExactKeys(
      options,
      Object.hasOwn(options, "signal") ? ["signal"] : [],
    )) {
      diagnose({ event: "validation_failed", query: prepared.query, attempt: 0 });
      return Promise.resolve(VALIDATION_FAILURE);
    }
    if (options.signal !== undefined && !isAbortSignal(options.signal)) {
      diagnose({ event: "validation_failed", query: prepared.query, attempt: 0 });
      return Promise.resolve(VALIDATION_FAILURE);
    }
    const callerSignal = options.signal as AbortSignal | undefined;
    if (callerSignal?.aborted === true) {
      diagnose({ event: "aborted", query: prepared.query, attempt: 0 });
      return Promise.resolve(ABORTED_RESULT);
    }

    let active = activeReads.get(prepared.key) as ActiveRead<Value> | undefined;
    if (active === undefined) {
      const controller = new AbortController();
      const created = {
        controller,
        consumers: new Set<symbol>(),
        privateState: prepared.privateState === true,
        closed: false,
        settled: false,
      } as ActiveRead<Value>;
      created.promise = runTransport(prepared, created)
        .catch(() =>
          created.controller.signal.aborted
            ? created.closed ? CLOSED_RESULT : ABORTED_RESULT
            : transportFailure(),
        )
        .finally(() => {
          created.settled = true;
          if (activeReads.get(prepared.key) === created) activeReads.delete(prepared.key);
        });
      active = created;
      activeReads.set(prepared.key, active as ActiveRead);
    }

    const consumer = Symbol("snapshot-query-consumer");
    active.consumers.add(consumer);
    return new Promise((resolve) => {
      let complete = false;
      const release = () => {
        if (complete) return;
        complete = true;
        callerSignal?.removeEventListener("abort", abort);
        active?.consumers.delete(consumer);
        if (active !== undefined && active.consumers.size === 0 && !active.settled) {
          if (activeReads.get(prepared.key) === active) activeReads.delete(prepared.key);
          active.controller.abort();
        }
      };
      const abort = () => {
        release();
        diagnose({ event: "aborted", query: prepared.query, attempt: 0 });
        resolve(ABORTED_RESULT);
      };
      callerSignal?.addEventListener("abort", abort, { once: true });
      active.promise.then((result) => {
        if (complete) return;
        release();
        resolve(result);
      });
    });
  };

  const reader: ChatSnapshotReader = {
    getReplyStylePreference(input, options = {}) {
      try { parseGetReplyStylePreferenceInput(input); }
      catch { return Promise.resolve(VALIDATION_FAILURE); }
      const url = `${config.endpoint}/preferences/reply-style`;
      return consume({ key: `PRIVATE GET ${url}`, query: "reply.style.preference", url,
        privateState: true, expectedStatus: 200, parse: parseReplyStylePreferenceState, hydrate() {},
      }, options);
    },
    listThreads(input, options = {}) {
      let request: ThreadListRequest;
      try { request = parseThreadListRequest(input); }
      catch { return Promise.resolve(VALIDATION_FAILURE); }
      const path = THREAD_LIST_PATH.replace(":parentConversationId", encodeURIComponent(request.parentConversationId));
      const url = `${config.endpoint}${path}?${new URLSearchParams(serializeThreadListQuery(request))}`;
      return consume({ key: `PRIVATE GET ${url}`, query: "thread.list", url,
        privateState: true, expectedStatus: 200,
        parse: value => parseThreadListResult(value, request), hydrate() {},
      }, options);
    },
    getMessageContext(input, options = {}) {
      let request: MessageContextRequest;
      try { request = parseMessageContextRequest(input); }
      catch { return Promise.resolve(VALIDATION_FAILURE); }
      const url = config.endpoint + MESSAGE_CONTEXT_PATH
        .replace(":conversationId", encodeURIComponent(request.conversationId))
        .replace(":messageId", encodeURIComponent(request.messageId));
      return consume({ key: `PRIVATE GET ${url}`, query: "message.context", url,
        privateState: true, expectedStatus: 200,
        parse: value => parseMessageContextResult(value, request), hydrate() {},
      }, options);
    },
    listConversations<Feature extends string = string>(
      input: ConversationListSnapshotInput,
      options: ChatSnapshotQueryOptions = {},
    ) {
      let validated: ConversationListSnapshotInput;
      try {
        validated = parseConversationListSnapshotInput(input);
      } catch {
        diagnose({ event: "validation_failed", query: "conversation.list", attempt: 0 });
        return Promise.resolve(VALIDATION_FAILURE);
      }
      const parameters = new URLSearchParams();
      parameters.set("scope", validated.scope.type);
      if (validated.scope.type === "entity") {
        parameters.set("entityType", validated.scope.entity.type);
        parameters.set("entityId", validated.scope.entity.id);
      }
      if (validated.cursor !== undefined) parameters.set("cursor", validated.cursor);
      if (validated.limit !== undefined) parameters.set("limit", String(validated.limit));
      const url = `${config.endpoint}/conversations?${parameters.toString()}`;
      return consume({
        key: `GET ${url}`,
        query: "conversation.list",
        url,
        parse(value) {
          const snapshot = parseConversationListSnapshot<Feature>(value);
          if (!sameScope(snapshot.scope, validated.scope)) {
            throw new TypeError("Snapshot scope mismatch");
          }
          return snapshot;
        },
        hydrate: (snapshot) => config.cache?.hydrateConversationList(snapshot, {
          ...(validated.cursor === undefined
            ? {}
            : { requestCursor: validated.cursor }),
        }),
      }, options);
    },
    getConversation<Feature extends string = string>(
      input: ConversationDetailSnapshotInput,
      options: ChatSnapshotQueryOptions = {},
    ) {
      let validated: ConversationDetailSnapshotInput;
      try {
        validated = parseConversationDetailSnapshotInput(input);
      } catch {
        diagnose({ event: "validation_failed", query: "conversation.detail", attempt: 0 });
        return Promise.resolve(VALIDATION_FAILURE);
      }
      const url = `${config.endpoint}/conversations/${encodeURIComponent(validated.conversationId)}`;
      return consume({
        key: `GET ${url}`,
        query: "conversation.detail",
        url,
        parse(value) {
          const snapshot = parseConversationDetailSnapshot<Feature>(value);
          if (snapshot.conversation.id !== validated.conversationId) {
            throw new TypeError("Snapshot conversation mismatch");
          }
          return snapshot;
        },
        hydrate: (snapshot) => config.cache?.hydrateConversationDetail(snapshot),
      }, options);
    },
    getMessageTimeline(input, options = {}) {
      let validated: MessageTimelineRequest;
      try {
        validated = validateTimelineRequest(input);
      } catch {
        diagnose({ event: "validation_failed", query: "message.timeline", attempt: 0 });
        return Promise.resolve(VALIDATION_FAILURE);
      }
      const parameters = new URLSearchParams();
      if (validated.direction === "forward") {
        parameters.set("after", String(validated.cursor ?? 0));
      } else if (validated.cursor !== undefined) {
        parameters.set("before", String(validated.cursor));
      }
      parameters.set("limit", String(validated.limit));
      const url = `${config.endpoint}/conversations/${encodeURIComponent(validated.conversationId)}/messages?${parameters.toString()}`;
      return consume({
        key: `GET ${url}`,
        query: "message.timeline",
        url,
        parse: (value) => parseTimelinePage(validated, value),
        hydrate: (page) => config.cache?.hydrateMessageTimeline(page),
      }, options);
    },
    getConversationDraft(input, options = {}) {
      let validated: ConversationDraftSnapshotInput;
      try {
        validated = parseConversationDraftSnapshotInput(input);
      } catch {
        diagnose({ event: "validation_failed", query: "conversation.draft", attempt: 0 });
        return Promise.resolve(VALIDATION_FAILURE);
      }
      const url = `${config.endpoint}/conversations/${encodeURIComponent(validated.conversationId)}/draft`;
      return consume({
        key: `PRIVATE GET ${url}`,
        query: "conversation.draft",
        url,
        privateState: true,
        parse: (value) => parseConversationDraftSnapshot(value, validated),
        hydrate: (snapshot) => config.cache?.hydrateConversationDraft(snapshot),
      }, options);
    },
    listSavedMessages(input, options = {}) {
      let validated: SavedMessageListSnapshotInput;
      try {
        validated = parseSavedMessageListSnapshotInput(input);
      } catch {
        diagnose({ event: "validation_failed", query: "saved_message.list", attempt: 0 });
        return Promise.resolve(VALIDATION_FAILURE);
      }
      const parameters = new URLSearchParams();
      if (validated.cursor !== undefined) parameters.set("cursor", validated.cursor);
      parameters.set("limit", String(validated.limit));
      const url = `${config.endpoint}/saved-messages?${parameters.toString()}`;
      return consume({
        key: `PRIVATE GET ${url}`,
        query: "saved_message.list",
        url,
        privateState: true,
        parse: (value) => parseSavedMessageListSnapshot(value, validated),
        hydrate: (snapshot) => config.cache?.hydrateSavedMessageList(snapshot),
      }, options);
    },
    listMessageReminders(input, options = {}) {
      let validated: MessageReminderListSnapshotInput;
      try {
        validated = parseMessageReminderListSnapshotInput(input);
      } catch {
        diagnose({ event: "validation_failed", query: "message_reminder.list", attempt: 0 });
        return Promise.resolve(VALIDATION_FAILURE);
      }
      const parameters = new URLSearchParams();
      if (validated.cursor !== undefined) parameters.set("cursor", validated.cursor);
      parameters.set("limit", String(validated.limit));
      if (validated.includeCancelled !== undefined) {
        parameters.set("includeCancelled", String(validated.includeCancelled));
      }
      const url = `${config.endpoint}/message-reminders?${parameters.toString()}`;
      return consume({
        key: `PRIVATE GET ${url}`,
        query: "message_reminder.list",
        url,
        privateState: true,
        parse: (value) => parseMessageReminderListSnapshot(value, validated),
        hydrate: (snapshot) => config.cache?.hydrateMessageReminderList(snapshot),
      }, options);
    },
    closeActive() {
      for (const [key, active] of activeReads) {
        activeReads.delete(key);
        active.closed = true;
        active.controller.abort();
      }
    },
  };
  config.cache?.subscribePrivateStateBoundary(() => {
    for (const [key, active] of activeReads) {
      if (!active.privateState) continue;
      activeReads.delete(key);
      active.controller.abort();
    }
  });
  return freeze(reader);
}
