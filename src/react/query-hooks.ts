import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import type {
  ChatClient,
  ChatThreadOpeningState,
} from "../client/create-chat-client.js";
import type {
  ChatConversationDraftState,
} from "../client/draft-runtime.js";
import type {
  ChatHostDirectoryFailure,
  ChatHostDirectorySearchState,
} from "../client/host-directory.js";
import type {
  ChatMessageSearchResult,
  ChatMessageSearchState,
} from "../client/message-search.js";
import type { ChatHuddleViewState } from "../client/huddle-runtime.js";
import {
  EMPTY_NORMALIZED_CHAT_CACHE_STATE,
  conversationSnapshotScopeKey,
  createConversationMessagesSelector,
  selectAttachmentUpload,
  selectConversationUnreadMentionCount,
  selectConversationUnreadCount,
  selectCurrentUserReadState,
  selectCurrentUserThreadFollowState,
  selectDirectMessageOtherUserRead,
  selectPresenceSignals,
  selectTypingSignals,
  type ChatCacheEquality,
  type ChatCacheSelector,
  type ChatTimelineMessage,
  type ClientAttachmentUploadState,
  type ConversationTypingState,
  type CurrentUserPresenceState,
  type CurrentUserMessageReminderListItem,
  type CurrentUserSavedMessageListItem,
  type CurrentUserThreadFollowState,
  type NormalizedChatCache,
  type NormalizedChatCacheState,
} from "../client/index.js";
import type { ChatSnapshotQueryResult } from "../client/snapshot-reader.js";
import type { Conversation } from "../contracts/conversation.js";
import type {
  ConversationListSnapshotSummary,
  ConversationSnapshotCursor,
  ConversationSnapshotScope,
} from "../contracts/conversation-snapshot.js";
import type { HostDirectoryUserSummary } from "../contracts/host-directory-snapshot.js";
import {
  normalizeMessageSearchQuery,
  type MessageSearchCursor,
  type MessageSearchFilters,
  type MessageSearchHit,
} from "../contracts/message-search.js";
import type {
  ConversationId,
  MessageId,
  MessageSequence,
  UserId,
} from "../contracts/identifiers.js";
import type {
  ConversationMember,
  ConversationReadState,
} from "../contracts/member-read-state.js";
import type {
  MessageTimelineCursor,
  MessageTimelinePagination,
} from "../contracts/message-timeline.js";
import type {
  MessageReminderSnapshotCursor,
  SavedMessageSnapshotCursor,
} from "../contracts/private-user-state-snapshot.js";
import type { ThreadSummary } from "../contracts/message.js";
import { ChatContext, type ChatContextValue } from "./index.js";

const EMPTY_ARRAY = Object.freeze([]) as readonly never[];
const EMPTY_DIRECTORY_SEARCH = Object.freeze({ state: "idle" } as const);
const EMPTY_MESSAGE_SEARCH = Object.freeze({ state: "idle" } as const);

export type ChatQueryErrorCode =
  | "provider_missing"
  | "provider_error"
  | "refresh_required"
  | "validation"
  | "authentication"
  | "rejected"
  | "malformed_response"
  | "transport"
  | "aborted"
  | "closed"
  | "draft_conflict"
  | "runtime_error";

/** Renderer-safe errors never contain tokens, response bodies, URLs, or thrown values. */
export interface ChatQueryError {
  readonly code: ChatQueryErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly httpStatus?: number;
}

/**
 * Stable result contract shared by every public query hook:
 * `loading` may carry stale data, `error` carries only a safe diagnostic,
 * `ready` has usable data, and `empty` is a successful no-value/no-row result.
 */
export type ChatQueryResult<Value> =
  | Readonly<{ status: "loading"; data: Value | undefined }>
  | Readonly<{ status: "error"; data: Value | undefined; error: ChatQueryError }>
  | Readonly<{ status: "ready"; data: Value }>
  | Readonly<{ status: "empty"; data: Value | undefined }>;

export interface ChatQueryOptions {
  readonly enabled?: boolean;
}

const PROVIDER_MISSING_ERROR = Object.freeze({
  code: "provider_missing",
  message: "This chat query must be rendered inside ChatProvider.",
  retryable: false,
} as const satisfies ChatQueryError);
const REFRESH_REQUIRED_ERROR = Object.freeze({
  code: "refresh_required",
  message: "The chat client must be refreshed before this query can run.",
  retryable: false,
} as const satisfies ChatQueryError);

const loading = <Value>(data?: Value): ChatQueryResult<Value> =>
  Object.freeze({ status: "loading", data });
const ready = <Value>(data: Value): ChatQueryResult<Value> =>
  Object.freeze({ status: "ready", data });
const empty = <Value>(data?: Value): ChatQueryResult<Value> =>
  Object.freeze({ status: "empty", data });
const failed = <Value>(
  error: ChatQueryError,
  data?: Value,
): ChatQueryResult<Value> => Object.freeze({ status: "error", data, error });

const providerError = (
  context: ChatContextValue | null,
): ChatQueryError | undefined => {
  if (context === null) return PROVIDER_MISSING_ERROR;
  if (context.readiness === "refresh_required") return REFRESH_REQUIRED_ERROR;
  if (context.error !== null) {
    return Object.freeze({
      code: "provider_error",
      message: context.error.message,
      retryable: true,
      ...(context.error.httpStatus === undefined
        ? {}
        : { httpStatus: context.error.httpStatus }),
    });
  }
  return undefined;
};

const resultError = (
  result: Exclude<ChatSnapshotQueryResult<unknown>, { status: "success" }>,
): ChatQueryError => Object.freeze({
  code: result.status,
  message: result.message,
  retryable:
    result.status === "transport" ||
    result.status === "authentication" ||
    result.status === "aborted" ||
    result.status === "closed",
  ...(!("httpStatus" in result) || result.httpStatus === undefined
    ? {}
    : { httpStatus: result.httpStatus }),
});

const shallowEqual = (
  left: readonly unknown[],
  right: readonly unknown[],
): boolean =>
  left === right ||
  (left.length === right.length && left.every((value, index) => value === right[index]));

const shallowRecordEqual = <Value extends object>(
  left: Value,
  right: Value,
): boolean => {
  if (left === right) return true;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length &&
    keys.every((key) =>
      (left as Record<string, unknown>)[key] ===
      (right as Record<string, unknown>)[key]);
};

const shallowRecordArrayEqual = <Value extends object>(
  left: readonly Value[],
  right: readonly Value[],
): boolean =>
  left === right ||
  (left.length === right.length && left.every((value, index) => {
    const other = right[index];
    if (other === undefined) return false;
    const keys = Object.keys(value);
    return keys.length === Object.keys(other).length &&
      keys.every((key) =>
        (value as Record<string, unknown>)[key] ===
        (other as Record<string, unknown>)[key]);
  }));

interface SelectorStore<Selection> {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => Selection;
  readonly getServerSnapshot: () => Selection;
}

const createSelectorStore = <Selection>(
  cache: NormalizedChatCache | undefined,
  selector: ChatCacheSelector<Selection>,
  equality: ChatCacheEquality<Selection>,
): SelectorStore<Selection> => {
  if (cache === undefined) {
    const snapshot = selector(EMPTY_NORMALIZED_CHAT_CACHE_STATE);
    return Object.freeze({
      subscribe: () => () => undefined,
      getSnapshot: () => snapshot,
      getServerSnapshot: () => snapshot,
    });
  }

  let snapshot = selector(cache.getState());
  const serverSnapshot = snapshot;
  return Object.freeze({
    subscribe(listener: () => void) {
      return cache.subscribe(
        selector,
        (selected) => {
          if (equality(snapshot, selected)) return;
          snapshot = selected;
          listener();
        },
        equality,
      );
    },
    getSnapshot() {
      const selected = selector(cache.getState());
      if (!equality(snapshot, selected)) snapshot = selected;
      return snapshot;
    },
    getServerSnapshot: () => serverSnapshot,
  });
};

/**
 * Low-level tearing-safe cache selector for custom headless view models.
 * A missing provider selects from the stable empty server snapshot.
 */
export function useChatSelector<Selection>(
  selector: ChatCacheSelector<Selection>,
  equality: ChatCacheEquality<Selection> = Object.is,
): Selection {
  const context = useContext(ChatContext);
  const store = useMemo(
    () => createSelectorStore(context?.client.cache, selector, equality),
    [context?.client.cache, equality, selector],
  );
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
  );
}

/** Returns the safe provider value, or null when rendered outside ChatProvider. */
export function useChat(): ChatContextValue | null {
  return useContext(ChatContext);
}

const useClientExternalStore = <Selection>(
  client: ChatClient | undefined,
  getSnapshot: (client: ChatClient) => Selection,
  subscribe: (client: ChatClient, listener: () => void) => () => void,
  fallback: Selection,
  equality: ChatCacheEquality<Selection> = Object.is,
): Selection => {
  const store = useMemo(() => {
    if (client === undefined) {
      return Object.freeze({
        subscribe: () => () => undefined,
        getSnapshot: () => fallback,
        getServerSnapshot: () => fallback,
      });
    }
    let snapshot = getSnapshot(client);
    const serverSnapshot = snapshot;
    return Object.freeze({
      subscribe: (listener: () => void) => subscribe(client, () => {
        const selected = getSnapshot(client);
        if (equality(snapshot, selected)) return;
        snapshot = selected;
        listener();
      }),
      getSnapshot: () => {
        const selected = getSnapshot(client);
        if (!equality(snapshot, selected)) snapshot = selected;
        return snapshot;
      },
      getServerSnapshot: () => serverSnapshot,
    });
  }, [client, equality, fallback, getSnapshot, subscribe]);
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
  );
};

export interface ConversationsQueryOptions extends ChatQueryOptions {
  readonly scope?: ConversationSnapshotScope;
  readonly limit?: number;
}

export interface ConversationsQueryData {
  readonly conversations: readonly ConversationListQueryConversation[];
  readonly nextCursor?: ConversationSnapshotCursor;
  readonly isLoadingMore: boolean;
  readonly loadMore: () => Promise<void>;
}

export type ConversationListQueryConversation = Conversation &
  Pick<ConversationListSnapshotSummary, "hasActiveHuddle">;

const ORGANIZATION_SCOPE = Object.freeze({ type: "organization" } as const);

const cacheIdentityKey = (
  state: NormalizedChatCacheState,
): string | undefined => state.identity === null
  ? undefined
  : JSON.stringify([
      state.identity.tenantId,
      state.identity.userId,
      state.identity.sessionId,
    ]);

export function useConversations(
  options: ConversationsQueryOptions = {},
): ChatQueryResult<ConversationsQueryData> {
  const context = useContext(ChatContext);
  const scope = options.scope ?? ORGANIZATION_SCOPE;
  const scopeKey = conversationSnapshotScopeKey(scope);
  const limit = options.limit ?? 50;
  const enabled = options.enabled !== false;
  const selector = useMemo<ChatCacheSelector<readonly unknown[]>>(
    () => (state) => Object.freeze([
      state.metadata.conversationLists[scopeKey],
      state.entities.conversations,
      state.metadata.conversationListActiveHuddles,
      cacheIdentityKey(state),
    ]),
    [scopeKey],
  );
  const selected = useChatSelector(selector, shallowEqual);
  const list = selected[0] as NormalizedChatCacheState["metadata"]["conversationLists"][string] | undefined;
  const conversationRecord = selected[1] as NormalizedChatCacheState["entities"]["conversations"];
  const activeHuddles = selected[2] as NormalizedChatCacheState["metadata"]["conversationListActiveHuddles"];
  const identityKey = selected[3] as string | undefined;
  const conversations = useMemo(
    () => Object.freeze((list?.conversationIds ?? EMPTY_ARRAY).flatMap((id) => {
      const conversation = conversationRecord[id];
      return conversation === undefined
        ? []
        : [Object.freeze({
            ...conversation,
            hasActiveHuddle: activeHuddles[id] ?? false,
          })];
    })),
    [activeHuddles, conversationRecord, list?.conversationIds],
  );
  const [requestError, setRequestError] = useState<ChatQueryError>();
  const [isLoadingMore, setLoadingMore] = useState(false);
  const canQuery = enabled && context?.isReady === true;

  useEffect(() => {
    // Restored lists are useful for initial rendering, but cannot establish
    // current discovery: creations and membership changes may have happened
    // since the snapshot. Refresh once for this active client/scope, without
    // letting hydration or pagination restart (or abort) the request.
    if (!canQuery || context === null) return;
    const controller = new AbortController();
    setRequestError(undefined);
    void context.client.listConversations({ scope, limit }, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted && result.status !== "success") {
          setRequestError(resultError(result));
        }
      });
    return () => controller.abort();
  }, [canQuery, context?.client, identityKey, limit, scopeKey]);

  const loadMore = useCallback(async (): Promise<void> => {
    if (context === null || !canQuery || list?.nextCursor === undefined) return;
    setLoadingMore(true);
    setRequestError(undefined);
    const result = await context.client.listConversations({
      scope,
      limit,
      cursor: list.nextCursor,
    });
    if (result.status !== "success") setRequestError(resultError(result));
    setLoadingMore(false);
  }, [canQuery, context?.client, limit, list?.nextCursor, scopeKey]);

  const data = useMemo<ConversationsQueryData>(() => Object.freeze({
    conversations,
    ...(list?.nextCursor === undefined ? {} : { nextCursor: list.nextCursor }),
    isLoadingMore,
    loadMore,
  }), [conversations, isLoadingMore, list?.nextCursor, loadMore]);
  const issue = providerError(context);
  if (issue !== undefined) return failed(issue, list === undefined ? undefined : data);
  if (requestError !== undefined) return failed(requestError, data);
  if (!enabled || list === undefined) return loading(list === undefined ? undefined : data);
  return conversations.length === 0 ? empty(data) : ready(data);
}

export function useConversation(
  conversationId: ConversationId,
  options: ChatQueryOptions = {},
): ChatQueryResult<Conversation> {
  const context = useContext(ChatContext);
  const enabled = options.enabled !== false;
  const selector = useMemo<ChatCacheSelector<readonly unknown[]>>(
    () => (state) => Object.freeze([
      state.entities.conversations[conversationId],
      state.metadata.conversationDetails[conversationId],
    ]),
    [conversationId],
  );
  const selected = useChatSelector(selector, shallowEqual);
  const conversation = selected[0] as Conversation | undefined;
  const hydrated = selected[1] !== undefined;
  const [requestError, setRequestError] = useState<ChatQueryError>();
  const canQuery = enabled && context?.isReady === true;

  useEffect(() => {
    if (!canQuery || hydrated || context === null) return;
    const controller = new AbortController();
    void context.client.getConversation({ conversationId }, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted && result.status !== "success") {
          setRequestError(resultError(result));
        }
      });
    return () => controller.abort();
  }, [canQuery, context?.client, conversationId, hydrated]);

  const issue = providerError(context);
  if (issue !== undefined) return failed(issue, conversation);
  if (requestError !== undefined) return failed(requestError, conversation);
  if (!enabled || !hydrated) return loading(conversation);
  return conversation === undefined ? empty(conversation as never) : ready(conversation);
}

export interface MessagesQueryOptions extends ChatQueryOptions {
  readonly limit?: number;
}

export interface MessagesQueryData {
  readonly messages: readonly ChatTimelineMessage[];
  readonly pagination: MessageTimelinePagination | undefined;
  readonly isLoadingOlder: boolean;
  readonly isLoadingNewer: boolean;
  readonly loadOlder: () => Promise<void>;
  readonly loadNewer: () => Promise<void>;
}

export function useMessages(
  conversationId: ConversationId,
  options: MessagesQueryOptions = {},
): ChatQueryResult<MessagesQueryData> {
  const context = useContext(ChatContext);
  const enabled = options.enabled !== false;
  const limit = options.limit ?? 50;
  const messagesSelector = useMemo(
    () => createConversationMessagesSelector(conversationId),
    [conversationId],
  );
  const selector = useMemo<ChatCacheSelector<readonly unknown[]>>(
    () => (state) => Object.freeze([
      state.timelines[conversationId],
      messagesSelector(state),
    ]),
    [conversationId, messagesSelector],
  );
  const selected = useChatSelector(selector, shallowEqual);
  const timeline = selected[0] as NormalizedChatCacheState["timelines"][ConversationId] | undefined;
  const messages = selected[1] as readonly ChatTimelineMessage[];
  const [requestError, setRequestError] = useState<ChatQueryError>();
  const [loadingDirection, setLoadingDirection] = useState<"older" | "newer">();
  const canQuery = enabled && context?.isReady === true;

  useEffect(() => {
    if (!canQuery || timeline !== undefined || context === null) return;
    const controller = new AbortController();
    void context.client.getMessageTimeline(
      { conversationId, direction: "backward", limit },
      { signal: controller.signal },
    ).then((result) => {
      if (!controller.signal.aborted && result.status !== "success") {
        setRequestError(resultError(result));
      }
    });
    return () => controller.abort();
  }, [canQuery, context?.client, conversationId, limit, timeline]);

  const load = useCallback(async (
    direction: "older" | "newer",
    cursor: MessageTimelineCursor | undefined,
  ): Promise<void> => {
    if (context === null || !canQuery || cursor === undefined) return;
    setLoadingDirection(direction);
    setRequestError(undefined);
    const result = await context.client.getMessageTimeline({
      conversationId,
      direction: direction === "older" ? "backward" : "forward",
      cursor,
      limit,
    });
    if (result.status !== "success") setRequestError(resultError(result));
    setLoadingDirection(undefined);
  }, [canQuery, context?.client, conversationId, limit]);
  const olderCursor = timeline?.pagination.older.available === true
    ? timeline.pagination.older.cursor
    : undefined;
  const newerCursor = timeline?.pagination.newer.available === true
    ? timeline.pagination.newer.cursor
    : undefined;
  const loadOlder = useCallback(() => load("older", olderCursor), [load, olderCursor]);
  const loadNewer = useCallback(() => load("newer", newerCursor), [load, newerCursor]);
  const data = useMemo<MessagesQueryData>(() => Object.freeze({
    messages,
    pagination: timeline?.pagination,
    isLoadingOlder: loadingDirection === "older",
    isLoadingNewer: loadingDirection === "newer",
    loadOlder,
    loadNewer,
  }), [loadNewer, loadOlder, loadingDirection, messages, timeline?.pagination]);

  const issue = providerError(context);
  if (issue !== undefined) return failed(issue, timeline === undefined ? undefined : data);
  if (requestError !== undefined) return failed(requestError, data);
  if (!enabled || timeline === undefined) return loading(timeline === undefined ? undefined : data);
  return messages.length === 0 ? empty(data) : ready(data);
}

export interface DirectoryUserQueryOptions extends ChatQueryOptions {
  readonly hydrate?: boolean;
}

export type DirectoryUsersQueryOptions = DirectoryUserQueryOptions;

interface DirectoryUsersObservedState {
  readonly client: ChatClient | undefined;
  readonly identityKey: string | undefined;
  readonly userIdsKey: string;
  readonly users: readonly HostDirectoryUserSummary[];
  readonly error?: ChatQueryError;
}

const selectDirectoryUsers = (
  client: ChatClient | undefined,
  userIds: readonly UserId[],
): readonly HostDirectoryUserSummary[] => Object.freeze(userIds.flatMap((userId) => {
  const user = client?.selectDirectoryUser(userId);
  return user === undefined ? [] : [user];
}));

const directoryFailureError = (
  result: ChatHostDirectoryFailure,
): ChatQueryError => Object.freeze({
  code: result.status,
  message: result.message,
  retryable: result.status === "transport" || result.status === "authentication",
  ...(!("httpStatus" in result) || result.httpStatus === undefined
    ? {}
    : { httpStatus: result.httpStatus }),
});

/**
 * Selects safe directory summaries in first-requested order and hydrates all
 * missing unique IDs through one client request.
 */
export function useDirectoryUsers(
  userIds: readonly UserId[],
  options: DirectoryUsersQueryOptions = {},
): ChatQueryResult<readonly HostDirectoryUserSummary[]> {
  const context = useContext(ChatContext);
  const client = context?.client;
  const enabled = options.enabled !== false;
  const shouldHydrate = options.hydrate !== false;
  const nextUserIds = [...new Set(userIds)];
  const userIdsKey = JSON.stringify(nextUserIds);
  const stableUserIds = useMemo<readonly UserId[]>(
    () => Object.freeze(nextUserIds),
    [userIdsKey],
  );
  const identitySelector = useMemo<ChatCacheSelector<string | undefined>>(
    () => cacheIdentityKey,
    [],
  );
  const identityKey = useChatSelector(identitySelector);
  const [observed, setObserved] = useState<DirectoryUsersObservedState>(() => Object.freeze({
    client,
    identityKey,
    userIdsKey,
    users: selectDirectoryUsers(client, stableUserIds),
  }));
  const current: DirectoryUsersObservedState = observed.client === client &&
      observed.identityKey === identityKey &&
      observed.userIdsKey === userIdsKey
    ? observed
    : Object.freeze({
        client,
        identityKey,
        userIdsKey,
        users: selectDirectoryUsers(client, stableUserIds),
      });
  const requestScope = useRef({ client, identityKey, userIdsKey });
  requestScope.current = { client, identityKey, userIdsKey };

  useEffect(() => {
    const cached = selectDirectoryUsers(client, stableUserIds);
    const missingUserIds = stableUserIds.filter(
      (userId) => client?.selectDirectoryUser(userId) === undefined,
    );
    setObserved(Object.freeze({ client, identityKey, userIdsKey, users: cached }));
    if (!enabled || !shouldHydrate || context?.isReady !== true ||
        client === undefined || missingUserIds.length === 0) return;
    const controller = new AbortController();
    const isCurrentRequest = (): boolean => {
      const scope = requestScope.current;
      return !controller.signal.aborted &&
        scope.client === client &&
        scope.identityKey === identityKey &&
        scope.userIdsKey === userIdsKey &&
        cacheIdentityKey(client.cache.getState()) === identityKey;
    };
    let retryTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const hydrate = (): void => {
      if (!isCurrentRequest()) return;
      void client.hydrateDirectoryUsers(missingUserIds, { signal: controller.signal })
        .then((result) => {
          if (!isCurrentRequest()) return;
          if (result.status === "success") {
            setObserved(Object.freeze({
              client,
              identityKey,
              userIdsKey,
              users: selectDirectoryUsers(client, stableUserIds),
            }));
          }
          else {
            setObserved(Object.freeze({
              client,
              identityKey,
              userIdsKey,
              users: cached,
              error: directoryFailureError(result),
            }));
            // Allow the directory's rate-limit window to expire without requiring
            // a remount or changing any conversation/thread state.
            if ("httpStatus" in result && result.httpStatus === 429) {
              retryTimer = globalThis.setTimeout(hydrate, 60_000);
            }
          }
        });
    };
    hydrate();
    return () => {
      controller.abort();
      globalThis.clearTimeout(retryTimer);
    };
  }, [client, context?.isReady, enabled, identityKey, shouldHydrate, stableUserIds, userIdsKey]);

  const issue = providerError(context);
  if (issue !== undefined) return failed(issue, current.users);
  if (current.error !== undefined) return failed(current.error, current.users);
  if (!enabled || (shouldHydrate && current.users.length < stableUserIds.length)) {
    return loading(current.users);
  }
  return current.users.length === 0 ? empty(current.users) : ready(current.users);
}

export function useDirectoryUser(
  userId: UserId,
  options: DirectoryUserQueryOptions = {},
): ChatQueryResult<HostDirectoryUserSummary> {
  const result = useDirectoryUsers([userId], options);
  const user = result.data?.[0];
  if (result.status === "loading") return loading(user);
  if (result.status === "error") return failed(result.error, user);
  return user === undefined ? empty(user as never) : ready(user);
}

export interface ConversationParticipantView {
  readonly userId: UserId;
  readonly user?: HostDirectoryUserSummary;
}

export interface ConversationParticipantsQueryData {
  readonly participantUserIds: readonly UserId[];
  readonly participants: readonly ConversationParticipantView[];
}

export type ConversationParticipantsQueryOptions = DirectoryUsersQueryOptions;

/**
 * Resolves the bounded participant projection already present in an accessible
 * conversation list. Authoritative detail membership supersedes that projection
 * without causing this hook to open conversation details.
 */
export function useConversationParticipants(
  conversationId: ConversationId,
  options: ConversationParticipantsQueryOptions = {},
): ChatQueryResult<ConversationParticipantsQueryData> {
  const enabled = options.enabled !== false;
  const selector = useMemo<ChatCacheSelector<readonly unknown[]>>(
    () => (state) => {
      const conversation = state.entities.conversations[conversationId];
      if (conversation === undefined) return Object.freeze([undefined]);
      const detailHydrated =
        state.metadata.conversationDetails[conversationId] !== undefined;
      return Object.freeze([
        detailHydrated
          ? state.entities.memberUserIdsByConversation[conversationId]
          : state.metadata.conversationListParticipantUserIds[conversationId],
      ]);
    },
    [conversationId],
  );
  const selected = useChatSelector(selector, shallowEqual);
  const participantUserIds = selected[0] as readonly UserId[] | undefined;
  const directory = useDirectoryUsers(participantUserIds ?? EMPTY_ARRAY, {
    enabled: enabled && participantUserIds !== undefined,
    ...(options.hydrate === undefined ? {} : { hydrate: options.hydrate }),
  });
  const data = useMemo<ConversationParticipantsQueryData | undefined>(() => {
    if (participantUserIds === undefined) return undefined;
    const usersById = new Map(
      (directory.data ?? EMPTY_ARRAY).map((user) => [user.userId, user]),
    );
    const participants = Object.freeze(participantUserIds.map((userId) => {
      const user = usersById.get(userId);
      return Object.freeze({
        userId,
        ...(user === undefined ? {} : { user }),
      });
    }));
    return Object.freeze({ participantUserIds, participants });
  }, [directory.data, participantUserIds]);

  if (directory.status === "error") return failed(directory.error, data);
  if (!enabled || participantUserIds === undefined || directory.status === "loading") {
    return loading(data);
  }
  return participantUserIds.length === 0
    ? empty(data as ConversationParticipantsQueryData)
    : ready(data as ConversationParticipantsQueryData);
}

export interface DirectorySearchQueryOptions extends ChatQueryOptions {
  readonly limit?: number;
}

export interface DirectorySearchQueryData {
  readonly query: string;
  readonly users: readonly HostDirectoryUserSummary[];
  readonly nextCursor?: string;
}

export function useDirectorySearch(
  query: string,
  options: DirectorySearchQueryOptions = {},
): ChatQueryResult<DirectorySearchQueryData> {
  const context = useContext(ChatContext);
  const client = context?.client;
  const enabled = options.enabled !== false;
  const limit = options.limit ?? 25;
  const getSnapshot = useCallback(
    (value: ChatClient) => value.getDirectorySearchState(),
    [],
  );
  const subscribe = useCallback(
    (value: ChatClient, listener: () => void) =>
      value.subscribeDirectorySearch(() => listener()),
    [],
  );
  const state = useClientExternalStore<ChatHostDirectorySearchState>(
    enabled ? client : undefined,
    getSnapshot,
    subscribe,
    EMPTY_DIRECTORY_SEARCH,
  );

  useEffect(() => {
    if (!enabled || context?.isReady !== true || query.trim().length === 0) {
      client?.cancelDirectorySearch();
      return;
    }
    const controller = new AbortController();
    void client?.searchDirectoryUsers({ query, limit }, { signal: controller.signal });
    return () => controller.abort();
  }, [client, context?.isReady, enabled, limit, query]);

  const data = useMemo<DirectorySearchQueryData>(() => Object.freeze({
    query: "query" in state ? state.query : query,
    users: state.state === "success" ? state.users : EMPTY_ARRAY,
    ...(state.state === "success" && state.nextCursor !== undefined
      ? { nextCursor: state.nextCursor }
      : {}),
  }), [query, state]);
  const issue = providerError(context);
  if (issue !== undefined) return failed(issue, data);
  if (!enabled || query.trim().length === 0) return empty(data);
  if (state.state === "error") {
    return failed(Object.freeze({
      code: state.failure.status,
      message: state.failure.message,
      retryable:
        state.failure.status === "transport" ||
        state.failure.status === "authentication",
      ...(!("httpStatus" in state.failure) || state.failure.httpStatus === undefined
        ? {}
        : { httpStatus: state.failure.httpStatus }),
    }), data);
  }
  if (state.state !== "success" || state.query !== query) return loading(data);
  return state.users.length === 0 ? empty(data) : ready(data);
}

export interface MessageSearchQueryOptions extends ChatQueryOptions {
  readonly filters?: MessageSearchFilters;
  readonly pageSize?: number;
}

export interface MessageSearchQueryData {
  readonly query: string;
  readonly hits: readonly MessageSearchHit[];
  readonly nextCursor?: MessageSearchCursor;
  readonly hasNextPage: boolean;
  readonly isLoadingMore: boolean;
  loadNextPage(): Promise<ChatMessageSearchResult | undefined>;
  cancel(): void;
}

const stableJsonKey = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? "undefined";
  } catch {
    return "invalid";
  }
};

/** Observes transient authorized search state without hydrating the normalized cache. */
export function useMessageSearch(
  query: string,
  options: MessageSearchQueryOptions = {},
): ChatQueryResult<MessageSearchQueryData> {
  const context = useContext(ChatContext);
  const client = context?.client;
  const enabled = options.enabled !== false;
  const pageSize = options.pageSize ?? 25;
  const filtersKey = stableJsonKey(options.filters);
  const filters = useMemo(() => options.filters, [filtersKey]);
  const normalizedQuery = typeof query === "string"
    ? normalizeMessageSearchQuery(query)
    : "";
  const getSnapshot = useCallback(
    (value: ChatClient) => value.getMessageSearchState(),
    [],
  );
  const subscribe = useCallback(
    (value: ChatClient, listener: () => void) =>
      value.subscribeMessageSearch(() => listener()),
    [],
  );
  const state = useClientExternalStore<ChatMessageSearchState>(
    client,
    getSnapshot,
    subscribe,
    EMPTY_MESSAGE_SEARCH,
  );

  useEffect(() => {
    if (!enabled || context?.isReady !== true || normalizedQuery.length === 0) {
      client?.cancelMessageSearch();
      return;
    }
    const controller = new AbortController();
    void client?.searchMessages({
      query: normalizedQuery,
      ...(filters === undefined ? {} : { filters }),
      pageSize,
    }, { signal: controller.signal });
    return () => controller.abort();
  }, [client, context?.isReady, enabled, filters, normalizedQuery, pageSize]);

  const loadNextPage = useCallback(async (): Promise<
    ChatMessageSearchResult | undefined
  > => {
    if (client === undefined || context?.isReady !== true || !enabled) return undefined;
    const current = client.getMessageSearchState();
    if (current.state === "idle" || current.query !== normalizedQuery ||
        current.nextCursor === undefined ||
        (current.state !== "success" && current.state !== "error")) {
      return undefined;
    }
    return client.searchMessages({
      query: normalizedQuery,
      ...(filters === undefined ? {} : { filters }),
      pageSize,
      cursor: current.nextCursor,
    });
  }, [client, context?.isReady, enabled, filters, normalizedQuery, pageSize]);

  const cancel = useCallback(() => client?.cancelMessageSearch(), [client]);
  const scopedState = state.state !== "idle" && state.query === normalizedQuery
    ? state
    : undefined;
  const data = useMemo<MessageSearchQueryData>(() => Object.freeze({
    query: normalizedQuery,
    hits: scopedState?.hits ?? EMPTY_ARRAY,
    ...(scopedState?.nextCursor === undefined
      ? {}
      : { nextCursor: scopedState.nextCursor }),
    hasNextPage: scopedState?.nextCursor !== undefined,
    isLoadingMore:
      (scopedState?.state === "scheduled" || scopedState?.state === "loading") &&
      scopedState.cursor !== undefined,
    loadNextPage,
    cancel,
  }), [cancel, loadNextPage, normalizedQuery, scopedState]);

  const issue = providerError(context);
  if (issue !== undefined) return failed(issue, data);
  if (!enabled || normalizedQuery.length === 0) return empty(data);
  if (scopedState?.state === "error") {
    const failure = scopedState.failure;
    return failed(Object.freeze({
      code: failure.status,
      message: failure.message,
      retryable:
        failure.status === "transport" ||
        failure.status === "authentication" ||
        failure.status === "aborted" ||
        failure.status === "closed",
      ...(!("httpStatus" in failure) || failure.httpStatus === undefined
        ? {}
        : { httpStatus: failure.httpStatus }),
    }), data);
  }
  if (scopedState === undefined ||
      ((scopedState.state === "scheduled" || scopedState.state === "loading") &&
        scopedState.cursor === undefined)) {
    return loading(data);
  }
  return data.hits.length === 0 ? empty(data) : ready(data);
}

export interface SavedMessagesQueryOptions extends ChatQueryOptions {
  readonly limit?: number;
}

export interface SavedMessagesQueryData {
  readonly items: readonly CurrentUserSavedMessageListItem[];
  readonly nextCursor: SavedMessageSnapshotCursor | null;
  readonly isLoadingMore: boolean;
  readonly loadMore: () => Promise<void>;
}

interface SavedPagesState {
  readonly client: ChatClient | undefined;
  readonly identityKey: string | undefined;
  readonly messageIds: readonly MessageId[];
  readonly nextCursor: SavedMessageSnapshotCursor | null;
  readonly initialized: boolean;
  readonly loadingMore: boolean;
  readonly error?: ChatQueryError;
}

export function useSavedMessages(
  options: SavedMessagesQueryOptions = {},
): ChatQueryResult<SavedMessagesQueryData> {
  const context = useContext(ChatContext);
  const client = context?.client;
  const enabled = options.enabled !== false;
  const limit = options.limit ?? 50;
  const identitySelector = useMemo<ChatCacheSelector<string | undefined>>(
    () => cacheIdentityKey,
    [],
  );
  const identityKey = useChatSelector(identitySelector);
  const [pages, setPages] = useState<SavedPagesState>(() => ({
    client,
    identityKey,
    messageIds: EMPTY_ARRAY,
    nextCursor: null,
    initialized: false,
    loadingMore: false,
  }));
  const currentPages = pages.client === client && pages.identityKey === identityKey ? pages : {
    client,
    identityKey,
    messageIds: EMPTY_ARRAY,
    nextCursor: null,
    initialized: false,
    loadingMore: false,
  };
  const savedSelector = useMemo<ChatCacheSelector<readonly unknown[]>>(
    () => (state) => Object.freeze([
      state.currentUser.savedMessages,
      state.currentUser.savedMessageRevisions,
      state.currentUser.pendingSavedMessageUpdates,
      state.currentUser.savedMessageUnavailableReasons,
      state.entities.messages,
      state.entities.conversations,
      state.currentUser.memberships,
      state.identity,
    ]),
    [],
  );
  const savedSources = useChatSelector(savedSelector, shallowEqual);
  const items = useMemo(() => {
    const state = context?.client.cache.getState();
    if (state === undefined) return EMPTY_ARRAY as readonly CurrentUserSavedMessageListItem[];
    return Object.freeze(currentPages.messageIds.flatMap((messageId) => {
      const savedMessage = state.currentUser.savedMessages[messageId];
      if (savedMessage?.isSaved !== true) return [];
      const pending = state.currentUser.pendingSavedMessageUpdates[messageId];
      const authoritativeSavedMessage = pending?.authoritativeSavedMessage ?? savedMessage;
      const explicitReason = state.currentUser.savedMessageUnavailableReasons[messageId];
      const message = state.entities.messages[messageId];
      const conversation = message === undefined
        ? undefined
        : state.entities.conversations[message.conversationId];
      const inaccessible = explicitReason ?? (
        message === undefined ||
        conversation === undefined ||
        conversation.archivedAt !== undefined ||
        (conversation.visibility === "private" &&
          state.currentUser.memberships[conversation.id]?.state !== "active")
          ? "inaccessible"
          : message.content === null
            ? "deleted"
            : undefined
      );
      return [Object.freeze({
        messageId,
        savedMessage,
        authoritativeSavedMessage,
        authoritativeRevision: state.currentUser.savedMessageRevisions[messageId] ?? 0,
        ...(pending === undefined ? {} : { pending }),
        message: inaccessible === undefined
          ? Object.freeze({ availability: "available" as const, current: message as ChatTimelineMessage })
          : Object.freeze({ availability: "unavailable" as const, reason: inaccessible }),
      })];
    }));
  }, [context?.client.cache, currentPages.messageIds, savedSources]);

  const requestPage = useCallback(async (
    cursor: SavedMessageSnapshotCursor | undefined,
  ): Promise<void> => {
    if (client === undefined || context?.isReady !== true || identityKey === undefined) return;
    setPages((state) => {
      const previous = state.client === client && state.identityKey === identityKey
        ? state
        : {
            client,
            identityKey,
            messageIds: EMPTY_ARRAY as readonly MessageId[],
            nextCursor: null,
            initialized: false,
            loadingMore: false,
          };
      const { error: _error, ...withoutError } = previous;
      return {
        ...withoutError,
        client,
        identityKey,
        loadingMore: cursor !== undefined,
      };
    });
    const result = await client.listSavedMessages({ limit, ...(cursor === undefined ? {} : { cursor }) });
    if (result.status !== "success") {
      setPages((state) => ({
        ...(state.client === client && state.identityKey === identityKey
          ? state
          : {
              client,
              identityKey,
              messageIds: EMPTY_ARRAY as readonly MessageId[],
              nextCursor: null,
              initialized: false,
              loadingMore: false,
            }),
        client,
        identityKey,
        initialized: true,
        loadingMore: false,
        error: resultError(result),
      }));
      return;
    }
    setPages((state) => {
      if (cacheIdentityKey(client.cache.getState()) !== identityKey) return state;
      const previous = state.client === client && state.identityKey === identityKey
        ? state.messageIds
        : EMPTY_ARRAY;
      const seen = new Set(previous);
      const messageIds = [...previous];
      for (const item of result.value.items) {
        if (!seen.has(item.messageId)) {
          seen.add(item.messageId);
          messageIds.push(item.messageId);
        }
      }
      return {
        client,
        identityKey,
        messageIds: Object.freeze(messageIds),
        nextCursor: result.value.page.nextCursor,
        initialized: true,
        loadingMore: false,
      };
    });
  }, [client, context?.isReady, identityKey, limit]);

  useEffect(() => {
    if (!enabled || context?.isReady !== true || currentPages.initialized) return;
    void requestPage(undefined);
  }, [context?.isReady, currentPages.initialized, enabled, requestPage]);
  const loadMore = useCallback(
    () => currentPages.nextCursor === null
      ? Promise.resolve()
      : requestPage(currentPages.nextCursor),
    [currentPages.nextCursor, requestPage],
  );
  const data = useMemo<SavedMessagesQueryData>(() => Object.freeze({
    items,
    nextCursor: currentPages.nextCursor,
    isLoadingMore: currentPages.loadingMore,
    loadMore,
  }), [currentPages.loadingMore, currentPages.nextCursor, items, loadMore]);
  const issue = providerError(context);
  if (issue !== undefined) return failed(issue, currentPages.initialized ? data : undefined);
  if (currentPages.error !== undefined) return failed(currentPages.error, data);
  if (!enabled || !currentPages.initialized) return loading(currentPages.initialized ? data : undefined);
  return items.length === 0 ? empty(data) : ready(data);
}

export interface MessageRemindersQueryOptions extends ChatQueryOptions {
  readonly limit?: number;
}

export interface MessageRemindersQueryData {
  readonly items: readonly CurrentUserMessageReminderListItem[];
  readonly nextCursor: MessageReminderSnapshotCursor | null;
  readonly isLoadingMore: boolean;
  readonly loadMore: () => Promise<void>;
}

interface ReminderPagesState {
  readonly client: ChatClient | undefined;
  readonly identityKey: string | undefined;
  readonly messageIds: readonly MessageId[];
  readonly nextCursor: MessageReminderSnapshotCursor | null;
  readonly initialized: boolean;
  readonly loadingMore: boolean;
  readonly error?: ChatQueryError;
}

export function useMessageReminders(
  options: MessageRemindersQueryOptions = {},
): ChatQueryResult<MessageRemindersQueryData> {
  const context = useContext(ChatContext);
  const client = context?.client;
  const enabled = options.enabled !== false;
  const limit = options.limit ?? 50;
  const identitySelector = useMemo<ChatCacheSelector<string | undefined>>(
    () => cacheIdentityKey,
    [],
  );
  const identityKey = useChatSelector(identitySelector);
  const [pages, setPages] = useState<ReminderPagesState>(() => ({
    client,
    identityKey,
    messageIds: EMPTY_ARRAY,
    nextCursor: null,
    initialized: false,
    loadingMore: false,
  }));
  const currentPages = pages.client === client && pages.identityKey === identityKey
    ? pages
    : {
        client,
        identityKey,
        messageIds: EMPTY_ARRAY as readonly MessageId[],
        nextCursor: null,
        initialized: false,
        loadingMore: false,
      };
  const reminderSelector = useMemo<ChatCacheSelector<readonly unknown[]>>(
    () => (state) => Object.freeze([
      state.currentUser.messageReminders,
      state.currentUser.messageReminderConversationIds,
      state.currentUser.messageReminderRevisions,
      state.currentUser.pendingMessageReminderUpdates,
      state.identity,
    ]),
    [],
  );
  const reminderSources = useChatSelector(reminderSelector, shallowEqual);
  const items = useMemo(() => {
    const state = context?.client.cache.getState();
    if (state === undefined) return EMPTY_ARRAY as readonly CurrentUserMessageReminderListItem[];
    return Object.freeze(currentPages.messageIds.flatMap((messageId) => {
      const reminder = state.currentUser.messageReminders[messageId];
      const conversationId = state.currentUser.messageReminderConversationIds[messageId];
      if (reminder?.state !== "scheduled" || conversationId === undefined) return [];
      const pending = state.currentUser.pendingMessageReminderUpdates[messageId];
      return [Object.freeze({
        conversationId,
        messageId,
        reminder,
        authoritativeReminder: pending?.authoritativeReminder ?? reminder,
        authoritativeRevision: state.currentUser.messageReminderRevisions[messageId] ?? 0,
        ...(pending === undefined ? {} : { pending }),
      })];
    }));
  }, [context?.client.cache, currentPages.messageIds, reminderSources]);

  const requestPage = useCallback(async (
    cursor: MessageReminderSnapshotCursor | undefined,
  ): Promise<void> => {
    if (client === undefined || context?.isReady !== true || identityKey === undefined) return;
    setPages((state) => {
      const previous = state.client === client && state.identityKey === identityKey
        ? state
        : {
            client,
            identityKey,
            messageIds: EMPTY_ARRAY as readonly MessageId[],
            nextCursor: null,
            initialized: false,
            loadingMore: false,
          };
      const { error: _error, ...withoutError } = previous;
      return { ...withoutError, client, identityKey, loadingMore: cursor !== undefined };
    });
    const result = await client.listMessageReminders({
      limit,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (result.status !== "success") {
      setPages((state) => ({
        ...(state.client === client && state.identityKey === identityKey ? state : {
          client,
          identityKey,
          messageIds: EMPTY_ARRAY as readonly MessageId[],
          nextCursor: null,
          initialized: false,
          loadingMore: false,
        }),
        client,
        identityKey,
        initialized: true,
        loadingMore: false,
        error: resultError(result),
      }));
      return;
    }
    setPages((state) => {
      if (cacheIdentityKey(client.cache.getState()) !== identityKey) return state;
      const previous = state.client === client && state.identityKey === identityKey
        ? state.messageIds
        : EMPTY_ARRAY;
      const seen = new Set(previous);
      const messageIds = [...previous];
      for (const item of result.value.items) {
        if (!seen.has(item.messageId)) {
          seen.add(item.messageId);
          messageIds.push(item.messageId);
        }
      }
      return {
        client,
        identityKey,
        messageIds: Object.freeze(messageIds),
        nextCursor: result.value.page.nextCursor,
        initialized: true,
        loadingMore: false,
      };
    });
  }, [client, context?.isReady, identityKey, limit]);

  useEffect(() => {
    if (!enabled || context?.isReady !== true || currentPages.initialized) return;
    void requestPage(undefined);
  }, [context?.isReady, currentPages.initialized, enabled, requestPage]);
  const loadMore = useCallback(
    () => currentPages.nextCursor === null
      ? Promise.resolve()
      : requestPage(currentPages.nextCursor),
    [currentPages.nextCursor, requestPage],
  );
  const data = useMemo<MessageRemindersQueryData>(() => Object.freeze({
    items,
    nextCursor: currentPages.nextCursor,
    isLoadingMore: currentPages.loadingMore,
    loadMore,
  }), [currentPages.loadingMore, currentPages.nextCursor, items, loadMore]);
  const issue = providerError(context);
  if (issue !== undefined) return failed(issue, currentPages.initialized ? data : undefined);
  if ("error" in currentPages && currentPages.error !== undefined) return failed(currentPages.error, data);
  if (!enabled || !currentPages.initialized) return loading(currentPages.initialized ? data : undefined);
  return items.length === 0 ? empty(data) : ready(data);
}

export interface ThreadQueryOptions extends ChatQueryOptions {
  readonly open?: boolean;
}

export interface ThreadQueryData {
  readonly rootMessage: ChatTimelineMessage;
  readonly summary: ThreadSummary | undefined;
  readonly opening: ChatThreadOpeningState;
  readonly thread: Conversation | undefined;
  readonly parentMessages: readonly ChatTimelineMessage[];
  readonly threadMessages: readonly ChatTimelineMessage[];
  readonly follow: CurrentUserThreadFollowState | undefined;
}

export function useThread(
  rootMessageId: MessageId,
  options: ThreadQueryOptions = {},
): ChatQueryResult<ThreadQueryData> {
  const context = useContext(ChatContext);
  const client = context?.client;
  const enabled = options.enabled !== false;
  const getOpening = useCallback(
    (value: ChatClient) => value.getThreadOpeningState(rootMessageId),
    [rootMessageId],
  );
  const subscribeOpening = useCallback(
    (value: ChatClient, listener: () => void) =>
      value.subscribeThreadOpening(rootMessageId, () => listener()),
    [rootMessageId],
  );
  const idleOpening = useMemo<ChatThreadOpeningState>(() => Object.freeze({
    state: "idle",
    rootMessageId,
  }), [rootMessageId]);
  const opening = useClientExternalStore(
    client,
    getOpening,
    subscribeOpening,
    idleOpening,
    shallowRecordEqual,
  );
  const selector = useMemo<ChatCacheSelector<readonly unknown[]>>(() => {
    const parentMessagesById = new Map<ConversationId, ChatCacheSelector<readonly ChatTimelineMessage[]>>();
    return (state) => {
      const root = state.entities.messages[rootMessageId];
      const threadId = opening.state === "ready"
        ? opening.threadConversationId
        : root?.isThreadRoot === true
          ? root.threadSummary.threadId
          : undefined;
      const parentId = root?.conversationId;
      const messagesFor = (conversationId: ConversationId | undefined) => {
        if (conversationId === undefined) return EMPTY_ARRAY;
        let value = parentMessagesById.get(conversationId);
        if (value === undefined) {
          value = createConversationMessagesSelector(conversationId);
          parentMessagesById.set(conversationId, value);
        }
        return value(state);
      };
      return Object.freeze([
        root,
        threadId === undefined ? undefined : state.entities.conversations[threadId],
        messagesFor(parentId),
        messagesFor(threadId),
        threadId === undefined ? undefined : state.currentUser.threadFollows[threadId],
        threadId === undefined ? undefined : state.currentUser.threadFollowRevisions[threadId],
        threadId === undefined ? undefined : state.currentUser.pendingThreadFollowUpdates[threadId],
      ]);
    };
  }, [opening, rootMessageId]);
  const selected = useChatSelector(selector, shallowEqual);
  const rootMessage = selected[0] as ChatTimelineMessage | undefined;
  const thread = selected[1] as Conversation | undefined;
  const parentMessages = selected[2] as readonly ChatTimelineMessage[];
  const threadMessages = selected[3] as readonly ChatTimelineMessage[];
  const threadId = opening.state === "ready"
    ? opening.threadConversationId
    : rootMessage?.isThreadRoot === true
      ? rootMessage.threadSummary.threadId
      : undefined;
  const follow = useMemo<CurrentUserThreadFollowState | undefined>(() => {
    if (threadId === undefined) return undefined;
    const projected = selected[4] as CurrentUserThreadFollowState["follow"] | undefined;
    const revision = selected[5] as number | undefined;
    const pending = selected[6] as CurrentUserThreadFollowState["pending"] | undefined;
    return Object.freeze({
      ...(projected === undefined ? {} : { follow: projected, authoritativeFollow: pending?.authoritativeFollow ?? projected }),
      authoritativeRevision: revision ?? 0,
      ...(pending === undefined ? {} : { pending }),
    });
  }, [selected, threadId]);

  useEffect(() => {
    if (!enabled || options.open !== true || context?.isReady !== true) return;
    // Recover cache replacement while mounted, but leave failed attempts at
    // the existing explicit Retry action instead of creating a request loop.
    if (opening.state !== "idle" &&
        !(opening.state === "ready" && (thread === undefined || rootMessage === undefined)) &&
        !(opening.state === "error" && opening.code === "root_message_unavailable" && rootMessage !== undefined)) return;
    void context.client.openThread(rootMessageId);
  }, [context?.client, context?.isReady, enabled, opening, options.open, rootMessage, rootMessageId, thread]);
  const data = useMemo<ThreadQueryData | undefined>(() => rootMessage === undefined
    ? undefined
    : Object.freeze({
        rootMessage,
        summary: rootMessage.isThreadRoot ? rootMessage.threadSummary : undefined,
        opening,
        thread,
        parentMessages,
        threadMessages,
        follow,
      }), [follow, opening, parentMessages, rootMessage, thread, threadMessages]);
  const issue = providerError(context);
  if (issue !== undefined) return failed(issue, data);
  if (opening.state === "error") return failed(Object.freeze({
    code: "runtime_error",
    message: opening.message,
    retryable:
      opening.code === "root_message_unavailable" ||
      opening.code === "cache_reconciliation_failed" ||
      opening.code === "command_failed" ||
      opening.code === "snapshot_failed" ||
      opening.code === "subscription_failed" ||
      opening.code === "closed",
    ...(opening.httpStatus === undefined ? {} : { httpStatus: opening.httpStatus }),
  }), data);
  if (!enabled || rootMessage === undefined || (options.open === true && opening.state === "loading")) {
    return loading(data);
  }
  return data?.summary === undefined ? empty(data as ThreadQueryData) : ready(data);
}

export interface ConversationMemberView {
  readonly userId: UserId;
  readonly membership?: ConversationMember;
  readonly user?: HostDirectoryUserSummary;
}

export interface MembersQueryData {
  readonly members: readonly ConversationMemberView[];
  /** Latest authoritative complete-member-list revision observed by the cache. */
  readonly memberListRevision?: number;
}

export function useMembers(
  conversationId: ConversationId,
  options: ChatQueryOptions = {},
): ChatQueryResult<MembersQueryData> {
  const context = useContext(ChatContext);
  const enabled = options.enabled !== false;
  const selector = useMemo<ChatCacheSelector<readonly unknown[]>>(
    () => (state) => Object.freeze([
      state.entities.memberUserIdsByConversation[conversationId],
      state.entities.membersByConversation[conversationId],
      state.metadata.conversationDetails[conversationId],
      state.metadata.memberListRevisions[conversationId],
    ]),
    [conversationId],
  );
  const selected = useChatSelector(selector, shallowEqual);
  const userIds = selected[0] as readonly UserId[] | undefined;
  const memberships = selected[1] as Readonly<Record<UserId, ConversationMember>> | undefined;
  const hydrated = selected[2] !== undefined;
  const memberListRevision = selected[3] as number | undefined;
  // Share directory recovery with participant/message queries so mounted member
  // labels refresh after a rate-limit cooldown without membership changes.
  const directory = useDirectoryUsers(userIds ?? EMPTY_ARRAY, { enabled });
  const members = useMemo(() => {
    const usersById = new Map(
      (directory.data ?? EMPTY_ARRAY).map((user) => [user.userId, user]),
    );
    return Object.freeze((userIds ?? EMPTY_ARRAY).map((userId) => {
      const membership = memberships?.[userId];
      const user = usersById.get(userId);
      return Object.freeze({
        userId,
        ...(membership === undefined ? {} : { membership }),
        ...(user === undefined ? {} : { user }),
      });
    }));
  }, [directory.data, memberships, userIds]);
  const data = useMemo(() => Object.freeze({
    members,
    ...(memberListRevision === undefined ? {} : { memberListRevision }),
  }), [memberListRevision, members]);
  const issue = providerError(context);
  if (issue !== undefined) return failed(issue, hydrated ? data : undefined);
  if (!enabled || !hydrated) return loading(hydrated ? data : undefined);
  return members.length === 0 ? empty(data) : ready(data);
}

export interface ReadStateQueryData {
  readonly readState: ConversationReadState;
  readonly unreadCount: number | undefined;
  readonly unreadMentionCount: number | undefined;
}

export function useReadState(
  conversationId: ConversationId,
): ChatQueryResult<ReadStateQueryData> {
  const context = useContext(ChatContext);
  const selector = useMemo<ChatCacheSelector<readonly unknown[]>>(
    () => (state) => Object.freeze([
      selectCurrentUserReadState(state, conversationId),
      selectConversationUnreadCount(state, conversationId),
      selectConversationUnreadMentionCount(state, conversationId),
      state.entities.conversations[conversationId],
    ]),
    [conversationId],
  );
  const selected = useChatSelector(selector, shallowEqual);
  const readState = selected[0] as ConversationReadState | undefined;
  const unreadCount = selected[1] as number | undefined;
  const unreadMentionCount = selected[2] as number | undefined;
  const knownConversation = selected[3] !== undefined;
  const data = useMemo<ReadStateQueryData | undefined>(() => readState === undefined
    ? undefined
    : Object.freeze({ readState, unreadCount, unreadMentionCount }), [
      readState,
      unreadCount,
      unreadMentionCount,
    ]);
  const issue = providerError(context);
  if (issue !== undefined) return failed(issue, data);
  if (!knownConversation) return loading(data);
  return data === undefined ? empty(data as never) : ready(data);
}

export interface DirectMessageReceiptQueryInput {
  readonly conversationId: ConversationId;
  readonly otherMemberReadState: ConversationReadState;
  readonly messageSequence: MessageSequence;
}

export function useDirectMessageReceipt(
  input: DirectMessageReceiptQueryInput,
): ChatQueryResult<boolean> {
  const context = useContext(ChatContext);
  const selector = useMemo<ChatCacheSelector<boolean | undefined>>(
    () => (state) => selectDirectMessageOtherUserRead(state, input),
    [input.conversationId, input.messageSequence, input.otherMemberReadState],
  );
  const value = useChatSelector(selector);
  const issue = providerError(context);
  if (issue !== undefined) return failed(issue, value);
  return value === undefined ? empty(value as never) : ready(value);
}

export function usePresence(
  userId?: UserId,
): ChatQueryResult<readonly CurrentUserPresenceState[]> {
  const context = useContext(ChatContext);
  const selector = useMemo<ChatCacheSelector<readonly CurrentUserPresenceState[]>>(
    () => (state) => {
      const values = selectPresenceSignals(state);
      return userId === undefined
        ? values
        : Object.freeze(values.filter((presence) => presence.userId === userId));
    },
    [userId],
  );
  const values = useChatSelector(
    selector,
    shallowRecordArrayEqual,
  );
  const issue = providerError(context);
  if (issue !== undefined) return failed(issue, values);
  return values.length === 0 ? empty(values) : ready(values);
}

export function useTyping(
  conversationId: ConversationId,
): ChatQueryResult<readonly ConversationTypingState[]> {
  const context = useContext(ChatContext);
  const selector = useMemo<ChatCacheSelector<readonly ConversationTypingState[]>>(
    () => (state) => selectTypingSignals(state, conversationId),
    [conversationId],
  );
  const values = useChatSelector(
    selector,
    shallowRecordArrayEqual,
  );
  const issue = providerError(context);
  if (issue !== undefined) return failed(issue, values);
  return values.length === 0 ? empty(values) : ready(values);
}

const draftRuntimeError = (state: ChatConversationDraftState): ChatQueryError | undefined => {
  if (state.status === "conflict") {
    return Object.freeze({
      code: "draft_conflict",
      message: state.conflict?.message ?? "This draft changed in another session.",
      retryable: false,
    });
  }
  if (state.status === "error" || state.status === "retryable") {
    return Object.freeze({
      code: "runtime_error",
      message: state.message ?? "The draft could not be synchronized.",
      retryable: state.status === "retryable",
    });
  }
  return undefined;
};

export function useDraft(
  conversationId: ConversationId,
  options: ChatQueryOptions = {},
): ChatQueryResult<ChatConversationDraftState> {
  const context = useContext(ChatContext);
  const client = context?.client;
  const enabled = options.enabled !== false;
  const fallback = useMemo<ChatConversationDraftState>(() => Object.freeze({
    conversationId,
    status: "idle",
    authoritativeRevision: 0,
    dirty: false,
  }), [conversationId]);
  const getSnapshot = useCallback(
    (value: ChatClient) => value.selectConversationDraft(conversationId),
    [conversationId],
  );
  const subscribe = useCallback(
    (value: ChatClient, listener: () => void) =>
      value.subscribeConversationDraft(conversationId, () => listener()),
    [conversationId],
  );
  const state = useClientExternalStore(
    client,
    getSnapshot,
    subscribe,
    fallback,
    shallowRecordEqual,
  );
  useEffect(() => {
    if (!enabled || context?.isReady !== true || state.status !== "idle") return;
    void context.client.openConversationDraft(conversationId);
  }, [context?.client, context?.isReady, conversationId, enabled, state.status]);
  const issue = providerError(context) ?? draftRuntimeError(state);
  if (issue !== undefined) return failed(issue, state);
  if (!enabled || state.status === "idle" || state.status === "hydrating") return loading(state);
  return state.draft === undefined ? empty(state) : ready(state);
}

export function useAttachmentUpload(
  uploadId: string,
): ChatQueryResult<ClientAttachmentUploadState> {
  const context = useContext(ChatContext);
  const selector = useMemo<ChatCacheSelector<ClientAttachmentUploadState | undefined>>(
    () => (state) => selectAttachmentUpload(state, uploadId),
    [uploadId],
  );
  const state = useChatSelector(selector);
  const issue = providerError(context);
  if (issue !== undefined) return failed(issue, state);
  return state === undefined ? empty(state as never) : ready(state);
}

export function useHuddle(
  conversationId: ConversationId,
  options: ChatQueryOptions = {},
): ChatQueryResult<ChatHuddleViewState> {
  const context = useContext(ChatContext);
  const client = context?.client;
  const enabled = options.enabled !== false;
  const fallback = useMemo<ChatHuddleViewState>(() => Object.freeze({
    conversationId,
    hydrationStatus: "idle",
    media: Object.freeze({ state: "idle" }),
  }), [conversationId]);
  const getSnapshot = useCallback(
    (value: ChatClient) => value.getHuddleState(conversationId),
    [conversationId],
  );
  const subscribe = useCallback(
    (value: ChatClient, listener: () => void) =>
      value.subscribeHuddle(conversationId, () => listener()),
    [conversationId],
  );
  const state = useClientExternalStore(
    enabled ? client : undefined,
    getSnapshot,
    subscribe,
    fallback,
    shallowRecordEqual,
  );
  useEffect(() => {
    if (!enabled || context?.isReady !== true || conversationId === "") return;
    return context.client.realtime?.subscribeConversation(conversationId);
  }, [context?.client, context?.isReady, conversationId, enabled]);
  useEffect(() => {
    if (!enabled || context?.isReady !== true || state.hydrationStatus !== "idle") return;
    void context.client.hydrateHuddle(conversationId);
  }, [context?.client, context?.isReady, conversationId, enabled, state.hydrationStatus]);
  const issue = providerError(context);
  if (issue !== undefined) return failed(issue, state);
  if (state.hydrationStatus === "error" || state.media.state === "error") {
    const mediaError = state.media.state === "error" ? state.media : undefined;
    return failed(Object.freeze({
      code: "runtime_error",
      message: mediaError?.message ?? "Huddle state could not be loaded.",
      retryable: mediaError?.retryable ?? true,
      ...(mediaError?.httpStatus === undefined ? {} : { httpStatus: mediaError.httpStatus }),
    }), state);
  }
  if (!enabled || state.hydrationStatus === "idle" || state.hydrationStatus === "loading") {
    return loading(state);
  }
  return state.canonicalState === undefined ? empty(state) : ready(state);
}
