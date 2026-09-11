import {
  Fragment,
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useImperativeHandle,
  useSyncExternalStore,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type Ref,
  type SubmitEvent,
} from "react";

import {
  useAttachmentUpload,
  useChat,
  useChatActions,
  useConversation,
  useConversationParticipants,
  useDraft,
  useDirectoryUsers,
  useMessages,
} from "../react/index.js";
import type { MessageMention, UserId } from "../contracts/index.js";
import {
  ReactionPicker,
  type ReactionPickerLabelContext,
  type ReactionPickerLabels,
  type ReactionPickerReactionKey,
} from "./reaction-picker.js";
import {
  applyComposerRichTextFormatting,
  canonicalComposerSelection,
  composerRichTextCommandIsActiveAtSelection,
  composerRichTextDocumentFromEditor,
  composerRichTextDocumentHasFormatting,
  composerRichTextDocumentPlainText,
  plainTextToComposerRichTextDocument,
  readComposerRichTextSelection,
  removeComposerRichTextCaretBoundary,
  renderComposerRichTextDocument,
  renderComposerRichTextDocumentWithCaretBoundary,
  setComposerRichTextSelection,
  supportsVisualComposerEditing,
  visualOffsetForComposerMarkdownOffset,
  type ComposerRichTextCommand,
  type ComposerVisualSelection,
} from "./composer-rich-text-editor.js";
import {
  composerMarkdownToRichTextDocument,
  richTextDocumentToCanonicalMarkdown,
  sanitizeComposerMarkdownLink,
} from "./composer-rich-text.js";
import type {
  ChatComposerAttachmentState,
  ChatComposerControls,
  ChatComposerDisabledReason,
  ChatComposerDraftViewModel,
  ChatComposerFormat,
  ChatComposerMentionParticipant,
  ChatComposerSlotProps,
  ChatComposerState,
  ChatConversationViewModel,
  ChatSlotHostProps,
  ChatWorkspaceSlotOverrides,
} from "./slots.js";

type ComposerConversationId = ChatConversationViewModel["id"];
type ComposerAttachmentId = NonNullable<
  ChatComposerDraftViewModel["content"]
>["attachments"][number]["attachmentId"];
type ComposerUploadInput = Parameters<
  ChatComposerSlotProps["actions"]["uploadAttachment"]
>[0];
type ComposerUploadContentType = ComposerUploadInput["metadata"]["contentType"];

const SUPPORTED_CONTENT_TYPES = new Set<ComposerUploadContentType>([
  "application/pdf",
  "audio/mpeg",
  "audio/ogg",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/plain",
  "video/mp4",
  "video/webm",
]);
const ATTACHMENT_ACCEPT = [...SUPPORTED_CONTENT_TYPES].join(",");
const ACTIVE_UPLOAD_STATUSES = new Set<ChatComposerAttachmentState["status"]>([
  "preparing",
  "pending",
  "uploading",
  "finalizing",
]);
const UNSAFE_FILE_NAME = /[\p{Cc}\p{Cf}<>:"/\\|?*]/gu;
const UNSAFE_DIAGNOSTIC = /[\p{Cc}\p{Cf}]/gu;

const COMPOSER_EMOJI_PICKER_LABELS: ReactionPickerLabels = Object.freeze({
  title: "Choose emoji",
  search: "Search emoji",
  searchPlaceholder: "Search emoji",
  categories: "Emoji categories",
  category: (categoryLabel: string) => `${categoryLabel} emoji`,
  grid: ({ categoryLabel, query }: ReactionPickerLabelContext) => query.length > 0
    ? `Emoji search results for ${query}`
    : `${categoryLabel} emoji`,
  empty: (query: string) => `No emoji found for “${query}”.`,
  close: "Close emoji picker",
});

type MarkdownFormattingCommand = ComposerRichTextCommand;

type ComposerSelection = Readonly<{ start: number; end: number }>;

interface ActiveMentionToken extends ComposerSelection {
  readonly query: string;
}

const INLINE_MENTION_QUERY = /^[\p{L}\p{M}\p{N}_\-.'’]*$/u;
const INLINE_MENTION_WORD_CHARACTER = /[\p{L}\p{M}\p{N}_]/u;

const activeMentionTokenAtCaret = (
  text: string,
  caret: number,
): ActiveMentionToken | undefined => {
  const end = Math.max(0, Math.min(caret, text.length));
  const prefix = text.slice(0, end);
  const start = prefix.lastIndexOf("@");
  if (start < 0) return undefined;
  const query = prefix.slice(start + 1);
  if (!INLINE_MENTION_QUERY.test(query)) return undefined;
  const previous = text.slice(0, start);
  const precedingCharacter = Array.from(previous).at(-1);
  if (precedingCharacter !== undefined && INLINE_MENTION_WORD_CHARACTER.test(precedingCharacter)) {
    return undefined;
  }
  let precedingBackslashes = 0;
  for (let index = previous.length - 1; index >= 0 && previous[index] === "\\"; index -= 1) {
    precedingBackslashes += 1;
  }
  if (precedingBackslashes % 2 === 1) return undefined;
  return Object.freeze({ start, end, query });
};

interface TrackedUserMention {
  readonly mention: Readonly<{ readonly type: "user"; readonly userId: UserId }>;
  readonly label: string;
  readonly token: string;
  readonly start: number;
  readonly end: number;
}

interface InternalMentionParticipant {
  readonly key: string;
  readonly userId: UserId;
  readonly label: string;
  readonly state: ChatComposerMentionParticipant["state"];
  readonly selectable: boolean;
}

const reconcileTrackedMentions = (
  previousText: string,
  nextText: string,
  mentions: readonly TrackedUserMention[],
): readonly TrackedUserMention[] => {
  if (previousText === nextText || mentions.length === 0) return mentions;
  let prefix = 0;
  while (
    prefix < previousText.length &&
    prefix < nextText.length &&
    previousText[prefix] === nextText[prefix]
  ) prefix += 1;
  let suffix = 0;
  while (
    suffix < previousText.length - prefix &&
    suffix < nextText.length - prefix &&
    previousText[previousText.length - 1 - suffix] ===
      nextText[nextText.length - 1 - suffix]
  ) suffix += 1;
  const previousChangeEnd = previousText.length - suffix;
  const nextChangeEnd = nextText.length - suffix;
  const delta = nextChangeEnd - previousChangeEnd;
  return Object.freeze(mentions.flatMap((tracked) => {
    let start = tracked.start;
    let end = tracked.end;
    if (tracked.end <= prefix) {
      // The edit is after this token.
    } else if (tracked.start >= previousChangeEnd) {
      start += delta;
      end += delta;
    } else {
      return [];
    }
    if (nextText.slice(start, end) !== tracked.token) return [];
    return [Object.freeze({ ...tracked, start, end })];
  }));
};

const restoreTrackedMentions = (
  text: string,
  mentions: readonly MessageMention[] | undefined,
  participants: readonly InternalMentionParticipant[],
): readonly TrackedUserMention[] => {
  if (mentions === undefined || mentions.length === 0) return Object.freeze([]);
  const participantsByUserId = new Map(participants.map((participant) => [
    participant.userId,
    participant,
  ]));
  let searchStart = 0;
  return Object.freeze(mentions.flatMap((mention) => {
    if (mention.type !== "user") return [];
    const participant = participantsByUserId.get(mention.userId);
    if (participant === undefined || !participant.selectable) return [];
    const token = `@${participant.label}`;
    let start = text.indexOf(token, searchStart);
    if (start < 0) start = text.indexOf(token);
    if (start < 0) return [];
    const end = start + token.length;
    searchStart = end;
    return [Object.freeze({
      mention: Object.freeze({ type: "user" as const, userId: mention.userId }),
      label: participant.label,
      token,
      start,
      end,
    })];
  }));
};

const mentionIdentity = (mention: MessageMention): string => {
  if (mention.type === "user") return `user:${mention.userId}`;
  if (mention.type === "conversation") return `conversation:${mention.conversationId}`;
  return `entity:${mention.entity.type}:${mention.entity.id}`;
};

const MARKDOWN_FORMATTING_CONTROLS = Object.freeze([
  Object.freeze({ command: "bold", label: "Bold", title: "Bold" }),
  Object.freeze({ command: "italic", label: "Italic", title: "Italic" }),
  Object.freeze({ command: "strikethrough", label: "Strikethrough", title: "Strikethrough" }),
  Object.freeze({ command: "link", label: "Insert link", title: "Insert link" }),
  Object.freeze({ command: "ordered-list", label: "Ordered list", title: "Ordered list" }),
  Object.freeze({ command: "bulleted-list", label: "Bulleted list", title: "Bulleted list" }),
  Object.freeze({ command: "inline-code", label: "Inline code", title: "Inline code" }),
  Object.freeze({ command: "code-block", label: "Code block", title: "Code block" }),
] satisfies readonly Readonly<{
  command: MarkdownFormattingCommand;
  label: string;
  title: string;
}>[]);

const markdownFormattingIcon = (command: MarkdownFormattingCommand): ReactElement => {
  const common = {
    className: "handrail-chat__composer-format-icon",
    viewBox: "0 0 20 20",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    focusable: "false",
  };
  switch (command) {
    case "bold":
      return createElement("svg", common,
        createElement("path", { d: "M6 3.5h4.5a3 3 0 0 1 0 6H6zm0 6h5a3.5 3.5 0 0 1 0 7H6z" }));
    case "italic":
      return createElement("svg", common,
        createElement("path", { d: "M9 3.5h6M5 16.5h6M12 3.5 8 16.5" }));
    case "strikethrough":
      return createElement("svg", common,
        createElement("path", { d: "M14.5 5.3c-.8-1.2-2.2-1.8-4.1-1.8-2.2 0-3.9 1.1-3.9 2.8 0 1.4 1 2.2 3.7 2.7M5 10h10M9.8 11c2.8.5 3.8 1.3 3.8 2.8 0 1.7-1.6 2.9-4 2.9-2 0-3.6-.8-4.5-2.1" }));
    case "link":
      return createElement("svg", common,
        createElement("path", { d: "m8.2 12.1 3.6-4.2M7.2 14.8l-1 .9a3 3 0 0 1-4.2-4.3l2.5-2.5a3 3 0 0 1 4.2 0M12.8 5.2l1-.9a3 3 0 0 1 4.2 4.3l-2.5 2.5a3 3 0 0 1-4.2 0" }));
    case "ordered-list":
      return createElement("svg", common,
        createElement("path", { d: "M8 5h9M8 10h9M8 15h9M3 4h1v3M3 10h1.5L3 12h1.5M3 14.5h1.5L3.2 16l1.3 1" }));
    case "bulleted-list":
      return createElement("svg", common,
        createElement("path", { d: "M8 5h9M8 10h9M8 15h9" }),
        createElement("path", { d: "M3.5 5h.01M3.5 10h.01M3.5 15h.01", strokeWidth: 3 }));
    case "inline-code":
      return createElement("svg", common,
        createElement("path", { d: "m7.5 5-5 5 5 5M12.5 5l5 5-5 5" }));
    case "code-block":
      return createElement("svg", common,
        createElement("rect", { x: 2.5, y: 3.5, width: 15, height: 13, rx: 2 }),
        createElement("path", { d: "m8 7-3 3 3 3M12 7l3 3-3 3" }));
  }
};

type ComposerActionIcon = "attachment" | "emoji" | "mention";

const composerActionIcon = (icon: ComposerActionIcon): ReactElement => {
  const common = {
    className: "handrail-chat__composer-action-icon",
    "data-composer-action-icon": icon,
    viewBox: "0 0 20 20",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    focusable: "false",
  };
  switch (icon) {
    case "attachment":
      return createElement("svg", common,
        createElement("path", { d: "m6.4 10.8 5.2-5.2a2.8 2.8 0 0 1 4 4l-6.7 6.7a4.2 4.2 0 0 1-6-6l6.4-6.4a1.8 1.8 0 0 1 2.6 2.6l-6.2 6.2" }));
    case "emoji":
      return createElement("svg", common,
        createElement("circle", { cx: 10, cy: 10, r: 7 }),
        createElement("path", { d: "M7.2 8h.01M12.8 8h.01M6.8 11.7a4 4 0 0 0 6.4 0" }));
    case "mention":
      return createElement("svg", common,
        createElement("circle", { cx: 9.5, cy: 10, r: 3 }),
        createElement("path", { d: "M12.5 7v5a2 2 0 0 0 4 0v-2a7 7 0 1 0-2 4.9" }));
  }
};

const safeFileName = (value: string): string => {
  const sanitized = value.replace(UNSAFE_FILE_NAME, "_").trim().slice(0, 255);
  return sanitized.length === 0 ? "Attachment" : sanitized;
};

const safeDiagnostic = (value: string, fallback: string): string => {
  const sanitized = value.replace(UNSAFE_DIAGNOSTIC, " ").trim().slice(0, 240);
  return sanitized.length === 0 ? fallback : sanitized;
};

const sendFailureMessage = (result: { readonly status: string; readonly httpStatus?: number }): string => {
  if (result.status === "rejected" && result.httpStatus === 403) {
    return "You do not have permission to send messages in this conversation. If you are not a member, ask a channel owner or moderator to add you. Your message was not removed.";
  }
  switch (result.status) {
    case "authentication":
      return "Chat authentication failed. Your message was not removed.";
    case "feature_disabled":
    case "unsupported":
      return "Sending is unavailable for this conversation. Your message was not removed.";
    case "validation":
      return "The message could not be sent. Check its content and attachments.";
    case "conflict":
    case "rejected":
      return "The message was not accepted. Your message was not removed.";
    case "closed":
      return "Chat is no longer available. Your message was not removed.";
    default:
      return "The message could not be sent. Your message was not removed.";
  }
};

interface LocalAttachment {
  readonly id: string;
  readonly uploadId?: string;
  readonly attachmentId?: ComposerAttachmentId;
  readonly fileName: string;
  readonly contentType?: string;
  readonly sizeBytes?: number;
  readonly status: ChatComposerAttachmentState["status"];
  readonly progress?: ChatComposerAttachmentState["progress"];
}

type ComposerReply = NonNullable<ChatComposerState["replyTo"]>;

interface EditorState {
  readonly replyTo?: ComposerReply;
  readonly text: string;
  readonly format: ChatComposerFormat;
  readonly mentions: readonly TrackedUserMention[];
}

interface FailedPayload {
  readonly replyTo?: ComposerReply;
  readonly text: string;
  readonly format: ChatComposerFormat;
  readonly mentions: readonly MessageMention[];
  readonly attachmentIds: readonly ComposerAttachmentId[];
}

export interface MessageComposerAvailability {
  /** Defaults to active when the host has no more restrictive normalized state. */
  readonly membershipState?: "active" | "left" | "removed";
  /** Defaults to true. Set false when normalized permissions are read-only. */
  readonly canSend?: boolean;
}

export interface MessageComposerProps {
  /** Public commands for host Reply actions; the destination remains conversationId. */
  readonly controlsRef?: Ref<ChatComposerControls>;
  readonly conversationId: ComposerConversationId;
  /** Optional already-normalized projection; otherwise the public hook resolves it. */
  readonly conversation?: ChatConversationViewModel;
  readonly availability?: MessageComposerAvailability;
  readonly disabled?: boolean;
  readonly readOnly?: boolean;
  readonly initialFormat?: ChatComposerFormat;
  readonly placeholder?: string;
  readonly inputLabel?: string;
  /**
   * Optional host coordination for the default empty-composer ArrowUp shortcut.
   * Return true only when an editor was opened so the key remains untouched
   * when no eligible message exists.
   */
  readonly onEditLatestMessage?: (
    returnFocusTarget: HTMLTextAreaElement,
  ) => boolean;
  readonly components?: Pick<ChatWorkspaceSlotOverrides, "Composer">;
  readonly hostProps?: ChatSlotHostProps<HTMLFormElement>;
}

const MessageComposerEditLatestContext = createContext<
  MessageComposerProps["onEditLatestMessage"]
>(undefined);

const ComposerFocusContext = createContext<{ current: (() => void) | undefined } | undefined>(undefined);

interface UploadObserverProps {
  readonly uploadId: string;
  readonly onChange: (
    uploadId: string,
    state: Pick<
      LocalAttachment,
      "status" | "progress" | "attachmentId"
    >,
  ) => void;
}

function AttachmentUploadObserver({
  uploadId,
  onChange,
}: UploadObserverProps): null {
  const result = useAttachmentUpload(uploadId);
  const status = result.data?.status;
  const progress = result.data?.progress;
  const attachmentId = status === "finalized"
    ? result.data?.attachment?.attachmentId
    : undefined;

  useEffect(() => {
    if (status === undefined) return;
    onChange(uploadId, {
      status,
      ...(progress === undefined ? {} : { progress }),
      ...(attachmentId === undefined ? {} : { attachmentId }),
    });
  }, [attachmentId, onChange, progress, status, uploadId]);
  return null;
}

const toAttachmentView = (
  attachment: LocalAttachment,
  cancellable: boolean,
): ChatComposerAttachmentState => Object.freeze({
  id: attachment.id,
  fileName: attachment.fileName,
  status: attachment.status,
  cancellable,
  ...(attachment.contentType === undefined
    ? {}
    : { contentType: attachment.contentType }),
  ...(attachment.sizeBytes === undefined
    ? {}
    : { sizeBytes: attachment.sizeBytes }),
  ...(attachment.progress === undefined
    ? {}
    : { progress: attachment.progress }),
  ...(attachment.attachmentId === undefined
    ? {}
    : { attachmentId: attachment.attachmentId }),
});

const samePayload = (
  message: { readonly content: unknown; readonly replyTo?: ComposerReply },
  payload: FailedPayload,
): boolean => {
  if (typeof message.content !== "object" || message.content === null) return false;
  const content = message.content as {
    readonly text?: unknown;
    readonly format?: unknown;
    readonly mentions?: readonly MessageMention[];
    readonly attachments?: readonly { readonly attachmentId?: unknown }[];
  };
  const ids = (content.attachments ?? []).map(({ attachmentId }) => attachmentId);
  const mentions = content.mentions ?? [];
  return message.replyTo?.messageId === payload.replyTo?.messageId &&
    message.replyTo?.notifyAuthor === payload.replyTo?.notifyAuthor &&
    content.text === payload.text &&
    content.format === payload.format &&
    mentions.length === payload.mentions.length &&
    mentions.every((mention, index) =>
      mentionIdentity(mention) === mentionIdentity(payload.mentions[index]!)) &&
    ids.length === payload.attachmentIds.length &&
    ids.every((id, index) => id === payload.attachmentIds[index]);
};

interface ConnectedMessageComposerProps extends MessageComposerProps {
  readonly providerReady: boolean;
}

function ConnectedMessageComposer(
  props: ConnectedMessageComposerProps,
): ReactElement {
  const conversationQuery = useConversation(props.conversationId, {
    enabled: props.conversation === undefined,
  });
  const draftQuery = useDraft(props.conversationId, {
    enabled: props.providerReady,
  });
  const messagesQuery = useMessages(props.conversationId, {
    enabled: props.providerReady,
  });
  const participantsQuery = useConversationParticipants(props.conversationId, {
    enabled: props.providerReady,
  });
  const actions = useChatActions(props.conversationId);
  const context = useChat();
  const sourceRuntime = context?.client.messageContext;
  const focusEditorRef = useRef<(() => void) | undefined>(undefined);
  const mountedRef = useRef(true);
  const draftEditRef = useRef(0);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const initialFormat = props.initialFormat ?? "plain";
  const [editor, setEditor] = useState<EditorState>({
    text: "",
    format: initialFormat,
    mentions: Object.freeze([]),
  });
  const sourceTarget = useMemo(() => editor.replyTo === undefined ? undefined :
    Object.freeze({ conversationId: props.conversationId, messageId: editor.replyTo.messageId }),
  [props.conversationId, editor.replyTo?.messageId]);
  const subscribeSource = useCallback((listener: () => void) =>
    sourceTarget === undefined || sourceRuntime === undefined ? () => {} : sourceRuntime.subscribe(sourceTarget, listener),
  [sourceRuntime, sourceTarget]);
  const sourceSnapshot = useCallback(() => sourceTarget === undefined ? undefined : sourceRuntime?.getState(sourceTarget),
    [sourceRuntime, sourceTarget]);
  const sourceState = useSyncExternalStore(subscribeSource, sourceSnapshot, sourceSnapshot);
  useEffect(() => {
    if (sourceTarget !== undefined && sourceState?.status === "idle") void sourceRuntime?.resolve(sourceTarget);
  }, [sourceRuntime, sourceState?.status, sourceTarget]);
  const source = sourceState?.status === "available" && sourceState.result?.status === "available"
    ? sourceState.result.message : undefined;
  const sourceUsers = useDirectoryUsers(source === undefined ? [] : [source.author.userId]);
  const sourceUser = sourceUsers.data?.[0];
  const replyContext = useMemo<ChatComposerState["replyContext"]>(() => {
    if (sourceTarget === undefined) return undefined;
    if (source !== undefined) return Object.freeze({ status: "available",
      authorLabel: sourceUser?.kind === "active" ? sourceUser.displayName.slice(0, 80) : "Participant",
      preview: (source.content.text || "Attachment or rich message").slice(0, 240) });
    const status = sourceState?.error === "access_revoked" || sourceState === undefined ? "unavailable" :
      sourceState.status === "idle" || sourceState.status === "loading_window" ? "loading" : sourceState.status;
    return Object.freeze({ status: status === "available" ? "unavailable" : status });
  }, [sourceTarget, source, sourceUser, sourceState]);
  const retryReplySource = useCallback(async (): Promise<void> => {
    if (sourceTarget === undefined || sourceRuntime === undefined) return;
    const current = sourceRuntime.getState(sourceTarget);
    if (current.status === "error" && current.error !== "access_revoked") await sourceRuntime.retry(sourceTarget);
  }, [sourceRuntime, sourceTarget]);
  const [attachments, setAttachments] = useState<readonly LocalAttachment[]>([]);
  const [isSending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string>();
  const [localDraftError, setLocalDraftError] = useState<string>();
  const [failedClientMessageId, setFailedClientMessageId] = useState<string>();
  const [lastAnnouncement, setLastAnnouncement] = useState<string>();
  const restoredRef = useRef(false);
  const restoredMentionsRef = useRef(false);
  const typingActiveRef = useRef(false);
  const sendingRef = useRef(false);
  const editorRef = useRef(editor);
  const attachmentsRef = useRef(attachments);
  const failedPayloadRef = useRef<FailedPayload | undefined>(undefined);
  const cancelUploadRef = useRef(new Map<string, () => void>());

  editorRef.current = editor;
  attachmentsRef.current = attachments;

  const rawConversation = props.conversation ?? conversationQuery.data;
  const conversation = useMemo<ChatConversationViewModel | undefined>(() => {
    if (rawConversation === undefined) return undefined;
    if (!("tenantId" in rawConversation)) return rawConversation;
    const { tenantId: _tenantId, ...rendererSafe } = rawConversation;
    return Object.freeze(rendererSafe) as ChatConversationViewModel;
  }, [rawConversation]);
  const mentionParticipants = useMemo<readonly InternalMentionParticipant[]>(() =>
    Object.freeze((participantsQuery.data?.participants ?? []).map((participant, index) => {
      const user = participant.user;
      const state: InternalMentionParticipant["state"] = user?.kind === "active"
        ? "active"
        : user?.kind === "redacted"
          ? "redacted"
          : user?.kind === "unavailable"
            ? "unavailable"
            : "unresolved";
      const label = user?.kind === "active"
        ? user.displayName
        : user?.kind === "redacted"
          ? "Hidden user"
          : user?.kind === "unavailable"
            ? "Unavailable user"
            : "Participant unavailable";
      return Object.freeze({
        key: `participant-${index}`,
        userId: participant.userId,
        label,
        state,
        selectable: state === "active" && label.trim().length > 0,
      });
    })), [participantsQuery.data?.participants]);

  const archived = conversation?.archivedAt !== undefined;
  let disabledReason: ChatComposerDisabledReason | undefined;
  if (!props.providerReady) disabledReason = "provider_unavailable";
  else if (conversation === undefined) disabledReason = "conversation_unavailable";
  else if (draftQuery.status === "loading") disabledReason = "draft_loading";
  else if (archived) disabledReason = "archived";
  else if (
    props.availability?.membershipState !== undefined &&
    props.availability.membershipState !== "active"
  ) disabledReason = "inactive_membership";
  else if (props.availability?.canSend === false) {
    disabledReason = "insufficient_permission";
  } else if (props.disabled === true) disabledReason = "host_disabled";
  else if (props.readOnly === true) disabledReason = "read_only";
  else if (isSending) disabledReason = "sending";
  const disabled = disabledReason !== undefined;

  const stopTyping = useCallback((): void => {
    if (!typingActiveRef.current) return;
    typingActiveRef.current = false;
    actions.stopTyping();
  }, [actions]);

  useEffect(() => {
    if (disabled) stopTyping();
  }, [disabled, stopTyping]);

  useEffect(() => () => {
    stopTyping();
    for (const cancel of cancelUploadRef.current.values()) cancel();
    cancelUploadRef.current.clear();
  }, [stopTyping]);

  useEffect(() => {
    if (restoredRef.current || draftQuery.status === "loading") return;
    restoredRef.current = true;
    const content = draftQuery.data?.draft?.kind === "replaced"
      ? draftQuery.data.draft.content
      : undefined;
    if (content === undefined) return;
    const restoredEditor = {
      ...(content.replyTo === undefined ? {} : { replyTo: Object.freeze({ ...content.replyTo }) }),
      text: content.text,
      format: content.format,
      mentions: restoreTrackedMentions(content.text, content.mentions, mentionParticipants),
    };
    const restoredAttachments = content.attachments.map(({ attachmentId }) => ({
      id: `attachment:${attachmentId}`,
      attachmentId,
      fileName: "Attachment",
      status: "restored" as const,
    }));
    editorRef.current = restoredEditor;
    attachmentsRef.current = restoredAttachments;
    setEditor(restoredEditor);
    setAttachments(Object.freeze(restoredAttachments));
  }, [draftQuery.data?.draft, draftQuery.status, mentionParticipants]);

  useEffect(() => {
    if (
      !restoredRef.current ||
      restoredMentionsRef.current ||
      participantsQuery.status === "loading"
    ) return;
    restoredMentionsRef.current = true;
    const content = draftQuery.data?.draft?.kind === "replaced"
      ? draftQuery.data.draft.content
      : undefined;
    if (content === undefined || editorRef.current.text !== content.text) return;
    const mentions = restoreTrackedMentions(content.text, content.mentions, mentionParticipants);
    if (mentions.length === 0) return;
    const next = { ...editorRef.current, mentions };
    editorRef.current = next;
    setEditor(next);
  }, [draftQuery.data?.draft, mentionParticipants, participantsQuery.status]);

  const finalizedIds = useCallback(
    (values: readonly LocalAttachment[]): readonly ComposerAttachmentId[] =>
      Object.freeze(values.flatMap((attachment) =>
        attachment.attachmentId === undefined ? [] : [attachment.attachmentId])),
    [],
  );

  const synchronizeDraft = useCallback((
    nextEditor: EditorState,
    nextAttachments: readonly LocalAttachment[],
  ): void => {
    if (!mountedRef.current) return;
    draftEditRef.current += 1;
    try {
      const ids = finalizedIds(nextAttachments);
      const mentions = nextEditor.mentions.map(({ mention }) => mention);
      if (nextEditor.text.length === 0 && ids.length === 0 && mentions.length === 0 && nextEditor.replyTo === undefined) {
        actions.clearConversationDraft();
      } else {
        actions.replaceConversationDraft({
          content: {
            ...(nextEditor.replyTo === undefined ? {} : { replyTo: nextEditor.replyTo }),
            format: nextEditor.format,
            text: nextEditor.text,
            ...(mentions.length === 0 ? {} : { mentions }),
            attachments: ids.map((attachmentId) => ({ attachmentId })),
          },
        });
      }
      setLocalDraftError(undefined);
    } catch {
      setLocalDraftError("The draft could not be updated.");
    }
  }, [actions, finalizedIds]);

  const changeReply = useCallback((replyTo: ComposerReply | undefined): void => {
    if (!mountedRef.current || !restoredRef.current || (disabled && disabledReason !== "sending")) return;
    const { replyTo: _previous, ...content } = editorRef.current;
    const next = { ...content, ...(replyTo === undefined ? {} : { replyTo }) };
    editorRef.current = next;
    setEditor(next);
    synchronizeDraft(next, attachmentsRef.current);
  }, [disabled, disabledReason, synchronizeDraft]);
  const selectReply = useCallback<ChatComposerControls["selectReply"]>((target) => {
    if (target.conversationId !== props.conversationId || target.messageId.trim().length === 0 ||
      target.messageId !== target.messageId.trim()) {
      throw new TypeError("Reply source must belong to the current conversation.");
    }
    changeReply(Object.freeze({ messageId: target.messageId, notifyAuthor: true }));
  }, [changeReply, props.conversationId]);
  const setReplyNotifyAuthor = useCallback((notifyAuthor: boolean): void => {
    const current = editorRef.current.replyTo;
    if (current !== undefined) changeReply(Object.freeze({ ...current, notifyAuthor }));
  }, [changeReply]);
  const clearReply = useCallback((): void => {
    changeReply(undefined);
    focusEditorRef.current?.();
  }, [changeReply]);

  const setText = useCallback((text: string): void => {
    setLastAnnouncement(undefined);
    const current = editorRef.current;
    const next = {
      ...current,
      text,
      mentions: reconcileTrackedMentions(current.text, text, current.mentions),
    };
    editorRef.current = next;
    setEditor(next);
    synchronizeDraft(next, attachmentsRef.current);
    if (disabled || text.trim().length === 0) {
      stopTyping();
      return;
    }
    if (actions.startTyping()) typingActiveRef.current = true;
  }, [actions, disabled, stopTyping, synchronizeDraft]);

  const insertMention = useCallback((
    participantKey: string,
    selection: ComposerSelection,
  ): number | undefined => {
    if (disabled) return undefined;
    const participant = mentionParticipants.find(({ key }) => key === participantKey);
    if (participant === undefined || !participant.selectable) return undefined;
    const current = editorRef.current;
    if (current.mentions.some(({ mention }) => mention.userId === participant.userId)) {
      return undefined;
    }
    const start = Math.max(0, Math.min(selection.start, current.text.length));
    const end = Math.max(start, Math.min(selection.end, current.text.length));
    const token = `@${participant.label}`;
    const leadingSpace = start > 0 && !/\s$/u.test(current.text.slice(0, start)) ? " " : "";
    const needsTrailingSpace = end >= current.text.length || !/^\s/u.test(current.text.slice(end));
    const insertion = `${leadingSpace}${token}${needsTrailingSpace ? " " : ""}`;
    const text = `${current.text.slice(0, start)}${insertion}${current.text.slice(end)}`;
    const retained = reconcileTrackedMentions(current.text, text, current.mentions);
    const tracked = Object.freeze({
      mention: Object.freeze({ type: "user" as const, userId: participant.userId }),
      label: participant.label,
      token,
      start: start + leadingSpace.length,
      end: start + leadingSpace.length + token.length,
    });
    const next = { ...current, text, mentions: Object.freeze([...retained, tracked]) };
    editorRef.current = next;
    setEditor(next);
    synchronizeDraft(next, attachmentsRef.current);
    setLastAnnouncement(`${participant.label} mentioned.`);
    if (!disabled && text.trim().length > 0 && actions.startTyping()) {
      typingActiveRef.current = true;
    }
    return start + insertion.length;
  }, [actions, disabled, mentionParticipants, synchronizeDraft]);

  const setFormat = useCallback((format: ChatComposerFormat): void => {
    if (format !== "plain" && format !== "markdown") return;
    setLastAnnouncement(undefined);
    const next = { ...editorRef.current, format };
    editorRef.current = next;
    setEditor(next);
    synchronizeDraft(next, attachmentsRef.current);
  }, [synchronizeDraft]);

  const updateUploadState = useCallback((
    uploadId: string,
    next: Pick<LocalAttachment, "status" | "progress" | "attachmentId">,
  ): void => {
    setAttachments((current) => {
      const updated = current.map((attachment) => {
        if (attachment.uploadId !== uploadId) return attachment;
        const {
          attachmentId: _attachmentId,
          progress: _progress,
          ...safeCurrent
        } = attachment;
        return {
              ...safeCurrent,
              status: next.status,
              ...(next.progress === undefined ? {} : { progress: next.progress }),
              ...(next.attachmentId === undefined
                ? {}
                : { attachmentId: next.attachmentId }),
            };
      });
      attachmentsRef.current = Object.freeze(updated);
      return attachmentsRef.current;
    });
  }, []);

  const settleFinalizedAttachment = useCallback((
    uploadId: string,
    attachmentId: ComposerAttachmentId,
  ): void => {
    cancelUploadRef.current.delete(uploadId);
    let updated: readonly LocalAttachment[] = attachmentsRef.current;
    updated = Object.freeze(updated.map((attachment) =>
      attachment.uploadId === uploadId
        ? { ...attachment, status: "finalized" as const, attachmentId }
        : attachment));
    attachmentsRef.current = updated;
    setAttachments(updated);
    synchronizeDraft(editorRef.current, updated);
    setLastAnnouncement("Attachment ready.");
  }, [synchronizeDraft]);

  const addAttachments = useCallback((files: readonly File[]): void => {
    if (disabled) return;
    setLastAnnouncement(undefined);
    for (const file of files) {
      const contentType = file.type as ComposerUploadContentType;
      if (!SUPPORTED_CONTENT_TYPES.has(contentType)) {
        setLocalDraftError("This attachment type is not supported.");
        continue;
      }
      let handle: ReturnType<typeof actions.uploadAttachment>;
      try {
        handle = actions.uploadAttachment({
          metadata: {
            fileName: safeFileName(file.name),
            contentType,
            sizeBytes: file.size,
          },
          source: file,
        });
      } catch {
        setLocalDraftError("The attachment could not be prepared.");
        continue;
      }
      const record: LocalAttachment = Object.freeze({
        id: `upload:${handle.uploadId}`,
        uploadId: handle.uploadId,
        fileName: safeFileName(file.name),
        contentType,
        sizeBytes: file.size,
        status: handle.state.status,
        ...(handle.state.progress === undefined
          ? {}
          : { progress: handle.state.progress }),
      });
      const updated = Object.freeze([...attachmentsRef.current, record]);
      attachmentsRef.current = updated;
      setAttachments(updated);
      cancelUploadRef.current.set(handle.uploadId, () => handle.cancel());
      void handle.completion.then((result) => {
        if (result.status === "finalized") {
          settleFinalizedAttachment(handle.uploadId, result.attachment.attachmentId);
          return;
        }
        cancelUploadRef.current.delete(handle.uploadId);
        updateUploadState(handle.uploadId, {
          status: result.status === "cancelled" ? "cancelled" :
            result.status === "rejected" ? "rejected" : "failed",
        });
        setLocalDraftError(
          result.status === "cancelled"
            ? "The attachment upload was cancelled."
            : "The attachment could not be uploaded.",
        );
      }).catch(() => {
        cancelUploadRef.current.delete(handle.uploadId);
        updateUploadState(handle.uploadId, { status: "failed" });
        setLocalDraftError("The attachment could not be uploaded.");
      });
    }
  }, [actions, disabled, settleFinalizedAttachment, updateUploadState]);

  const cancelAttachment = useCallback((uploadId: string): void => {
    cancelUploadRef.current.get(uploadId)?.();
  }, []);

  const removeAttachment = useCallback((id: string): void => {
    setLastAnnouncement(undefined);
    const removed = attachmentsRef.current.find((attachment) => attachment.id === id);
    if (removed?.uploadId !== undefined) {
      cancelUploadRef.current.get(removed.uploadId)?.();
      cancelUploadRef.current.delete(removed.uploadId);
    }
    const updated = Object.freeze(
      attachmentsRef.current.filter((attachment) => attachment.id !== id),
    );
    attachmentsRef.current = updated;
    setAttachments(updated);
    synchronizeDraft(editorRef.current, updated);
  }, [synchronizeDraft]);

  const clearAfterSuccess = useCallback((): void => {
    const nextEditor = {
      text: "",
      format: editorRef.current.format,
      mentions: Object.freeze([]),
    };
    editorRef.current = nextEditor;
    attachmentsRef.current = Object.freeze([]);
    setEditor(nextEditor);
    setAttachments(attachmentsRef.current);
    setSendError(undefined);
    setFailedClientMessageId(undefined);
    failedPayloadRef.current = undefined;
    stopTyping();
    setLastAnnouncement("Message sent.");
  }, [stopTyping]);

  const send = useCallback(async (): Promise<void> => {
    if (sendingRef.current || disabled) return;
    const currentEditor = editorRef.current;
    const submittedVersion = draftEditRef.current;
    const draftAtSubmission = context?.client.selectConversationDraft(props.conversationId).draft;
    const attachmentIds = finalizedIds(attachmentsRef.current);
    const mentions = Object.freeze(currentEditor.mentions.map(({ mention }) => mention));
    const hasUnsettledUpload = attachmentsRef.current.some((attachment) =>
      ACTIVE_UPLOAD_STATUSES.has(attachment.status));
    if (
      hasUnsettledUpload ||
      (currentEditor.text.trim().length === 0 && attachmentIds.length === 0)
    ) return;
    sendingRef.current = true;
    setSending(true);
    setSendError(undefined);
    setFailedClientMessageId(undefined);
    setLastAnnouncement(undefined);
    failedPayloadRef.current = Object.freeze({
      ...(currentEditor.replyTo === undefined ? {} : { replyTo: currentEditor.replyTo }),
      text: currentEditor.text,
      format: currentEditor.format,
      mentions,
      attachmentIds,
    });
    stopTyping();
    try {
      const result = await actions.sendMessage({
        ...(currentEditor.replyTo === undefined ? {} : { replyTo: currentEditor.replyTo }),
        content: {
          format: currentEditor.format,
          text: currentEditor.text,
          ...(mentions.length === 0 ? {} : { mentions }),
          ...(attachmentIds.length === 0
            ? {}
            : { attachments: attachmentIds.map((attachmentId) => ({ attachmentId })) }),
        },
      });
      if (!mountedRef.current) return;
      if (result.status === "success") {
        const currentDraft = context?.client.selectConversationDraft(props.conversationId).draft;
        const ownsDraft = currentDraft?.kind === "clear_tombstone" ||
          JSON.stringify(currentDraft) === JSON.stringify(draftAtSubmission);
        if (draftEditRef.current === submittedVersion && ownsDraft) clearAfterSuccess();
      } else setSendError(sendFailureMessage(result));
    } catch {
      setSendError("The message could not be sent. Your message was not removed.");
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }, [actions, clearAfterSuccess, context?.client, disabled, finalizedIds, props.conversationId, stopTyping]);

  useEffect(() => {
    if (sendError === undefined || failedClientMessageId !== undefined) return;
    const payload = failedPayloadRef.current;
    if (payload === undefined) return;
    const failed = [...(messagesQuery.data?.messages ?? [])].reverse().find((message) =>
      "delivery" in message &&
      message.delivery.state === "failed" &&
      samePayload(message, payload));
    if (failed !== undefined && "delivery" in failed && failed.delivery.retryable) {
      setFailedClientMessageId(failed.delivery.clientMessageId);
    }
  }, [failedClientMessageId, messagesQuery.data?.messages, sendError]);

  const retrySend = useCallback(async (): Promise<void> => {
    if (
      sendingRef.current ||
      failedClientMessageId === undefined ||
      disabledReason !== undefined
    ) return;
    const submittedVersion = draftEditRef.current;
    const current = editorRef.current;
    const payload = failedPayloadRef.current;
    const matchesDraft = payload !== undefined && samePayload({
      ...(current.replyTo === undefined ? {} : { replyTo: current.replyTo }),
      content: { ...current, mentions: current.mentions.map(({ mention }) => mention),
        attachments: finalizedIds(attachmentsRef.current).map((attachmentId) => ({ attachmentId })) },
    }, payload);
    const draftBeforeRetry = context?.client.selectConversationDraft(props.conversationId).draft;
    sendingRef.current = true;
    setSending(true);
    setSendError(undefined);
    setFailedClientMessageId(undefined);
    try {
      const result = await actions.retryMessage(failedClientMessageId);
      if (!mountedRef.current) return;
      if (result.status === "success") {
        if (!matchesDraft || submittedVersion !== draftEditRef.current ||
          context?.client.selectConversationDraft(props.conversationId).draft !== draftBeforeRetry) return;
        try {
          actions.clearConversationDraft();
        } catch {
          setLocalDraftError("The sent message draft could not be cleared.");
        }
        clearAfterSuccess();
      } else setSendError(sendFailureMessage(result));
    } catch {
      setSendError("The message could not be retried. Your message was not removed.");
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }, [actions, clearAfterSuccess, context?.client, disabledReason, failedClientMessageId, finalizedIds, props.conversationId]);

  const retryDraft = useCallback(async (): Promise<void> => {
    try {
      const result = await actions.retryConversationDraft();
      if (result.status === "success") setLocalDraftError(undefined);
      else setLocalDraftError("The draft could not be synchronized.");
    } catch {
      setLocalDraftError("The draft could not be synchronized.");
    }
  }, [actions]);

  const draftError = localDraftError ?? (
    draftQuery.status === "error"
      ? safeDiagnostic(
          draftQuery.error.message,
          "The draft could not be synchronized.",
        )
      : undefined
  );
  const attachmentViews = useMemo(
    () => Object.freeze(attachments.map((attachment) => toAttachmentView(
      attachment,
      attachment.uploadId !== undefined &&
        cancelUploadRef.current.has(attachment.uploadId) &&
        !["finalized", "rejected", "failed", "cancelled", "abandoned"].includes(
          attachment.status,
        ),
    ))),
    [attachments],
  );
  const hasUnsettledUpload = attachments.some((attachment) =>
    ACTIVE_UPLOAD_STATUSES.has(attachment.status));
  const hasContent = editor.text.trim().length > 0 ||
    attachments.some((attachment) => attachment.attachmentId !== undefined);
  const canSubmit = !disabled && !isSending && !hasUnsettledUpload && hasContent;
  const status = useMemo<ChatComposerState["status"]>(() => {
    if (isSending) return Object.freeze({ kind: "sending", message: "Sending message…" });
    if (hasUnsettledUpload) {
      return Object.freeze({ kind: "upload", message: "Uploading attachment…" });
    }
    if (lastAnnouncement !== undefined) {
      return Object.freeze({
        kind: lastAnnouncement === "Message sent." ? "sent" : "upload",
        message: lastAnnouncement,
      });
    }
    if (["debouncing", "saving"].includes(draftQuery.data?.status ?? "")) {
      return Object.freeze({ kind: "draft", message: "Saving draft…" });
    }
    return Object.freeze({ kind: "idle", message: "" });
  }, [draftQuery.data?.status, hasUnsettledUpload, isSending, lastAnnouncement]);
  const state = useMemo<ChatComposerState>(() => Object.freeze({
    ...(editor.replyTo === undefined ? {} : { replyTo: editor.replyTo }),
    ...(replyContext === undefined ? {} : { replyContext }),
    inputLabel: props.inputLabel ?? "Message",
    placeholder: props.placeholder ?? "Write a message",
    text: editor.text,
    format: editor.format,
    attachments: attachmentViews,
    mentionParticipants: Object.freeze(mentionParticipants.map((participant) =>
      Object.freeze({
        key: participant.key,
        label: participant.label,
        state: participant.state,
        selectable: participant.selectable && !editor.mentions.some(
          ({ mention }) => mention.userId === participant.userId,
        ),
      }))),
    mentions: Object.freeze(editor.mentions.map(({ label, token }) =>
      Object.freeze({ label, text: token }))),
    disabled,
    readOnly: props.readOnly === true,
    ...(disabledReason === undefined ? {} : { disabledReason }),
    isSending,
    canSubmit,
    ...(draftError === undefined ? {} : { draftError }),
    ...(sendError === undefined ? {} : { sendError }),
    ...(failedClientMessageId === undefined
      ? {}
      : { failedClientMessageId }),
    status,
  }), [
    attachmentViews,
    canSubmit,
    disabled,
    disabledReason,
    draftError,
    editor.format,
    editor.replyTo,
    replyContext,
    editor.mentions,
    editor.text,
    failedClientMessageId,
    isSending,
    mentionParticipants,
    props.inputLabel,
    props.placeholder,
    props.readOnly,
    sendError,
    status,
  ]);
  const controls = useMemo<ChatComposerControls>(() => Object.freeze({
    focus: () => focusEditorRef.current?.(),
    selectReply,
    setReplyNotifyAuthor,
    clearReply,
    retryReplySource,
    setText,
    setFormat,
    insertMention,
    send,
    retrySend,
    retryDraft,
    addAttachments,
    cancelAttachment,
    removeAttachment,
    blur: stopTyping,
  }), [
    selectReply,
    setReplyNotifyAuthor,
    clearReply,
    retryReplySource,
    addAttachments,
    cancelAttachment,
    removeAttachment,
    retryDraft,
    retrySend,
    send,
    setFormat,
    setText,
    insertMention,
    stopTyping,
  ]);
  useImperativeHandle(props.controlsRef, () => controls, [controls]);
  const draft: ChatComposerDraftViewModel = Object.freeze({
    status: draftQuery.data?.status ?? "idle",
    dirty: draftQuery.data?.dirty ?? false,
    ...(draftQuery.data?.conflict === undefined
      ? {}
      : { conflict: draftQuery.data.conflict }),
    ...(draftQuery.data?.message === undefined
      ? {}
      : { message: draftQuery.data.message }),
    ...(draftQuery.data?.draft?.kind !== "replaced"
      ? {}
      : { content: draftQuery.data.draft.content }),
  });
  const hostOnSubmit = props.hostProps?.onSubmit;
  const onSubmit = useCallback((event: SubmitEvent<HTMLFormElement>): void => {
    hostOnSubmit?.(event);
    if (event.defaultPrevented) return;
    event.preventDefault();
    void send();
  }, [hostOnSubmit, send]);
  const hostProps: ChatSlotHostProps<HTMLFormElement> = Object.freeze({
    ...props.hostProps,
    className: ["handrail-chat__composer", props.hostProps?.className]
      .filter(Boolean)
      .join(" "),
    onSubmit,
    "aria-busy": isSending,
    "aria-disabled": disabled,
  });

  const uploadObservers = attachments.flatMap((attachment) =>
    attachment.uploadId === undefined
      ? []
      : [createElement(AttachmentUploadObserver, {
          key: attachment.uploadId,
          uploadId: attachment.uploadId,
          onChange: updateUploadState,
        })]);

  if (conversation === undefined) {
    return createElement(Fragment, null,
      createElement(UnavailableMessageComposer, {
        ...(props.inputLabel === undefined ? {} : { inputLabel: props.inputLabel }),
        ...(props.placeholder === undefined ? {} : { placeholder: props.placeholder }),
        reason: "Conversation unavailable",
      }),
      ...uploadObservers,
    );
  }
  const Renderer = props.components?.Composer ?? DefaultMessageComposerRenderer;
  return createElement(Fragment, null,
    createElement(
      MessageComposerEditLatestContext.Provider,
      { value: props.onEditLatestMessage },
      createElement(ComposerFocusContext.Provider, { value: focusEditorRef }, createElement(Renderer, {
        conversation,
        draft,
        state,
        controls,
        actions,
        hostProps,
      })),
    ),
    ...uploadObservers,
  );
}

const disabledReasonLabel = (
  reason: ChatComposerDisabledReason | undefined,
): string | undefined => {
  switch (reason) {
    case "provider_unavailable": return "Chat unavailable";
    case "conversation_unavailable": return "Conversation unavailable";
    case "draft_loading": return "Loading draft";
    case "archived": return "This conversation is archived";
    case "inactive_membership": return "You are not an active conversation member";
    case "insufficient_permission": return "You do not have permission to send messages";
    case "host_disabled": return "Message composer disabled";
    case "read_only": return "This conversation is read-only";
    case "sending": return "Sending message";
    default: return undefined;
  }
};

export function DefaultMessageComposerRenderer({
  conversation,
  state,
  controls,
  hostProps,
}: ChatComposerSlotProps): ReactElement {
  const focusEditor = useContext(ComposerFocusContext);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const richEditorRef = useRef<HTMLDivElement>(null);
  const conversationIdRef = useRef(conversation.id);
  const selectionRef = useRef({ start: state.text.length, end: state.text.length });
  const richSelectionRef = useRef<ComposerVisualSelection>({
    start: state.text.length,
    end: state.text.length,
  });
  const pendingCaretRef = useRef<number | undefined>(undefined);
  const pendingFormattingSelectionRef = useRef<ComposerSelection | undefined>(undefined);
  const pointerFormattingSelectionRef = useRef<ComposerSelection | undefined>(undefined);
  const pendingRichSelectionRef = useRef<ComposerVisualSelection | undefined>(undefined);
  const pointerRichSelectionRef = useRef<ComposerVisualSelection | undefined>(undefined);
  const activeMentionSelectionRef = useRef<ComposerSelection | undefined>(undefined);
  const lastRichValueRef = useRef<Readonly<{
    text: string;
    format: ChatComposerFormat;
  }> | undefined>(undefined);
  const mentionFilterRef = useRef<HTMLInputElement>(null);
  const isComposingRef = useRef(false);
  const [richTextAvailable, setRichTextAvailable] = useState(false);
  const [emojiPickerConversationId, setEmojiPickerConversationId] =
    useState<ComposerConversationId>();
  const [mentionPickerConversationId, setMentionPickerConversationId] =
    useState<ComposerConversationId>();
  const [mentionPickerMode, setMentionPickerMode] = useState<"toolbar" | "inline">();
  const [mentionQuery, setMentionQuery] = useState("");
  const [activeMentionKey, setActiveMentionKey] = useState<string>();
  conversationIdRef.current = conversation.id;
  const requestEditLatestMessage = useContext(MessageComposerEditLatestContext);
  const id = useId().replaceAll(":", "");
  const statusId = `${id}-status`;
  const errorId = `${id}-error`;
  const inputId = `${id}-input`;
  const mentionListId = `${id}-mention-list`;
  const label = state.inputLabel;
  useEffect(() => {
    setRichTextAvailable(supportsVisualComposerEditing(document));
  }, []);
  const synchronizeTextareaHeight = useCallback((): void => {
    const textarea = textareaRef.current;
    if (textarea === null) return;

    textarea.style.height = "auto";
    textarea.style.overflowY = "hidden";
    const view = textarea.ownerDocument.defaultView;
    const computed = view?.getComputedStyle(textarea);
    const maximumHeight = Number.parseFloat(
      computed?.maxBlockSize || computed?.maxHeight || "",
    );
    const hasMaximum = Number.isFinite(maximumHeight) && maximumHeight > 0;
    const contentHeight = textarea.scrollHeight;
    const nextHeight = hasMaximum
      ? Math.min(contentHeight, maximumHeight)
      : contentHeight;

    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = hasMaximum && contentHeight > maximumHeight
      ? "auto"
      : "hidden";
  }, []);

  useEffect(() => {
    synchronizeTextareaHeight();
  }, [state.text, synchronizeTextareaHeight]);

  const synchronizeRichEditorHeight = useCallback((): void => {
    const editor = richEditorRef.current;
    if (editor === null) return;
    editor.style.height = "auto";
    editor.style.overflowY = "hidden";
    const computed = editor.ownerDocument.defaultView?.getComputedStyle(editor);
    const maximumHeight = Number.parseFloat(
      computed?.maxBlockSize || computed?.maxHeight || "",
    );
    const hasMaximum = Number.isFinite(maximumHeight) && maximumHeight > 0;
    const contentHeight = editor.scrollHeight;
    if (contentHeight > 0) {
      editor.style.height = `${hasMaximum ? Math.min(contentHeight, maximumHeight) : contentHeight}px`;
    }
    editor.style.overflowY = hasMaximum && contentHeight > maximumHeight ? "auto" : "hidden";
  }, []);

  useEffect(() => {
    if (!richTextAvailable) return;
    const editor = richEditorRef.current;
    if (editor === null) return;
    const lastValue = lastRichValueRef.current;
    const incomingMatches = lastValue?.text === state.text && lastValue.format === state.format;
    const richText = state.format === "markdown"
      ? composerMarkdownToRichTextDocument(state.text)
      : plainTextToComposerRichTextDocument(state.text);
    if (!incomingMatches) renderComposerRichTextDocument(editor, richText);
    lastRichValueRef.current = { text: state.text, format: state.format };
    synchronizeRichEditorHeight();

    const pendingSelection = pendingRichSelectionRef.current;
    const pendingCaret = pendingCaretRef.current;
    if (pendingSelection !== undefined || pendingCaret !== undefined) {
      pendingRichSelectionRef.current = undefined;
      if (pendingCaret !== undefined) pendingCaretRef.current = undefined;
      const selection = pendingSelection ?? {
        start: visualOffsetForComposerMarkdownOffset(richText, pendingCaret ?? state.text.length),
        end: visualOffsetForComposerMarkdownOffset(richText, pendingCaret ?? state.text.length),
      };
      richSelectionRef.current = selection;
      editor.focus();
      setComposerRichTextSelection(editor, selection);
    }
  }, [richTextAvailable, state.format, state.text, synchronizeRichEditorHeight]);

  useEffect(() => {
    if (richTextAvailable) return;
    const nextSelection = pendingFormattingSelectionRef.current;
    const textarea = textareaRef.current;
    if (textarea === null) return;
    if (nextSelection !== undefined) {
      pendingFormattingSelectionRef.current = undefined;
      textarea.focus();
      const start = Math.max(0, Math.min(nextSelection.start, textarea.value.length));
      const end = Math.max(start, Math.min(nextSelection.end, textarea.value.length));
      textarea.setSelectionRange(start, end);
      selectionRef.current = { start, end };
      return;
    }
    const pendingCaret = pendingCaretRef.current;
    if (pendingCaret === undefined) return;
    pendingCaretRef.current = undefined;
    textarea.focus();
    const caret = Math.max(0, Math.min(pendingCaret, textarea.value.length));
    textarea.setSelectionRange(caret, caret);
    selectionRef.current = { start: caret, end: caret };
  }, [richTextAvailable, state.text]);

  useEffect(() => {
    setEmojiPickerConversationId(undefined);
    setMentionPickerConversationId(undefined);
    setMentionPickerMode(undefined);
    setMentionQuery("");
    setActiveMentionKey(undefined);
    pendingCaretRef.current = undefined;
    pendingFormattingSelectionRef.current = undefined;
    pointerFormattingSelectionRef.current = undefined;
    pendingRichSelectionRef.current = undefined;
    pointerRichSelectionRef.current = undefined;
    activeMentionSelectionRef.current = undefined;
    lastRichValueRef.current = undefined;
    isComposingRef.current = false;
  }, [conversation.id]);

  useEffect(() => {
    if (!state.disabled && !state.readOnly) return;
    setEmojiPickerConversationId(undefined);
    setMentionPickerConversationId(undefined);
    setMentionPickerMode(undefined);
    setMentionQuery("");
    setActiveMentionKey(undefined);
    pendingCaretRef.current = undefined;
    pendingFormattingSelectionRef.current = undefined;
    pointerFormattingSelectionRef.current = undefined;
    pendingRichSelectionRef.current = undefined;
    pointerRichSelectionRef.current = undefined;
    activeMentionSelectionRef.current = undefined;
    isComposingRef.current = false;
  }, [state.disabled, state.readOnly]);

  const filteredMentionParticipants = useMemo(() => {
    const normalizedQuery = mentionQuery.trim().toLocaleLowerCase();
    return normalizedQuery.length === 0
      ? state.mentionParticipants
      : state.mentionParticipants.filter(({ label }) =>
          label.toLocaleLowerCase().includes(normalizedQuery));
  }, [mentionQuery, state.mentionParticipants]);

  useEffect(() => {
    if (mentionPickerConversationId !== conversation.id) return;
    const selectable = filteredMentionParticipants.filter(({ selectable }) => selectable);
    if (!selectable.some(({ key }) => key === activeMentionKey)) {
      setActiveMentionKey(selectable[0]?.key);
    }
  }, [activeMentionKey, conversation.id, filteredMentionParticipants, mentionPickerConversationId]);

  useEffect(() => {
    if (
      mentionPickerConversationId === conversation.id &&
      mentionPickerMode === "toolbar"
    ) mentionFilterRef.current?.focus();
  }, [conversation.id, mentionPickerConversationId, mentionPickerMode]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea === null) return;
    const view = textarea.ownerDocument.defaultView;
    const handleSizingChange = (): void => synchronizeTextareaHeight();
    const ResizeObserverConstructor = view?.ResizeObserver;
    const resizeObserver = typeof ResizeObserverConstructor === "function"
      ? new ResizeObserverConstructor(handleSizingChange)
      : undefined;
    resizeObserver?.observe(textarea.parentElement ?? textarea);

    const fonts = textarea.ownerDocument.fonts;
    let active = true;
    fonts?.addEventListener?.("loadingdone", handleSizingChange);
    void fonts?.ready.then(() => {
      if (active) handleSizingChange();
    });

    return () => {
      active = false;
      resizeObserver?.disconnect();
      fonts?.removeEventListener?.("loadingdone", handleSizingChange);
    };
  }, [synchronizeTextareaHeight]);

  useEffect(() => {
    if (!richTextAvailable) return;
    const editor = richEditorRef.current;
    if (editor === null) return;
    const view = editor.ownerDocument.defaultView;
    const handleSizingChange = (): void => synchronizeRichEditorHeight();
    const ResizeObserverConstructor = view?.ResizeObserver;
    const resizeObserver = typeof ResizeObserverConstructor === "function"
      ? new ResizeObserverConstructor(handleSizingChange)
      : undefined;
    resizeObserver?.observe(editor.parentElement ?? editor);
    return () => resizeObserver?.disconnect();
  }, [richTextAvailable, synchronizeRichEditorHeight]);

  const currentRichDocument = () => {
    const editor = richEditorRef.current;
    return editor === null
      ? state.format === "markdown"
        ? composerMarkdownToRichTextDocument(state.text)
        : plainTextToComposerRichTextDocument(state.text)
      : composerRichTextDocumentFromEditor(editor);
  };

  const rememberRichSelection = (): ComposerVisualSelection | undefined => {
    const editor = richEditorRef.current;
    if (!richTextAvailable || editor === null) return undefined;
    const visualSelection = readComposerRichTextSelection(editor);
    if (visualSelection === undefined) return undefined;
    richSelectionRef.current = visualSelection;
    const richText = composerRichTextDocumentFromEditor(editor);
    selectionRef.current = state.format === "markdown"
      ? canonicalComposerSelection(richText, visualSelection)
      : visualSelection;
    return visualSelection;
  };

  const moveActiveMention = (direction: 1 | -1): void => {
    const selectable = filteredMentionParticipants.filter(({ selectable }) => selectable);
    if (selectable.length === 0) return;
    const currentIndex = selectable.findIndex(({ key }) => key === activeMentionKey);
    const nextIndex = currentIndex < 0
      ? direction > 0 ? 0 : selectable.length - 1
      : (currentIndex + direction + selectable.length) % selectable.length;
    setActiveMentionKey(selectable[nextIndex]?.key);
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    const composing = event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
    const inlineMentionPickerOpen =
      mentionPickerConversationId === conversation.id && mentionPickerMode === "inline";
    if (inlineMentionPickerOpen && !composing) {
      if (event.key === "Escape") {
        event.preventDefault();
        dismissMentionPicker(false);
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        moveActiveMention(event.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        if (activeMentionKey !== undefined) selectMention(activeMentionKey);
        return;
      }
    }
    if (event.key === "ArrowUp") {
      if (
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        composing ||
        state.disabled ||
        state.readOnly ||
        state.text.length > 0 ||
        state.attachments.length > 0 ||
        state.replyTo !== undefined ||
        requestEditLatestMessage === undefined
      ) return;
      const editTarget = textareaRef.current;
      if (editTarget !== null && requestEditLatestMessage(editTarget)) event.preventDefault();
      return;
    }
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      composing
    ) return;
    event.preventDefault();
    void controls.send();
  };
  const handleFileChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const files = event.currentTarget.files;
    if (files !== null && files.length > 0) controls.addAttachments([...files]);
    event.currentTarget.value = "";
  };
  const handlePaste = (event: ClipboardEvent<HTMLElement>): void => {
    if (state.disabled || state.readOnly) return;
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (files.length > 0) controls.addAttachments(files);
  };
  const error = state.sendError ?? state.draftError;
  const reason = disabledReasonLabel(state.disabledReason);
  const statusMessage = state.status.kind === "draft" ? "" : state.status.message;
  const hasStatusFeedback = statusMessage.length > 0 || reason !== undefined;
  const hasFeedback = hasStatusFeedback || error !== undefined;
  const readTextareaSelection = (): ComposerSelection => {
    const textarea = textareaRef.current;
    const textLength = state.text.length;
    const start = Math.max(0, Math.min(textarea?.selectionStart ?? textLength, textLength));
    const end = Math.max(start, Math.min(textarea?.selectionEnd ?? start, textLength));
    return Object.freeze({ start, end });
  };
  const readComposerSelection = (): ComposerSelection => {
    const richSelection = rememberRichSelection();
    if (richSelection === undefined) return readTextareaSelection();
    const richText = currentRichDocument();
    return state.format === "markdown"
      ? canonicalComposerSelection(richText, richSelection)
      : richSelection;
  };
  const preserveFormattingSelection = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ): void => {
    if (state.disabled || state.readOnly) return;
    if (richTextAvailable) {
      pointerRichSelectionRef.current = rememberRichSelection() ?? richSelectionRef.current;
    } else pointerFormattingSelectionRef.current = readTextareaSelection();
    event.preventDefault();
  };
  const formatSelection = (command: MarkdownFormattingCommand): void => {
    if (state.disabled || state.readOnly || !richTextAvailable) return;
    const editor = richEditorRef.current;
    if (editor === null) return;
    const selection = pointerRichSelectionRef.current ??
      rememberRichSelection() ?? richSelectionRef.current;
    pointerRichSelectionRef.current = undefined;
    let href: string | undefined;
    if (command === "link") {
      const entered = editor.ownerDocument.defaultView?.prompt?.(
        "Link URL",
        "https://",
      );
      if (entered === null || entered === undefined) {
        editor.focus();
        setComposerRichTextSelection(editor, selection);
        return;
      }
      href = sanitizeComposerMarkdownLink(entered);
      if (href === undefined) {
        editor.focus();
        setComposerRichTextSelection(editor, selection);
        return;
      }
    }
    const formatted = applyComposerRichTextFormatting(
      composerRichTextDocumentFromEditor(editor),
      selection,
      command,
      href,
      selection.start === selection.end
        ? composerRichTextCommandIsActiveAtSelection(editor, command)
        : undefined,
    );
    if (formatted === undefined) return;
    const markdown = richTextDocumentToCanonicalMarkdown(formatted.document);
    if (formatted.caretMarks === undefined) {
      renderComposerRichTextDocument(editor, formatted.document);
    } else {
      renderComposerRichTextDocumentWithCaretBoundary(
        editor,
        formatted.document,
        formatted.selection.start,
        formatted.caretMarks,
      );
    }
    richSelectionRef.current = formatted.selection;
    selectionRef.current = canonicalComposerSelection(formatted.document, formatted.selection);
    lastRichValueRef.current = { text: markdown, format: "markdown" };
    // Deactivation does not change Markdown, so there will be no render where a
    // queued selection can be consumed. Leaving one pending would move the
    // caret back into the old mark after the next keyboard input.
    pendingRichSelectionRef.current = markdown !== state.text || state.format !== "markdown"
      ? formatted.selection
      : undefined;
    editor.focus();
    if (formatted.caretMarks === undefined) {
      setComposerRichTextSelection(editor, formatted.selection);
    }
    synchronizeRichEditorHeight();
    if (state.format !== "markdown") controls.setFormat("markdown");
    controls.setText(markdown);
  };
  const handleFormattingKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    command: MarkdownFormattingCommand,
  ): void => {
    if (event.repeat || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    formatSelection(command);
  };
  const emojiPickerOpen = emojiPickerConversationId === conversation.id;
  const openEmojiPicker = (): void => {
    if (state.disabled || state.readOnly) return;
    selectionRef.current = readComposerSelection();
    pendingCaretRef.current = undefined;
    setMentionPickerConversationId(undefined);
    setMentionPickerMode(undefined);
    setMentionQuery("");
    setActiveMentionKey(undefined);
    setEmojiPickerConversationId(conversation.id);
  };
  const handleEmojiKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
  ): void => {
    if (event.repeat || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    openEmojiPicker();
  };
  useEffect(() => {
    if (focusEditor === undefined) return;
    focusEditor.current = restoreTextareaFocus;
    return () => { focusEditor.current = undefined; };
  });
  const restoreTextareaFocus = (): void => {
    if (richTextAvailable) {
      const editor = richEditorRef.current;
      if (editor === null) return;
      const richText = currentRichDocument();
      const pendingCaret = pendingCaretRef.current;
      const nextSelection = pendingCaret === undefined
        ? richSelectionRef.current
        : {
            start: visualOffsetForComposerMarkdownOffset(richText, pendingCaret),
            end: visualOffsetForComposerMarkdownOffset(richText, pendingCaret),
          };
      editor.focus();
      setComposerRichTextSelection(editor, nextSelection);
      richSelectionRef.current = nextSelection;
      pendingCaretRef.current = undefined;
      return;
    }
    const textarea = textareaRef.current;
    if (textarea === null) return;
    textarea.focus();
    const pendingCaret = pendingCaretRef.current;
    const nextSelection = pendingCaret === undefined
      ? selectionRef.current
      : { start: pendingCaret, end: pendingCaret };
    const start = Math.max(0, Math.min(nextSelection.start, textarea.value.length));
    const end = Math.max(start, Math.min(nextSelection.end, textarea.value.length));
    textarea.setSelectionRange(start, end);
    pendingCaretRef.current = undefined;
  };
  const insertEmoji = (emoji: ReactionPickerReactionKey): void => {
    const pickerConversationId = emojiPickerConversationId;
    if (
      pickerConversationId === undefined ||
      pickerConversationId !== conversation.id ||
      pickerConversationId !== conversationIdRef.current ||
      state.disabled ||
      state.readOnly
    ) return;
    const textLength = state.text.length;
    const start = Math.max(0, Math.min(selectionRef.current.start, textLength));
    const end = Math.max(start, Math.min(selectionRef.current.end, textLength));
    pendingCaretRef.current = start + emoji.length;
    controls.setText(`${state.text.slice(0, start)}${emoji}${state.text.slice(end)}`);
  };
  const dismissEmojiPicker = (pickerConversationId: ComposerConversationId): void => {
    setEmojiPickerConversationId((current) =>
      current === pickerConversationId ? undefined : current);
  };
  const mentionPickerOpen = mentionPickerConversationId === conversation.id;
  const openMentionPicker = (): void => {
    if (state.disabled || state.readOnly) return;
    selectionRef.current = readComposerSelection();
    pendingCaretRef.current = undefined;
    setEmojiPickerConversationId(undefined);
    setMentionQuery("");
    setMentionPickerMode("toolbar");
    setActiveMentionKey(
      state.mentionParticipants.find(({ selectable }) => selectable)?.key,
    );
    setMentionPickerConversationId(conversation.id);
  };
  const dismissMentionPicker = (restoreFocus = true): void => {
    setMentionPickerConversationId(undefined);
    setMentionPickerMode(undefined);
    setMentionQuery("");
    setActiveMentionKey(undefined);
    activeMentionSelectionRef.current = undefined;
    if (restoreFocus) restoreTextareaFocus();
  };
  const selectMention = (participantKey: string): void => {
    if (
      !mentionPickerOpen ||
      conversationIdRef.current !== conversation.id ||
      state.disabled ||
      state.readOnly
    ) return;
    const mentionSelection = mentionPickerMode === "inline"
      ? activeMentionSelectionRef.current ?? selectionRef.current
      : selectionRef.current;
    const caret = controls.insertMention(participantKey, mentionSelection);
    if (caret === undefined) return;
    pendingCaretRef.current = caret;
    dismissMentionPicker(false);
  };
  const handleMentionPickerKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      dismissMentionPicker();
      return;
    }
    if (event.key === "Enter") {
      if (activeMentionKey === undefined) return;
      event.preventDefault();
      selectMention(activeMentionKey);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    moveActiveMention(event.key === "ArrowDown" ? 1 : -1);
  };

  const handleRichInput = (event: FormEvent<HTMLDivElement>): void => {
    if (state.disabled || state.readOnly) return;
    const editor = event.currentTarget;
    // A deactivated inline mark uses an ignored, zero-width DOM boundary so
    // the browser's native editing algorithm cannot extend the preceding mark.
    // Once the first native input lands there, retain the typed text and remove
    // the boundary before selection mapping or serialization.
    removeComposerRichTextCaretBoundary(editor);
    const richText = composerRichTextDocumentFromEditor(editor);
    const visualText = composerRichTextDocumentPlainText(richText);
    const visualSelection = readComposerRichTextSelection(editor) ?? {
      start: visualText.length,
      end: visualText.length,
    };
    richSelectionRef.current = visualSelection;
    const useMarkdown = state.format === "markdown" ||
      composerRichTextDocumentHasFormatting(richText);
    const nextText = useMarkdown
      ? richTextDocumentToCanonicalMarkdown(richText)
      : visualText;
    const nextFormat: ChatComposerFormat = useMarkdown ? "markdown" : "plain";
    selectionRef.current = useMarkdown
      ? canonicalComposerSelection(richText, visualSelection)
      : visualSelection;
    lastRichValueRef.current = { text: nextText, format: nextFormat };
    synchronizeRichEditorHeight();
    if (nextFormat !== state.format) controls.setFormat(nextFormat);
    controls.setText(nextText);

    const composing = isComposingRef.current ||
      (event.nativeEvent as InputEvent).isComposing;
    if (composing) {
      if (mentionPickerMode === "inline") dismissMentionPicker(false);
      return;
    }
    const activeToken = activeMentionTokenAtCaret(visualText, visualSelection.end);
    if (activeToken === undefined) {
      if (mentionPickerMode === "inline") dismissMentionPicker(false);
      return;
    }
    selectionRef.current = useMarkdown
      ? canonicalComposerSelection(richText, activeToken)
      : activeToken;
    activeMentionSelectionRef.current = selectionRef.current;
    pendingCaretRef.current = undefined;
    setEmojiPickerConversationId(undefined);
    setMentionPickerMode("inline");
    setMentionQuery(activeToken.query);
    setMentionPickerConversationId(conversation.id);
  };

  return createElement(
    "form",
    {
      ...hostProps,
      "data-read-only": state.readOnly ? true : undefined,
      "aria-describedby": [
        hasStatusFeedback ? statusId : undefined,
        error === undefined ? undefined : errorId,
      ].filter(Boolean).join(" ") || undefined,
    },
    state.replyTo === undefined ? null : createElement("div", {
      className: "handrail-chat__composer-reply", "aria-label": "Reply context",
    },
      createElement("div", { role: "status", "aria-live": "polite" },
        state.replyContext?.status === "available"
          ? `Replying to ${state.replyContext.authorLabel}: ${state.replyContext.preview}`
          : state.replyContext?.status === "deleted" ? "Original message was deleted."
          : state.replyContext?.status === "error" ? "Could not load original message."
          : state.replyContext?.status === "loading" ? "Loading original message…" : "Original message unavailable."),
      state.replyContext?.status !== "error" ? null : createElement("button", {
        type: "button", className: "handrail-chat__attachment-action",
        onClick: () => void controls.retryReplySource(),
      }, "Retry original message"),
      createElement("label", null,
        createElement("input", { type: "checkbox", checked: state.replyTo.notifyAuthor,
          disabled: state.disabled || state.readOnly,
          onChange: (event: ChangeEvent<HTMLInputElement>) => controls.setReplyNotifyAuthor(event.currentTarget.checked),
        }), "Notify reply author"),
      createElement("button", { type: "button", className: "handrail-chat__attachment-action",
        disabled: state.disabled || state.readOnly,
        onClick: controls.clearReply,
      }, "Cancel reply")),
    createElement("label", { htmlFor: inputId, className: "handrail-chat__sr-only" }, label),
    richTextAvailable
      ? createElement("div", {
          className: "handrail-chat__composer-formatting-toolbar",
          "aria-label": "Text formatting",
          role: "toolbar",
        }, ...MARKDOWN_FORMATTING_CONTROLS.map(({ command, label: controlLabel, title }) =>
          createElement("button", {
            key: command,
            type: "button",
            className: "handrail-chat__control handrail-chat__composer-format",
            "aria-label": controlLabel,
            title,
            disabled: state.disabled || state.readOnly,
            onPointerDown: preserveFormattingSelection,
            onClick: () => formatSelection(command),
            onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) =>
              handleFormattingKeyDown(event, command),
          }, markdownFormattingIcon(command))))
      : null,
    richTextAvailable
      ? createElement("div", {
          ref: richEditorRef,
          id: inputId,
          className: "handrail-chat__control handrail-chat__composer-input handrail-chat__composer-rich-input",
          role: "textbox",
          contentEditable: !state.disabled && !state.readOnly,
          suppressContentEditableWarning: true,
          tabIndex: state.disabled && !state.readOnly ? -1 : 0,
          "aria-label": label,
          "aria-multiline": true,
          "aria-readonly": state.readOnly || undefined,
          "aria-disabled": state.disabled && !state.readOnly || undefined,
          "aria-invalid": error !== undefined,
          "aria-placeholder": reason ?? state.placeholder,
          "data-placeholder": reason ?? state.placeholder,
          "aria-autocomplete": mentionPickerMode === "inline" ? "list" : undefined,
          "aria-controls": mentionPickerMode === "inline" ? mentionListId : undefined,
          "aria-expanded": mentionPickerMode === "inline" ? mentionPickerOpen : undefined,
          "aria-activedescendant": mentionPickerMode !== "inline" || activeMentionKey === undefined
            ? undefined
            : `${mentionListId}-${activeMentionKey}`,
          onBeforeInput: (event: FormEvent<HTMLDivElement>) => {
            if (state.disabled || state.readOnly) event.preventDefault();
          },
          onInput: handleRichInput,
          onCompositionStart: () => {
            isComposingRef.current = true;
            if (mentionPickerMode === "inline") dismissMentionPicker(false);
          },
          onCompositionEnd: () => {
            isComposingRef.current = false;
          },
          onKeyDown: handleKeyDown,
          onKeyUp: rememberRichSelection,
          onPointerUp: rememberRichSelection,
          onSelect: rememberRichSelection,
          onPaste: handlePaste,
          onClick: (event) => {
            const target = event.target;
            if (target instanceof HTMLElement && target.closest("a") !== null) {
              event.preventDefault();
            }
          },
          onBlur: () => {
            rememberRichSelection();
            controls.blur();
          },
        })
      : null,
    createElement("textarea", {
      ref: textareaRef,
      id: richTextAvailable ? undefined : inputId,
      className: richTextAvailable
        ? "handrail-chat__composer-input-shadow"
        : "handrail-chat__control handrail-chat__composer-input",
      hidden: richTextAvailable,
      "aria-hidden": richTextAvailable || undefined,
      tabIndex: richTextAvailable ? -1 : undefined,
      value: state.text,
      placeholder: reason ?? state.placeholder,
      disabled: state.disabled && !state.readOnly,
      readOnly: state.readOnly,
      "aria-label": label,
      "aria-invalid": error !== undefined,
      "aria-autocomplete": mentionPickerMode === "inline" ? "list" : undefined,
      "aria-controls": mentionPickerMode === "inline" ? mentionListId : undefined,
      "aria-expanded": mentionPickerMode === "inline" ? mentionPickerOpen : undefined,
      "aria-activedescendant": mentionPickerMode !== "inline" || activeMentionKey === undefined
        ? undefined
        : `${mentionListId}-${activeMentionKey}`,
      onChange: (event: ChangeEvent<HTMLTextAreaElement>) => {
        synchronizeTextareaHeight();
        const nextText = event.currentTarget.value;
        controls.setText(nextText);
        const composing = isComposingRef.current ||
          (event.nativeEvent as InputEvent).isComposing;
        if (state.disabled || state.readOnly || composing) {
          if (mentionPickerMode === "inline") dismissMentionPicker(false);
          return;
        }
        const caret = event.currentTarget.selectionStart ?? nextText.length;
        const activeToken = activeMentionTokenAtCaret(nextText, caret);
        if (activeToken === undefined) {
          if (mentionPickerMode === "inline") dismissMentionPicker(false);
          return;
        }
        selectionRef.current = activeToken;
        activeMentionSelectionRef.current = activeToken;
        pendingCaretRef.current = undefined;
        setEmojiPickerConversationId(undefined);
        setMentionPickerMode("inline");
        setMentionQuery(activeToken.query);
        setMentionPickerConversationId(conversation.id);
      },
      onCompositionStart: () => {
        isComposingRef.current = true;
        if (mentionPickerMode === "inline") dismissMentionPicker(false);
      },
      onCompositionEnd: () => {
        isComposingRef.current = false;
      },
      onKeyDown: handleKeyDown,
      onPaste: handlePaste,
      onBlur: controls.blur,
      rows: 1,
    }),
    state.attachments.length === 0
      ? null
      : createElement("ul", {
          className: "handrail-chat__composer-attachments",
          "aria-label": "Message attachments",
        }, ...state.attachments.map((attachment) => {
          const total = attachment.progress?.totalBytes ?? 0;
          const uploaded = attachment.progress?.uploadedBytes ?? 0;
          const percent = total <= 0
            ? 0
            : Math.max(0, Math.min(100, Math.round((uploaded / total) * 100)));
          return createElement("li", {
            key: attachment.id,
            className: "handrail-chat__attachment-chip",
          },
          createElement("span", null, attachment.fileName),
          createElement("span", {
            className: "handrail-chat__composer-attachment-status handrail-chat__muted",
            ...(attachment.status === "uploading"
              ? {
                  role: "progressbar",
                  "aria-label": `${attachment.fileName} upload progress`,
                  "aria-valuemin": 0,
                  "aria-valuemax": 100,
                  "aria-valuenow": percent,
                }
              : {}),
          }, attachment.status === "uploading" ? `${percent}%` : attachment.status),
          attachment.cancellable
            ? createElement("button", {
                type: "button",
                className: "handrail-chat__attachment-action",
                "aria-label": `Cancel upload ${attachment.fileName}`,
                onClick: () =>
                  controls.cancelAttachment(attachment.id.replace(/^upload:/, "")),
              }, "Cancel")
            : createElement("button", {
                type: "button",
                className: "handrail-chat__attachment-action",
                "aria-label": `Remove attachment ${attachment.fileName}`,
                disabled: state.isSending,
                onClick: () => controls.removeAttachment(attachment.id),
              }, "Remove"));
        })),
    createElement("div", { className: "handrail-chat__composer-footer" },
      createElement("div", {
        className: "handrail-chat__composer-toolbar",
        "aria-label": "Message tools",
        role: "toolbar",
      },
        createElement("label", {
          className: "handrail-chat__composer-action handrail-chat__composer-attach",
          "aria-disabled": state.disabled,
          title: "Attach files",
        },
        composerActionIcon("attachment"),
        createElement("span", { className: "handrail-chat__sr-only" }, "Attach files"),
        createElement("input", {
          type: "file",
          multiple: true,
          accept: ATTACHMENT_ACCEPT,
          "aria-label": "Attach files",
          disabled: state.disabled,
          onChange: handleFileChange,
        })),
        createElement("div", {
          className: "handrail-chat__composer-emoji-picker-anchor",
          "data-picker-open": emojiPickerOpen ? true : undefined,
        },
        createElement("button", {
          type: "button",
          className: "handrail-chat__control handrail-chat__composer-action handrail-chat__composer-emoji-trigger",
          "aria-label": "Choose emoji",
          "aria-expanded": emojiPickerOpen,
          "aria-haspopup": "dialog",
          title: "Choose emoji",
          disabled: state.disabled || state.readOnly,
          onClick: openEmojiPicker,
          onKeyDown: handleEmojiKeyDown,
        }, composerActionIcon("emoji")),
        emojiPickerOpen
          ? createElement(ReactionPicker, {
              ariaLabel: "Choose emoji",
              className: "handrail-chat__composer-emoji-picker",
              labels: COMPOSER_EMOJI_PICKER_LABELS,
              onDismiss: () => dismissEmojiPicker(conversation.id),
              onSelect: insertEmoji,
              restoreFocus: restoreTextareaFocus,
            })
          : null),
        createElement("div", {
          className: "handrail-chat__composer-mention-picker-anchor",
          "data-picker-open": mentionPickerOpen ? true : undefined,
        },
        createElement("button", {
          type: "button",
          className: "handrail-chat__control handrail-chat__composer-action handrail-chat__composer-mention-trigger",
          "aria-label": "Mention a participant",
          "aria-expanded": mentionPickerOpen,
          "aria-haspopup": "listbox",
          title: "Mention a participant",
          disabled: state.disabled || state.readOnly,
          onClick: openMentionPicker,
        }, composerActionIcon("mention")),
        mentionPickerOpen
          ? createElement("div", {
              className: "handrail-chat__composer-mention-picker",
              role: "dialog",
              "aria-label": "Mention a participant",
            },
            createElement("label", {
              className: "handrail-chat__sr-only",
              htmlFor: `${id}-mention-filter`,
            }, "Filter participants"),
            createElement("input", {
              ref: mentionFilterRef,
              id: `${id}-mention-filter`,
              className: "handrail-chat__control handrail-chat__composer-mention-filter",
              type: "search",
              value: mentionQuery,
              placeholder: "Filter participants",
              "aria-label": "Filter participants",
              "aria-controls": mentionListId,
              "aria-activedescendant": activeMentionKey === undefined
                ? undefined
                : `${mentionListId}-${activeMentionKey}`,
              onChange: (event: ChangeEvent<HTMLInputElement>) =>
                setMentionQuery(event.currentTarget.value),
              onKeyDown: handleMentionPickerKeyDown,
            }),
            createElement("div", {
              id: mentionListId,
              className: "handrail-chat__composer-mention-list",
              role: "listbox",
              "aria-label": "Conversation participants",
            },
            filteredMentionParticipants.length === 0
              ? createElement("div", {
                  className: "handrail-chat__composer-mention-empty handrail-chat__muted",
                  role: "status",
                }, "No participants found.")
              : filteredMentionParticipants.map((participant) => createElement("button", {
                  id: `${mentionListId}-${participant.key}`,
                  key: participant.key,
                  type: "button",
                  className: "handrail-chat__composer-mention-option",
                  role: "option",
                  "aria-selected": participant.key === activeMentionKey,
                  "aria-disabled": !participant.selectable,
                  disabled: !participant.selectable,
                  onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) =>
                    event.preventDefault(),
                  onPointerMove: () => {
                    if (participant.selectable) setActiveMentionKey(participant.key);
                  },
                  onClick: () => selectMention(participant.key),
                },
                createElement("span", null, participant.label),
                participant.selectable
                  ? null
                  : createElement("span", {
                      className: "handrail-chat__composer-mention-option-note",
                    }, participant.state === "active" ? "Already mentioned" : "Unavailable")))),
            )
          : null),
      ),
      hasFeedback
        ? createElement("div", { className: "handrail-chat__composer-feedback" },
          hasStatusFeedback
            ? createElement("div", {
                id: statusId,
                role: "status",
                "aria-live": "polite",
                "aria-atomic": true,
                className: "handrail-chat__muted",
              }, statusMessage || reason || "")
            : null,
        error === undefined
          ? null
          : createElement("div", {
              id: errorId,
              role: "alert",
              "aria-live": "assertive",
              className: "handrail-chat__composer-error",
            },
            error,
            state.sendError !== undefined && state.failedClientMessageId !== undefined
              ? createElement("button", {
                  type: "button",
                  className: "handrail-chat__attachment-action",
                  disabled: state.disabled,
                  onClick: () => void controls.retrySend(),
                }, "Retry send")
              : null,
            state.draftError !== undefined
              ? createElement("button", {
                  type: "button",
                  className: "handrail-chat__attachment-action",
                  onClick: () => void controls.retryDraft(),
                }, "Retry draft")
              : null),
        )
        : null,
      createElement("button", {
        type: "submit",
        className: "handrail-chat__button handrail-chat__composer-send",
        disabled: !state.canSubmit,
        "aria-label": state.isSending ? "Sending message" : "Send message",
      }, state.isSending ? "Sending…" : "Send"),
    ),
  );
}

interface UnavailableMessageComposerProps {
  readonly inputLabel?: string;
  readonly placeholder?: string;
  readonly reason: string;
}

function UnavailableMessageComposer({
  inputLabel = "Message",
  placeholder,
  reason,
}: UnavailableMessageComposerProps): ReactElement {
  const inputId = `${useId().replaceAll(":", "")}-input`;
  return createElement("form", {
    className: "handrail-chat__composer",
    "aria-disabled": true,
    onSubmit: (event: SubmitEvent<HTMLFormElement>) => event.preventDefault(),
  },
  createElement("label", {
    className: "handrail-chat__sr-only",
    htmlFor: inputId,
  }, inputLabel),
  createElement("textarea", {
    id: inputId,
    className: "handrail-chat__control handrail-chat__composer-input",
    "aria-label": inputLabel,
    placeholder: placeholder ?? reason,
    disabled: true,
    rows: 1,
  }),
  createElement("div", { className: "handrail-chat__composer-footer" },
    createElement("div", {
      role: "status",
      "aria-live": "polite",
      className: "handrail-chat__composer-feedback handrail-chat__muted",
    }, reason),
    createElement("button", {
      type: "submit",
      className: "handrail-chat__button handrail-chat__composer-send",
      disabled: true,
      "aria-label": "Send message",
    }, "Send")));
}

/**
 * Accessible, draft-backed optional UI composer. It consumes only the public
 * React hooks/actions entry point and passes renderer-safe state to overrides.
 */
export function MessageComposer(props: MessageComposerProps): ReactElement {
  const context = useChat();
  if (context === null) {
    return createElement(UnavailableMessageComposer, {
      ...(props.inputLabel === undefined ? {} : { inputLabel: props.inputLabel }),
      ...(props.placeholder === undefined ? {} : { placeholder: props.placeholder }),
      reason: "Chat unavailable",
    });
  }
  return createElement(ConnectedMessageComposer, {
    ...props,
    key: props.conversationId,
    providerReady: context.isReady,
  });
}
