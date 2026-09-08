import { useThreadCreationRestriction } from "./thread-creation-dialog.js";
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";

import type {
  NormalizedChatCacheState,
  PendingMessageReminderUpdate,
  PendingSavedMessageUpdate,
} from "../client/index.js";
import type {
  CanonicalMessageReminder,
  ConversationId,
  ConversationReadState,
  HostDirectoryUserSummary,
  IsoTimestamp,
  MessageBlock,
  MessageId,
  MessageContextRequest,
  UserId,
} from "../contracts/index.js";
import {
  ChatContext,
  useChatActions,
  useChatSelector,
  useDirectMessageReceipt,
  useDirectoryUsers,
  useMessages,
  useReadState,
  useReplyStyle,
  useThread,
  type ChatActions,
  type MessagesQueryData,
} from "../react/index.js";
import type {
  ChatComposerControls,
  ChatAttachmentViewModel,
  ChatEntityReferenceViewModel,
  ChatLinkPreviewViewModel,
  ChatMessageActions,
  ChatReplyContextViewModel,
  ChatMessageReminderActionOutcome,
  ChatMessageReminderViewModel,
  ChatMessageSavedActionOutcome,
  ChatMessageSavedViewModel,
  ChatMessageViewModel,
  ChatConversationIntroductionViewModel,
  ChatSystemEventViewModel,
  ChatWorkspaceSlots,
  ChatWorkspaceSlotOverrides,
} from "./slots.js";
import type { MessageComposerAvailability } from "./message-composer.js";
import { ReactionPicker, type ReactionPickerReactionKey } from "./reaction-picker.js";
import {
  calculateTimelineAnchorOffsetCorrection,
  calculateTimelineWindow,
  type TimelineWindowAnchor,
  type TimelineWindowRow,
} from "./timeline-window.js";

type TimelineMessage = MessagesQueryData["messages"][number];
type TimelineSlots = Pick<
  ChatWorkspaceSlots,
  "Avatar" | "Message" | "EmptyState" | "Attachment" | "LinkPreview" | "SystemEvent" | "EntityReference"
>;

/** Minimal public message identity passed to a host availability resolver. */
export interface MessageMutationTarget {
  readonly id: MessageId;
  readonly conversationId: ConversationId;
  readonly authorUserId: UserId;
}

/** Host-authoritative mutation availability projected to message renderers. */
export interface MessageMutationAvailability {
  readonly canEdit: boolean;
  readonly canDelete: boolean;
}

export type MessageMutationAvailabilityResolver = (
  message: MessageMutationTarget,
) => MessageMutationAvailability | undefined;

/** Renderer-safe source data used by a host-owned Forward destination picker. */
export interface MessageForwardRequest {
  readonly sourceMessageId: MessageId;
  readonly sourceConversationId: ConversationId;
  readonly preview: string;
}

/** Optional imperative coordination for an external/default composer. */
export interface MessageTimelineEditController {
  /** Returns false without changing focus when no default editable row exists. */
  readonly requestLatestMessageEdit: (
    returnFocusTarget: HTMLElement | null,
  ) => boolean;
  /** Mounts an already-loaded message so an external navigator can locate it. */
  readonly revealMessage: (messageId: MessageId) => boolean;
}

export interface MessageTimelineProps {
  readonly conversationId: ConversationId;
  /** Optional display-only context for a conversation-specific empty state. */
  readonly introduction?: ChatConversationIntroductionViewModel;
  readonly ariaLabel?: string;
  readonly className?: string;
  readonly pageSize?: number;
  readonly slots?: Pick<
    ChatWorkspaceSlotOverrides,
    "Avatar" | "Message" | "EmptyState" | "Attachment" | "LinkPreview" | "SystemEvent" | "EntityReference"
  >;
  /**
   * Preferred shortcut order for canonical reaction aggregates. Configured keys
   * never create empty chips; the picker still accepts any catalog-backed key,
   * and existing canonical keys outside this list remain visible and toggleable.
   */
  readonly reactionKeys?: readonly string[];
  /** Trusted host identity used only for the fail-closed author default. */
  readonly currentUserId?: UserId;
  /**
   * Optional host-authoritative override. Returning `undefined` uses the
   * author default; a returned result replaces it so either action can be
   * granted or revoked independently.
   */
  readonly resolveMessageMutationAvailability?: MessageMutationAvailabilityResolver;
  /** Optional ref used to coordinate the default timeline with a composer. */
  readonly editControllerRef?: Ref<MessageTimelineEditController>;
  /**
   * An authorized cursor for the other participant in a one-to-one direct
   * conversation. The public receipt hook validates the conversation and actor.
   */
  readonly otherMemberReadState?: ConversationReadState;
  /** Selects a source in the current conversation composer; never changes destination. */
  readonly onReplyRequested?: ChatComposerControls["selectReply"];
  /** Restrictions on inline Reply; Current thread entry points keep their legacy behavior. */
  readonly readOnly?: boolean;
  readonly replyAvailability?: MessageComposerAvailability;
  /** Notifies a composing host after the public open-thread action resolves. */
  readonly onOpenThread?: (
    rootMessageId: ChatMessageViewModel["id"],
    returnFocusTarget: HTMLElement | null,
  ) => void;
  /** Requests an explicit named-thread dialog independently of inline Reply. */
  readonly onCreateThread?: MessageTimelineProps["onOpenThread"];
  /** Opens a host-owned destination picker for an eligible canonical message. */
  readonly onForwardMessage?: (
    request: MessageForwardRequest,
    returnFocusTarget: HTMLElement | null,
  ) => void;
}

const joinClassNames = (...values: readonly (string | undefined)[]): string =>
  values.filter((value): value is string => value !== undefined && value.length > 0).join(" ");

const displayName = (user: HostDirectoryUserSummary | undefined): string => {
  if (user?.kind === "active") return user.displayName;
  if (user?.kind === "redacted") return "Hidden user";
  return "Unknown user";
};

export const DefaultMessageTimelineAvatar: TimelineSlots["Avatar"] = ({ user, size, hostProps }) => {
  const label = displayName(user);
  const initials = user.kind === "active" && user.avatar.kind === "initials"
    ? user.avatar.initials
    : label.slice(0, 1).toLocaleUpperCase();
  return createElement(
    "span",
    {
      ...hostProps,
      className: joinClassNames("handrail-chat__timeline-avatar", hostProps.className),
      "data-size": size,
      title: label,
    },
    user.kind === "active" && user.avatar.kind === "image"
      ? createElement("img", {
          alt: user.avatar.altText ?? "",
          className: "handrail-chat__timeline-avatar-image",
          src: user.avatar.url,
        })
      : createElement("span", { "aria-hidden": "true" }, initials),
  );
};

const actionSucceeded = (result: unknown): boolean =>
  typeof result !== "object" || result === null || !("status" in result) || result.status === "success";

const reminderActionOutcome = (result: unknown): ChatMessageReminderActionOutcome => {
  if (!actionSucceeded(result)) return Object.freeze({ status: "failed", conflict: false });
  const value = typeof result === "object" && result !== null && "value" in result
    ? result.value
    : undefined;
  const conflict = typeof value === "object" && value !== null &&
    "reconciliationStatus" in value && value.reconciliationStatus === "revision-conflict";
  return Object.freeze({ status: "success", conflict });
};

const savedMessageActionOutcome = (result: unknown): ChatMessageSavedActionOutcome => {
  if (!actionSucceeded(result)) return Object.freeze({ status: "failed", conflict: false });
  const value = typeof result === "object" && result !== null && "value" in result
    ? result.value
    : undefined;
  const conflict = typeof value === "object" && value !== null &&
    "reconciliationStatus" in value && value.reconciliationStatus === "saved_message_revision_conflict";
  return Object.freeze({ status: "success", conflict });
};

const MessageTimelineAnnouncementContext = createContext<((message: string) => void) | undefined>(undefined);

interface MessageTimelineEditRequest {
  readonly id: number;
  readonly messageId: MessageId;
  readonly finish: (restoreComposerFocus: boolean) => void;
}

const MessageTimelineEditRequestContext = createContext<
  MessageTimelineEditRequest | undefined
>(undefined);

const forwardPreview = (message: ChatMessageViewModel): string | undefined => {
  const content = message.content;
  if (
    message.delivery.state !== "sent" ||
    message.deletedAt !== undefined ||
    content === null ||
    message.attachmentMetadata.length > 0 ||
    (content.attachments?.length ?? 0) > 0 ||
    content.blocks !== undefined
  ) return undefined;
  return content.text.length === 0 ? "(Empty message)" : content.text;
};

const REMINDER_PRESETS = Object.freeze([
  Object.freeze({ label: "In 20 minutes", offsetMs: 20 * 60 * 1_000 }),
  Object.freeze({ label: "In 1 hour", offsetMs: 60 * 60 * 1_000 }),
  Object.freeze({ label: "Tomorrow", offsetMs: 24 * 60 * 60 * 1_000 }),
]);

const reminderDueLabel = (dueAt: IsoTimestamp): string => {
  const value = new Date(dueAt);
  return Number.isFinite(value.getTime())
    ? new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(value)
    : dueAt;
};

type TimelineActionIconName = "retry" | "reply" | "save" | "unsave" | "copy" | "more";

const timelineActionIcon = (name: TimelineActionIconName): ReactElement => {
  const common = {
    "aria-hidden": true,
    className: "handrail-chat__timeline-action-icon",
    "data-timeline-action-icon": name,
    fill: "none",
    focusable: "false",
    stroke: "currentColor",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    strokeWidth: 1.8,
    viewBox: "0 0 20 20",
  };
  switch (name) {
    case "retry":
      return createElement("svg", common,
        createElement("path", { d: "M16.2 7.1V3.8l-1.7 1.7A7 7 0 1 0 17 10" }),
        createElement("path", { d: "M11.2 3.2a7 7 0 0 1 3.3 2.3" }));
    case "reply":
      return createElement("svg", common,
        createElement("path", { d: "M8.3 5 3.5 9.5 8.3 14" }),
        createElement("path", { d: "M4 9.5h6.7a5.8 5.8 0 0 1 5.8 5.8" }));
    case "save":
      return createElement("svg", common,
        createElement("path", { d: "M5.2 3.2h9.6v13.6L10 13.7l-4.8 3.1z" }));
    case "unsave":
      return createElement("svg", common,
        createElement("path", { d: "M5.2 3.2h9.6v13.6L10 13.7l-4.8 3.1z" }),
        createElement("path", { d: "m7.7 8.5 1.5 1.5 3.2-3.2" }));
    case "copy":
      return createElement("svg", common,
        createElement("rect", { height: 10, rx: 1.5, width: 10, x: 6.5, y: 6.5 }),
        createElement("path", { d: "M13.5 6.5v-2a1 1 0 0 0-1-1h-8a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h2" }));
    case "more":
      return createElement("svg", common,
        createElement("path", { d: "M4.5 10h.01M10 10h.01M15.5 10h.01", strokeWidth: 2.8 }));
  }
};

const reactionPickerTriggerIcon = (): ReactElement => createElement(
  "svg",
  {
    "aria-hidden": true,
    className: "handrail-chat__timeline-reaction-picker-icon",
    fill: "none",
    focusable: "false",
    stroke: "currentColor",
    strokeLinecap: "round",
    strokeLinejoin: "round",
    strokeWidth: 1.8,
    viewBox: "0 0 20 20",
  },
  createElement("circle", { cx: 8.5, cy: 10, r: 6.5 }),
  createElement("path", { d: "M6.2 8h.01M10.8 8h.01M6 11.6a3.5 3.5 0 0 0 5 0M15.5 3.5v5M13 6h5" }),
);

const markdownLinkIsSafe = (href: string): boolean => {
  try {
    const parsed = new URL(href.replace(/[\u0000-\u001f\u007f]/g, ""), "https://handrail.invalid");
    return parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:";
  } catch {
    return false;
  }
};

const renderMarkdownInline = (source: string, keyPrefix: string): ReactNode[] => {
  const nodes: ReactNode[] = [];
  let text = "";
  let index = 0;
  let nodeIndex = 0;

  const flushText = (): void => {
    if (text.length === 0) return;
    nodes.push(text);
    text = "";
  };
  const appendElement = (type: string, props: Record<string, unknown>, children: ReactNode): void => {
    flushText();
    nodes.push(createElement(type, { ...props, key: `${keyPrefix}-${nodeIndex++}` }, children));
  };
  const findClosingMarker = (marker: string, from: number): number => {
    const closing = source.indexOf(marker, from);
    return closing > from ? closing : -1;
  };

  while (index < source.length) {
    const character = source[index];
    if (character === "\\" && index + 1 < source.length) {
      text += source[index + 1];
      index += 2;
      continue;
    }
    if (character === "`") {
      const closing = source.indexOf("`", index + 1);
      if (closing > index + 1) {
        appendElement("code", {}, source.slice(index + 1, closing));
        index = closing + 1;
        continue;
      }
    }
    if (character === "[") {
      const labelEnd = source.indexOf("](", index + 1);
      const destinationEnd = labelEnd === -1 ? -1 : source.indexOf(")", labelEnd + 2);
      if (labelEnd > index + 1 && destinationEnd > labelEnd + 2) {
        const label = source.slice(index + 1, labelEnd);
        const href = source.slice(labelEnd + 2, destinationEnd).trim();
        const children = renderMarkdownInline(label, `${keyPrefix}-link-${nodeIndex}`);
        appendElement(
          markdownLinkIsSafe(href) ? "a" : "span",
          markdownLinkIsSafe(href)
            ? { href, rel: "noreferrer" }
            : { className: "handrail-chat__timeline-markdown-unsafe-link" },
          children,
        );
        index = destinationEnd + 1;
        continue;
      }
    }

    const marker = source.startsWith("**", index)
      ? "**"
      : source.startsWith("__", index)
        ? "__"
        : source.startsWith("~~", index)
          ? "~~"
          : character === "*" || character === "_"
            ? character
            : undefined;
    if (marker !== undefined) {
      const closing = findClosingMarker(marker, index + marker.length);
      if (closing !== -1) {
        const type = marker === "~~" ? "del" : marker.length === 2 ? "strong" : "em";
        appendElement(
          type,
          {},
          renderMarkdownInline(
            source.slice(index + marker.length, closing),
            `${keyPrefix}-${type}-${nodeIndex}`,
          ),
        );
        index = closing + marker.length;
        continue;
      }
    }

    text += character;
    index += 1;
  }
  flushText();
  return nodes;
};

interface MarkdownListLine {
  readonly ordered: boolean;
  readonly ordinal?: number;
  readonly text: string;
}

const markdownListLine = (line: string): MarkdownListLine | undefined => {
  const match = line.match(/^ {0,3}(?:([-+*])|(\d+)[.)])[\t ]+(.*)$/);
  if (match === null) return undefined;
  return match[2] === undefined
    ? { ordered: false, text: match[3] ?? "" }
    : { ordered: true, ordinal: Number(match[2]), text: match[3] ?? "" };
};

const markdownFence = (line: string): { readonly character: string; readonly length: number } | undefined => {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})[^\r\n]*$/);
  const marker = match?.[1];
  return marker === undefined ? undefined : { character: marker[0] ?? "`", length: marker.length };
};

const closesMarkdownFence = (
  line: string,
  fence: { readonly character: string; readonly length: number },
): boolean => {
  const marker = line.trim();
  return marker.length >= fence.length && [...marker].every((character) => character === fence.character);
};

const renderMarkdown = (source: string): ReactElement => {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    if ((lines[index] ?? "").trim().length === 0) {
      index += 1;
      continue;
    }

    const fence = markdownFence(lines[index] ?? "");
    if (fence !== undefined) {
      const openingIndex = index;
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !closesMarkdownFence(lines[index] ?? "", fence)) {
        codeLines.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(createElement(
        "pre",
        { className: "handrail-chat__timeline-markdown-code-block", key: `block-${openingIndex}` },
        createElement("code", null, codeLines.join("\n")),
      ));
      continue;
    }

    const firstListLine = markdownListLine(lines[index] ?? "");
    if (firstListLine !== undefined) {
      const openingIndex = index;
      const items: ReactNode[] = [];
      while (index < lines.length) {
        const item = markdownListLine(lines[index] ?? "");
        if (item === undefined || item.ordered !== firstListLine.ordered) break;
        items.push(createElement(
          "li",
          { key: `item-${index}` },
          renderMarkdownInline(item.text, `block-${openingIndex}-item-${index}`),
        ));
        index += 1;
      }
      const listProps = firstListLine.ordered && firstListLine.ordinal !== 1
        ? { start: firstListLine.ordinal }
        : {};
      blocks.push(createElement(
        firstListLine.ordered ? "ol" : "ul",
        { ...listProps, key: `block-${openingIndex}` },
        items,
      ));
      continue;
    }

    const openingIndex = index;
    const paragraphLines: string[] = [];
    while (
      index < lines.length &&
      (lines[index] ?? "").trim().length > 0 &&
      markdownFence(lines[index] ?? "") === undefined &&
      markdownListLine(lines[index] ?? "") === undefined
    ) {
      paragraphLines.push(lines[index] ?? "");
      index += 1;
    }
    blocks.push(createElement(
      "p",
      { key: `block-${openingIndex}` },
      renderMarkdownInline(paragraphLines.join("\n"), `block-${openingIndex}`),
    ));
  }

  return createElement(
    "div",
    { className: "handrail-chat__timeline-text handrail-chat__timeline-markdown" },
    blocks,
  );
};

export const DefaultMessageRenderer: TimelineSlots["Message"] = ({ message, actions, hostProps }) => {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(message.content?.text ?? "");
  const editTextareaRef = useRef<HTMLTextAreaElement>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [reminderOpen, setReminderOpen] = useState(false);
  const [customReminder, setCustomReminder] = useState("");
  const [reminderFeedback, setReminderFeedback] = useState("");
  const [reminderValidation, setReminderValidation] = useState("");
  const [reminderMutationLatched, setReminderMutationLatched] = useState(false);
  const reminderMutationLatch = useRef(false);
  const [savedFeedback, setSavedFeedback] = useState("");
  const [savedMutationLatched, setSavedMutationLatched] = useState(false);
  const savedMutationLatch = useRef(false);
  const setTimelineAnnouncement = useContext(MessageTimelineAnnouncementContext);
  const requestedEdit = useContext(MessageTimelineEditRequestContext);
  const activeEditRequest = requestedEdit?.messageId === message.id
    ? requestedEdit
    : undefined;
  const deleted = message.content === null || message.deletedAt !== undefined;
  const forwardablePreview = forwardPreview(message);
  const revision = message.revision.revision;
  const deliveryLabel = message.delivery.state === "sending"
    ? "Sending"
    : message.delivery.state === "failed"
      ? "Send failed"
      : undefined;
  const editLabel = message.editState === "pending"
    ? "Saving edit"
    : message.editState === "revision_conflict"
      ? "Edit conflict. Refresh and try again."
      : revision > 1
        ? "Edited"
        : undefined;
  const reminderPending = reminderMutationLatched || message.reminder.mutationState === "pending";
  const savedPending = savedMutationLatched || message.saved.mutationState === "pending";
  const savedEligible = !deleted && message.delivery.state === "sent" && message.saved.available;
  const savedStatus = message.saved.conflict
    ? "Saved status changed elsewhere. Showing the latest state."
    : savedPending
      ? "Updating saved status…"
      : message.saved.mutationState === "failed"
        ? message.saved.retryable
          ? "Saved-message update failed. Retry is available."
          : "Saved-message update failed."
        : savedFeedback;
  const scheduledDueAt = message.reminder.state === "scheduled" ? message.reminder.dueAt : undefined;
  const reminderStatus = message.reminder.conflict
    ? "Reminder changed elsewhere. Showing the latest schedule."
    : reminderPending
      ? "Updating reminder…"
      : message.reminder.mutationState === "failed"
      ? message.reminder.retryable
        ? "Reminder update failed. Retry is available."
        : "Reminder update failed."
      : reminderFeedback.length > 0
          ? reminderFeedback
          : scheduledDueAt === undefined
            ? ""
            : `Reminder set for ${reminderDueLabel(scheduledDueAt)}.`;

  useEffect(() => {
    if (!editing) setEditText(message.content?.text ?? "");
  }, [editing, message.content?.text]);

  useEffect(() => {
    if (message.canEdit) return;
    setEditing(false);
    activeEditRequest?.finish(true);
  }, [activeEditRequest, message.canEdit]);

  useLayoutEffect(() => {
    if (
      activeEditRequest === undefined ||
      !message.canEdit ||
      deleted ||
      message.delivery.state !== "sent"
    ) return;
    setEditing(true);
  }, [activeEditRequest?.id, deleted, message.canEdit, message.delivery.state]);

  useLayoutEffect(() => {
    if (!editing || activeEditRequest === undefined) return;
    const textarea = editTextareaRef.current;
    if (textarea === null) return;
    textarea.focus();
    const caret = textarea.value.length;
    textarea.setSelectionRange(caret, caret);
  }, [activeEditRequest?.id, editing]);

  const cancelEdit = (): void => {
    setEditing(false);
    activeEditRequest?.finish(true);
  };

  const submitEdit = async (): Promise<void> => {
    const content = message.content;
    if (content === null) return;
    const result = await actions.editMessage({
      messageId: message.id,
      expectedRevision: revision,
      content: { ...content, text: editText },
    });
    if (actionSucceeded(result)) {
      setEditing(false);
      activeEditRequest?.finish(false);
    }
  };

  const copyMessage = async (): Promise<void> => {
    const text = message.content?.text;
    if (deleted || text === undefined) return;
    setTimelineAnnouncement?.("Copying message…");
    try {
      if (typeof navigator === "undefined" || typeof navigator.clipboard?.writeText !== "function") {
        setTimelineAnnouncement?.("Copying message failed.");
        return;
      }
      await navigator.clipboard.writeText(text);
      setTimelineAnnouncement?.("Copying message complete.");
    } catch {
      setTimelineAnnouncement?.("Copying message failed.");
    }
  };

  const latchReminderMutation = (): boolean => {
    if (reminderMutationLatch.current || message.reminder.mutationState === "pending") return false;
    reminderMutationLatch.current = true;
    setReminderMutationLatched(true);
    setReminderValidation("");
    return true;
  };

  const releaseReminderMutation = (): void => {
    reminderMutationLatch.current = false;
    setReminderMutationLatched(false);
  };

  const setReminder = async (dueAt: IsoTimestamp): Promise<void> => {
    if (!latchReminderMutation()) return;
    setReminderFeedback("Scheduling reminder…");
    try {
      const outcome = await actions.setMessageReminder({ messageId: message.id, dueAt });
      if (outcome.status === "failed") {
        setReminderFeedback("Reminder update failed.");
        return;
      }
      setReminderValidation("");
      setReminderFeedback(outcome.conflict
        ? "Reminder changed elsewhere. Showing the latest schedule."
        : "Reminder scheduled.");
    } finally {
      releaseReminderMutation();
    }
  };

  const setPresetReminder = (offsetMs: number): void => {
    void setReminder(new Date(Date.now() + offsetMs).toISOString() as IsoTimestamp);
  };

  const submitCustomReminder = (): void => {
    if (reminderMutationLatch.current || message.reminder.mutationState === "pending") return;
    const instant = new Date(customReminder);
    if (customReminder.length === 0 || !Number.isFinite(instant.getTime())) {
      setReminderValidation("Enter a valid local date and time.");
      return;
    }
    if (instant.getTime() <= Date.now()) {
      setReminderValidation("Choose a future date and time.");
      return;
    }
    void setReminder(instant.toISOString() as IsoTimestamp);
  };

  const cancelReminder = async (): Promise<void> => {
    if (!latchReminderMutation()) return;
    setReminderFeedback("Cancelling reminder…");
    try {
      const outcome = await actions.cancelMessageReminder(message.id);
      setReminderFeedback(outcome.status === "failed"
        ? "Reminder cancellation failed."
        : outcome.conflict
          ? "Reminder changed elsewhere. Showing the latest schedule."
          : "Reminder cancelled.");
    } finally {
      releaseReminderMutation();
    }
  };

  const retryReminder = async (): Promise<void> => {
    if (!latchReminderMutation()) return;
    setReminderFeedback("Retrying reminder…");
    try {
      const outcome = await actions.retryMessageReminder(message.id);
      setReminderFeedback(outcome.status === "failed"
        ? "Reminder retry failed."
        : outcome.conflict
          ? "Reminder changed elsewhere. Showing the latest schedule."
          : "Reminder updated.");
    } finally {
      releaseReminderMutation();
    }
  };

  const latchSavedMutation = (): boolean => {
    if (!savedEligible || savedMutationLatch.current || message.saved.mutationState === "pending") return false;
    savedMutationLatch.current = true;
    setSavedMutationLatched(true);
    return true;
  };

  const releaseSavedMutation = (): void => {
    savedMutationLatch.current = false;
    setSavedMutationLatched(false);
  };

  const toggleSaved = async (): Promise<void> => {
    if (!latchSavedMutation()) return;
    const wasSaved = message.saved.isSaved;
    setSavedFeedback(wasSaved ? "Removing from saved…" : "Saving message…");
    try {
      const outcome = wasSaved
        ? await actions.unsaveMessage(message.id)
        : await actions.saveMessage(message.id);
      setSavedFeedback(outcome.status === "failed"
        ? "Saved-message update failed."
        : outcome.conflict
          ? "Saved status changed elsewhere. Showing the latest state."
          : wasSaved
            ? "Removed from saved."
            : "Message saved.");
    } finally {
      releaseSavedMutation();
    }
  };

  const retrySaved = async (): Promise<void> => {
    if (!latchSavedMutation()) return;
    setSavedFeedback("Retrying saved-message update…");
    try {
      const outcome = await actions.retrySavedMessage(message.id);
      setSavedFeedback(outcome.status === "failed"
        ? "Saved-message retry failed."
        : outcome.conflict
          ? "Saved status changed elsewhere. Showing the latest state."
          : "Saved-message update completed.");
    } finally {
      releaseSavedMutation();
    }
  };

  const directControls: ReactNode[] = [];
  const overflowControls: ReactNode[] = [];
  if (message.delivery.state === "failed" && message.delivery.retryable) {
    directControls.push(createElement(
      "button",
      {
        "aria-label": "Retry",
        className: "handrail-chat__timeline-action handrail-chat__timeline-action--icon",
        key: "retry",
        onClick: () => void actions.retryMessage(message.delivery.state === "failed" ? message.delivery.clientMessageId : ""),
        title: "Retry sending message",
        type: "button",
      },
      timelineActionIcon("retry"),
    ));
  }
  if (!deleted && message.delivery.state === "sent") {
    directControls.push(createElement(
      "button",
      {
        "aria-label": "Reply",
        className: "handrail-chat__timeline-action handrail-chat__timeline-action--icon",
        key: "reply",
        disabled: actions.replyDisabledReason !== undefined,
        "aria-description": actions.replyDisabledReason,
        onClick: () => actions.selectReply === undefined
          ? void actions.openThread(message.id)
          : actions.selectReply(message.id),
        title: actions.replyDisabledReason ?? "Reply to message",
        type: "button",
      },
      timelineActionIcon("reply"),
    ));
    if (actions.showOpenThread || actions.requestThreadCreation !== undefined) {
      const label = actions.showOpenThread ? "Open Thread" : "Create Thread";
      directControls.push(createElement("button", {
        "aria-label": label, key: "named-thread", type: "button",
        className: "handrail-chat__timeline-action",
        disabled: !actions.showOpenThread && actions.threadCreationDisabledReason !== undefined,
        "aria-description": actions.showOpenThread ? undefined : actions.threadCreationDisabledReason,
        title: actions.showOpenThread ? label : actions.threadCreationDisabledReason ?? label,
        onClick: () => actions.showOpenThread ? void actions.openThread(message.id) : actions.requestThreadCreation?.(message.id),
      }, label));
    }
    overflowControls.push(createElement(
      "button",
      {
        "aria-label": "Mark unread",
        className: "handrail-chat__timeline-action",
        key: "mark-unread",
        onClick: () => void actions.markUnread({ fromSequence: message.sequence }),
        title: "Mark unread from this message",
        type: "button",
      },
      "Mark unread",
    ));
    if (message.saved.available) {
      if (message.saved.mutationState === "failed" && message.saved.retryable) {
        directControls.push(createElement(
          "button",
          {
            "aria-label": "Retry saved-message update",
            className: "handrail-chat__timeline-action handrail-chat__timeline-action--icon",
            disabled: savedPending,
            key: "saved-toggle",
            onClick: () => void retrySaved(),
            title: "Retry saved-message update",
            type: "button",
          },
          timelineActionIcon("retry"),
        ));
      } else {
        const savedActionLabel = message.saved.isSaved ? "Remove from saved" : "Save";
        directControls.push(createElement(
          "button",
          {
            "aria-label": savedActionLabel,
            className: "handrail-chat__timeline-action handrail-chat__timeline-action--icon",
            disabled: savedPending,
            key: "saved-toggle",
            onClick: () => void toggleSaved(),
            title: message.saved.isSaved ? "Remove message from saved" : "Save message",
            type: "button",
          },
          timelineActionIcon(message.saved.isSaved ? "unsave" : "save"),
        ));
      }
    }
    overflowControls.push(createElement(
      "button",
      {
        "aria-label": "Remind me",
        "aria-expanded": reminderOpen,
        "aria-controls": `reminder-controls-${message.id}`,
        className: "handrail-chat__timeline-action",
        disabled: reminderPending,
        key: "reminder",
        onClick: () => setReminderOpen((value) => !value),
        title: "Set a reminder for this message",
        type: "button",
      },
      "Remind me",
    ));
    if (forwardablePreview !== undefined && actions.forwardMessage !== undefined) {
      overflowControls.push(createElement(
        "button",
        {
          "aria-label": "Forward",
          className: "handrail-chat__timeline-action",
          key: "forward",
          onClick: () => actions.forwardMessage?.(message.id),
          title: "Forward message",
          type: "button",
        },
        "Forward",
      ));
    }
  }
  if (!deleted) {
    directControls.push(createElement(
      "button",
      {
        "aria-label": "Copy",
        className: "handrail-chat__timeline-action handrail-chat__timeline-action--icon",
        key: "copy",
        onClick: () => void copyMessage(),
        title: "Copy message text",
        type: "button",
      },
      timelineActionIcon("copy"),
    ));
  }
  if (!deleted && message.delivery.state === "sent" && message.canEdit) {
    const editActionLabel = editing ? "Cancel edit" : "Edit";
    overflowControls.push(createElement(
      "button",
      {
        "aria-label": editActionLabel,
        "aria-expanded": editing,
        className: "handrail-chat__timeline-action",
        key: "edit",
        onClick: () => {
          if (editing) cancelEdit();
          else setEditing(true);
        },
        title: editing ? "Cancel editing message" : "Edit message",
        type: "button",
      },
      editActionLabel,
    ));
  }
  if (!deleted && message.delivery.state === "sent" && message.canDelete) {
    const deleteActionLabel = message.deleteState === "pending" ? "Deleting" : "Delete";
    overflowControls.push(createElement(
      "button",
      {
        "aria-label": deleteActionLabel,
        className: "handrail-chat__timeline-action",
        disabled: message.deleteState === "pending",
        key: "delete",
        onClick: () => void actions.deleteMessage({ messageId: message.id, expectedRevision: revision }),
        title: message.deleteState === "pending" ? "Deleting message" : "Delete message",
        type: "button",
      },
      deleteActionLabel,
    ));
  }

  const actionsExpanded = overflowOpen || reminderOpen || editing;

  return createElement(
    "div",
    {
      ...hostProps,
      className: joinClassNames("handrail-chat__timeline-message", hostProps.className),
    },
    message.replyContext === undefined ? null : createElement(ReplyReference, { context: message.replyContext }),
    deleted
      ? createElement("p", { className: "handrail-chat__timeline-tombstone" },
          message.deleteState === "pending" ? "Deleting message…" : "This message was deleted.")
      : editing && message.canEdit
        ? createElement(
            "form",
            {
              className: "handrail-chat__timeline-edit",
              onSubmit: (event) => {
                event.preventDefault();
                void submitEdit();
              },
            },
            createElement("label", { className: "handrail-chat__sr-only", htmlFor: `edit-${message.id}` }, "Edit message"),
            createElement("textarea", {
              autoFocus: true,
              className: "handrail-chat__control",
              id: `edit-${message.id}`,
              onChange: (event) => setEditText((event.currentTarget as HTMLTextAreaElement).value),
              onKeyDown: (event) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                event.stopPropagation();
                cancelEdit();
              },
              ref: editTextareaRef,
              value: editText,
            }),
            createElement("button", { className: "handrail-chat__button", type: "submit" }, "Save edit"),
          )
        : message.content?.format === "markdown"
          ? renderMarkdown(message.content.text)
          : createElement("p", { className: "handrail-chat__timeline-text" }, message.content?.text ?? ""),
    createElement(
      "div",
      { className: "handrail-chat__timeline-status" },
      deliveryLabel === undefined ? null : createElement("span", null, deliveryLabel),
      editLabel === undefined ? null : createElement("span", null, editLabel),
      savedStatus.length === 0
        ? null
        : createElement("span", { "aria-live": "polite", role: "status" }, savedStatus),
      scheduledDueAt === undefined
        ? null
        : createElement("span", null, "Reminder: ", createElement("time", { dateTime: scheduledDueAt }, reminderDueLabel(scheduledDueAt))),
    ),
    !deleted && message.delivery.state === "sent" && reminderOpen
      ? createElement(
          "section",
          {
            "aria-label": "Reminder options",
            className: "handrail-chat__timeline-reminder",
            id: `reminder-controls-${message.id}`,
          },
          createElement("div", { "aria-label": "Reminder presets", className: "handrail-chat__timeline-reminder-presets", role: "group" },
            REMINDER_PRESETS.map((preset) => createElement("button", {
              className: "handrail-chat__timeline-action",
              disabled: reminderPending,
              key: preset.label,
              onClick: () => setPresetReminder(preset.offsetMs),
              type: "button",
            }, preset.label))),
          createElement(
            "div",
            { className: "handrail-chat__timeline-reminder-custom" },
            createElement("label", { htmlFor: `reminder-local-${message.id}` }, "Custom local date and time"),
            createElement("input", {
              className: "handrail-chat__control",
              disabled: reminderPending,
              id: `reminder-local-${message.id}`,
              onChange: (event) => setCustomReminder((event.currentTarget as HTMLInputElement).value),
              type: "datetime-local",
              value: customReminder,
            }),
            createElement("button", {
              className: "handrail-chat__button",
              disabled: reminderPending,
              onClick: submitCustomReminder,
              type: "button",
            }, "Set reminder"),
          ),
          scheduledDueAt === undefined
            ? null
            : createElement("button", {
                className: "handrail-chat__timeline-action",
                disabled: reminderPending,
                onClick: () => void cancelReminder(),
                type: "button",
              }, "Cancel reminder"),
          message.reminder.mutationState === "failed" && message.reminder.retryable
            ? createElement("button", {
                className: "handrail-chat__timeline-action",
                disabled: reminderPending,
                onClick: () => void retryReminder(),
                type: "button",
              }, "Retry reminder" )
            : null,
          reminderValidation.length === 0
            ? null
            : createElement("p", { role: "alert" }, reminderValidation),
          createElement("p", { "aria-live": "polite", role: "status" }, reminderStatus),
        )
      : null,
    directControls.length === 0 && overflowControls.length === 0
      ? null
      : createElement(
          "div",
          {
            "aria-label": "Message actions",
            className: "handrail-chat__timeline-actions",
            "data-actions-expanded": actionsExpanded ? "true" : "false",
            role: "toolbar",
          },
          directControls,
          overflowControls.length === 0
            ? null
            : createElement(
                "div",
                { className: "handrail-chat__timeline-actions-overflow" },
                createElement(
                  "button",
                  {
                    "aria-controls": `message-actions-overflow-${message.id}`,
                    "aria-expanded": overflowOpen,
                    "aria-label": "More message actions",
                    className: "handrail-chat__timeline-action handrail-chat__timeline-action--icon handrail-chat__timeline-action--overflow-toggle",
                    onClick: () => setOverflowOpen((value) => !value),
                    title: "More message actions",
                    type: "button",
                  },
                  timelineActionIcon("more"),
                ),
                createElement(
                  "div",
                  {
                    "aria-label": "More message actions",
                    className: "handrail-chat__timeline-actions-overflow-panel",
                    hidden: !overflowOpen,
                    id: `message-actions-overflow-${message.id}`,
                    role: "group",
                  },
                  overflowControls,
                ),
              ),
        ),
  );
};

export const DefaultMessageTimelineEmptyState: TimelineSlots["EmptyState"] = ({
  title,
  description,
  introduction,
  hostProps,
}) => {
  const decorativeGlyph = hostProps["data-state-glyph"];
  const participantCount = introduction?.participants?.length ?? 0;
  return createElement(
    "section",
    {
      ...hostProps,
      className: joinClassNames(
        "handrail-chat__timeline-empty",
        introduction === undefined
          ? undefined
          : "handrail-chat__timeline-introduction",
        hostProps.className,
      ),
      ...(introduction === undefined
        ? {}
        : {
            "data-conversation-type": introduction.conversationType,
            ...(introduction.visibility === undefined
              ? {}
              : { "data-conversation-visibility": introduction.visibility }),
            ...(introduction.participantResolution === undefined
              ? {}
              : { "data-participant-resolution": introduction.participantResolution }),
          }),
    },
    decorativeGlyph === undefined
      ? null
      : createElement(
          "span",
          { "aria-hidden": true, className: "handrail-chat__state-panel-glyph" },
          String(decorativeGlyph),
        ),
    createElement(
      "h2",
      { className: introduction === undefined ? undefined : "handrail-chat__timeline-introduction-title" },
      title,
    ),
    introduction === undefined
      ? description === undefined ? null : createElement("p", null, description)
      : createElement(
          "div",
          { className: "handrail-chat__timeline-introduction-body" },
          introduction.visibility === undefined
            ? null
            : createElement(
                "p",
                { className: "handrail-chat__timeline-introduction-visibility" },
                introduction.visibility === "public" ? "Public channel" : "Private channel",
              ),
          createElement(
            "p",
            { className: "handrail-chat__timeline-introduction-context" },
            introduction.context,
          ),
          introduction.entity === undefined
            ? null
            : createElement(
                "p",
                { className: "handrail-chat__timeline-introduction-detail" },
                `Connected to ${introduction.entity.type} ${introduction.entity.id}.`,
              ),
          !introduction.archived
            ? null
            : createElement(
                "p",
                { className: "handrail-chat__timeline-introduction-detail" },
                "This conversation is archived.",
              ),
          introduction.conversationType !== "group_direct" ||
              introduction.participantResolution !== "ready"
            ? null
            : createElement(
                "p",
                { className: "handrail-chat__timeline-introduction-detail" },
                `${participantCount} other ${participantCount === 1 ? "participant" : "participants"}`,
              ),
          createElement(
            "p",
            { className: "handrail-chat__timeline-introduction-prompt" },
            introduction.prompt,
          ),
        ),
  );
};

const PREVIEWABLE_IMAGE_CONTENT_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const ATTACHMENT_CONTENT_TYPE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  "application/pdf": "PDF document",
  "audio/mpeg": "MP3 audio",
  "audio/ogg": "Ogg audio",
  "image/gif": "GIF image",
  "image/jpeg": "JPEG image",
  "image/png": "PNG image",
  "image/webp": "WebP image",
  "text/plain": "Plain text",
  "video/mp4": "MP4 video",
  "video/webm": "WebM video",
});

const attachmentSizeLabel = (sizeBytes: number): string => {
  if (sizeBytes < 1_024) return `${sizeBytes} ${sizeBytes === 1 ? "byte" : "bytes"}`;

  const units = ["KB", "MB", "GB", "TB"] as const;
  let value = sizeBytes / 1_024;
  let unitIndex = 0;
  while (value >= 1_024 && unitIndex < units.length - 1) {
    value /= 1_024;
    unitIndex += 1;
  }
  const precision = value >= 10 || Number.isInteger(value) ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
};

const nonEmptyAttachmentText = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const attachmentImageDimension = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;

export const DefaultAttachmentRenderer: TimelineSlots["Attachment"] = ({ attachment, hostProps }) => {
  const value = attachment.attachment;
  const isPreviewableImage = PREVIEWABLE_IMAGE_CONTENT_TYPES.has(value.contentType);
  const metadata = `${ATTACHMENT_CONTENT_TYPE_LABELS[value.contentType] ?? value.contentType} · ${attachmentSizeLabel(value.sizeBytes)}`;
  const previewUrl = nonEmptyAttachmentText(value.previewUrl) ? value.previewUrl : value.downloadUrl;
  const altText = nonEmptyAttachmentText(value.altText) ? value.altText : value.fileName;
  const width = attachmentImageDimension(value.width);
  const height = attachmentImageDimension(value.height);
  return createElement(
    "article",
    {
      ...hostProps,
      className: joinClassNames("handrail-chat__timeline-attachment", hostProps.className),
      "data-attachment-kind": isPreviewableImage ? "image" : "file",
    },
    isPreviewableImage
      ? createElement(
          "a",
          {
            "aria-label": `Open ${value.fileName}`,
            className: "handrail-chat__timeline-attachment-preview",
            href: value.downloadUrl,
          },
          createElement("img", {
            alt: altText,
            className: "handrail-chat__timeline-attachment-image",
            decoding: "async",
            ...(height === undefined ? {} : { height }),
            loading: "lazy",
            src: previewUrl,
            ...(width === undefined ? {} : { width }),
          }),
        )
      : null,
    createElement(
      "div",
      { className: "handrail-chat__timeline-attachment-details" },
      createElement(
        "span",
        { className: "handrail-chat__timeline-attachment-name", title: value.fileName },
        value.fileName,
      ),
      createElement("span", { className: "handrail-chat__muted" }, metadata),
      createElement(
        "a",
        {
          className: "handrail-chat__timeline-attachment-download",
          download: value.fileName,
          href: value.downloadUrl,
        },
        "Download",
      ),
    ),
  );
};

export const DefaultLinkPreviewRenderer: TimelineSlots["LinkPreview"] = ({ linkPreview, hostProps }) =>
  createElement(
    "article",
    {
      ...hostProps,
      className: joinClassNames("handrail-chat__timeline-link-preview", hostProps.className),
    },
    createElement(
      "a",
      {
        className: "handrail-chat__timeline-link-preview-link",
        href: linkPreview.url,
        rel: "noopener noreferrer",
        target: "_blank",
      },
      linkPreview.imageUrl === undefined
        ? null
        : createElement("img", {
            alt: "",
            className: "handrail-chat__timeline-link-preview-image",
            decoding: "async",
            loading: "lazy",
            referrerPolicy: "no-referrer",
            src: linkPreview.imageUrl,
          }),
      createElement(
        "span",
        { className: "handrail-chat__timeline-link-preview-content" },
        linkPreview.siteName === undefined
          ? null
          : createElement(
              "span",
              { className: "handrail-chat__timeline-link-preview-site" },
              linkPreview.siteName,
            ),
        createElement(
          "strong",
          { className: "handrail-chat__timeline-link-preview-title" },
          linkPreview.title,
        ),
        linkPreview.description === undefined
          ? null
          : createElement(
              "span",
              { className: "handrail-chat__timeline-link-preview-description" },
              linkPreview.description,
            ),
        createElement(
          "span",
          { className: "handrail-chat__timeline-link-preview-url" },
          linkPreview.url,
        ),
      ),
    ),
  );

export const DefaultSystemEventRenderer: TimelineSlots["SystemEvent"] = ({ event, hostProps }) =>
  createElement(
    "p",
    { ...hostProps, className: joinClassNames("handrail-chat__timeline-system-event", hostProps.className) },
    event.summary,
  );

export const DefaultEntityReferenceRenderer: TimelineSlots["EntityReference"] = ({ entityReference, hostProps }) =>
  createElement(
    "span",
    { ...hostProps, className: joinClassNames("handrail-chat__timeline-entity", hostProps.className) },
    entityReference.label,
  );

const DEFAULT_SLOTS: TimelineSlots = Object.freeze({
  Avatar: DefaultMessageTimelineAvatar,
  Message: DefaultMessageRenderer,
  EmptyState: DefaultMessageTimelineEmptyState,
  Attachment: DefaultAttachmentRenderer,
  LinkPreview: DefaultLinkPreviewRenderer,
  SystemEvent: DefaultSystemEventRenderer,
  EntityReference: DefaultEntityReferenceRenderer,
});

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

const absoluteHttpUrl = (value: string): string | undefined => {
  const normalized = value.trim();
  if (!/^https?:\/\//i.test(normalized) || /[\u0000-\u001f\u007f]/.test(normalized)) return undefined;
  try {
    const parsed = new URL(normalized);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname.length > 0
      ? parsed.href
      : undefined;
  } catch {
    return undefined;
  }
};

const projectLinkPreview = (block: MessageBlock): ChatLinkPreviewViewModel | undefined => {
  if (block.type !== "link_preview" || !isRecord(block.data)) return undefined;
  const data = block.data;
  const urlValue = stringValue(data.url);
  const title = stringValue(data.title)?.trim();
  if (urlValue === undefined || title === undefined) return undefined;
  const url = absoluteHttpUrl(urlValue);
  if (url === undefined) return undefined;

  const optionalText = (key: "description" | "siteName"): string | undefined | null => {
    const value = data[key];
    if (value === undefined) return undefined;
    return stringValue(value)?.trim() ?? null;
  };
  const description = optionalText("description");
  const siteName = optionalText("siteName");
  if (description === null || siteName === null) return undefined;

  let imageUrl: string | undefined;
  if (data.imageUrl !== undefined) {
    const imageUrlValue = stringValue(data.imageUrl);
    if (imageUrlValue === undefined) return undefined;
    imageUrl = absoluteHttpUrl(imageUrlValue);
    if (imageUrl === undefined) return undefined;
  }

  return Object.freeze({
    url,
    title,
    ...(description === undefined ? {} : { description }),
    ...(siteName === undefined ? {} : { siteName }),
    ...(imageUrl === undefined ? {} : { imageUrl }),
  });
};

const projectSystemEvent = (
  block: MessageBlock,
  message: ChatMessageViewModel,
  index: number,
): ChatSystemEventViewModel | undefined => {
  if (!["system_event", "system.event", "handrail.system_event"].includes(block.type) || !isRecord(block.data)) return undefined;
  const summary = stringValue(block.data.summary);
  const kind = stringValue(block.data.kind);
  if (summary === undefined || kind === undefined) return undefined;
  const details = isRecord(block.data.details)
    ? Object.fromEntries(Object.entries(block.data.details).filter((entry): entry is [string, string | number | boolean | null] => {
        const value = entry[1];
        return value === null || ["string", "number", "boolean"].includes(typeof value);
      }))
    : undefined;
  return Object.freeze({
    id: `${message.id}-system-${index}`,
    conversationId: message.conversationId,
    kind,
    occurredAt: message.createdAt,
    summary,
    ...(details === undefined ? {} : { details: Object.freeze(details) }),
  });
};

const projectEntityReference = (block: MessageBlock): ChatEntityReferenceViewModel | undefined => {
  if (!["entity_reference", "entity.reference", "erp.reference"].includes(block.type) || !isRecord(block.data)) return undefined;
  const nested = isRecord(block.data.entity) ? block.data.entity : block.data;
  const type = stringValue(nested.type) ?? (block.type === "erp.reference" ? "erp" : undefined);
  const id = stringValue(nested.id);
  const label = stringValue(block.data.label) ?? id;
  if (type === undefined || id === undefined || label === undefined) return undefined;
  const description = stringValue(block.data.description);
  return Object.freeze({
    entity: Object.freeze({ type, id }),
    label,
    ...(description === undefined ? {} : { description }),
  });
};

type MessageReminderSource = readonly [
  CanonicalMessageReminder | undefined,
  number,
  PendingMessageReminderUpdate | undefined,
];

type MessageSavedSource = readonly [
  boolean,
  boolean,
  number,
  PendingSavedMessageUpdate | undefined,
];

const sameReminder = (
  left: CanonicalMessageReminder | undefined,
  right: CanonicalMessageReminder | undefined,
): boolean => left?.state === right?.state &&
  (left?.state !== "scheduled" || right?.state !== "scheduled" || left.dueAt === right.dueAt);

const equalMessageReminderSource = (
  left: MessageReminderSource,
  right: MessageReminderSource,
): boolean => left[0] === right[0] && left[1] === right[1] && left[2] === right[2];

const projectMessageReminder = (
  source: MessageReminderSource,
): ChatMessageReminderViewModel => {
  const [optimisticReminder, authoritativeRevision, pending] = source;
  const conflict = pending?.authoritativeReminder !== undefined &&
    !sameReminder(pending.desiredReminder, pending.authoritativeReminder);
  const reminder = conflict ? pending.authoritativeReminder : optimisticReminder;
  return Object.freeze({
    state: reminder?.state ?? "none",
    ...(reminder?.state === "scheduled" ? { dueAt: reminder.dueAt } : {}),
    authoritativeRevision,
    mutationState: pending?.state ?? "idle",
    retryable: pending?.retryable === true,
    conflict,
  });
};

const equalMessageSavedSource = (
  left: MessageSavedSource,
  right: MessageSavedSource,
): boolean => left[0] === right[0] && left[1] === right[1] &&
  left[2] === right[2] && left[3] === right[3];

const projectMessageSaved = (source: MessageSavedSource): ChatMessageSavedViewModel => {
  const [available, optimisticIsSaved, authoritativeRevision, pending] = source;
  const authoritativeIsSaved = pending?.authoritativeSavedMessage?.isSaved ?? false;
  const conflict = pending?.state === "conflict" ||
    (pending?.authoritativeSavedMessage !== undefined &&
      (pending.desiredSavedMessage.isSaved !== authoritativeIsSaved ||
        pending.desiredSavedMessage.privateNote !==
          pending.authoritativeSavedMessage.privateNote));
  return Object.freeze({
    available,
    isSaved: conflict ? authoritativeIsSaved : optimisticIsSaved,
    authoritativeRevision,
    mutationState: pending?.state ?? "idle",
    retryable: pending?.retryable === true,
    conflict,
  });
};

const boundedReplyText = (text: string, limit: number): string =>
  text.length > limit ? `${text.slice(0, limit - 1)}…` : text;

type JumpToReply = (target: MessageContextRequest) => Promise<boolean>;

const useReplyContext = (message: TimelineMessage, jump: JumpToReply): ChatReplyContextViewModel | undefined => {
  const runtime = useContext(ChatContext)?.client.messageContext;
  const sourceId = message.deletedAt === undefined ? message.replyTo?.messageId : undefined;
  const target = useMemo(() => sourceId === undefined ? undefined :
    Object.freeze({ conversationId: message.conversationId, messageId: sourceId }),
  [message.conversationId, sourceId]);
  const subscribe = useCallback((listener: () => void) =>
    target === undefined || runtime === undefined ? () => {} : runtime.subscribe(target, listener), [runtime, target]);
  const snapshot = useCallback(() => target === undefined ? undefined : runtime?.getState(target), [runtime, target]);
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    if (target !== undefined && state?.status === "idle") void runtime?.resolve(target);
  }, [runtime, target, state]);
  const source = state?.status === "available" && state.result?.status === "available" ? state.result.message : undefined;
  const users = useDirectoryUsers(source === undefined ? [] : [source.author.userId]);
  return useMemo(() => {
    if (target === undefined) return undefined;
    if (source !== undefined) return Object.freeze({ ...target, status: "available" as const,
      authorLabel: boundedReplyText(displayName(users.data?.[0]), 80),
      preview: boundedReplyText(source.content.text || "Attachment or rich message", 240),
      jump: () => jump(target) });
    const status = state?.error === "access_revoked" ? "unavailable" :
      state === undefined ? "unavailable" : state.status === "idle" ? "loading" : state.status;
    if (status === "error" && runtime !== undefined) return Object.freeze({ ...target, status,
      retry: async () => {
        const current = runtime.getState(target);
        if (current.status === "error" && current.error !== "access_revoked") await runtime.retry(target);
      } });
    return Object.freeze({ ...target, status: status === "available" || status === "error" ? "unavailable" : status });
  }, [target, source, users.data, state, runtime, jump]);
};

const ReplyReference = ({ context }: { readonly context: ChatReplyContextViewModel }): ReactElement => {
  const label = context.status === "available" ? `Reply to ${context.authorLabel}: ${context.preview}` :
    context.status === "deleted" ? "Original message was deleted." :
    context.status === "unavailable" ? "Original message unavailable." :
    context.status === "error" ? "Could not load original message." :
    context.status === "loading_window" ? "Loading original message location…" : "Loading original message…";
  return createElement("div", { className: "handrail-chat__reply-reference", "data-reply-status": context.status, "aria-live": "polite" },
    createElement("button", { type: "button",
      // Keep an in-flight trigger focusable so keyboard users can cancel with Escape.
      disabled: context.jump === undefined && context.status !== "loading_window" && context.status !== "error",
      "aria-disabled": context.jump === undefined,
      "aria-label": context.jump === undefined ? label : `Jump to original message. ${label}`,
      onClick: () => { void context.jump?.(); } }, label),
    context.retry === undefined ? null : createElement("button", { type: "button",
      onClick: () => { void context.retry?.(); } }, "Retry original message"));
};

const toViewModel = (
  message: TimelineMessage,
  author: HostDirectoryUserSummary | undefined,
  availability: MessageMutationAvailability,
  reminder: ChatMessageReminderViewModel,
  saved: ChatMessageSavedViewModel,
  replyContext: ChatReplyContextViewModel | undefined,
): ChatMessageViewModel => {
  const raw = message as TimelineMessage & {
    readonly delivery?: { readonly state: "sending" | "failed"; readonly clientMessageId: string; readonly retryable: boolean };
    readonly editState?: { readonly state: "pending" | "revision_conflict" };
    readonly deleteState?: { readonly state: "pending" };
  };
  return Object.freeze({
    ...(replyContext === undefined ? {} : { replyContext }),
    id: message.id,
    conversationId: message.conversationId,
    sequence: message.sequence,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    revision: message.revision,
    content: message.content,
    ...(message.deletedAt === undefined ? {} : { deletedAt: message.deletedAt, deletedByUserId: message.deletedByUserId }),
    reactions: message.reactions,
    attachmentMetadata: message.attachmentMetadata,
    isThreadRoot: message.isThreadRoot,
    ...(message.isThreadRoot ? { threadSummary: message.threadSummary } : {}),
    ...(author === undefined ? {} : { author }),
    delivery: raw.delivery === undefined
      ? Object.freeze({ state: "sent" as const })
      : raw.delivery.state === "sending"
        ? Object.freeze({ state: "sending" as const, clientMessageId: raw.delivery.clientMessageId })
        : Object.freeze({ state: "failed" as const, clientMessageId: raw.delivery.clientMessageId, retryable: raw.delivery.retryable }),
    editState: raw.editState?.state ?? "idle",
    deleteState: raw.deleteState?.state ?? "idle",
    saved,
    reminder,
    canEdit: availability.canEdit,
    canDelete: availability.canDelete,
  });
};

const resolveMutationAvailability = (
  message: TimelineMessage,
  currentUserId: UserId | undefined,
  resolveHostAvailability: MessageMutationAvailabilityResolver | undefined,
): MessageMutationAvailability => {
  const ownsMessage = currentUserId !== undefined && message.author.userId === currentUserId;
  const hostAvailability = resolveHostAvailability?.(Object.freeze({
    id: message.id,
    conversationId: message.conversationId,
    authorUserId: message.author.userId,
  }));
  return Object.freeze(hostAvailability === undefined
    ? { canEdit: ownsMessage, canDelete: ownsMessage }
    : {
        canEdit: hostAvailability.canEdit === true,
        canDelete: hostAvailability.canDelete === true,
      });
};

const Receipt = ({
  conversationId,
  message,
  otherMemberReadState,
}: {
  readonly conversationId: ConversationId;
  readonly message: TimelineMessage;
  readonly otherMemberReadState: ConversationReadState;
}): ReactElement | null => {
  const receipt = useDirectMessageReceipt({
    conversationId,
    otherMemberReadState,
    messageSequence: message.sequence,
  });
  if (message.author.userId === otherMemberReadState.userId || receipt.status !== "ready" || !receipt.data) return null;
  return createElement("span", { "aria-label": "Read by recipient", className: "handrail-chat__timeline-receipt" }, "Read");
};

interface MessageRowProps {
  readonly actions: ChatActions;
  readonly author: HostDirectoryUserSummary | undefined;
  readonly conversationId: ConversationId;
  readonly currentUserId?: UserId;
  readonly editRequest?: MessageTimelineEditRequest;
  readonly grouped: boolean;
  readonly index: number;
  readonly message: TimelineMessage;
  readonly rowId: string;
  readonly jumpToReply: JumpToReply;
  readonly otherMemberReadState?: ConversationReadState;
  readonly onOpenThread?: MessageTimelineProps["onOpenThread"];
  readonly onReplyRequested?: MessageTimelineProps["onReplyRequested"];
  readonly onCreateThread?: MessageTimelineProps["onCreateThread"];
  readonly threadCreationDisabledReason: string | undefined;
  readonly inlineReply: boolean;
  readonly replyDisabledReason: string | undefined;
  readonly onForwardMessage?: MessageTimelineProps["onForwardMessage"];
  readonly reactionKeys: readonly string[];
  readonly resolveMessageMutationAvailability?: MessageMutationAvailabilityResolver;
  readonly setLiveMessage: (message: string) => void;
  readonly slots: TimelineSlots;
  readonly total: number;
}

const REACTION_PICKER_VIEWPORT_MARGIN_PX = 16;
const REACTION_PICKER_TRIGGER_GAP_PX = 4;
const REACTION_PICKER_MAX_WIDTH_PX = 352;
const REACTION_PICKER_MAX_HEIGHT_PX = 480;

const reactionPickerViewportStyle = (
  trigger: HTMLElement,
  panel: HTMLElement | null,
): CSSProperties | undefined => {
  const view = trigger.ownerDocument.defaultView;
  if (view === null) return undefined;
  const triggerRect = trigger.getBoundingClientRect();
  const panelRect = panel?.getBoundingClientRect();
  const availableWidth = Math.max(0, view.innerWidth - (REACTION_PICKER_VIEWPORT_MARGIN_PX * 2));
  const availableHeight = Math.max(0, view.innerHeight - (REACTION_PICKER_VIEWPORT_MARGIN_PX * 2));
  const panelWidth = Math.min(
    panelRect !== undefined && panelRect.width > 0 ? panelRect.width : REACTION_PICKER_MAX_WIDTH_PX,
    availableWidth,
  );
  const panelHeight = Math.min(
    panelRect !== undefined && panelRect.height > 0 ? panelRect.height : REACTION_PICKER_MAX_HEIGHT_PX,
    availableHeight,
  );
  const maximumLeft = Math.max(
    REACTION_PICKER_VIEWPORT_MARGIN_PX,
    view.innerWidth - panelWidth - REACTION_PICKER_VIEWPORT_MARGIN_PX,
  );
  const preferredLeft = ((triggerRect.left + triggerRect.right) / 2) <= (view.innerWidth / 2)
    ? triggerRect.left
    : triggerRect.right - panelWidth;
  const left = Math.min(
    maximumLeft,
    Math.max(REACTION_PICKER_VIEWPORT_MARGIN_PX, preferredLeft),
  );
  const belowTop = triggerRect.bottom + REACTION_PICKER_TRIGGER_GAP_PX;
  const aboveTop = triggerRect.top - panelHeight - REACTION_PICKER_TRIGGER_GAP_PX;
  const maximumTop = Math.max(
    REACTION_PICKER_VIEWPORT_MARGIN_PX,
    view.innerHeight - panelHeight - REACTION_PICKER_VIEWPORT_MARGIN_PX,
  );
  const top = belowTop + panelHeight <= view.innerHeight - REACTION_PICKER_VIEWPORT_MARGIN_PX
    ? belowTop
    : aboveTop >= REACTION_PICKER_VIEWPORT_MARGIN_PX
      ? aboveTop
      : Math.min(maximumTop, Math.max(REACTION_PICKER_VIEWPORT_MARGIN_PX, belowTop));
  return Object.freeze({
    inset: "auto",
    left,
    margin: 0,
    position: "fixed",
    top,
  });
};

const MessageRow = ({
  actions,
  author,
  conversationId,
  currentUserId,
  editRequest,
  grouped,
  index,
  message,
  rowId,
  jumpToReply,
  otherMemberReadState,
  onOpenThread,
  onReplyRequested,
  onCreateThread,
  threadCreationDisabledReason,
  inlineReply,
  replyDisabledReason: conversationReplyDisabledReason,
  onForwardMessage,
  reactionKeys,
  resolveMessageMutationAvailability,
  setLiveMessage,
  slots,
  total,
}: MessageRowProps): ReactElement => {
  const [reactionPickerOpen, setReactionPickerOpen] = useState(false);
  const [reactionPickerStyle, setReactionPickerStyle] = useState<CSSProperties | undefined>(undefined);
  const reactionPickerAnchorRef = useRef<HTMLSpanElement | null>(null);
  const reactionPickerTriggerRef = useRef<HTMLButtonElement | null>(null);
  const threadResult = useThread(message.id, { enabled: message.isThreadRoot });
  const reminderSelector = useMemo(
    () => (state: NormalizedChatCacheState): MessageReminderSource =>
      Object.freeze([
        state.currentUser.messageReminders[message.id],
        state.currentUser.messageReminderRevisions[message.id] ?? 0,
        state.currentUser.pendingMessageReminderUpdates[message.id],
      ]),
    [message.id],
  );
  const reminderSource = useChatSelector(reminderSelector, equalMessageReminderSource);
  const reminder = useMemo(() => projectMessageReminder(reminderSource), [reminderSource]);
  const savedSelector = useMemo(
    () => (state: NormalizedChatCacheState): MessageSavedSource => {
      const cachedMessage = state.entities.messages[message.id];
      const cachedConversation = state.entities.conversations[message.conversationId];
      const accessibleConversation = cachedConversation !== undefined &&
        cachedConversation.archivedAt === undefined &&
        (cachedConversation.visibility === "public" ||
          state.currentUser.memberships[cachedConversation.id]?.state === "active");
      return Object.freeze([
        state.identity !== null &&
          state.currentUser.savedMessageUnavailableReasons[message.id] === undefined &&
          cachedMessage?.content != null &&
          accessibleConversation,
        state.currentUser.savedMessages[message.id]?.isSaved === true,
        state.currentUser.savedMessageRevisions[message.id] ?? 0,
        state.currentUser.pendingSavedMessageUpdates[message.id],
      ]);
    },
    [message.conversationId, message.id],
  );
  const savedSource = useChatSelector(savedSelector, equalMessageSavedSource);
  const saved = useMemo(() => projectMessageSaved(savedSource), [savedSource]);
  const availability = useMemo(
    () => resolveMutationAvailability(message, currentUserId, resolveMessageMutationAvailability),
    [currentUserId, message, resolveMessageMutationAvailability],
  );
  const replyContext = useReplyContext(message, jumpToReply);
  const viewModel = useMemo(
    () => toViewModel(message, author, availability, reminder, saved, replyContext),
    [author, availability, message, reminder, saved, replyContext],
  );

  const run = useCallback(<Value,>(
    label: string,
    operation: () => Value,
    restoreFocus = true,
  ): Value => {
    const active = typeof document === "undefined" ? null : document.activeElement;
    setLiveMessage(`${label}…`);
    let result: Value;
    try {
      result = operation();
    } catch (error) {
      setLiveMessage(`${label} failed.`);
      throw error;
    }
    void Promise.resolve(result).then(
      (value) => setLiveMessage(actionSucceeded(value) ? `${label} complete.` : `${label} failed.`),
      () => setLiveMessage(`${label} failed.`),
    ).finally(() => {
      if (restoreFocus && active instanceof HTMLElement && active.isConnected) active.focus();
    });
    return result;
  }, [setLiveMessage]);

  const replyDisabledReason = conversationReplyDisabledReason ?? (viewModel.delivery.state !== "sent" ||
    viewModel.content === null || viewModel.deletedAt !== undefined || viewModel.sequence <= 0
    ? "This message is unavailable for replies." : undefined);

  // Invalidate retained custom-slot callbacks when the row, destination, style or
  // availability changes. A stale source must never reach a newly bound composer.
  const replyBinding = useMemo(() => ({
    inlineReply, replyDisabledReason, onReplyRequested, viewModel, conversationId, onCreateThread, threadCreationDisabledReason,
  }), [inlineReply, replyDisabledReason, onReplyRequested, viewModel, conversationId, onCreateThread, threadCreationDisabledReason]);
  const replyBindingRef = useRef<typeof replyBinding | undefined>(replyBinding);
  replyBindingRef.current = replyBinding;
  useLayoutEffect(() => {
    replyBindingRef.current = replyBinding;
    return () => { replyBindingRef.current = undefined; };
  }, [replyBinding]);

  const openBinding = useMemo(() => ({}), [conversationId, onOpenThread]);
  const openBindingRef = useRef<typeof openBinding | undefined>(openBinding);
  openBindingRef.current = openBinding;
  useLayoutEffect(() => {
    openBindingRef.current = openBinding;
    return () => { openBindingRef.current = undefined; };
  }, [openBinding]);

  const messageActions = useMemo<ChatMessageActions>(() => ({
    ...(inlineReply && viewModel.isThreadRoot ? { showOpenThread: true } : {}),
    ...(inlineReply && !viewModel.isThreadRoot && onCreateThread !== undefined ? {
      ...(threadCreationDisabledReason === undefined ? {} : { threadCreationDisabledReason }),
      requestThreadCreation: (rootMessageId: MessageId) => {
        if (replyBindingRef.current !== replyBinding || threadCreationDisabledReason !== undefined ||
          rootMessageId !== viewModel.id || viewModel.delivery.state !== "sent" ||
          viewModel.content === null || viewModel.deletedAt !== undefined || viewModel.sequence <= 0) return;
        onCreateThread(rootMessageId, document.activeElement instanceof HTMLElement ? document.activeElement : null);
      },
    } : {}),
    ...(inlineReply ? {
      ...(replyDisabledReason === undefined ? {} : { replyDisabledReason }),
      selectReply: (sourceMessageId: MessageId) => {
        if (replyBindingRef.current !== replyBinding || replyDisabledReason !== undefined ||
          sourceMessageId !== viewModel.id || viewModel.conversationId !== conversationId ||
          viewModel.delivery.state !== "sent" || viewModel.content === null ||
          viewModel.deletedAt !== undefined || viewModel.sequence <= 0) return;
        onReplyRequested?.({ conversationId, messageId: sourceMessageId });
      },
    } : {}),
    retryMessage: (clientMessageId) => run("Retrying message", () => actions.retryMessage(clientMessageId)),
    editMessage: (input) => run("Saving edit", () => actions.editMessage(input)),
    deleteMessage: (input) => run("Deleting message", () => actions.deleteMessage(input)),
    setReaction: (input) => run("Updating reaction", () => actions.setReaction(input)),
    markUnread: (input) => run("Marking message unread", () => actions.markUnread(input)),
    openThread: (rootMessageId) => {
      const returnFocusTarget = typeof document !== "undefined" && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
      const result = run("Opening thread", () => actions.openThread(rootMessageId), false);
      void Promise.resolve(result).then(
        () => { if (openBindingRef.current === openBinding) onOpenThread?.(rootMessageId, returnFocusTarget); },
        () => undefined,
      );
      return result;
    },
    ...(onForwardMessage === undefined
      ? {}
      : {
          forwardMessage: (sourceMessageId: MessageId) => {
            if (sourceMessageId !== viewModel.id) return;
            const preview = forwardPreview(viewModel);
            if (preview === undefined) return;
            const returnFocusTarget = typeof document !== "undefined" && document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null;
            onForwardMessage(Object.freeze({
              sourceMessageId: viewModel.id,
              sourceConversationId: viewModel.conversationId,
              preview,
            }), returnFocusTarget);
          },
        }),
    saveMessage: async (messageId) => {
      if (messageId !== viewModel.id || !viewModel.saved.available) {
        return Object.freeze({ status: "failed", conflict: false });
      }
      try {
        const result = await run("Saving message", () => actions.saveMessage({ messageId }));
        return savedMessageActionOutcome(result);
      } catch {
        return Object.freeze({ status: "failed", conflict: false });
      }
    },
    unsaveMessage: async (messageId) => {
      if (messageId !== viewModel.id || !viewModel.saved.available) {
        return Object.freeze({ status: "failed", conflict: false });
      }
      try {
        const result = await run("Removing saved message", () => actions.unsaveMessage({ messageId }));
        return savedMessageActionOutcome(result);
      } catch {
        return Object.freeze({ status: "failed", conflict: false });
      }
    },
    retrySavedMessage: async (messageId) => {
      if (messageId !== viewModel.id || !viewModel.saved.available ||
        viewModel.saved.mutationState !== "failed" || !viewModel.saved.retryable) {
        return Object.freeze({ status: "failed", conflict: false });
      }
      try {
        const result = await run("Retrying saved-message update", () => actions.retrySavedMessage(messageId));
        return savedMessageActionOutcome(result);
      } catch {
        return Object.freeze({ status: "failed", conflict: false });
      }
    },
    setMessageReminder: async (input) => {
      if (input.messageId !== viewModel.id) return Object.freeze({ status: "failed", conflict: false });
      try {
        const result = await run("Setting reminder", () => actions.setMessageReminder(input));
        return reminderActionOutcome(result);
      } catch {
        return Object.freeze({ status: "failed", conflict: false });
      }
    },
    cancelMessageReminder: async (messageId) => {
      if (messageId !== viewModel.id) return Object.freeze({ status: "failed", conflict: false });
      try {
        const result = await run("Cancelling reminder", () => actions.cancelMessageReminder(messageId));
        return reminderActionOutcome(result);
      } catch {
        return Object.freeze({ status: "failed", conflict: false });
      }
    },
    retryMessageReminder: async (messageId) => {
      if (messageId !== viewModel.id) return Object.freeze({ status: "failed", conflict: false });
      try {
        const result = await run("Retrying reminder", () => actions.retryMessageReminder(messageId));
        return reminderActionOutcome(result);
      } catch {
        return Object.freeze({ status: "failed", conflict: false });
      }
    },
  }), [actions, openBinding, onCreateThread, threadCreationDisabledReason, onForwardMessage, onOpenThread, run, viewModel, inlineReply, replyDisabledReason, onReplyRequested, conversationId, replyBinding]);

  const reactionAggregates = useMemo(() => {
    const preferredOrder = new Map<string, number>();
    for (const reactionKey of reactionKeys) {
      if (!preferredOrder.has(reactionKey)) preferredOrder.set(reactionKey, preferredOrder.size);
    }
    const seen = new Set<string>();
    return message.reactions
      .filter((reaction) => {
        if (seen.has(reaction.reactionKey)) return false;
        seen.add(reaction.reactionKey);
        return true;
      })
      .map((reaction, index) => ({ reaction, index }))
      .sort((left, right) => {
        const leftOrder = preferredOrder.get(left.reaction.reactionKey);
        const rightOrder = preferredOrder.get(right.reaction.reactionKey);
        if (leftOrder === undefined && rightOrder === undefined) return left.index - right.index;
        if (leftOrder === undefined) return 1;
        if (rightOrder === undefined) return -1;
        return leftOrder - rightOrder;
      })
      .map(({ reaction }) => reaction);
  }, [message.reactions, reactionKeys]);
  const reactionEligible = message.content !== null &&
    message.deletedAt === undefined &&
    viewModel.delivery.state === "sent";
  const restoreReactionTriggerFocus = useCallback(() => {
    reactionPickerTriggerRef.current?.focus();
  }, []);
  const positionReactionPicker = useCallback(() => {
    const trigger = reactionPickerTriggerRef.current;
    if (trigger === null) return;
    const panel = reactionPickerAnchorRef.current?.querySelector<HTMLElement>(
      ".handrail-chat__reaction-picker",
    ) ?? null;
    setReactionPickerStyle(reactionPickerViewportStyle(trigger, panel));
  }, []);
  const openReactionPicker = useCallback(() => {
    positionReactionPicker();
    setReactionPickerOpen(true);
  }, [positionReactionPicker]);
  const selectPickerReaction = useCallback((reactionKey: ReactionPickerReactionKey) => {
    const aggregate = message.reactions.find((reaction) => reaction.reactionKey === reactionKey);
    void messageActions.setReaction({
      messageId: message.id,
      reactionKey,
      reacted: !(aggregate?.reactedByCurrentUser ?? false),
    });
  }, [message.id, message.reactions, messageActions]);

  useEffect(() => {
    if (!reactionEligible) setReactionPickerOpen(false);
  }, [reactionEligible]);

  useLayoutEffect(() => {
    if (!reactionPickerOpen) return;
    const trigger = reactionPickerTriggerRef.current;
    const view = trigger?.ownerDocument.defaultView;
    if (trigger === null || trigger === undefined || view === null || view === undefined) return;
    let frame: number | undefined;
    const update = (): void => {
      if (frame !== undefined) return;
      frame = view.requestAnimationFrame(() => {
        frame = undefined;
        positionReactionPicker();
      });
    };
    positionReactionPicker();
    view.addEventListener("resize", update);
    view.addEventListener("scroll", update, true);
    return () => {
      if (frame !== undefined) view.cancelAnimationFrame(frame);
      view.removeEventListener("resize", update);
      view.removeEventListener("scroll", update, true);
    };
  }, [positionReactionPicker, reactionPickerOpen]);

  const blocks = message.content?.blocks ?? [];
  const supplements: ReactNode[] = message.attachmentMetadata.map((attachment, attachmentIndex) => {
    const projected: ChatAttachmentViewModel = Object.freeze({ attachment });
    return createElement(slots.Attachment, {
      attachment: projected,
      hostProps: { "aria-label": `Attachment ${attachment.fileName}` },
      key: `attachment-${attachment.attachmentId}-${attachmentIndex}`,
    });
  });
  blocks.forEach((block, blockIndex) => {
    const systemEvent = projectSystemEvent(block, viewModel, blockIndex);
    if (systemEvent !== undefined) {
      supplements.push(createElement(slots.SystemEvent, {
        event: systemEvent,
        hostProps: { "aria-label": "System event" },
        key: `system-${blockIndex}`,
      }));
      return;
    }
    const linkPreview = projectLinkPreview(block);
    if (linkPreview !== undefined) {
      supplements.push(createElement(slots.LinkPreview, {
        linkPreview,
        hostProps: { "aria-label": `Link preview for ${linkPreview.title}` },
        key: `link-preview-${blockIndex}`,
      }));
      return;
    }
    const entityReference = projectEntityReference(block);
    if (entityReference !== undefined) {
      supplements.push(createElement(slots.EntityReference, {
        entityReference,
        hostProps: { "aria-label": `Entity ${entityReference.label}` },
        key: `entity-${blockIndex}`,
      }));
      return;
    }
    supplements.push(createElement(
      "p",
      { className: "handrail-chat__timeline-unknown-block", key: `unknown-${blockIndex}` },
      `Unsupported message content: ${block.type}`,
    ));
  });

  const threadName = threadResult.data?.thread?.name;
  const threadSummary = message.isThreadRoot
    ? threadResult.data?.summary ?? message.threadSummary
    : undefined;

  return createElement(
    "li",
    {
      "aria-label": `Message from ${displayName(author)}`,
      "aria-posinset": index + 1,
      "aria-setsize": total,
      className: joinClassNames(
        "handrail-chat__timeline-item",
        grouped ? "handrail-chat__timeline-item--grouped" : undefined,
        reactionEligible ? "handrail-chat__timeline-item--reaction-eligible" : undefined,
      ),
      "data-message-id": message.id,
      ...("delivery" in message ? {} : { "data-message-sequence": message.sequence }),
      "data-timeline-row-id": rowId,
      role: "article",
      tabIndex: -1,
    },
    grouped || author === undefined
      ? null
      : createElement(slots.Avatar, { user: author, size: "medium", hostProps: { "aria-label": displayName(author) } }),
    createElement(
      "div",
      { className: "handrail-chat__timeline-item-body" },
      grouped ? null : createElement(
        "header",
        { className: "handrail-chat__timeline-author" },
        createElement("strong", null, displayName(author)),
        createElement(
          "time",
          {
            "aria-label": localDateTimeLabel(message.createdAt),
            dateTime: message.createdAt,
            title: localDateTimeLabel(message.createdAt),
          },
          localTimeLabel(message.createdAt),
        ),
      ),
      createElement(
        MessageTimelineEditRequestContext.Provider,
        { value: editRequest },
        createElement(
          MessageTimelineAnnouncementContext.Provider,
          { value: setLiveMessage },
          createElement(slots.Message, {
            actions: messageActions,
            message: viewModel,
            hostProps: { "data-delivery-state": viewModel.delivery.state, "data-edit-state": viewModel.editState, "data-delete-state": viewModel.deleteState },
          }),
        ),
      ),
      supplements,
      !reactionEligible
        ? null
        : createElement(
            "div",
            { "aria-label": "Reactions", className: "handrail-chat__timeline-reactions", role: "group" },
            reactionAggregates.map((aggregate) => {
              const reactionKey = aggregate.reactionKey;
              const reacted = aggregate.reactedByCurrentUser;
              return createElement(
                "button",
                {
                  "aria-label": `${reacted ? "Remove" : "Add"} ${reactionKey} reaction`,
                  "aria-pressed": reacted,
                  className: "handrail-chat__timeline-reaction",
                  key: reactionKey,
                  onClick: () => void messageActions.setReaction({ messageId: message.id, reactionKey, reacted: !reacted }),
                  type: "button",
                },
                reactionKey,
                createElement("span", { "aria-label": `${aggregate.count} reactions` }, aggregate.count),
              );
            }),
            createElement(
              "span",
              {
                className: "handrail-chat__timeline-reaction-picker-anchor",
                "data-picker-open": reactionPickerOpen,
                ref: reactionPickerAnchorRef,
              },
              createElement(
                "button",
                {
                  "aria-expanded": reactionPickerOpen,
                  "aria-haspopup": "dialog",
                  "aria-label": "Add reaction",
                  className: "handrail-chat__timeline-reaction-picker-trigger",
                  onClick: openReactionPicker,
                  ref: reactionPickerTriggerRef,
                  title: "Add reaction",
                  type: "button",
                },
                reactionPickerTriggerIcon(),
              ),
              reactionPickerOpen
                ? createElement(ReactionPicker, {
                    ariaLabel: `Choose a reaction for message from ${displayName(author)}`,
                    className: "handrail-chat__timeline-reaction-picker",
                    onDismiss: () => setReactionPickerOpen(false),
                    onSelect: selectPickerReaction,
                    restoreFocus: restoreReactionTriggerFocus,
                    ...(reactionPickerStyle === undefined ? {} : { style: reactionPickerStyle }),
                    topLayer: true,
                  })
                : null,
            ),
          ),
      threadSummary === undefined
        ? null
        : createElement(
            "button",
            {
              "aria-label": `Open thread${threadName === undefined ? "" : ` ${threadName}`} with ${threadSummary.replyCount} ${threadSummary.replyCount === 1 ? "reply" : "replies"}`,
              className: "handrail-chat__timeline-thread",
              onClick: () => void messageActions.openThread(message.id),
              type: "button",
            },
            threadName === undefined ? null : `${threadName} · `,
            `${threadSummary.replyCount} ${threadSummary.replyCount === 1 ? "reply" : "replies"}`,
            threadSummary.unreadCount > 0 ? ` · ${threadSummary.unreadCount} unread` : "",
          ),
      otherMemberReadState === undefined
        ? null
        : createElement(Receipt, { conversationId, message, otherMemberReadState }),
    ),
  );
};

const effectiveLastReadSequence = (state: ConversationReadState | undefined): number | undefined => {
  if (state === undefined) return undefined;
  return state.manualUnreadFromSequence === undefined
    ? state.lastReadSequence
    : Math.min(state.lastReadSequence, state.manualUnreadFromSequence - 1);
};

interface TimelineUnreadBoundary {
  readonly conversationId: ConversationId;
  effectiveRead: number | undefined;
  hasUnread: boolean;
  initialized: boolean;
  observedManualUnreadFromSequence: number | undefined;
}

const localDateKeyFromDate = (date: Date): string => {
  return [
    date.getFullYear().toString().padStart(4, "0"),
    (date.getMonth() + 1).toString().padStart(2, "0"),
    date.getDate().toString().padStart(2, "0"),
  ].join("-");
};

const localDateKey = (timestamp: IsoTimestamp): string =>
  localDateKeyFromDate(new Date(timestamp));

const localDateLabel = (timestamp: IsoTimestamp): string =>
  new Intl.DateTimeFormat(undefined, { dateStyle: "long" }).format(new Date(timestamp));

const localTimeLabel = (timestamp: IsoTimestamp): string =>
  new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(timestamp));

const localDateTimeLabel = (timestamp: IsoTimestamp): string =>
  new Intl.DateTimeFormat(undefined, { dateStyle: "long", timeStyle: "medium" }).format(new Date(timestamp));

const isGroupedWithPrevious = (message: TimelineMessage, previous: TimelineMessage | undefined): boolean => {
  if (previous === undefined || previous.author.userId !== message.author.userId) return false;
  const currentDate = new Date(message.createdAt);
  const previousDate = new Date(previous.createdAt);
  return localDateKey(message.createdAt) === localDateKey(previous.createdAt) &&
    currentDate.getTime() - previousDate.getTime() <= 5 * 60_000;
};

interface TimelineDateRowDescriptor {
  readonly id: string;
  readonly kind: "date";
  readonly dayKey: string;
  readonly label: string;
  readonly accessibleLabel: string;
  readonly estimatedHeight: number;
}

interface TimelineUnreadRowDescriptor {
  readonly id: string;
  readonly kind: "unread";
  readonly estimatedHeight: number;
}

interface TimelineMessageRowDescriptor {
  readonly id: string;
  readonly kind: "message";
  readonly message: TimelineMessage;
  readonly messageIndex: number;
  readonly grouped: boolean;
  readonly estimatedHeight: number;
}

type TimelineRowDescriptor =
  | TimelineDateRowDescriptor
  | TimelineUnreadRowDescriptor
  | TimelineMessageRowDescriptor;

const READ_VISIBILITY_THRESHOLD = 0.5;
const READ_OBSERVATION_SETTLE_MS = 100;
const BOTTOM_AFFINITY_THRESHOLD_PX = 24;
const TIMELINE_OVERSCAN_PX = 600;
const DATE_ROW_ESTIMATED_HEIGHT_PX = 50;
const UNREAD_ROW_ESTIMATED_HEIGHT_PX = 38;
const MESSAGE_ROW_ESTIMATED_HEIGHT_PX = 92;
const GROUPED_MESSAGE_ROW_ESTIMATED_HEIGHT_PX = 68;

const isActiveTimelineViewport = (viewport: HTMLElement): boolean => {
  if (
    !viewport.isConnected ||
    document.visibilityState !== "visible" ||
    !document.hasFocus() ||
    viewport.closest('[hidden], [aria-hidden="true"]') !== null
  ) return false;
  if (viewport.closest(".handrail-chat__timeline") === null) return false;
  let element: HTMLElement | null = viewport;
  while (element !== null) {
    const style = window.getComputedStyle(element);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse" ||
      style.opacity === "0"
    ) return false;
    element = element.parentElement;
  }
  return true;
};

const isMeaningfullyVisibleMessage = (entry: IntersectionObserverEntry): boolean => {
  if (!entry.isIntersecting || entry.rootBounds === null) return false;
  const row = entry.boundingClientRect;
  const root = entry.rootBounds;
  if (row.width <= 0 || row.height <= 0 || root.width <= 0 || root.height <= 0) return false;
  const visibleWidth = Math.max(0, Math.min(row.right, root.right) - Math.max(row.left, root.left));
  const visibleHeight = Math.max(0, Math.min(row.bottom, root.bottom) - Math.max(row.top, root.top));
  if (visibleWidth <= 0 || visibleHeight <= 0) return false;
  const fullyVisible = visibleWidth >= row.width && visibleHeight >= row.height;
  return fullyVisible || entry.intersectionRatio >= READ_VISIBILITY_THRESHOLD;
};

/**
 * Accessible, headless-hook-driven parent-conversation timeline. It imports no
 * client cache, transport, socket, provider, server, or testing implementation.
 */
export function MessageTimeline({
  conversationId,
  introduction,
  ariaLabel = "Message timeline",
  className,
  pageSize,
  slots: slotOverrides,
  reactionKeys = ["👍"],
  currentUserId,
  resolveMessageMutationAvailability,
  editControllerRef,
  otherMemberReadState,
  onOpenThread,
  onReplyRequested,
  onCreateThread,
  readOnly,
  replyAvailability,
  onForwardMessage,
}: MessageTimelineProps): ReactElement {
  const context = useContext(ChatContext);
  const threadCreationDisabledReason = useThreadCreationRestriction(conversationId, readOnly, replyAvailability);
  const sourceRuntime = context?.client.messageContext;
  const inlineReply = useReplyStyle().effectiveStyle === "discord";
  const conversationReplyRestriction = useChatSelector(useCallback((state: NormalizedChatCacheState) => {
    const conversation = state.entities.conversations[conversationId];
    const membership = state.currentUser.memberships[conversationId];
    if (state.identity === null || conversation === undefined) return "This conversation is unavailable.";
    if (conversation.archivedAt !== undefined) return "This conversation is archived.";
    if ((membership !== undefined && membership.state !== "active") ||
      (conversation.visibility !== "public" && membership?.state !== "active")) {
      return "You must be an active member to reply.";
    }
    return undefined;
  }, [conversationId]));
  const replyDisabledReason = !inlineReply ? undefined : !context?.isReady ? "Chat is not ready to send replies." :
    context.state.state !== "ready" || context.state.enabledFeatures?.inlineReplies !== true
      ? "Inline replies are not supported by this server." :
    readOnly === true ? "This conversation is read-only." :
    replyAvailability?.canSend === false ? "You do not have permission to send messages." :
    replyAvailability?.membershipState !== undefined && replyAvailability.membershipState !== "active"
      ? "You must be an active member to reply." :
    conversationReplyRestriction ?? (onReplyRequested === undefined ? "A reply composer is unavailable." : undefined);
  const navigationScope = useMemo(() => ({ conversationId, sourceRuntime }), [conversationId, sourceRuntime]);
  const navigationScopeRef = useRef<typeof navigationScope | undefined>(navigationScope);
  navigationScopeRef.current = navigationScope;
  const navigationRef = useRef<{
    target: MessageContextRequest; trigger: HTMLElement | null; row: HTMLElement | null;
    ready: boolean; finish: (success: boolean) => void; release: () => void;
  } | undefined>(undefined);
  const [navigationVersion, setNavigationVersion] = useState(0);
  const messagesResult = useMessages(conversationId, pageSize === undefined ? {} : { limit: pageSize });
  const readResult = useReadState(conversationId);
  const actions = useChatActions(conversationId);
  const [liveMessage, setLiveMessage] = useState("");
  const [editRequest, setEditRequest] = useState<{
    readonly id: number;
    readonly messageId: MessageId;
    readonly returnFocusTarget: HTMLElement | null;
  }>();
  const editRequestIdRef = useRef(0);
  const viewportRef = useRef<HTMLDivElement>(null);
  const feedRef = useRef<HTMLOListElement>(null);
  const anchorRef = useRef<{
    readonly anchor: TimelineWindowAnchor;
    readonly focusMessageId?: MessageId;
    readonly viewportOffsetFromAnchorTop?: number;
  } | undefined>(undefined);
  const pendingMeasurementAnchorRef = useRef<TimelineWindowAnchor | undefined>(undefined);
  const pendingFocusMessageIdRef = useRef<MessageId | undefined>(undefined);
  const revealMessageRef = useRef<(messageId: MessageId, focus: boolean) => boolean>(() => false);
  const initialScrollConversationIdRef = useRef<ConversationId | undefined>(undefined);
  const bottomAffinityRef = useRef(true);
  const [bottomPinned, setBottomPinned] = useState(true);
  const [viewportMetrics, setViewportMetrics] = useState({ offset: 0, height: 0 });
  const measuredRowHeightsRef = useRef(new Map<string, number>());
  const [measurementVersion, setMeasurementVersion] = useState(0);
  const renderedMessageCountRef = useRef(0);
  const [newMessageCount, setNewMessageCount] = useState(0);
  const readCursorRef = useRef<number | undefined>(undefined);
  const requestedReadCursorRef = useRef<number | undefined>(undefined);
  // Read receipts can advance while the conversation is open, but the visual
  // entry boundary remains stable until navigation selects another conversation.
  const unreadBoundaryRef = useRef<TimelineUnreadBoundary>({
    conversationId,
    effectiveRead: undefined,
    hasUnread: false,
    initialized: false,
    observedManualUnreadFromSequence: undefined,
  });
  const suppressReadObservationRef = useRef(false);
  const readSuppressionTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // A manual unread command pauses this visit's automatic reads, including
  // already scheduled observations and layout changes caused by the divider.
  const manualReadPauseRef = useRef<{ pending: boolean } | undefined>(undefined);
  const scheduleReadRef = useRef<() => void>(() => undefined);
  const resumeIntentionalReading = useCallback((): void => {
    if (manualReadPauseRef.current?.pending) return;
    manualReadPauseRef.current = undefined;
    scheduleReadRef.current();
  }, []);
  const timelineActions = useMemo<ChatActions>(() => ({
    ...actions,
    markUnread: async (input) => {
      const previousPause = manualReadPauseRef.current;
      const pause = { pending: true };
      manualReadPauseRef.current = pause;
      let succeeded = false;
      try {
        const result = await actions.markUnread(input);
        succeeded = actionSucceeded(result);
        return result;
      } finally {
        pause.pending = false;
        if (!succeeded && manualReadPauseRef.current === pause) {
          manualReadPauseRef.current = previousPause;
          scheduleReadRef.current();
        }
      }
    },
  }), [actions]);
  const messages = useMemo(
    () => [...(messagesResult.data?.messages ?? [])]
      .filter((message) => message.conversationId === conversationId)
      .sort((left, right) => left.sequence - right.sequence),
    [conversationId, messagesResult.data?.messages],
  );
  const authorIds = useMemo(
    () => [...new Set(messages.map((message) => message.author.userId))],
    [messages],
  );
  const authorsResult = useDirectoryUsers(authorIds);
  const authorsById = useMemo(
    () => new Map((authorsResult.data ?? []).map((author) => [author.userId, author])),
    [authorsResult.data],
  );
  const currentReadState = readResult.data?.readState;
  const effectiveRead = effectiveLastReadSequence(currentReadState);
  if (unreadBoundaryRef.current.conversationId !== conversationId) {
    unreadBoundaryRef.current = {
      conversationId,
      effectiveRead: undefined,
      hasUnread: false,
      initialized: false,
      observedManualUnreadFromSequence: undefined,
    };
  }
  const unreadBoundary = unreadBoundaryRef.current;
  if (
    !unreadBoundary.initialized &&
    effectiveRead !== undefined &&
    (messages.length > 0 || messagesResult.status !== "loading")
  ) {
    unreadBoundary.effectiveRead = effectiveRead;
    unreadBoundary.hasUnread = messages.some((message) => message.sequence > effectiveRead);
    unreadBoundary.initialized = true;
    unreadBoundary.observedManualUnreadFromSequence =
      currentReadState?.manualUnreadFromSequence;
  } else if (unreadBoundary.initialized) {
    const manualUnreadFromSequence = currentReadState?.manualUnreadFromSequence;
    if (
      manualUnreadFromSequence !== undefined &&
      manualUnreadFromSequence !== unreadBoundary.observedManualUnreadFromSequence
    ) {
      unreadBoundary.effectiveRead = manualUnreadFromSequence - 1;
      unreadBoundary.hasUnread = true;
    }
    unreadBoundary.observedManualUnreadFromSequence = manualUnreadFromSequence;
  }
  const unreadBoundaryRead = unreadBoundary.hasUnread
    ? unreadBoundary.effectiveRead
    : undefined;
  const firstUnreadIndex = unreadBoundaryRead === undefined
    ? -1
    : messages.findIndex((message) => message.sequence > unreadBoundaryRead);
  const rowDescriptors = useMemo<readonly TimelineRowDescriptor[]>(() => {
    const rows: TimelineRowDescriptor[] = [];
    const todayKey = localDateKeyFromDate(new Date());
    messages.forEach((message, messageIndex) => {
      const dayKey = localDateKey(message.createdAt);
      const previousMessage = messages[messageIndex - 1];
      if (previousMessage === undefined || dayKey !== localDateKey(previousMessage.createdAt)) {
        const fullDateLabel = localDateLabel(message.createdAt);
        const isToday = dayKey === todayKey;
        rows.push(Object.freeze({
          id: `date:${dayKey}:${message.id}`,
          kind: "date",
          dayKey,
          label: isToday ? "Today" : fullDateLabel,
          accessibleLabel: isToday ? `Today, ${fullDateLabel}` : fullDateLabel,
          estimatedHeight: DATE_ROW_ESTIMATED_HEIGHT_PX,
        }));
      }
      if (messageIndex === firstUnreadIndex) {
        rows.push(Object.freeze({
          id: `unread:${message.id}`,
          kind: "unread",
          estimatedHeight: UNREAD_ROW_ESTIMATED_HEIGHT_PX,
        }));
      }
      const grouped = isGroupedWithPrevious(message, previousMessage);
      rows.push(Object.freeze({
        id: `message:${message.id}`,
        kind: "message",
        message,
        messageIndex,
        grouped,
        estimatedHeight: grouped
          ? GROUPED_MESSAGE_ROW_ESTIMATED_HEIGHT_PX
          : MESSAGE_ROW_ESTIMATED_HEIGHT_PX,
      }));
    });
    return Object.freeze(rows);
  }, [firstUnreadIndex, messages]);
  const timelineRows = useMemo<readonly TimelineWindowRow[]>(() =>
    Object.freeze(rowDescriptors.map((row) => {
      const measuredHeight = measuredRowHeightsRef.current.get(row.id);
      return Object.freeze({
        id: row.id,
        estimatedHeight: row.estimatedHeight,
        ...(measuredHeight === undefined ? {} : { measuredHeight }),
      });
    })), [measurementVersion, rowDescriptors]);
  const timelineWindow = useMemo(() => calculateTimelineWindow({
    rows: timelineRows,
    viewportOffset: viewportMetrics.offset,
    viewportHeight: viewportMetrics.height,
    overscan: TIMELINE_OVERSCAN_PX,
  }), [timelineRows, viewportMetrics]);
  const mountedRowKey = timelineWindow.mountedRowIds.join("\u0000");
  const firstMessageId = messages[0]?.id;
  const latestMessage = messages[messages.length - 1];
  const latestRowIdentity = latestMessage === undefined
    ? undefined
    : "delivery" in latestMessage
      ? `${latestMessage.id}:optimistic:${latestMessage.delivery.clientMessageId}:${latestMessage.delivery.state}:${latestMessage.delivery.attempt}`
      : `${latestMessage.id}:canonical:${latestMessage.revision.revision}`;
  const slots = useMemo<TimelineSlots>(() => ({
    Avatar: slotOverrides?.Avatar ?? DEFAULT_SLOTS.Avatar,
    Message: slotOverrides?.Message ?? DEFAULT_SLOTS.Message,
    EmptyState: slotOverrides?.EmptyState ?? DEFAULT_SLOTS.EmptyState,
    Attachment: slotOverrides?.Attachment ?? DEFAULT_SLOTS.Attachment,
    LinkPreview: slotOverrides?.LinkPreview ?? DEFAULT_SLOTS.LinkPreview,
    SystemEvent: slotOverrides?.SystemEvent ?? DEFAULT_SLOTS.SystemEvent,
    EntityReference: slotOverrides?.EntityReference ?? DEFAULT_SLOTS.EntityReference,
  }), [slotOverrides]);
  const latestEditableMessage = useMemo(() => {
    if (
      editControllerRef === undefined ||
      currentUserId === undefined ||
      slots.Message !== DefaultMessageRenderer
    ) return undefined;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (
        message === undefined ||
        message.author.userId !== currentUserId ||
        message.content === null ||
        message.deletedAt !== undefined ||
        "delivery" in message ||
        !resolveMutationAvailability(
          message,
          currentUserId,
          resolveMessageMutationAvailability,
        ).canEdit
      ) continue;
      return message;
    }
    return undefined;
  }, [
    currentUserId,
    editControllerRef,
    messages,
    resolveMessageMutationAvailability,
    slots.Message,
  ]);
  const finishEditRequest = useCallback((restoreComposerFocus: boolean): void => {
    setEditRequest((current) => {
      if (current === undefined) return current;
      if (restoreComposerFocus && current.returnFocusTarget?.isConnected) {
        current.returnFocusTarget.focus();
      }
      return undefined;
    });
  }, []);
  const requestLatestMessageEdit = useCallback((
    returnFocusTarget: HTMLElement | null,
  ): boolean => {
    if (latestEditableMessage === undefined) return false;
    revealMessageRef.current(latestEditableMessage.id, false);
    editRequestIdRef.current += 1;
    setEditRequest(Object.freeze({
      id: editRequestIdRef.current,
      messageId: latestEditableMessage.id,
      returnFocusTarget,
    }));
    return true;
  }, [latestEditableMessage]);
  useImperativeHandle(editControllerRef, () => Object.freeze({
    requestLatestMessageEdit,
    revealMessage: (messageId: MessageId) => revealMessageRef.current(messageId, false),
  }), [requestLatestMessageEdit]);

  useEffect(() => {
    setEditRequest(undefined);
  }, [conversationId]);

  readCursorRef.current = effectiveRead;

  useEffect(() => {
    requestedReadCursorRef.current = effectiveRead;
  }, [conversationId, effectiveRead]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null || typeof IntersectionObserver === "undefined") return;
    let disposed = false;
    let scrolling = false;
    let readTimer: ReturnType<typeof setTimeout> | undefined;
    let scrollTimer: ReturnType<typeof setTimeout> | undefined;
    const qualifiedSequences = new Map<HTMLElement, number>();

    const cancelRead = (): void => {
      if (readTimer !== undefined) clearTimeout(readTimer);
      readTimer = undefined;
    };
    const timelineIsActive = (): boolean =>
      !disposed && !suppressReadObservationRef.current &&
      manualReadPauseRef.current === undefined && isActiveTimelineViewport(viewport);
    const flushRead = (): void => {
      readTimer = undefined;
      if (scrolling || !timelineIsActive()) return;
      let highest: number | undefined;
      for (const [row, sequence] of qualifiedSequences) {
        if (!row.isConnected || !viewport.contains(row)) {
          qualifiedSequences.delete(row);
          continue;
        }
        if (highest === undefined || sequence > highest) highest = sequence;
      }
      const current = Math.max(
        readCursorRef.current ?? -1,
        requestedReadCursorRef.current ?? -1,
      );
      if (highest === undefined || highest <= current) return;
      requestedReadCursorRef.current = highest;
      try {
        void actions.markRead({ throughSequence: highest }).then((result) => {
          if (!actionSucceeded(result) && requestedReadCursorRef.current === highest) {
            requestedReadCursorRef.current = readCursorRef.current;
          }
        }, () => {
          if (requestedReadCursorRef.current === highest) {
            requestedReadCursorRef.current = readCursorRef.current;
          }
        });
      } catch {
        if (requestedReadCursorRef.current === highest) {
          requestedReadCursorRef.current = readCursorRef.current;
        }
      }
    };
    const scheduleRead = (): void => {
      cancelRead();
      if (scrolling || !timelineIsActive() || qualifiedSequences.size === 0) return;
      readTimer = setTimeout(flushRead, READ_OBSERVATION_SETTLE_MS);
    };
    scheduleReadRef.current = scheduleRead;
    const observer = new IntersectionObserver((entries) => {
      // Keep visibility current while manually paused so a later intentional
      // read can proceed without requiring a new intersection threshold crossing.
      if (disposed || suppressReadObservationRef.current || !isActiveTimelineViewport(viewport)) return;
      for (const entry of entries) {
        if (!(entry.target instanceof HTMLElement)) continue;
        const sequence = Number(entry.target.dataset.messageSequence);
        if (!Number.isSafeInteger(sequence) || sequence < 0) continue;
        if (isMeaningfullyVisibleMessage(entry)) {
          qualifiedSequences.set(entry.target, sequence);
        } else {
          qualifiedSequences.delete(entry.target);
        }
      }
      scheduleRead();
    }, {
      root: viewport,
      threshold: [0, READ_VISIBILITY_THRESHOLD, 1],
    });
    for (const row of viewport.querySelectorAll<HTMLElement>("[data-message-sequence]")) {
      observer.observe(row);
    }
    const onScroll = (): void => {
      scrolling = true;
      cancelRead();
      if (scrollTimer !== undefined) clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        scrollTimer = undefined;
        scrolling = false;
        scheduleRead();
      }, READ_OBSERVATION_SETTLE_MS);
    };
    const onActivityChange = (): void => {
      if (isActiveTimelineViewport(viewport)) resumeIntentionalReading();
      if (!timelineIsActive()) {
        cancelRead();
        return;
      }
      scheduleRead();
    };
    const onPointerDown = (event: PointerEvent): void => {
      // The viewport itself is the scrollbar target; message action buttons
      // and their focus restoration must not release the manual pause.
      if (event.target === viewport) resumeIntentionalReading();
    };
    viewport.addEventListener("wheel", resumeIntentionalReading, { passive: true });
    viewport.addEventListener("touchmove", resumeIntentionalReading, { passive: true });
    viewport.addEventListener("pointerdown", onPointerDown);
    viewport.addEventListener("scroll", onScroll, { passive: true });
    document.addEventListener("visibilitychange", onActivityChange);
    window.addEventListener("blur", onActivityChange);
    window.addEventListener("focus", onActivityChange);
    return () => {
      disposed = true;
      cancelRead();
      if (scrollTimer !== undefined) clearTimeout(scrollTimer);
      observer.disconnect();
      qualifiedSequences.clear();
      scheduleReadRef.current = () => undefined;
      viewport.removeEventListener("wheel", resumeIntentionalReading);
      viewport.removeEventListener("touchmove", resumeIntentionalReading);
      viewport.removeEventListener("pointerdown", onPointerDown);
      viewport.removeEventListener("scroll", onScroll);
      document.removeEventListener("visibilitychange", onActivityChange);
      window.removeEventListener("blur", onActivityChange);
      window.removeEventListener("focus", onActivityChange);
    };
  }, [actions, conversationId, mountedRowKey, resumeIntentionalReading]);

  useEffect(() => () => {
    if (readSuppressionTimerRef.current !== undefined) {
      clearTimeout(readSuppressionTimerRef.current);
      readSuppressionTimerRef.current = undefined;
    }
    suppressReadObservationRef.current = false;
    manualReadPauseRef.current = undefined;
  }, [conversationId]);

  const finishReplyNavigation = useCallback((success: boolean, preferRow = false) => {
    const pending = navigationRef.current;
    if (pending === undefined) return;
    navigationRef.current = undefined;
    pending.release();
    if (!success) {
      pendingFocusMessageIdRef.current = undefined;
      const target = !preferRow && pending.trigger?.isConnected && !pending.trigger.matches(":disabled") ? pending.trigger :
        pending.row?.isConnected ? pending.row : null;
      target?.focus({ preventScroll: true });
    }
    pending.finish(success);
  }, []);

  useLayoutEffect(() => {
    navigationScopeRef.current = navigationScope;
    return () => {
      if (navigationScopeRef.current === navigationScope) navigationScopeRef.current = undefined;
      finishReplyNavigation(false);
    };
  }, [navigationScope, finishReplyNavigation]);

  const jumpToReply = useCallback<JumpToReply>((target) => {
    if (navigationScopeRef.current !== navigationScope) return Promise.resolve(false);
    finishReplyNavigation(false);
    if (target.conversationId !== conversationId || sourceRuntime?.getState(target).status !== "available") return Promise.resolve(false);
    const active = typeof document === "undefined" ? null : document.activeElement;
    const trigger = active instanceof HTMLElement ? active : null;
    return new Promise<boolean>((finish) => {
      const pending = { target, trigger, row: trigger?.closest<HTMLElement>("[data-message-id]") ?? null,
        ready: false, finish, release: () => {} };
      navigationRef.current = pending;
      pending.release = sourceRuntime.subscribe(target, () => {
        const status = sourceRuntime.getState(target).status;
        if (status !== "available" && status !== "loading_window") finishReplyNavigation(false, true);
      });
      const ready = () => {
        if (navigationRef.current !== pending) {
          // Window requests belong to the runtime and may finish after Escape.
          // If hydration removed the restored trigger, retain a focus position
          // in this timeline without stealing focus from another control/scope.
          if (navigationScopeRef.current === navigationScope && navigationRef.current === undefined &&
              trigger !== null && !trigger.isConnected && document.activeElement === document.body) {
            viewportRef.current?.focus({ preventScroll: true });
          }
          return;
        }
        if (sourceRuntime.getState(target).status !== "available") { finishReplyNavigation(false); return; }
        pending.ready = true;
        setNavigationVersion(version => version + 1);
      };
      if (revealMessageRef.current(target.messageId, false)) ready();
      else void sourceRuntime.loadSourceWindow(target).then(ready, () => {
        if (navigationRef.current === pending) finishReplyNavigation(false);
      });
    });
  }, [conversationId, sourceRuntime, navigationScope, finishReplyNavigation]);

  const updateBottomAffinity = useCallback((pinned: boolean): void => {
    if (pinned) setNewMessageCount(0);
    if (bottomAffinityRef.current === pinned) return;
    bottomAffinityRef.current = pinned;
    setBottomPinned(pinned);
  }, []);

  const syncViewportMetrics = useCallback((viewport: HTMLElement): void => {
    const next = { offset: viewport.scrollTop, height: viewport.clientHeight };
    setViewportMetrics((current) =>
      current.offset === next.offset && current.height === next.height ? current : next);
  }, []);

  const revealMessage = useCallback((messageId: MessageId, focus: boolean): boolean => {
    const viewport = viewportRef.current;
    const rowIndex = rowDescriptors.findIndex((row) =>
      row.kind === "message" && row.message.id === messageId);
    if (viewport === null || rowIndex === -1) return false;
    const row = timelineRows[rowIndex];
    if (row === undefined) return false;
    const rowTop = calculateTimelineAnchorOffsetCorrection({
      rows: timelineRows,
      anchor: { rowId: row.id, offsetWithinRow: 0 },
      viewportHeight: viewport.clientHeight,
    });
    const rowHeight = row.measuredHeight ?? row.estimatedHeight;
    viewport.scrollTop = Math.max(
      0,
      rowTop - Math.max(0, (viewport.clientHeight - rowHeight) / 2),
    );
    if (focus) {
      const mountedTarget = [...viewport.querySelectorAll<HTMLElement>("[data-message-id]")]
        .find((element) => element.dataset.messageId === messageId);
      if (mountedTarget === undefined) pendingFocusMessageIdRef.current = messageId;
      else mountedTarget.focus({ preventScroll: true });
    }
    updateBottomAffinity(rowIndex === rowDescriptors.length - 1);
    syncViewportMetrics(viewport);
    return true;
  }, [rowDescriptors, syncViewportMetrics, timelineRows, updateBottomAffinity]);
  revealMessageRef.current = revealMessage;

  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null) return;
    const onScroll = (): void => {
      const maximum = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      updateBottomAffinity(maximum - viewport.scrollTop <= BOTTOM_AFFINITY_THRESHOLD_PX);
      syncViewportMetrics(viewport);
    };
    syncViewportMetrics(viewport);
    viewport.addEventListener("scroll", onScroll, { passive: true });
    return () => viewport.removeEventListener("scroll", onScroll);
  }, [conversationId, syncViewportMetrics, updateBottomAffinity]);

  useLayoutEffect(() => {
    initialScrollConversationIdRef.current = undefined;
    anchorRef.current = undefined;
    bottomAffinityRef.current = true;
    measuredRowHeightsRef.current.clear();
    pendingMeasurementAnchorRef.current = undefined;
    pendingFocusMessageIdRef.current = undefined;
    renderedMessageCountRef.current = messages.length;
    setBottomPinned(true);
    setNewMessageCount(0);
    setViewportMetrics({ offset: 0, height: 0 });
    setMeasurementVersion((current) => current + 1);
  }, [conversationId]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (
      viewport === null ||
      messages.length === 0 ||
      readResult.status === "loading" ||
      anchorRef.current !== undefined ||
      initialScrollConversationIdRef.current === conversationId
    ) return;
    const unreadRow = rowDescriptors.find((row) => row.kind === "unread");
    const maximum = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    viewport.scrollTop = unreadRow === undefined
      ? maximum
      : calculateTimelineAnchorOffsetCorrection({
        rows: timelineRows,
        anchor: { rowId: unreadRow.id, offsetWithinRow: 0 },
        viewportHeight: viewport.clientHeight,
      });
    updateBottomAffinity(maximum - viewport.scrollTop <= BOTTOM_AFFINITY_THRESHOLD_PX);
    initialScrollConversationIdRef.current = conversationId;
    renderedMessageCountRef.current = messages.length;
    syncViewportMetrics(viewport);
  }, [conversationId, messages.length, readResult.status, rowDescriptors, timelineRows, syncViewportMetrics, updateBottomAffinity]);

  useLayoutEffect(() => {
    const previousCount = renderedMessageCountRef.current;
    renderedMessageCountRef.current = messages.length;
    if (
      initialScrollConversationIdRef.current !== conversationId ||
      bottomAffinityRef.current ||
      anchorRef.current !== undefined
    ) return;
    const appendedCount = messages.length - previousCount;
    if (appendedCount > 0) setNewMessageCount((current) => current + appendedCount);
  }, [conversationId, messages.length]);

  useLayoutEffect(() => {
    const pending = anchorRef.current;
    const viewport = viewportRef.current;
    if (pending === undefined || viewport === null) return;
    const correctedAnchorTop = calculateTimelineAnchorOffsetCorrection({
      rows: timelineRows,
      anchor: pending.anchor,
      viewportHeight: viewport.clientHeight,
      fallbackViewportOffset: viewport.scrollTop,
    });
    viewport.scrollTop = Math.max(
      0,
      correctedAnchorTop + (pending.viewportOffsetFromAnchorTop ?? 0),
    );
    if (pending.focusMessageId !== undefined) {
      pendingFocusMessageIdRef.current = pending.focusMessageId;
    }
    anchorRef.current = undefined;
    syncViewportMetrics(viewport);
  }, [firstMessageId, syncViewportMetrics, timelineRows]);

  useLayoutEffect(() => {
    const anchor = pendingMeasurementAnchorRef.current;
    const viewport = viewportRef.current;
    if (anchor === undefined || viewport === null) return;
    pendingMeasurementAnchorRef.current = undefined;
    if (bottomAffinityRef.current) {
      viewport.scrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    } else {
      viewport.scrollTop = calculateTimelineAnchorOffsetCorrection({
        rows: timelineRows,
        anchor,
        viewportHeight: viewport.clientHeight,
        fallbackViewportOffset: viewport.scrollTop,
      });
    }
    syncViewportMetrics(viewport);
  }, [measurementVersion, syncViewportMetrics, timelineRows]);

  useLayoutEffect(() => {
    const messageId = pendingFocusMessageIdRef.current;
    const viewport = viewportRef.current;
    if (messageId === undefined || viewport === null) return;
    const target = [...viewport.querySelectorAll<HTMLElement>("[data-message-id]")]
      .find((element) => element.dataset.messageId === messageId);
    if (target === undefined) return;
    pendingFocusMessageIdRef.current = undefined;
    target.focus({ preventScroll: true });
  }, [mountedRowKey]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (
      viewport === null ||
      latestRowIdentity === undefined ||
      initialScrollConversationIdRef.current !== conversationId ||
      anchorRef.current !== undefined ||
      !bottomAffinityRef.current
    ) return;
    viewport.scrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    syncViewportMetrics(viewport);
  }, [conversationId, latestRowIdentity, syncViewportMetrics]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null) return;
    const restoreBottom = (): void => {
      if (!bottomAffinityRef.current || anchorRef.current !== undefined) return;
      viewport.scrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      syncViewportMetrics(viewport);
    };
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", restoreBottom);
      return () => window.removeEventListener("resize", restoreBottom);
    }
    const observer = new ResizeObserver(restoreBottom);
    observer.observe(viewport);
    if (feedRef.current !== null) observer.observe(feedRef.current);
    return () => observer.disconnect();
  }, [conversationId, latestRowIdentity, mountedRowKey, syncViewportMetrics]);

  useLayoutEffect(() => {
    const pending = navigationRef.current;
    if (pending?.ready !== true || pending.target.conversationId !== conversationId) return;
    if (sourceRuntime?.getState(pending.target).status !== "available" ||
        !revealMessageRef.current(pending.target.messageId, true)) {
      setLiveMessage("Could not open original message.");
      finishReplyNavigation(false);
      return;
    }
    if (pendingFocusMessageIdRef.current === undefined) {
      setLiveMessage("Original message.");
      finishReplyNavigation(true);
    }
  }, [conversationId, sourceRuntime, navigationVersion, mountedRowKey, finishReplyNavigation]);

  useLayoutEffect(() => {
    const feed = feedRef.current;
    const viewport = viewportRef.current;
    if (feed === null || viewport === null) return;
    const renderedRows = () => [...feed.querySelectorAll<HTMLElement>("[data-timeline-row-id]")];
    const measure = (): void => {
      let changed = false;
      for (const row of renderedRows()) {
        const rowId = row.dataset.timelineRowId;
        if (rowId === undefined) continue;
        const rectHeight = row.getBoundingClientRect().height;
        const contentHeight = rectHeight > 0 ? rectHeight : row.offsetHeight;
        if (!Number.isFinite(contentHeight) || contentHeight <= 0) continue;
        const style = window.getComputedStyle(row);
        const measuredHeight = contentHeight +
          (Number.parseFloat(style.marginTop) || 0) +
          (Number.parseFloat(style.marginBottom) || 0);
        const previous = measuredRowHeightsRef.current.get(rowId);
        if (previous !== undefined && Math.abs(previous - measuredHeight) < 0.5) continue;
        measuredRowHeightsRef.current.set(rowId, measuredHeight);
        changed = true;
      }
      if (!changed) return;
      if (
        !bottomAffinityRef.current &&
        anchorRef.current === undefined &&
        timelineWindow.anchor !== undefined
      ) {
        // Entry positioning may have moved the viewport during this layout
        // pass, before the virtual window has rendered at the new offset.
        pendingMeasurementAnchorRef.current = calculateTimelineWindow({
          rows: timelineRows,
          viewportOffset: viewport.scrollTop,
          viewportHeight: viewport.clientHeight,
          overscan: TIMELINE_OVERSCAN_PX,
        }).anchor;
      }
      setMeasurementVersion((current) => current + 1);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    for (const row of renderedRows()) observer.observe(row);
    return () => observer.disconnect();
  }, [conversationId, mountedRowKey, timelineRows, timelineWindow.anchor]);

  const loadOlder = useCallback(() => {
    const data = messagesResult.data;
    const viewport = viewportRef.current;
    if (data === undefined || viewport === null || data.isLoadingOlder || data.pagination?.older.available !== true) return;
    suppressReadObservationRef.current = true;
    if (readSuppressionTimerRef.current !== undefined) clearTimeout(readSuppressionTimerRef.current);
    updateBottomAffinity(false);
    const firstMessageRow = firstMessageId === undefined
      ? undefined
      : timelineRows.find((row) => row.id === `message:${firstMessageId}`);
    const firstMessageTop = firstMessageRow === undefined
      ? undefined
      : calculateTimelineAnchorOffsetCorrection({
          rows: timelineRows,
          anchor: { rowId: firstMessageRow.id, offsetWithinRow: 0 },
          viewportHeight: viewport.clientHeight,
        });
    const anchor = firstMessageRow === undefined
      ? calculateTimelineWindow({
          rows: timelineRows,
          viewportOffset: viewport.scrollTop,
          viewportHeight: viewport.clientHeight,
          overscan: TIMELINE_OVERSCAN_PX,
        }).anchor
      : {
          rowId: firstMessageRow.id,
          offsetWithinRow: Math.max(0, viewport.scrollTop - (firstMessageTop ?? 0)),
        };
    if (anchor !== undefined) {
      anchorRef.current = {
        anchor,
        ...(firstMessageId === undefined ? {} : { focusMessageId: firstMessageId }),
        ...(firstMessageTop === undefined
          ? {}
          : { viewportOffsetFromAnchorTop: viewport.scrollTop - firstMessageTop }),
      };
    }
    setLiveMessage("Loading older messages…");
    void data.loadOlder().then(
      () => setLiveMessage("Older messages loaded."),
      () => setLiveMessage("Older messages could not be loaded."),
    ).finally(() => {
      readSuppressionTimerRef.current = setTimeout(() => {
        readSuppressionTimerRef.current = undefined;
        suppressReadObservationRef.current = false;
      }, READ_OBSERVATION_SETTLE_MS);
    });
  }, [firstMessageId, messagesResult.data, timelineRows, timelineWindow.anchor, updateBottomAffinity]);

  const jumpToLatest = useCallback((): void => {
    resumeIntentionalReading();
    const viewport = viewportRef.current;
    if (viewport === null) return;
    // An exact, synchronous assignment avoids motion for users who request it.
    viewport.scrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    setNewMessageCount(0);
    updateBottomAffinity(true);
    syncViewportMetrics(viewport);
  }, [resumeIntentionalReading, syncViewportMetrics, updateBottomAffinity]);

  const onTimelineKeyDown = (event: KeyboardEvent<HTMLOListElement>): void => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
    if (messages.length === 0) return;
    resumeIntentionalReading();
    const activeRow = document.activeElement instanceof HTMLElement
      ? document.activeElement.closest<HTMLElement>("[data-message-id]")
      : null;
    const current = activeRow === null
      ? -1
      : messages.findIndex((message) => message.id === activeRow.dataset.messageId);
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? messages.length - 1
        : event.key === "ArrowDown"
          ? Math.min(messages.length - 1, Math.max(0, current + 1))
          : Math.max(0, current < 0 ? messages.length - 1 : current - 1);
    const target = messages[next];
    if (target === undefined) return;
    event.preventDefault();
    revealMessage(target.id, true);
  };

  const loading = messagesResult.status === "loading" && messages.length === 0;
  const unavailable = messagesResult.status === "error" && messages.length === 0;
  const empty = messagesResult.status === "empty" || (!loading && !unavailable && messages.length === 0);
  const queryAnnouncement = messagesResult.status === "error"
    ? `Messages could not be loaded. ${messagesResult.error.message}`
    : messagesResult.data?.isLoadingOlder
      ? "Loading older messages…"
      : "";
  let body: ReactNode;
  if (loading) {
    body = createElement("div", { "aria-busy": "true", className: "handrail-chat__timeline-loading" }, "Loading messages…");
  } else if (unavailable) {
    body = createElement(slots.EmptyState, {
      kind: "unavailable",
      title: "Messages unavailable",
      description: messagesResult.error.message,
      hostProps: { role: "alert" },
    });
  } else if (empty) {
    body = createElement(slots.EmptyState, {
      kind: "no_messages",
      title: introduction?.identity ?? "No messages yet",
      description: introduction?.prompt ?? "Start the conversation when you are ready.",
      ...(introduction === undefined ? {} : { introduction }),
      hostProps: {
        className: "handrail-chat__timeline-column",
        ...(introduction === undefined
          ? {}
          : { "data-conversation-introduction": introduction.conversationType }),
      },
    });
  } else {
    const rows: ReactNode[] = [];
    if (timelineWindow.beforeSpacerHeight > 0) {
      rows.push(createElement("li", {
        "aria-hidden": "true",
        className: "handrail-chat__timeline-spacer",
        key: "window-before",
        role: "presentation",
        style: { blockSize: `${timelineWindow.beforeSpacerHeight}px` },
      }));
    }
    for (
      let rowIndex = timelineWindow.startIndex;
      rowIndex < timelineWindow.endIndex;
      rowIndex += 1
    ) {
      const row = rowDescriptors[rowIndex];
      if (row === undefined) continue;
      if (row.kind === "date") {
        rows.push(createElement(
          "li",
          {
            "aria-label": row.accessibleLabel,
            className: "handrail-chat__timeline-date",
            "data-timeline-row-id": row.id,
            key: row.id,
            role: "separator",
          },
          createElement("time", { dateTime: row.dayKey }, row.label),
        ));
        continue;
      }
      if (row.kind === "unread") {
        rows.push(createElement(
          "li",
          {
            "aria-label": "Unread messages",
            className: "handrail-chat__timeline-unread",
            "data-timeline-row-id": row.id,
            key: row.id,
            role: "separator",
          },
          createElement("span", null, "Unread messages"),
        ));
        continue;
      }
      const message = row.message;
      rows.push(createElement(MessageRow, {
        actions: timelineActions,
        inlineReply,
        threadCreationDisabledReason,
        ...(onCreateThread === undefined ? {} : { onCreateThread }),
        replyDisabledReason,
        ...(onReplyRequested === undefined ? {} : { onReplyRequested }),
        jumpToReply,
        author: authorsById.get(message.author.userId),
        conversationId,
        ...(currentUserId === undefined ? {} : { currentUserId }),
        ...(editRequest?.messageId !== message.id
          ? {}
          : {
              editRequest: Object.freeze({
                id: editRequest.id,
                messageId: editRequest.messageId,
                finish: finishEditRequest,
              }),
            }),
        grouped: row.grouped,
        index: row.messageIndex,
        key: row.id,
        message,
        ...(otherMemberReadState === undefined ? {} : { otherMemberReadState }),
        ...(onOpenThread === undefined ? {} : { onOpenThread }),
        ...(onForwardMessage === undefined ? {} : { onForwardMessage }),
        reactionKeys,
        ...(resolveMessageMutationAvailability === undefined
          ? {}
          : { resolveMessageMutationAvailability }),
        setLiveMessage,
        slots,
        total: messages.length,
        rowId: row.id,
      }));
    }
    if (timelineWindow.afterSpacerHeight > 0) {
      rows.push(createElement("li", {
        "aria-hidden": "true",
        className: "handrail-chat__timeline-spacer",
        key: "window-after",
        role: "presentation",
        style: { blockSize: `${timelineWindow.afterSpacerHeight}px` },
      }));
    }
    body = createElement(
      "ol",
      {
        "aria-busy": messagesResult.data?.isLoadingOlder ?? false,
        "aria-label": ariaLabel,
        className: "handrail-chat__timeline-feed handrail-chat__timeline-column",
        onKeyDown: onTimelineKeyDown,
        ref: feedRef,
        role: "feed",
      },
      rows,
    );
  }

  return createElement(
    "section",
    { "aria-label": ariaLabel, className: joinClassNames("handrail-chat__timeline", className),
      onKeyDown: (event) => {
        if (event.key === "Escape" && navigationRef.current !== undefined) {
          event.preventDefault();
          finishReplyNavigation(false);
          setLiveMessage("Original message navigation cancelled.");
        }
      } },
    messagesResult.data?.pagination?.older.available === true
      ? createElement(
          "button",
          {
            className: "handrail-chat__timeline-load-older",
            disabled: messagesResult.data.isLoadingOlder,
            onClick: loadOlder,
            type: "button",
          },
          messagesResult.data.isLoadingOlder ? "Loading older messages" : "Load older messages",
        )
      : null,
    createElement("div", {
      className: "handrail-chat__timeline-viewport",
      "data-bottom-pinned": bottomPinned ? "true" : "false",
      ...(bottomPinned ? {} : { "data-latest-available": "true" }),
      ref: viewportRef,
      tabIndex: -1,
    }, body),
    bottomPinned
      ? null
      : createElement(
          "button",
          {
            className: "handrail-chat__timeline-jump-latest",
            onClick: jumpToLatest,
            type: "button",
          },
          newMessageCount === 0
            ? "Jump to latest"
            : `Jump to latest (${newMessageCount} new ${newMessageCount === 1 ? "message" : "messages"})`,
        ),
    createElement(
      "div",
      { "aria-atomic": "true", "aria-live": "polite", className: "handrail-chat__sr-only", role: "status" },
      liveMessage || queryAnnouncement,
    ),
  );
}
