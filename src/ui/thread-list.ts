import { createElement, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import type { ConversationId, MessageId } from "../contracts/index.js";
import { useChat, useChatSelector, useThreadList } from "../react/index.js";

export interface ThreadListSelection {
  readonly threadConversationId: ConversationId;
  readonly parentConversationId: ConversationId;
  readonly rootMessageId: MessageId;
}
export interface ThreadListProps {
  readonly parentConversationId: ConversationId;
  readonly parentLabel: string;
  readonly onOpen: (selection: ThreadListSelection, returnFocusTarget: HTMLElement) => void;
  readonly onBack: () => void;
  /** A denied parent list invalidates any history opened from this discovery. */
  readonly onUnavailable?: () => void;
  /** Keep discovery subscribed while its selected history is visible. */
  readonly hidden?: boolean;
  readonly pageSize?: number;
}

/** Authorized discovery only; follow, membership and read mutations remain explicit actions. */
export function ThreadList({ parentConversationId, parentLabel, onOpen, onBack, onUnavailable, hidden = false, pageSize = 50 }: ThreadListProps): ReactElement {
  const chat = useChat();
  const identity = useChatSelector(state => state.identity === null ? "" : JSON.stringify([state.identity.tenantId, state.identity.userId]));
  const scope = useMemo(() => ({}), [chat?.client, identity, parentConversationId]);
  const [view, setView] = useState<"active" | "all">("active");
  const list = useThreadList({ parentConversationId, view, limit: pageSize });
  const [focusedId, setFocusedId] = useState<ConversationId>();
  const [openingId, setOpeningId] = useState<ConversationId>();
  const [openError, setOpenError] = useState(false);
  const rows = useRef(new Map<ConversationId, HTMLButtonElement>());
  const backRef = useRef<HTMLButtonElement>(null);
  const attempt = useRef(0);
  const current = useRef({ scope, list, hidden });
  current.current = { scope, list, hidden };
  useEffect(() => () => { attempt.current++; }, [scope]);
  useLayoutEffect(() => {
    if (list.status === "unavailable") onUnavailable?.();
  }, [list.status, onUnavailable]);
  const capability = useRef({ scope, supported: false });
  if (capability.current.scope !== scope || list.status === "unavailable") capability.current = { scope, supported: false };
  else if (list.result !== undefined) capability.current.supported = list.result.lifecycleSupported || Boolean(list.result.inactivityPolicy);
  // Keep the view buttons mounted while the next view loads, preserving keyboard focus.
  const controlsSupported = capability.current.supported;
  const busy = ["idle", "loading", "refreshing", "loading_more"].includes(list.status);
  const items = list.status === "unavailable" ? [] : list.items;
  const tabStop = items.some(item => item.thread.id === focusedId) ? focusedId : items[0]?.thread.id;
  useLayoutEffect(() => {
    if (!hidden) (tabStop === undefined ? backRef.current : rows.current.get(tabStop))?.focus();
  }, [hidden, scope]);
  // When authorization or refreshed discovery removes the focused row, retain a useful list focus.
  useLayoutEffect(() => {
    if (!hidden && focusedId !== undefined && !items.some(item => item.thread.id === focusedId)) {
      (tabStop === undefined ? backRef.current : rows.current.get(tabStop))?.focus();
    }
  }, [hidden, items, focusedId, tabStop]);

  const open = async (id: ConversationId, target: HTMLButtonElement): Promise<void> => {
    const row = current.current.list.items.find(item => item.thread.id === id);
    if (!row || !chat?.isReady || current.current.scope !== scope || current.current.hidden) return;
    const token = ++attempt.current;
    setOpeningId(id); setOpenError(false);
    try {
      const result = await chat.client.openExistingThread(id);
      if (token !== attempt.current || current.current.scope !== scope || current.current.hidden) return;
      const stillAuthorized = current.current.list.status !== "unavailable" && current.current.list.items.some(item =>
        item.thread.id === id && item.thread.rootMessageId === row.thread.rootMessageId);
      if (result.state !== "ready" || !stillAuthorized || result.threadConversationId !== id ||
          result.parentConversationId !== parentConversationId || result.rootMessageId !== row.thread.rootMessageId ||
          row.thread.parentConversationId !== parentConversationId) {
        setOpenError(true); return;
      }
      onOpen({ threadConversationId: id, parentConversationId, rootMessageId: result.rootMessageId }, target);
    } catch {
      if (token === attempt.current && current.current.scope === scope) setOpenError(true);
    } finally {
      if (token === attempt.current && current.current.scope === scope) setOpeningId(undefined);
    }
  };
  const navigate = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const next = event.key === "ArrowDown" ? (index + 1) % items.length
      : event.key === "ArrowUp" ? (index + items.length - 1) % items.length
      : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : undefined;
    if (next === undefined) return;
    event.preventDefault(); rows.current.get(items[next]!.thread.id)?.focus();
  };
  return createElement("section", { className: "handrail-chat__thread-list", "aria-label": `Threads in ${parentLabel}`, hidden,
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); attempt.current++; onBack(); }
    } },
    createElement("header", null,
      createElement("h2", null, "Channel threads"),
      createElement("button", { type: "button", ref: backRef, onClick: () => { attempt.current++; onBack(); } }, `Back to ${parentLabel}`)),
    controlsSupported ? createElement("div", { role: "group", "aria-label": "Thread discovery view" },
      ...(["active", "all"] as const).map(value => createElement("button", { key: value, type: "button", "aria-pressed": view === value,
        onClick: () => { attempt.current++; setOpeningId(undefined); setOpenError(false); setView(value); } }, value === "active" ? "Active threads" : "All threads"))) : null,
    createElement("button", { type: "button", disabled: busy, onClick: () => void list.actions.refresh() }, "Refresh threads"),
    busy ? createElement("p", { role: "status", "aria-live": "polite" }, list.status === "loading_more" ? "Loading more threads…" : list.status === "refreshing" ? "Refreshing threads…" : "Loading threads…") : null,
    list.status === "unavailable" ? createElement("p", { role: "status" }, "Channel threads are unavailable.") : null,
    list.status === "error" ? createElement("div", { role: "alert" },
      "Threads could not be loaded. ", createElement("button", { type: "button", onClick: () => void list.actions.retry() }, "Retry threads")) : null,
    list.empty && list.status === "ready" ? createElement("p", { role: "status" }, "No threads yet.") : null,
    createElement("ul", { "aria-label": "Channel threads", "aria-busy": busy }, ...items.map((item, index) => {
      const thread = item.thread;
      const name = thread.name ?? "Unnamed thread";
      const unread = Math.max(0, thread.latestSequence - thread.currentReadState.lastReadSequence);
      return createElement("li", { key: thread.id }, createElement("button", {
        type: "button", "data-thread-id": thread.id, tabIndex: tabStop === thread.id ? 0 : -1,
        ref: (element: HTMLButtonElement | null) => { if (element) rows.current.set(thread.id, element); else rows.current.delete(thread.id); },
        onFocus: () => setFocusedId(thread.id), onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => navigate(event, index),
        onClick: (event) => void open(thread.id, event.currentTarget),
      }, createElement("strong", null, name),
      createElement("span", null, item.currentThreadFollow.follow?.isFollowing === true ? "Following" : "Not following"),
      createElement("span", null, `${unread} unread`),
      openingId === thread.id ? createElement("span", { role: "status" }, "Opening thread…") : null));
    })),
    openError ? createElement("p", { role: "alert" }, "The thread could not be opened. Select it again to retry.") : null,
    list.hasMore ? createElement("button", { type: "button", disabled: busy || list.status === "error", onClick: () => void list.actions.loadMore() }, "Load more threads") : null);
}
