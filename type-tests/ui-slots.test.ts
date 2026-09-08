import {
  createElement,
  createRef,
  type ComponentType,
} from "react";

import type { ChatActions } from "../src/react/index.js";
import {
  resolveChatWorkspaceSlots,
  type ChatAttachmentSlotProps,
  type ChatAvatarSlotProps,
  type ChatChannelHeaderSlotProps,
  type ChatComposerSlotProps,
  type ChatEmptyStateSlotProps,
  type ChatEntityReferenceSlotProps,
  type ChatLinkPreviewSlotProps,
  type ChatMessageSlotProps,
  type ChatMessageViewModel,
  type ChatSlotHostProps,
  type ChatSystemEventSlotProps,
  type ChatUserSlotProps,
  type ChatWorkspaceHeaderSlotProps,
  type ChatWorkspaceIdentityViewModel,
  type ChatWorkspaceProps,
  type ChatWorkspaceSlotOverrides,
  type ChatWorkspaceSlots,
} from "../src/ui/index.js";

const WorkspaceHeader = (({ hostProps }: ChatWorkspaceHeaderSlotProps) =>
  createElement("div", hostProps)) satisfies ComponentType<
  ChatWorkspaceHeaderSlotProps
>;
const Avatar = ((_props: ChatAvatarSlotProps) => null) satisfies ComponentType<
  ChatAvatarSlotProps
>;
const Message = (({ hostProps }: ChatMessageSlotProps) =>
  createElement("article", hostProps)) satisfies ComponentType<
  ChatMessageSlotProps
>;
const ChannelHeader = ((_props: ChatChannelHeaderSlotProps) => null) satisfies ComponentType<
  ChatChannelHeaderSlotProps
>;
const Composer = ((_props: ChatComposerSlotProps) => null) satisfies ComponentType<
  ChatComposerSlotProps
>;
const EmptyState = ((_props: ChatEmptyStateSlotProps) => null) satisfies ComponentType<
  ChatEmptyStateSlotProps
>;
const Attachment = ((_props: ChatAttachmentSlotProps) => null) satisfies ComponentType<
  ChatAttachmentSlotProps
>;
const LinkPreview = ((_props: ChatLinkPreviewSlotProps) => null) satisfies ComponentType<
  ChatLinkPreviewSlotProps
>;
const SystemEvent = ((_props: ChatSystemEventSlotProps) => null) satisfies ComponentType<
  ChatSystemEventSlotProps
>;
const User = ((_props: ChatUserSlotProps) => null) satisfies ComponentType<
  ChatUserSlotProps
>;
const EntityReference = ((_props: ChatEntityReferenceSlotProps) => null) satisfies ComponentType<
  ChatEntityReferenceSlotProps
>;

const fullSlots = {
  WorkspaceHeader,
  Avatar,
  Message,
  ChannelHeader,
  Composer,
  EmptyState,
  Attachment,
  LinkPreview,
  SystemEvent,
  User,
  EntityReference,
} satisfies ChatWorkspaceSlots;

const partialSlots = {
  WorkspaceHeader,
  Message,
  Composer,
} satisfies ChatWorkspaceSlotOverrides;

const resolved: ChatWorkspaceSlots = resolveChatWorkspaceSlots(
  fullSlots,
  partialSlots,
);

const messageHostRef = createRef<HTMLElement>();
const workspaceHeaderRef = createRef<HTMLDivElement>();
const workspaceHeaderHostProps = {
  className: "company-workspace-header",
  role: "group",
  "aria-label": "Workspace controls",
  "data-workspace-state": "ready",
  ref: workspaceHeaderRef,
} satisfies ChatSlotHostProps<HTMLDivElement>;
const accessibleHostProps = {
  className: "company-message",
  role: "article",
  "aria-label": "Message from Avery",
  "aria-describedby": "message-help",
  "data-message-state": "sent",
  ref: messageHostRef,
} satisfies ChatSlotHostProps<HTMLElement>;

declare const messageProps: ChatMessageSlotProps;
declare const messageView: ChatMessageViewModel;
declare const actions: ChatActions;

const workspaceIdentity = {
  id: "workspace-public-id",
  name: "Acme Support",
  description: "Customer collaboration",
} satisfies ChatWorkspaceIdentityViewModel;
const workspaceProps = {
  scope: { type: "organization" },
  workspaceIdentity,
  workspaceMenuContent: createElement("span", null, "Menu"),
  onWorkspaceMenuOpen: () => undefined,
  workspaceSettingsContent: createElement("span", null, "Settings"),
  onWorkspaceSettingsOpen: () => undefined,
} satisfies ChatWorkspaceProps;
const workspaceHeaderProps = {
  identity: workspaceIdentity,
  controls: {
    messageSearch: createElement("button", { type: "button" }, "Search"),
    createConversation: createElement("button", { type: "button" }, "Add"),
  },
  hostProps: workspaceHeaderHostProps,
} satisfies ChatWorkspaceHeaderSlotProps;

const privateWorkspaceIdentity: ChatWorkspaceIdentityViewModel = {
  name: "Private workspace",
  // @ts-expect-error Trusted tenant identity cannot cross the workspace renderer boundary.
  tenantId: "tenant-private",
};
const privateWorkspaceHeaderProps: ChatWorkspaceHeaderSlotProps = {
  ...workspaceHeaderProps,
  // @ts-expect-error The trusted client is never a WorkspaceHeader prop.
  client: {},
};
const privateWorkspaceHeaderControls: ChatWorkspaceHeaderSlotProps = {
  ...workspaceHeaderProps,
  controls: {
    // @ts-expect-error Provider state cannot cross through workspace controls.
    provider: "private-provider",
  },
};

const canEdit: boolean = messageView.canEdit;
const canDelete: boolean = messageView.canDelete;
const reminderRevision: number = messageView.reminder.authoritativeRevision;
const reminderDueAt: string | undefined = messageView.reminder.dueAt;
const savedAvailable: boolean = messageView.saved.available;
const savedState: boolean = messageView.saved.isSaved;
const savedRevision: number = messageView.saved.authoritativeRevision;
// @ts-expect-error Capability names are not renderer-safe message fields.
messageView.capabilityNames;
// @ts-expect-error Role arrays are not renderer-safe message fields.
messageView.roles;
// @ts-expect-error Permission adapters are not renderer-safe message fields.
messageView.permissionAdapter;

const privateMessageProps: ChatMessageSlotProps = {
  ...messageProps,
  // @ts-expect-error Trusted tenant identity is not a renderer prop.
  tenantId: "tenant-private",
};
const privateAttachmentProps: ChatAttachmentSlotProps = {
  hostProps: {},
  attachment: {
    attachment: messageView.attachmentMetadata[0]!,
    // @ts-expect-error Provider descriptors are never attachment renderer data.
    providerDescriptor: { bucket: "private" },
  },
};
const linkPreviewProps = {
  hostProps: { "data-preview-kind": "external" },
  linkPreview: {
    url: "https://example.test/article",
    title: "Article title",
    description: "Article description",
    siteName: "Example",
    imageUrl: "https://example.test/article.png",
  },
} satisfies ChatLinkPreviewSlotProps;
const privateLinkPreviewProps: ChatLinkPreviewSlotProps = {
  ...linkPreviewProps,
  // @ts-expect-error Raw block payloads never cross the link-preview renderer boundary.
  data: { url: "javascript:alert(1)" },
};
const privateLinkPreviewViewModel: ChatLinkPreviewSlotProps = {
  hostProps: {},
  linkPreview: {
    url: "https://example.test/article",
    title: "Article title",
    // @ts-expect-error Provider fields are never link-preview renderer data.
    providerDescriptor: { credential: "private" },
  },
};
const privateUserProps: ChatUserSlotProps = {
  ...({} as ChatUserSlotProps),
  // @ts-expect-error Credentials cannot cross the public UI boundary.
  accessToken: "secret",
};

// @ts-expect-error Message slots receive only message-applicable actions.
messageProps.actions.createChannel;
messageProps.actions.markUnread({ fromSequence: messageView.sequence });
messageProps.actions.markUnread({
  // @ts-expect-error Conversation identity is bound before actions reach a renderer.
  conversationId: messageView.conversationId,
  fromSequence: messageView.sequence,
});
messageProps.actions.forwardMessage?.(messageView.id);
// @ts-expect-error Destination selection stays in the workspace, not a message slot.
messageProps.actions.forwardMessage?.({
  destinationConversationId: messageView.conversationId,
});
messageProps.actions.setMessageReminder({
  messageId: messageView.id,
  dueAt: messageView.createdAt,
});
messageProps.actions.setMessageReminder({
  messageId: messageView.id,
  dueAt: messageView.createdAt,
  // @ts-expect-error Renderer reminder commands do not expose authoritative revisions.
  expectedReminderRevision: messageView.reminder.authoritativeRevision,
});
// @ts-expect-error Idempotency correlation never crosses the renderer boundary.
messageView.reminder.idempotencyKey;
// @ts-expect-error Actor-private saved-message notes never cross the renderer boundary.
messageView.saved.privateNote;
// @ts-expect-error Raw pending saved-message records never cross the renderer boundary.
messageView.saved.pending;
messageProps.actions.saveMessage(messageView.id);
messageProps.actions.unsaveMessage(messageView.id);
messageProps.actions.retrySavedMessage(messageView.id);
// @ts-expect-error Renderer save actions accept only the bound public message identity.
messageProps.actions.saveMessage({ messageId: messageView.id, privateNote: "private" });
// @ts-expect-error Message slots do not receive the trusted client instance.
messageProps.actions.client;

const incompatibleOverrides: ChatWorkspaceSlotOverrides = {
  // @ts-expect-error Avatar props are incompatible with the Message slot.
  Message: Avatar,
};

void [
  resolved,
  workspaceHeaderHostProps,
  accessibleHostProps,
  workspaceProps,
  workspaceHeaderProps,
  savedAvailable,
  savedState,
  savedRevision,
  privateWorkspaceIdentity,
  privateWorkspaceHeaderProps,
  privateWorkspaceHeaderControls,
  privateMessageProps,
  privateAttachmentProps,
  linkPreviewProps,
  privateLinkPreviewProps,
  privateLinkPreviewViewModel,
  privateUserProps,
  actions,
  canDelete,
  canEdit,
  reminderDueAt,
  reminderRevision,
  incompatibleOverrides,
];

const ReplyMessage = ({ message }: ChatMessageSlotProps) => {
  const reply = message.replyContext;
  if (reply === undefined) return null; // Legacy host messages remain valid.
  // @ts-expect-error Source windows and canonical messages are not renderer data.
  reply.result;
  // @ts-expect-error Diagnostic details are never renderer data.
  reply.error;
  // @ts-expect-error Reply context is readonly.
  reply.messageId = message.id;
  if (reply.status === "available") {
    const preview: string = reply.preview;
    const author: string = reply.authorLabel;
    const jump: Promise<boolean> = reply.jump();
    void jump;
    return createElement("span", null, author, preview);
  }
  const inaccessiblePreview: undefined = reply.preview;
  const inaccessibleAuthor: undefined = reply.authorLabel;
  const disabledJump: undefined = reply.jump;
  if (reply.status === "error") {
    const retry: Promise<void> = reply.retry();
    void retry;
  }
  void [inaccessiblePreview, inaccessibleAuthor, disabledJump];
  return null;
};
void ReplyMessage;
