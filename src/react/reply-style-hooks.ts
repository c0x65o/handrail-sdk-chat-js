import { useContext, useEffect, useMemo, useSyncExternalStore } from "react";
import type { ChatReplyStyle, ChatReplyStyleState } from "../client/reply-style-runtime.js";
import { ChatContext } from "./index.js";

const unavailable: ChatReplyStyleState = Object.freeze({
  effectiveStyle: "current", origin: "fallback", resolutionReason: "supported",
  confirmedPreference: undefined, requestedStyle: undefined, loading: false,
  loadStatus: "idle", saveStatus: "idle", capability: "unknown",
  editingAvailable: false, disabledReason: "identity_required",
  loadError: undefined, saveError: undefined, reconciliationRequired: false,
  pendingInput: undefined, result: undefined,
});

/** Observe confirmed and requested preference state; reconnect hydration belongs to the client. */
export function useReplyStyle(): ChatReplyStyleState {
  const context = useContext(ChatContext);
  const runtime = context?.client.replyStyle;
  const store = useMemo(() => {
    const serverSnapshot = runtime?.getState() ?? unavailable;
    return {
      subscribe: (listener: () => void) => runtime?.subscribe(listener) ?? (() => undefined),
      getSnapshot: () => runtime?.getState() ?? unavailable,
      getServerSnapshot: () => serverSnapshot,
    };
  }, [runtime]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  useEffect(() => {
    // An unresolved failed read requires explicit retry, not an effect-driven loop.
    if (context?.isReady && runtime?.getState().loadStatus === "idle") void runtime.load();
  }, [runtime, context?.isReady]);
  return state;
}

export type ReplyStyleActions = Pick<ChatReplyStyle, "load" | "update" | "retry">;

/** Stable actions for the current provider binding. Retry preserves runtime reconciliation. */
export function useReplyStyleActions(): ReplyStyleActions {
  const runtime = useContext(ChatContext)?.client.replyStyle;
  return useMemo(() => ({
    load: () => runtime?.load() ?? Promise.resolve(unavailable),
    update: (style) => runtime?.update(style) ?? Promise.resolve(unavailable),
    retry: () => runtime?.retry() ?? Promise.resolve(unavailable),
  }), [runtime]);
}
