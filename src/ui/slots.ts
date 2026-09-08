import type {
  ComponentType,
  HTMLAttributes,
  ReactNode,
  RefAttributes,
} from "react";

import type {
  ChatConversationDraftState,
  ChatTimelineMessage,
  ClientAttachmentUploadProgress,
  ClientAttachmentUploadStatus,
  MessageAttachmentMetadata,
} from "../client/index.js";
import type {
  Conversation,
  ConversationId,
  ConversationType,
  ConversationVisibility,
  DraftContent,
  HostDirectoryUserSummary,
  HostEntityReference,
  IsoTimestamp,
  MessageId,
} from "../contracts/index.js";
import type { ChatActions } from "../react/index.js";

type ChatSlotDataAttributeValue = string | number | boolean | undefined;
type ChatSlotDataAttributes = {
  readonly [Attribute in `data-${string}`]?: ChatSlotDataAttributeValue;
};

/**
 * Props that every slot forwards to its outer host element. Children and raw
 * HTML are intentionally owned by the renderer, while normal DOM events,
 * class names, WAI-ARIA attributes, data attributes, and refs pass through.
 */
export type ChatSlotHostProps<HostElement extends HTMLElement = HTMLElement> =
  Readonly<
    Omit<
      HTMLAttributes<HostElement>,
      "children" | "className" | "dangerouslySetInnerHTML"
    > &
      RefAttributes<HostElement> & {
        readonly className?: string;
      }
  > &
    ChatSlotDataAttributes;

/** Compile-time guard against trusted identity, transport, and provider data. */
export interface NoPrivateChatRendererFields {
  readonly tenant?: never;
  readonly tenantId?: never;
  readonly actor?: never;
  readonly actorId?: never;
  readonly actorContext?: never;
  readonly client?: never;
  readonly realtimeEvent?: never;
  readonly transport?: never;
  readonly provider?: never;
  readonly providerDescriptor?: never;
  readonly credential?: never;
  readonly credentials?: never;
  readonly secret?: never;
  readonly token?: never;
  readonly accessToken?: never;
  readonly refreshToken?: never;
}

type RendererConversation<Source> = Source extends Conversation
  ? Omit<Source, "tenantId">
  : never;

/** A normalized conversation projection with trusted tenant identity removed. */
export type ChatConversationViewModel =
  RendererConversation<Conversation> & NoPrivateChatRendererFields;

export type ChatMessageDeliveryState =
  | Readonly<{ state: "sent" }>
  | Readonly<{ state: "sending"; clientMessageId: string }>
  | Readonly<{
      state: "failed";
      clientMessageId: string;
      retryable: boolean;
    }>;
export type ChatMessageEditState = "idle" | "pending" | "revision_conflict";
export type ChatMessageDeleteState = "idle" | "pending";
export type ChatMessageReminderMutationState = "idle" | "pending" | "failed" | "conflict";
export type ChatMessageSavedMutationState =
  | "idle"
  | "pending"
  | "failed"
  | "conflict";

/** Actor-private saved-message data reduced to renderer-safe display state. */
export type ChatMessageSavedViewModel = Readonly<{
  readonly available: boolean;
  readonly isSaved: boolean;
  readonly authoritativeRevision: number;
  readonly mutationState: ChatMessageSavedMutationState;
  readonly retryable: boolean;
  /** A newer canonical value replaced the in-flight optimistic presentation. */
  readonly conflict: boolean;
}>;

/** Renderer-safe outcome; private notes and command correlation stay internal. */
export type ChatMessageSavedActionOutcome = Readonly<{
  readonly status: "success" | "failed";
  readonly conflict: boolean;
}>;

/** Canonical actor-private reminder data reduced to renderer-safe display state. */
export type ChatMessageReminderViewModel = Readonly<{
  readonly state: "none" | "scheduled" | "cancelled";
  readonly dueAt?: IsoTimestamp;
  readonly authoritativeRevision: number;
  readonly mutationState: ChatMessageReminderMutationState;
  readonly retryable: boolean;
  /** A newer canonical value replaced the in-flight optimistic presentation. */
  readonly conflict: boolean;
}>;

/** Renderer-safe outcome; command correlation and provider details stay internal. */
export type ChatMessageReminderActionOutcome = Readonly<{
  readonly status: "success" | "failed";
  readonly conflict: boolean;
}>;

type ChatMessageProjection = Pick<
  ChatTimelineMessage,
  | "id"
  | "conversationId"
  | "sequence"
  | "createdAt"
  | "updatedAt"
  | "revision"
  | "content"
  | "deletedAt"
  | "deletedByUserId"
  | "reactions"
  | "attachmentMetadata"
  | "isThreadRoot"
  | "threadSummary"
>;

/** Immediate source only. Text is bounded; inaccessible states carry no source data. */
export type ChatReplyContextViewModel = Readonly<{
  readonly conversationId: ConversationId;
  readonly messageId: MessageId;
} & (
  | { readonly status: "available"; readonly authorLabel: string; readonly preview: string;
      readonly jump: () => Promise<boolean>; readonly retry?: never }
  | { readonly status: "error"; readonly retry: () => Promise<void>;
      readonly authorLabel?: never; readonly preview?: never; readonly jump?: never }
  | { readonly status: "loading" | "loading_window" | "deleted" | "unavailable";
      readonly authorLabel?: never; readonly preview?: never; readonly jump?: never; readonly retry?: never }
)>;

/**
 * Renderer-safe message state. Optimistic internals such as idempotency keys,
 * retry diagnostics, and previous canonical rows are reduced to display state.
 */
export type ChatMessageViewModel = Readonly<
  ChatMessageProjection &
    NoPrivateChatRendererFields & {
      readonly author?: HostDirectoryUserSummary;
      readonly replyContext?: ChatReplyContextViewModel;
      readonly delivery: ChatMessageDeliveryState;
      readonly editState: ChatMessageEditState;
      readonly deleteState: ChatMessageDeleteState;
      readonly saved: ChatMessageSavedViewModel;
      readonly reminder: ChatMessageReminderViewModel;
      readonly canEdit: boolean;
      readonly canDelete: boolean;
    }
>;

export type ChatComposerDraftViewModel = Readonly<
  Pick<
    ChatConversationDraftState,
    "status" | "dirty" | "conflict" | "message"
  > &
    NoPrivateChatRendererFields & {
      readonly content?: DraftContent;
    }
>;

export interface ChatAttachmentViewModel extends NoPrivateChatRendererFields {
  readonly attachment: MessageAttachmentMetadata;
  readonly uploadStatus?: ClientAttachmentUploadStatus;
  readonly uploadProgress?: ClientAttachmentUploadProgress;
}

/** A normalized, renderer-safe projection of an exact `link_preview` block. */
export interface ChatLinkPreviewViewModel extends NoPrivateChatRendererFields {
  readonly url: string;
  readonly title: string;
  readonly description?: string;
  readonly siteName?: string;
  readonly imageUrl?: string;
}

export type ChatSystemEventDetailValue = string | number | boolean | null;

/** A display projection, never a raw realtime or transport event. */
export interface ChatSystemEventViewModel extends NoPrivateChatRendererFields {
  readonly id: string;
  readonly conversationId: ChatMessageViewModel["conversationId"];
  readonly kind: string;
  readonly occurredAt: IsoTimestamp;
  readonly summary: string;
  readonly actorUser?: HostDirectoryUserSummary;
  readonly details?: Readonly<Record<string, ChatSystemEventDetailValue>>;
}

export interface ChatEntityReferenceViewModel
  extends NoPrivateChatRendererFields {
  readonly entity: HostEntityReference;
  readonly label: string;
  readonly description?: string;
}

export type ChatMessageActions = Pick<
  ChatActions,
  | "retryMessage"
  | "editMessage"
  | "deleteMessage"
  | "setReaction"
  | "markUnread"
  | "openThread"
> & Readonly<{
  /** Inline source selection in Discord style; absent in Current style. Never opens a thread. */
  selectReply?: (sourceMessageId: MessageId) => void;
  /** Accessible explanation when inline source selection is unavailable. */
  replyDisabledReason?: string;
  /** Requests a named discussion dialog; never creates from an implicit name. */
  requestThreadCreation?: (rootMessageId: MessageId) => void;
  threadCreationDisabledReason?: string;
  /** Explicit existing-thread action in Discord style. */
  showOpenThread?: boolean;
  /** Requests host-owned destination selection for this canonical row. */
  forwardMessage?: (sourceMessageId: MessageId) => void;
  saveMessage: (messageId: MessageId) => Promise<ChatMessageSavedActionOutcome>;
  unsaveMessage: (messageId: MessageId) => Promise<ChatMessageSavedActionOutcome>;
  retrySavedMessage: (messageId: MessageId) => Promise<ChatMessageSavedActionOutcome>;
  setMessageReminder: (
    input: Readonly<{ readonly messageId: MessageId; readonly dueAt: IsoTimestamp }>,
  ) => Promise<ChatMessageReminderActionOutcome>;
  cancelMessageReminder: (messageId: MessageId) => Promise<ChatMessageReminderActionOutcome>;
  retryMessageReminder: (messageId: MessageId) => Promise<ChatMessageReminderActionOutcome>;
}>;

export type ChatChannelHeaderActions = Pick<
  ChatActions,
  | "archiveConversation"
  | "restoreConversation"
  | "updateConversationPreference"
  | "startHuddle"
  | "joinHuddle"
  | "leaveHuddle"
  | "endHuddle"
>;

export type ChatComposerActions = Pick<
  ChatActions,
  | "sendMessage"
  | "replaceConversationDraft"
  | "clearConversationDraft"
  | "flushConversationDraft"
  | "retryConversationDraft"
  | "uploadAttachment"
  | "startTyping"
  | "stopTyping"
>;

export type ChatComposerFormat = DraftContent["format"];

export type ChatComposerDisabledReason =
  | "provider_unavailable"
  | "conversation_unavailable"
  | "draft_loading"
  | "archived"
  | "inactive_membership"
  | "insufficient_permission"
  | "host_disabled"
  | "read_only"
  | "sending";

export interface ChatComposerAttachmentState
  extends NoPrivateChatRendererFields {
  /** A local upload id or finalized attachment id, never a provider object key. */
  readonly id: string;
  readonly fileName: string;
  readonly contentType?: string;
  readonly sizeBytes?: number;
  readonly status: ClientAttachmentUploadStatus | "restored";
  readonly progress?: ClientAttachmentUploadProgress;
  readonly attachmentId?: string;
  readonly cancellable: boolean;
}

export type ChatComposerMentionParticipantState =
  | "active"
  | "redacted"
  | "unavailable"
  | "unresolved";

/** Display-only participant projection. The opaque key is valid only for this composer. */
export interface ChatComposerMentionParticipant
  extends NoPrivateChatRendererFields {
  readonly key: string;
  readonly label: string;
  readonly state: ChatComposerMentionParticipantState;
  readonly selectable: boolean;
}

/** Display-only mention token; canonical user IDs remain inside the connected composer. */
export interface ChatComposerMentionState extends NoPrivateChatRendererFields {
  readonly label: string;
  readonly text: string;
}

export interface ChatComposerSelection extends NoPrivateChatRendererFields {
  readonly start: number;
  readonly end: number;
}

export interface ChatComposerStatus extends NoPrivateChatRendererFields {
  readonly kind: "idle" | "draft" | "upload" | "sending" | "sent";
  readonly message: string;
}

/** Renderer-safe state shared by the default Composer and host overrides. */
export interface ChatComposerState extends NoPrivateChatRendererFields {
  readonly inputLabel: string;
  readonly placeholder: string;
  readonly text: string;
  readonly format: ChatComposerFormat;
  readonly replyTo?: NonNullable<DraftContent["replyTo"]>;
  /** Only currently accessible source content is included. */
  readonly replyContext?: Readonly<{
    status: "loading" | "available" | "deleted" | "unavailable" | "error";
    authorLabel?: string;
    preview?: string;
  }>;
  readonly attachments: readonly ChatComposerAttachmentState[];
  readonly mentionParticipants: readonly ChatComposerMentionParticipant[];
  readonly mentions: readonly ChatComposerMentionState[];
  readonly disabled: boolean;
  readonly readOnly: boolean;
  readonly disabledReason?: ChatComposerDisabledReason;
  readonly isSending: boolean;
  readonly canSubmit: boolean;
  readonly draftError?: string;
  readonly sendError?: string;
  readonly failedClientMessageId?: string;
  readonly status: ChatComposerStatus;
}

/**
 * UI-level commands used by both the default renderer and a Composer override.
 * Byte sources are accepted transiently by `addAttachments` and are never part
 * of renderer state or retained by the optional UI.
 */
export interface ChatComposerControls extends NoPrivateChatRendererFields {
  /** Select/replace a source in this conversation. Each selection starts with ping on. */
  readonly selectReply: (source: Readonly<{ conversationId: ConversationId; messageId: MessageId }>) => void;
  readonly setReplyNotifyAuthor: (notifyAuthor: boolean) => void;
  /** Preserve content and return focus to the editor. */
  readonly clearReply: () => void;
  readonly retryReplySource: () => Promise<void>;
  readonly setText: (text: string) => void;
  readonly setFormat: (format: ChatComposerFormat) => void;
  /** Inserts one canonical user mention and returns the post-token caret. */
  readonly insertMention: (
    participantKey: string,
    selection: ChatComposerSelection,
  ) => number | undefined;
  readonly send: () => Promise<void>;
  readonly retrySend: () => Promise<void>;
  readonly retryDraft: () => Promise<void>;
  readonly addAttachments: (files: readonly File[]) => void;
  readonly cancelAttachment: (uploadId: string) => void;
  readonly removeAttachment: (id: string) => void;
  readonly blur: () => void;
}

export type ChatUserActions = Pick<
  ChatActions,
  | "createDirect"
  | "createGroupDirect"
  | "addConversationMember"
  | "removeConversationMember"
>;

/** Host-supplied workspace identity reduced to display-only fields. */
export interface ChatWorkspaceIdentityViewModel
  extends NoPrivateChatRendererFields {
  readonly id?: string;
  readonly name: string;
  readonly description?: string;
}

/** Already-wired controls that a WorkspaceHeader renderer may reposition. */
export interface ChatWorkspaceHeaderControls
  extends NoPrivateChatRendererFields {
  readonly messageSearch?: ReactNode;
  readonly createConversation?: ReactNode;
  readonly menu?: ReactNode;
  readonly settings?: ReactNode;
}

export interface ChatWorkspaceHeaderSlotProps
  extends NoPrivateChatRendererFields {
  readonly identity?: ChatWorkspaceIdentityViewModel;
  readonly controls: ChatWorkspaceHeaderControls;
  readonly hostProps: ChatSlotHostProps<HTMLDivElement>;
}

export interface ChatAvatarSlotProps extends NoPrivateChatRendererFields {
  readonly user: HostDirectoryUserSummary;
  readonly size: "small" | "medium" | "large";
  readonly hostProps: ChatSlotHostProps<HTMLSpanElement>;
}

export interface ChatMessageSlotProps extends NoPrivateChatRendererFields {
  readonly message: ChatMessageViewModel;
  readonly actions: ChatMessageActions;
  readonly hostProps: ChatSlotHostProps<HTMLElement>;
}

export interface ChatChannelHeaderSlotProps
  extends NoPrivateChatRendererFields {
  readonly conversation: ChatConversationViewModel;
  readonly actions: ChatChannelHeaderActions;
  readonly hostProps: ChatSlotHostProps<HTMLElement>;
}

export interface ChatComposerSlotProps extends NoPrivateChatRendererFields {
  readonly conversation: ChatConversationViewModel;
  readonly draft: ChatComposerDraftViewModel;
  readonly state: ChatComposerState;
  readonly controls: ChatComposerControls;
  readonly actions: ChatComposerActions;
  readonly hostProps: ChatSlotHostProps<HTMLFormElement>;
}

export type ChatEmptyStateKind =
  | "no_conversation"
  | "no_messages"
  | "no_search_results"
  | "unavailable";

export type ChatConversationIntroductionParticipantState =
  | "active"
  | "redacted"
  | "unavailable"
  | "unresolved";

/** Display-only participant identity; membership and user identifiers stay private. */
export interface ChatConversationIntroductionParticipant
  extends NoPrivateChatRendererFields {
  readonly label: string;
  readonly state: ChatConversationIntroductionParticipantState;
}

/**
 * Renderer-safe context for an empty conversation timeline. This projection is
 * deliberately free of conversation, tenant, membership, and provider IDs.
 */
export interface ChatConversationIntroductionViewModel
  extends NoPrivateChatRendererFields {
  readonly conversationType: ConversationType;
  readonly identity: string;
  readonly context: string;
  readonly prompt: string;
  readonly visibility?: ConversationVisibility;
  readonly archived: boolean;
  readonly entity?: Readonly<HostEntityReference>;
  readonly participantResolution?: "ready" | "loading" | "unavailable";
  readonly participants?: readonly ChatConversationIntroductionParticipant[];
}

export interface ChatEmptyStateSlotProps extends NoPrivateChatRendererFields {
  readonly kind: ChatEmptyStateKind;
  readonly title: string;
  readonly description?: string;
  /** Present only for a conversation-specific empty message timeline. */
  readonly introduction?: ChatConversationIntroductionViewModel;
  readonly hostProps: ChatSlotHostProps<HTMLElement>;
}

export interface ChatAttachmentSlotProps extends NoPrivateChatRendererFields {
  readonly attachment: ChatAttachmentViewModel;
  readonly hostProps: ChatSlotHostProps<HTMLElement>;
}

export interface ChatLinkPreviewSlotProps extends NoPrivateChatRendererFields {
  readonly linkPreview: ChatLinkPreviewViewModel;
  readonly hostProps: ChatSlotHostProps<HTMLElement>;
}

export interface ChatSystemEventSlotProps extends NoPrivateChatRendererFields {
  readonly event: ChatSystemEventViewModel;
  readonly hostProps: ChatSlotHostProps<HTMLElement>;
}

export interface ChatUserSlotProps extends NoPrivateChatRendererFields {
  readonly user: HostDirectoryUserSummary;
  readonly actions: ChatUserActions;
  readonly hostProps: ChatSlotHostProps<HTMLElement>;
}

export interface ChatEntityReferenceSlotProps
  extends NoPrivateChatRendererFields {
  readonly entityReference: ChatEntityReferenceViewModel;
  readonly hostProps: ChatSlotHostProps<HTMLElement>;
}

export type ChatWorkspaceSlotComponent<Props> = ComponentType<Props>;

/** The stable, public set of ChatWorkspace customization points. */
export const CHAT_WORKSPACE_SLOT_KEYS = Object.freeze([
  "WorkspaceHeader",
  "Avatar",
  "Message",
  "ChannelHeader",
  "Composer",
  "EmptyState",
  "Attachment",
  "LinkPreview",
  "SystemEvent",
  "User",
  "EntityReference",
] as const);

export type ChatWorkspaceSlotName =
  (typeof CHAT_WORKSPACE_SLOT_KEYS)[number];

/** A complete map supplied by the optional UI implementation. */
export interface ChatWorkspaceSlots {
  readonly WorkspaceHeader: ChatWorkspaceSlotComponent<ChatWorkspaceHeaderSlotProps>;
  readonly Avatar: ChatWorkspaceSlotComponent<ChatAvatarSlotProps>;
  readonly Message: ChatWorkspaceSlotComponent<ChatMessageSlotProps>;
  readonly ChannelHeader: ChatWorkspaceSlotComponent<ChatChannelHeaderSlotProps>;
  readonly Composer: ChatWorkspaceSlotComponent<ChatComposerSlotProps>;
  readonly EmptyState: ChatWorkspaceSlotComponent<ChatEmptyStateSlotProps>;
  readonly Attachment: ChatWorkspaceSlotComponent<ChatAttachmentSlotProps>;
  readonly LinkPreview: ChatWorkspaceSlotComponent<ChatLinkPreviewSlotProps>;
  readonly SystemEvent: ChatWorkspaceSlotComponent<ChatSystemEventSlotProps>;
  readonly User: ChatWorkspaceSlotComponent<ChatUserSlotProps>;
  readonly EntityReference: ChatWorkspaceSlotComponent<ChatEntityReferenceSlotProps>;
}

/** Consumer replacements; omitted slots retain their corresponding defaults. */
export type ChatWorkspaceSlotOverrides = Partial<ChatWorkspaceSlots>;

/**
 * Resolves a complete slot map in stable key order. Neither the complete
 * defaults nor partial consumer overrides are mutated or returned directly.
 */
export function resolveChatWorkspaceSlots(
  defaults: ChatWorkspaceSlots,
  overrides: ChatWorkspaceSlotOverrides = {},
): ChatWorkspaceSlots {
  return Object.freeze({
    WorkspaceHeader:
      overrides.WorkspaceHeader ?? defaults.WorkspaceHeader,
    Avatar: overrides.Avatar ?? defaults.Avatar,
    Message: overrides.Message ?? defaults.Message,
    ChannelHeader: overrides.ChannelHeader ?? defaults.ChannelHeader,
    Composer: overrides.Composer ?? defaults.Composer,
    EmptyState: overrides.EmptyState ?? defaults.EmptyState,
    Attachment: overrides.Attachment ?? defaults.Attachment,
    LinkPreview: overrides.LinkPreview ?? defaults.LinkPreview,
    SystemEvent: overrides.SystemEvent ?? defaults.SystemEvent,
    User: overrides.User ?? defaults.User,
    EntityReference:
      overrides.EntityReference ?? defaults.EntityReference,
  });
}
