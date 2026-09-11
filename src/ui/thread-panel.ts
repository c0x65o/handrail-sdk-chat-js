import {
  createElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactElement,
  type RefObject,
} from "react";

import type { ConversationId, MessageId } from "../contracts/index.js";
import {
  useChat,
  useChatActions,
  useMessages,
  useChatSelector,
  useDirectoryUser,
  useReadState,
  useReplyStyle,
  useThread,
  useThreadLifecycle,
  type ThreadQueryData,
} from "../react/index.js";
import {
  MessageComposer,
  type MessageComposerProps,
} from "./message-composer.js";
import {
  MessageTimeline,
  type MessageTimelineProps,
} from "./message-timeline.js";

import type { ChatComposerControls } from "./slots.js";
import { NotificationPreferences } from "./notification-preferences.js";

export interface ThreadPanelProps {
  /** Identity of the immutable message in the parent conversation. */
  readonly rootMessageId: MessageId;
  /** Open authorized history by canonical ID, including unavailable roots. */
  readonly threadConversationId?: ConversationId;
  readonly parentConversationId?: ConversationId;
  readonly ariaLabel?: string;
  readonly className?: string;
  readonly closeLabel?: string;
  /** A controlled panel remains mounted until its host handles this request. */
  readonly onClose?: () => void;
  /** Overrides the element focused when a controlled close is requested. */
  readonly returnFocusRef?: RefObject<HTMLElement | null>;
  readonly pageSize?: number;
  readonly currentUserId?: MessageTimelineProps["currentUserId"];
  readonly resolveMessageMutationAvailability?: MessageTimelineProps["resolveMessageMutationAvailability"];
  /**
   * Preferred shortcut order for reply aggregates. Keys do not create empty
   * chips; picker selections and canonical aggregates outside the list remain
   * available through the shared MessageTimeline behavior.
   */
  readonly reactionKeys?: readonly string[];
  readonly timelineSlots?: MessageTimelineProps["slots"];
  readonly composerComponents?: MessageComposerProps["components"];
  readonly composerAvailability?: MessageComposerProps["availability"];
  /**
   * Explicit host authorization for shared lifecycle controls, scoped to this
   * thread and parent. Unknown authority grants no controls. Resolve management
   * and send policy independently; following and reply style confer neither.
   * Runtime readiness and server authorization still apply.
   */
  readonly lifecycleAvailability?: { readonly canManage?: boolean; readonly canSend?: boolean };
  readonly composerPlaceholder?: string;
  readonly readOnly?: boolean;
}

const joinClassNames = (...values: readonly (string | undefined)[]): string =>
  values.filter((value): value is string => value !== undefined && value.length > 0).join(" ");

const actionSucceeded = (result: unknown): boolean =>
  typeof result !== "object" || result === null || !("status" in result) || result.status === "success";

const actionMessage = (result: unknown, fallback: string): string => {
  if (typeof result === "object" && result !== null && "status" in result && result.status === "transport") {
    return "The chat service could not be reached. Check your connection and try again.";
  }
  if (typeof result !== "object" || result === null || !("message" in result)) return fallback;
  return typeof result.message === "string" && result.message.trim().length > 0
    ? result.message
    : fallback;
};

type PanelData = Omit<ThreadQueryData, "rootMessage" | "opening"> & {
  readonly rootMessage?: ThreadQueryData["rootMessage"];
  readonly opening: ThreadQueryData["opening"] | ReturnType<NonNullable<ReturnType<typeof useChat>>["client"]["getExistingThreadOpeningState"]>;
};

interface ThreadRootContextProps {
  readonly data: PanelData & { readonly rootMessage: ThreadQueryData["rootMessage"] };
  readonly parentLabel: string;
}

interface ThreadRetryProps {
  readonly rootMessageId: MessageId;
  readonly threadConversationId?: ConversationId;
}

function ThreadRetry({ rootMessageId, threadConversationId }: ThreadRetryProps): ReactElement {
  const chat = useChat();
  const actions = useChatActions();
  const [retrying, setRetrying] = useState(false);

  const retry = async (): Promise<void> => {
    setRetrying(true);
    try {
      if (threadConversationId !== undefined) await chat?.client.openExistingThread(threadConversationId);
      else await actions.openThread(rootMessageId);
    } finally {
      setRetrying(false);
    }
  };

  return createElement(
    "button",
    {
      className: "handrail-chat__button",
      disabled: retrying,
      onClick: () => void retry(),
      type: "button",
    },
    retrying ? "Retrying…" : "Retry",
  );
}

function ThreadRootContext({ data, parentLabel }: ThreadRootContextProps): ReactElement {
  const root = data.rootMessage;
  const authorResult = useDirectoryUser(root.author.userId);
  const author = authorResult.data;
  const authorName = author?.kind === "active"
    ? author.displayName
    : author?.kind === "redacted"
      ? "Hidden user"
      : "Unknown user";
  const body = root.content === null
    ? "This message was deleted."
    : root.content.text;

  return createElement(
    "article",
    {
      "aria-label": "Thread root message",
      "aria-readonly": "true",
      className: "handrail-chat__thread-root",
      "data-parent-conversation-id": root.conversationId,
      "data-root-message-id": root.id,
    },
    createElement(
      "div",
      { className: "handrail-chat__thread-root-meta" },
      createElement("strong", null, authorName),
      createElement("time", { dateTime: root.createdAt }, new Date(root.createdAt).toLocaleString()),
      createElement("span", { className: "handrail-chat__thread-parent" }, `In ${parentLabel}`),
    ),
    createElement(
      "p",
      {
        className: joinClassNames(
          "handrail-chat__thread-root-text",
          root.content === null ? "handrail-chat__thread-root-text--deleted" : undefined,
        ),
      },
      body,
    ),
  );
}

interface ResolvedThreadProps extends ThreadPanelProps {
  readonly data: PanelData;
  readonly binding?: { readonly id: ConversationId; readonly parentConversationId: ConversationId };
}

function ResolvedThread({
  composerComponents,
  composerAvailability,
  composerPlaceholder,
  lifecycleAvailability,
  data,
  binding,
  currentUserId,
  pageSize,
  reactionKeys,
  resolveMessageMutationAvailability,
  readOnly,
  timelineSlots,
}: ResolvedThreadProps): ReactElement {
  const thread = data.thread?.type === "thread" ? data.thread : binding;
  if (thread === undefined) {
    return createElement(
      "div",
      { className: "handrail-chat__thread-state", role: "status" },
      "Preparing thread…",
    );
  }

  return createElement(ConnectedThread, {
    data,
    threadId: thread.id,
    parentConversationId: thread.parentConversationId,
    ...(lifecycleAvailability === undefined ? {} : { lifecycleAvailability }),
    ...(currentUserId === undefined ? {} : { currentUserId }),
    ...(composerComponents === undefined ? {} : { composerComponents }),
    ...(composerAvailability === undefined ? {} : { composerAvailability }),
    ...(composerPlaceholder === undefined ? {} : { composerPlaceholder }),
    ...(pageSize === undefined ? {} : { pageSize }),
    ...(reactionKeys === undefined ? {} : { reactionKeys }),
    ...(resolveMessageMutationAvailability === undefined
      ? {}
      : { resolveMessageMutationAvailability }),
    ...(readOnly === undefined ? {} : { readOnly }),
    ...(timelineSlots === undefined ? {} : { timelineSlots }),
  });
}

interface ConnectedThreadProps {
  readonly data: PanelData;
  readonly threadId: ConversationId;
  readonly parentConversationId: ConversationId;
  readonly lifecycleAvailability?: ThreadPanelProps["lifecycleAvailability"];
  readonly currentUserId?: MessageTimelineProps["currentUserId"];
  readonly pageSize?: number;
  readonly reactionKeys?: readonly string[];
  readonly resolveMessageMutationAvailability?: MessageTimelineProps["resolveMessageMutationAvailability"];
  readonly timelineSlots?: MessageTimelineProps["slots"];
  readonly composerComponents?: MessageComposerProps["components"];
  readonly composerAvailability?: MessageComposerProps["availability"];
  readonly composerPlaceholder?: string;
  readonly readOnly?: boolean;
}

function ConnectedThread({
  composerComponents,
  composerAvailability,
  composerPlaceholder,
  lifecycleAvailability,
  parentConversationId,
  data,
  currentUserId,
  pageSize,
  reactionKeys,
  resolveMessageMutationAvailability,
  readOnly,
  threadId,
  timelineSlots,
}: ConnectedThreadProps): ReactElement {
  const composerControlsRef = useRef<ChatComposerControls>(null);
  const currentThreadIdRef = useRef(threadId);
  currentThreadIdRef.current = threadId;
  const selectReply = useCallback<ChatComposerControls["selectReply"]>((source) => {
    if (source.conversationId !== currentThreadIdRef.current) return;
    composerControlsRef.current?.selectReply(source);
  }, []);
  const focusReplyComposer = useCallback(() => composerControlsRef.current?.focus?.(), []);
  const actions = useChatActions(threadId);
  const discord = useReplyStyle().effectiveStyle === "discord";
  const readResult = useReadState(threadId);
  const lifecycle = useThreadLifecycle(threadId, parentConversationId);
  const archived = useChatSelector(state =>
    state.entities.conversations[threadId]?.archivedAt !== undefined ||
    state.entities.conversations[parentConversationId]?.archivedAt !== undefined) === true;
  const cachedLifecycle = data.thread?.threadLifecycle;
  const canonical = cachedLifecycle !== undefined &&
    cachedLifecycle.revision > (lifecycle.lifecycle?.revision ?? 0)
    ? cachedLifecycle : lifecycle.lifecycle;
  const closed = canonical?.closedAt !== undefined;
  const locked = canonical?.locked === true;
  const denied = lifecycle.error === "access_revoked";
  const sendRestriction = archived
    ? "This thread or its parent is administratively archived. Sending is unavailable. Your draft is retained."
    : locked ? "This thread is locked. Sending is unavailable until it is unlocked. Your draft is retained."
    : denied ? "Thread access was denied. Sending is unavailable. Your draft is retained." : undefined;
  const availability = {
    ...composerAvailability,
    ...(sendRestriction !== undefined || lifecycleAvailability?.canSend === false ? { canSend: false } : {}),
  };
  const canManage = lifecycleAvailability?.canManage === true && readOnly !== true;
  const canSend = lifecycleAvailability?.canSend === true && readOnly !== true &&
    composerAvailability?.canSend !== false &&
    (composerAvailability?.membershipState === undefined || composerAvailability.membershipState === "active");
  const [actionStatus, setActionStatus] = useState("");
  const [busyAction, setBusyAction] = useState<"read">();
  const followInFlight = useRef(false);
  const followButtonRef = useRef<HTMLButtonElement>(null);
  const restoreSubscriptionFocus = useRef(false);
  const [followBusy, setFollowBusy] = useState(false);
  const [retryFollow, setRetryFollow] = useState<boolean>();
  const following = (data.follow?.pending === undefined
    ? data.follow?.follow : data.follow.pending.authoritativeFollow)?.isFollowing === true;
  const followPending = data.follow?.pending?.state === "pending";
  const followLabel = following ? discord ? "Leave" : "Unfollow" : discord ? "Join" : "Follow";
  useEffect(() => {
    if (!followBusy && restoreSubscriptionFocus.current) {
      restoreSubscriptionFocus.current = false;
      followButtonRef.current?.focus();
    }
  }, [followBusy]);
  const unreadCount = readResult.data?.unreadCount ?? data.summary?.unreadCount ?? 0;
  const latestSequence = data.threadMessages.reduce(
    (latest, message) => Math.max(latest, message.sequence),
    0,
  );

  const updateFollow = async (desired = !following): Promise<void> => {
    if (followInFlight.current || followPending || denied || readOnly) return;
    followInFlight.current = true;
    restoreSubscriptionFocus.current = document.activeElement?.textContent === "Retry subscription";
    setFollowBusy(true);
    setRetryFollow(undefined);
    setActionStatus("Saving thread subscription…");
    try {
      const result = await (desired ? actions.followThread() : actions.unfollowThread());
      const intentSatisfied = result.status === "success" &&
        result.value.follow.isFollowing === desired;
      if (!intentSatisfied) setRetryFollow(desired);
      const retryLabel = desired ? discord ? "Join" : "Follow" : discord ? "Leave" : "Unfollow";
      setActionStatus(intentSatisfied
        ? desired ? discord ? "Thread joined." : "Thread followed." : discord ? "Thread left. History and preferences are retained." : "Thread unfollowed."
        : result.status === "success" && result.value.reconciliationStatus === "follow_revision_conflict"
          ? `The thread follow state changed elsewhere. You are ${result.value.follow.isFollowing ? "still following" : "not following"} this thread. Select ${retryLabel} to try again, or Retry subscription.`
          : `${actionMessage(result, "The thread follow setting could not be changed.")} Select Retry subscription to try again.`);
    } catch {
      setRetryFollow(desired);
      setActionStatus("The thread follow setting could not be changed. Select Retry subscription to try again.");
    } finally {
      followInFlight.current = false;
      setFollowBusy(false);
    }
  };

  const markRead = async (): Promise<void> => {
    setBusyAction("read");
    setActionStatus("");
    try {
      const result = await actions.markRead({ throughSequence: latestSequence });
      setActionStatus(actionSucceeded(result)
        ? "Thread marked as read."
        : actionMessage(result, "The thread could not be marked as read."));
    } catch {
      setActionStatus("The thread could not be marked as read.");
    } finally {
      setBusyAction(undefined);
    }
  };

  return createElement(
    "div",
    {
      className: "handrail-chat__thread-conversation",
      "data-thread-conversation-id": threadId,
      "data-thread-opening": data.opening.state === "ready" && "reconciliationStatus" in data.opening
        ? data.opening.reconciliationStatus
        : data.opening.state,
    },
    createElement("div", { className: "handrail-chat__thread-content" },
    createElement(
      "div",
      { className: "handrail-chat__thread-summary" },
      createElement(
        "span",
        null,
        `${data.summary?.replyCount ?? data.threadMessages.length} ${
          (data.summary?.replyCount ?? data.threadMessages.length) === 1 ? "reply" : "replies"
        }`,
      ),
      createElement("span", { "aria-live": "polite" }, `${unreadCount} unread`),
      createElement(
        "span",
        null,
        `${data.summary?.participantIds.length ?? 0} ${
          (data.summary?.participantIds.length ?? 0) === 1 ? "participant" : "participants"
        }`,
      ),
    ),
    createElement("div", null, createElement(
      "div",
      { "aria-label": "Thread controls", className: "handrail-chat__thread-controls", role: "group" },
      createElement(
        "button",
        {
          "aria-pressed": following,
          ref: followButtonRef,
          className: "handrail-chat__thread-action",
          "aria-busy": followPending || followBusy,
          disabled: followPending || followBusy || denied || readOnly === true,
          onClick: () => void updateFollow(),
          type: "button",
        },
        followLabel,
      ),
      retryFollow === undefined ? null : createElement("button", {
        type: "button", className: "handrail-chat__thread-action",
        disabled: followPending || followBusy || denied || readOnly === true,
        onClick: () => void updateFollow(retryFollow),
      }, "Retry subscription"),
      createElement(ThreadNotificationPreferences, { key: threadId, threadId, readOnly: readOnly === true || denied }),
      createElement(
        "button",
        {
          className: "handrail-chat__thread-action",
          disabled: latestSequence <= 0 || unreadCount === 0 || busyAction === "read",
          onClick: () => void markRead(),
          type: "button",
        },
        busyAction === "read" ? "Marking read…" : "Mark read",
      ),
    ),
    createElement(ThreadLifecycleControls, { lifecycle, closed, locked, archived, canManage, canSend }),
    sendRestriction !== undefined || closed ? createElement("p", { className: "handrail-chat__thread-controls" },
      createElement("span", { role: "status", "aria-live": "polite" }, sendRestriction ?? (closed
        ? "This thread is closed. An authorized send will reopen the discussion automatically."
        : null))) : null),
    data.thread === undefined || denied ? null : createElement(MessageTimeline, {
      ariaLabel: "Thread replies",
      onReplyRequested: selectReply,
      onThreadReplyRequested: focusReplyComposer,
      replyAvailability: availability,
      readOnly: readOnly ?? false,
      conversationId: threadId,
      ...(currentUserId === undefined ? {} : { currentUserId }),
      ...(pageSize === undefined ? {} : { pageSize }),
      ...(reactionKeys === undefined ? {} : { reactionKeys }),
      ...(resolveMessageMutationAvailability === undefined
        ? {}
        : { resolveMessageMutationAvailability }),
      ...(timelineSlots === undefined ? {} : { slots: timelineSlots }),
    }),
    ),
    createElement(MessageComposer, {
      controlsRef: composerControlsRef,
      availability,
      conversationId: threadId,
      inputLabel: "Reply to thread",
      readOnly: readOnly ?? false,
      ...(composerComponents === undefined ? {} : { components: composerComponents }),
      ...(composerPlaceholder === undefined ? {} : { placeholder: composerPlaceholder }),
    }),
    createElement(
      "div",
      { "aria-atomic": "true", "aria-live": "polite", className: "handrail-chat__status", role: "status" },
      followPending || followBusy ? "Saving thread subscription…" : actionStatus,
    ),
  );
}

/** Never pass optimistic preference projections off as confirmed settings. */
function ThreadNotificationPreferences({ threadId, readOnly }: {
  readonly threadId: ConversationId;
  readonly readOnly: boolean;
}): ReactElement {
  const chat = useChat();
  const actions = useChatActions(threadId);
  const pending = useChatSelector(state => state.currentUser.pendingPreferenceUpdates[threadId]);
  const preference = useChatSelector(state => {
    const update = state.currentUser.pendingPreferenceUpdates[threadId];
    return update === undefined ? state.currentUser.preferences[threadId] : update.authoritativePreference;
  });
  const [loadState, setLoadState] = useState<"idle" | "loading" | "error">("idle");
  const inFlight = useRef(false);
  const load = useCallback(async () => {
    if (inFlight.current || !chat?.isReady || readOnly) return;
    inFlight.current = true;
    setLoadState("loading");
    try { await chat.client.getConversation({ conversationId: threadId }); }
    catch { /* The unavailable state provides an explicit retry. */ }
    finally { inFlight.current = false; setLoadState("error"); }
  }, [chat?.client, chat?.isReady, readOnly, threadId]);
  useEffect(() => {
    if (preference === undefined && pending === undefined && loadState === "idle") void load();
  }, [preference, pending, loadState, load]);
  return createElement("div", null,
    preference === undefined ? createElement("div", { role: "status", "aria-live": "polite" },
      loadState === "loading" ? "Loading thread notification preferences…" : "Thread notification preferences are unavailable.",
      createElement("button", { type: "button", className: "handrail-chat__thread-action",
        disabled: loadState === "loading" || pending?.state === "pending" || !chat?.isReady || readOnly,
        onClick: () => void load() }, "Retry notification preferences"))
      : createElement(NotificationPreferences, { actions, preference,
          readOnly, externalPending: pending?.state === "pending",
          triggerLabelPrefix: "Thread notification preferences" }),
    pending?.state === "pending" ? createElement("span", { role: "status" }, "Saving thread notification preferences…") : null,
  );
}

/** Navigation never calls these shared discussion commands. */
function ThreadLifecycleControls({ lifecycle, closed, locked, archived, canManage, canSend }: {
  readonly lifecycle: ReturnType<typeof useThreadLifecycle>;
  readonly closed: boolean;
  readonly locked: boolean;
  readonly archived: boolean;
  readonly canManage: boolean;
  readonly canSend: boolean;
}): ReactElement {
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const updating = busy || lifecycle.status === "updating";
  const denied = lifecycle.error === "access_revoked";
  const ready = !archived && !denied && lifecycle.actionsAvailable;
  const visible = !archived && !denied && (ready || lifecycle.status === "updating");
  const retryIntent = lifecycle.pendingInput?.intent;
  const retryAllowed = retryIntent === undefined ||
    (retryIntent === "reopen" ? canSend && !locked : canManage);
  const needsRetry = failed || lifecycle.status === "error" || lifecycle.status === "conflict" ||
    lifecycle.status === "unavailable";
  const run = async (action: keyof typeof lifecycle.actions): Promise<void> => {
    if (inFlight.current || updating) return;
    inFlight.current = true;
    setBusy(true);
    setFailed(false);
    try { await lifecycle.actions[action](); }
    catch { setFailed(true); }
    finally { inFlight.current = false; setBusy(false); }
  };
  const status = denied ? "Thread lifecycle change denied. Your draft is retained."
    : updating ? "Updating thread…"
    : lifecycle.status === "loading" || lifecycle.status === "idle" ? "Loading thread lifecycle…"
    : lifecycle.status === "conflict" ? "The thread changed elsewhere. The current state is shown. Retry repeats the original request."
    : failed || lifecycle.status === "error" ? "The thread lifecycle could not be updated or loaded. Your draft is retained."
    : !ready ? "Thread lifecycle controls are unavailable."
    : locked ? "Thread locked. Unlocking leaves the discussion closed."
    : closed ? "Thread closed." : "Thread open.";
  const button = (action: "close" | "reopen" | "lock" | "unlock", label: string) => createElement("button", {
    key: action, type: "button", className: "handrail-chat__thread-action",
    disabled: updating || !ready, onClick: () => { if (ready) void run(action); },
  }, label);
  return createElement("div", { className: "handrail-chat__thread-controls", "aria-busy": updating },
    createElement("p", { role: denied || failed || lifecycle.status === "error" ? "alert" : "status", "aria-live": "polite" }, status),
    createElement("div", { role: "group", "aria-label": "Shared thread lifecycle", className: "handrail-chat__thread-controls" },
      visible && canManage && !closed ? button("close", "Close thread") : null,
      visible && canSend && closed && !locked ? button("reopen", "Reopen thread") : null,
      visible && canManage ? locked ? button("unlock", "Unlock thread") : button("lock", "Lock thread") : null,
      needsRetry && !denied && !archived && retryAllowed && (retryIntent === undefined || ready)
        ? createElement("button", { type: "button", className: "handrail-chat__thread-action",
            disabled: updating, onClick: () => void run("retry") }, "Retry lifecycle") : null,
    ),
  );
}

const threadCloseIcon = (): ReactElement => createElement(
  "svg",
  {
    "aria-hidden": true,
    className: "handrail-chat__thread-close-icon",
    fill: "none",
    focusable: "false",
    stroke: "currentColor",
    strokeLinecap: "round",
    strokeWidth: 1.8,
    viewBox: "0 0 20 20",
  },
  createElement("path", { d: "m5 5 10 10M15 5 5 15" }),
);

/**
 * Focused optional thread surface built exclusively from public React hooks and
 * conversation-bound UI primitives. The parent root remains read-only while
 * replies, pagination, drafts, unread state, and actions bind to the thread.
 */
function ThreadPanelSurface({
  ariaLabel,
  className,
  closeLabel = "Close panel",
  onClose,
  returnFocusRef,
  rootMessageId,
  threadConversationId,
  parentConversationId,
  result,
  ...contentProps
}: ThreadPanelProps & { result: { status: string; data?: PanelData | undefined; error?: { message: string; retryable: boolean } | undefined } }): ReactElement {
  const panelRef = useRef<HTMLElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const closeRequestedRef = useRef(false);
  const focusMovedRef = useRef(false);
  // Retain only destination IDs, never revoked history, so an access denial can
  // disable the mounted composer without discarding its local draft/uploads.
  const retainedBinding = useRef<{ root: MessageId; id: ConversationId; parentConversationId: ConversationId } | undefined>(undefined);
  if (retainedBinding.current?.root !== rootMessageId) retainedBinding.current = undefined;
  if (result.status !== "error" && result.data?.opening.state === "ready" && result.data.thread?.type === "thread") {
    retainedBinding.current = { root: rootMessageId, id: result.data.thread.id,
      parentConversationId: result.data.thread.parentConversationId };
  }

  useLayoutEffect(() => {
    if (focusMovedRef.current) return;
    focusMovedRef.current = true;
    const activeElement = document.activeElement;
    openerRef.current = activeElement instanceof HTMLElement && activeElement.isConnected
      ? activeElement
      : null;
    panelRef.current?.focus();
  }, []);

  const restoreFocus = useCallback(() => {
    const target = returnFocusRef?.current ?? openerRef.current;
    if (target?.isConnected === true) target.focus();
  }, [returnFocusRef]);

  useEffect(() => () => {
    if (closeRequestedRef.current) restoreFocus();
  }, [restoreFocus]);

  const requestClose = useCallback(() => {
    if (onClose === undefined) return;
    closeRequestedRef.current = true;
    onClose();
    queueMicrotask(restoreFocus);
  }, [onClose, restoreFocus]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== "Escape" || onClose === undefined || event.defaultPrevented) return;
    event.preventDefault();
    requestClose();
  };

  const parentLabel = useChatSelector(useCallback(state => {
    const root = state.entities.messages[rootMessageId];
    const parentId = parentConversationId ?? root?.conversationId;
    const parent = parentId === undefined ? undefined : state.entities.conversations[parentId];
    if (parent === undefined) return "parent conversation";
    if (parent.type === "channel") return parent.name;
    if (parent.type === "direct") return "direct conversation";
    if (parent.type === "group_direct") return parent.name ?? "group conversation";
    return "parent conversation";
  }, [rootMessageId, parentConversationId]));
  const data = result.data;
  const threadName = data?.thread?.name ?? "Thread";
  const loading = result.status === "loading" || data?.opening.state === "loading";
  let body: ReactElement;
  if (retainedBinding.current !== undefined) {
    const safeData: PanelData = data ?? {
      opening: { state: "idle", rootMessageId }, summary: undefined, thread: undefined,
      parentMessages: [], threadMessages: [], follow: undefined,
    };
    body = createElement(ResolvedThread, { ...contentProps, data: safeData, rootMessageId,
      binding: retainedBinding.current });
  } else if (loading) {
    body = createElement(
      "div",
      { "aria-busy": "true", className: "handrail-chat__thread-state", role: "status" },
      "Opening thread…",
    );
  } else if (result.status === "error" && result.error !== undefined) {
    body = createElement(
      "div",
      { className: "handrail-chat__thread-state handrail-chat__thread-state--error", role: "alert" },
      createElement("h3", null, "Thread unavailable"),
      createElement("p", null, result.error.message),
      result.error.retryable
        ? createElement(ThreadRetry, { rootMessageId, ...(threadConversationId === undefined ? {} : { threadConversationId }) })
        : null,
    );
  } else if (data === undefined || (threadConversationId === undefined && data.summary === undefined)) {
    body = createElement(
      "div",
      { className: "handrail-chat__thread-state", role: "status" },
      createElement("h3", null, "Thread unavailable"),
      createElement("p", null, "The root message is unavailable or cannot start a thread."),
    );
  } else {
    body = createElement(ResolvedThread, { ...contentProps, data, rootMessageId });
  }

  return createElement(
    "aside",
    {
      "aria-label": ariaLabel ?? threadName,
      className: joinClassNames("handrail-chat__thread-panel", className),
      "data-handrail-focus": "",
      "data-handrail-thread-panel": "",
      onKeyDown,
      ref: panelRef,
      tabIndex: -1,
    },
    createElement(
      "header",
      { className: "handrail-chat__thread-header" },
      createElement("h2", null, data?.thread?.name ?? ariaLabel ?? "Thread"),
      onClose === undefined
        ? null
        : createElement(
            "button",
            {
              "aria-label": closeLabel,
              className: "handrail-chat__thread-close",
              onClick: requestClose,
              type: "button",
            },
            threadCloseIcon(),
          ),
    ),
    data === undefined ? null : data.rootMessage === undefined
      ? createElement("p", { className: "handrail-chat__thread-root", role: "status" }, `In ${parentLabel} · Root message unavailable`)
      : createElement(ThreadRootContext, { data: { ...data, rootMessage: data.rootMessage }, parentLabel }),
    retainedBinding.current !== undefined && result.status === "error" && result.error !== undefined
      ? createElement("div", { className: "handrail-chat__thread-state handrail-chat__thread-state--recovery", role: "alert" },
          createElement("p", null, result.error.message),
          result.error.retryable ? createElement(ThreadRetry, { rootMessageId,
            ...(threadConversationId === undefined ? {} : { threadConversationId }) }) : null)
      : null,
    body,
  );
}


function RootThreadPanel(props: ThreadPanelProps): ReactElement {
  const result = useThread(props.rootMessageId, { open: true });
  return createElement(ThreadPanelSurface, { ...props, result });
}

function ExistingThreadPanel(props: ThreadPanelProps & { threadConversationId: ConversationId }): ReactElement {
  const chat = useChat();
  const client = chat?.client;
  const id = props.threadConversationId;
  const idle = useMemo(() => ({ state: "idle" as const, threadConversationId: id }), [id]);
  // Normalize the uncached idle getter to a stable external-store snapshot.
  const snapshot = useCallback(() => {
    const value = client?.getExistingThreadOpeningState(id);
    return value === undefined || value.state === "idle" ? idle : value;
  }, [client, id, idle]);
  const subscribe = useCallback((listener: () => void) =>
    client?.subscribeExistingThreadOpening(id, listener) ?? (() => undefined), [client, id]);
  const opening = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    if (chat?.isReady !== true || opening.state !== "idle" || props.parentConversationId === undefined) return;
    // The public runtime publishes sanitized errors and resolves all opening attempts.
    void client?.openExistingThread(id);
  }, [client, chat?.isReady, id, opening.state, props.parentConversationId]);
  const cache = useChatSelector(state => state);
  const messages = useMessages(id, { enabled: false });
  const thread = cache?.entities.conversations[id];
  const parent = props.parentConversationId === undefined ? undefined : cache?.entities.conversations[props.parentConversationId];
  const member = parent === undefined ? undefined : cache?.currentUser.memberships[parent.id];
  const valid = opening.state === "ready" && opening.threadConversationId === id &&
    opening.rootMessageId === props.rootMessageId && opening.parentConversationId === props.parentConversationId &&
    thread?.type === "thread" && thread.id === id && thread.rootMessageId === props.rootMessageId &&
    thread.parentConversationId === props.parentConversationId && thread.tenantId === cache?.identity?.tenantId &&
    parent !== undefined && parent.tenantId === cache?.identity?.tenantId &&
    (member === undefined || (member.state === "active" && member.userId === cache?.identity?.userId));
  const root = valid && opening.rootContext !== "unavailable" ? cache?.entities.messages[props.rootMessageId] : undefined;
  const safeRoot = root?.conversationId === props.parentConversationId ? root : undefined;
  const follow = cache?.currentUser.threadFollows[id];
  const pending = cache?.currentUser.pendingThreadFollowUpdates[id];
  const data: PanelData | undefined = !valid ? undefined : {
    ...(safeRoot === undefined ? {} : { rootMessage: safeRoot }),
    summary: safeRoot?.isThreadRoot ? safeRoot.threadSummary : undefined,
    opening, thread, parentMessages: [], threadMessages: messages.data?.messages ?? [],
    follow: { authoritativeRevision: cache?.currentUser.threadFollowRevisions[id] ?? 0,
      ...(follow === undefined ? {} : { follow }), ...(pending === undefined ? {} : { pending }) },
  };
  return createElement(ThreadPanelSurface, { ...props, result: {
    status: opening.state === "error" ? "error" : opening.state === "idle" || opening.state === "loading" ? "loading" : "ready",
    data,
    ...(opening.state === "error" ? { error: { message: "The thread could not be loaded.", retryable: true } } : {}),
  } });
}

/** Root links retain reconciliation; discovery uses read-only canonical history opening. */
export function ThreadPanel(props: ThreadPanelProps): ReactElement {
  return props.threadConversationId === undefined
    ? createElement(RootThreadPanel, props)
    : createElement(ExistingThreadPanel, { ...props, key: props.threadConversationId, threadConversationId: props.threadConversationId });
}
