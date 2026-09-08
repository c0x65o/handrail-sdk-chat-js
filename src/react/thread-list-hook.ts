import { useCallback, useContext, useMemo, useSyncExternalStore } from "react";
import type { ChatThreadListQuery, ChatThreadListState } from "../client/thread-list.js";
import { ChatContext } from "./index.js";

/** Observe authorized channel discovery. Opening a selected canonical thread is a separate action. */
export function useThreadList(input: ChatThreadListQuery) {
  const context = useContext(ChatContext);
  const runtime = context?.client.threadList;
  const query = useMemo(() => ({ parentConversationId: input.parentConversationId,
    view: input.view ?? "active", limit: input.limit ?? 50 }), [input.parentConversationId, input.view, input.limit]);
  const idle = useMemo<ChatThreadListState>(() => Object.freeze({ ...query,
    status: "idle", items: [], empty: false, hasMore: false }), [query]);
  const subscribe = useCallback((listener: () => void) => runtime?.subscribe(query, listener) ?? (() => undefined), [runtime, query]);
  const snapshot = useCallback(() => runtime?.getState(query) ?? idle, [runtime, query, idle]);
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  const actions = useMemo(() => ({
    refresh: () => runtime?.refresh(query) ?? Promise.resolve(idle),
    loadMore: () => runtime?.loadMore(query) ?? Promise.resolve(idle),
    retry: () => runtime?.retry(query) ?? Promise.resolve(idle),
  }), [runtime, query, idle]);
  return { ...state, actions };
}
