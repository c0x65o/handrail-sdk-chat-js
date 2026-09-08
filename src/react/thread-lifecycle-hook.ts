import { useCallback, useContext, useEffect, useMemo, useSyncExternalStore } from "react";
import type { ChatThreadLifecycleState } from "../client/thread-lifecycle.js";
import type { ConversationId } from "../contracts/identifiers.js";
import { ChatContext } from "./index.js";

/** Headless shared lifecycle. Unmount/dismissal only releases the observer. */
export function useThreadLifecycle(threadId: ConversationId, parentConversationId: ConversationId) {
  const context = useContext(ChatContext);
  const runtime = context?.client.threadLifecycle;
  const idle = useMemo<ChatThreadLifecycleState>(() => Object.freeze({
    threadId, parentConversationId, status: "idle", legacy: false, actionsAvailable: false,
  }), [threadId, parentConversationId]);
  const subscribe = useCallback((listener: () => void) =>
    runtime?.subscribe(threadId, listener) ?? (() => undefined), [runtime, threadId]);
  const snapshot = useCallback(() => {
    const current = runtime?.getState(threadId);
    return current?.parentConversationId === parentConversationId ? current : idle;
  }, [runtime, threadId, parentConversationId, idle]);
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    if (context?.isReady) void runtime?.load(threadId, parentConversationId);
  }, [runtime, threadId, parentConversationId, context?.isReady]);
  const actions = useMemo(() => ({
    reload: () => runtime?.load(threadId, parentConversationId) ?? Promise.resolve(idle),
    close: () => runtime?.close(threadId) ?? Promise.resolve(idle),
    reopen: () => runtime?.reopen(threadId) ?? Promise.resolve(idle),
    lock: () => runtime?.lock(threadId) ?? Promise.resolve(idle),
    unlock: () => runtime?.unlock(threadId) ?? Promise.resolve(idle),
    retry: () => runtime?.retry(threadId) ?? Promise.resolve(idle),
  }), [runtime, threadId, parentConversationId, idle]);
  return { ...state, actions };
}
