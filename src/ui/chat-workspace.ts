import {
  Fragment,
  createElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
  type UIEvent,
} from "react";

import type {
  Conversation,
  ConversationId,
  ConversationMemberPreference,
  ConversationReadState,
  ConversationSnapshotScope,
  HostDirectoryUserSummary,
  MessageSearchFilters,
  MessageSearchHit,
  MessageId,
  UserId,
} from "../contracts/index.js";
import { MAX_REACTION_KEY_UTF8_BYTES } from "../contracts/index.js";
import {
  useChat,
  useChatActions,
  useChatSelector,
  useConversation,
  useConversationParticipants,
  useConversations,
  useDirectoryUsers,
  useHuddle,
  useMessageSearch,
  useMembers,
  useReadState,
  useReplyStyle,
  useTyping,
  type ChatActions,
  type ConversationListQueryConversation,
} from "../react/index.js";
import {
  HuddleControls,
  type HuddleControlsProps,
  type HuddleControlsPermissions,
  type HuddleMediaRenderer,
} from "./huddle-controls.js";
import {
  DefaultMessageComposerRenderer,
  MessageComposer,
  type MessageComposerAvailability,
} from "./message-composer.js";
import {
  DefaultAttachmentRenderer,
  DefaultEntityReferenceRenderer,
  DefaultLinkPreviewRenderer,
  DefaultMessageRenderer,
  DefaultMessageTimelineAvatar,
  DefaultMessageTimelineEmptyState,
  DefaultSystemEventRenderer,
  MessageTimeline,
  type MessageTimelineEditController,
  type MessageForwardRequest,
  type MessageMutationAvailabilityResolver,
} from "./message-timeline.js";
import {
  resolveChatWorkspaceSlots,
  type ChatComposerControls,
  type ChatChannelHeaderSlotProps,
  type ChatConversationIntroductionParticipant,
  type ChatConversationIntroductionViewModel,
  type ChatConversationViewModel,
  type ChatUserSlotProps,
  type ChatWorkspaceHeaderSlotProps,
  type ChatWorkspaceIdentityViewModel,
  type ChatWorkspaceSlotOverrides,
  type ChatWorkspaceSlots,
} from "./slots.js";
import { DirectConversationCreation } from "./direct-conversation-creation.js";
import { GroupDirectConversationCreation } from "./group-direct-conversation-creation.js";
import {
  MemberManagement,
  type ChatWorkspaceMemberManagementAvailability,
} from "./member-management.js";
import { NotificationPreferences } from "./notification-preferences.js";
import { ThreadCreationDialog, useThreadCreationRestriction, type ThreadCreationRequest, type ThreadCreationDraft } from "./thread-creation-dialog.js";
import { ThreadList, type ThreadListSelection } from "./thread-list.js";
import { ThreadPanel, type ThreadPanelProps } from "./thread-panel.js";
import { ReplyStyleSettingsDialog } from "./reply-style-settings.js";
import {
  calculateTimelineAnchorOffsetCorrection,
  calculateTimelineWindow,
  type TimelineWindowRow,
} from "./timeline-window.js";

interface ConversationFilterShortcutRegistration {
  focusConversationFilter: () => boolean;
  root: HTMLElement | null;
}

interface ConversationFilterShortcutDocumentState {
  activeRegistration: ConversationFilterShortcutRegistration | undefined;
  readonly onKeyDown: (event: DocumentEventMap["keydown"]) => void;
  readonly registrations: Set<ConversationFilterShortcutRegistration>;
}

const conversationFilterShortcutDocuments = new WeakMap<
  Document,
  ConversationFilterShortcutDocumentState
>();

function bodyShortcutRegistration(
  ownerDocument: Document,
  state: ConversationFilterShortcutDocumentState,
): ConversationFilterShortcutRegistration | undefined {
  const activeRegistration = state.activeRegistration;
  if (
    activeRegistration !== undefined &&
    state.registrations.has(activeRegistration) &&
    activeRegistration.root?.isConnected === true
  ) {
    return activeRegistration;
  }
  const connectedRegistrations = [...state.registrations].filter(
    ({ root }) => root?.isConnected === true,
  );
  return connectedRegistrations.length === 1 ? connectedRegistrations[0] : undefined;
}

function registerConversationFilterShortcut(
  ownerDocument: Document,
  registration: ConversationFilterShortcutRegistration,
): () => void {
  let state = conversationFilterShortcutDocuments.get(ownerDocument);
  if (state === undefined) {
    const registrations = new Set<ConversationFilterShortcutRegistration>();
    state = {
      activeRegistration: undefined,
      registrations,
      onKeyDown: (event) => {
        if (
          event.defaultPrevented ||
          event.target !== ownerDocument.body ||
          event.key !== "/" ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey ||
          event.isComposing
        ) {
          return;
        }
        const bodyRegistration = bodyShortcutRegistration(ownerDocument, state!);
        if (bodyRegistration === undefined) return;
        const root = bodyRegistration.root;
        if (root === null) return;
        if (root.querySelector(
          ".handrail-chat__message-search, [role='menu'], [role='dialog']",
        ) !== null) {
          return;
        }
        if (!bodyRegistration.focusConversationFilter()) return;
        event.preventDefault();
      },
    };
    conversationFilterShortcutDocuments.set(ownerDocument, state);
    ownerDocument.addEventListener("keydown", state.onKeyDown);
  }
  state.registrations.add(registration);
  return () => {
    const currentState = conversationFilterShortcutDocuments.get(ownerDocument);
    if (currentState === undefined) return;
    currentState.registrations.delete(registration);
    if (currentState.activeRegistration === registration) {
      currentState.activeRegistration = undefined;
    }
    if (currentState.registrations.size > 0) return;
    ownerDocument.removeEventListener("keydown", currentState.onKeyDown);
    conversationFilterShortcutDocuments.delete(ownerDocument);
  };
}

function claimConversationFilterShortcut(
  registration: ConversationFilterShortcutRegistration,
): void {
  const root = registration.root;
  if (root === null) return;
  const state = conversationFilterShortcutDocuments.get(root.ownerDocument);
  if (state?.registrations.has(registration) === true) {
    state.activeRegistration = registration;
  }
}

export type ChatWorkspaceMode =
  | "full-screen"
  | "side-panel"
  | "modal"
  | "record";

export interface ChatWorkspaceBodyProps {
  readonly conversation: ChatConversationViewModel;
  readonly actions: ChatActions;
  readonly slots: ChatWorkspaceSlots;
}

export type ChatWorkspaceBodyRenderer = (
  props: ChatWorkspaceBodyProps,
) => ReactNode;

type ChatWorkspacePreferenceSelector = Parameters<
  typeof useChatSelector<ConversationMemberPreference | undefined>
>[0];

type ChatWorkspacePreferencePendingSelector = Parameters<
  typeof useChatSelector<boolean>
>[0];

type ChatWorkspacePreferences = Readonly<
  Record<ConversationId, ConversationMemberPreference>
>;

type ChatWorkspacePreferencesSelector = Parameters<
  typeof useChatSelector<ChatWorkspacePreferences>
>[0];

const selectConversationPreferences: ChatWorkspacePreferencesSelector =
  (state) => state.currentUser.preferences;

type ConversationParticipantIdsByConversation = Readonly<
  Record<ConversationId, readonly UserId[]>
>;

type ConversationParticipantIdsSelector = Parameters<
  typeof useChatSelector<ConversationParticipantIdsByConversation>
>[0];

const selectDetailParticipantUserIds: ConversationParticipantIdsSelector =
  (state) => state.entities.memberUserIdsByConversation;

const selectListParticipantUserIds: ConversationParticipantIdsSelector =
  (state) => state.metadata.conversationListParticipantUserIds;

type ConversationNavigationMuteState = "unmuted" | "finite" | "indefinite";

const DEFAULT_CONVERSATION_NAVIGATION_PREFERENCE = Object.freeze({
  notificationPreference: "all",
  isStarred: false,
  mute: Object.freeze({ muted: false }),
}) satisfies Pick<
  ConversationMemberPreference,
  "notificationPreference" | "isStarred" | "mute"
>;

const conversationNavigationNotificationLabel = (
  level: ConversationMemberPreference["notificationPreference"],
): string => {
  if (level === "mentions") return "Mentions only";
  if (level === "none") return "No notifications";
  return "All messages";
};

const conversationNavigationMuteState = (
  preference: ConversationMemberPreference | undefined,
): ConversationNavigationMuteState => preference?.mute.muted === true
  ? preference.mute.mutedUntil === undefined ? "indefinite" : "finite"
  : "unmuted";

const conversationNavigationMuteLabel = (
  preference: ConversationMemberPreference | undefined,
): string => preference?.mute.muted === true
  ? preference.mute.mutedUntil === undefined
    ? "Muted indefinitely"
    : `Muted until ${preference.mute.mutedUntil}`
  : "Unmuted";

const conversationStarFailureMessage = (
  result: Exclude<
    Awaited<ReturnType<ChatActions["updateConversationPreference"]>>,
    { readonly status: "success" }
  >,
  desiredStarred: boolean,
  label: string,
): string => {
  const action = desiredStarred ? "star" : "unstar";
  switch (result.status) {
    case "authentication":
      return `Could not ${action} ${label}. Sign in again, then retry.`;
    case "transport":
      return `Could not ${action} ${label}. Check your connection, then retry.`;
    case "validation":
      return `Could not ${action} ${label}. Refresh the conversation, then retry.`;
    case "feature_disabled":
    case "unsupported":
      return `Could not ${action} ${label}. Starred conversations are unavailable; contact your workspace administrator.`;
    case "rejected":
    case "conflict":
      return `Could not ${action} ${label}. Check your access, then retry.`;
    case "malformed_response":
      return `Could not ${action} ${label} because the server response was invalid. Retry, or contact support.`;
    case "aborted":
    case "closed":
      return `Could not ${action} ${label}. Reopen the chat, then retry.`;
  }
};

/** Host-authoritative permission to expose default channel creation UI. */
export interface ChatWorkspaceChannelCreationAvailability {
  readonly canCreate: boolean;
}

/** Host-authoritative permission to expose default direct creation UI. */
export interface ChatWorkspaceDirectCreationAvailability {
  readonly canCreate: boolean;
}

/** Host-authoritative permission to expose default group-direct creation UI. */
export interface ChatWorkspaceGroupDirectCreationAvailability {
  readonly canCreate: boolean;
}

/** Host override for routing a message-search result. */
export interface ChatWorkspaceMessageSearchNavigation {
  readonly result: MessageSearchHit;
  /** Selects the result conversation and focuses its exact rendered message. */
  navigateDefault(): Promise<boolean>;
}

/**
 * Props for the optional drop-in shell. `conversationId` makes selection
 * controlled; pass `null` for an intentionally empty controlled selection.
 */
export interface ChatWorkspaceProps {
  readonly scope: ConversationSnapshotScope;
  readonly mode?: ChatWorkspaceMode;
  /**
   * Requests that the host close a modal workspace. The host owns changing
   * `mode` or unmounting the workspace in response.
   */
  readonly onModalCloseRequest?: () => void;
  readonly conversationId?: ConversationId | null;
  readonly defaultConversationId?: ConversationId;
  readonly onConversationChange?: (conversationId: ConversationId) => void;
  readonly components?: ChatWorkspaceSlotOverrides;
  readonly renderTimeline?: ChatWorkspaceBodyRenderer;
  readonly renderComposer?: ChatWorkspaceBodyRenderer;
  readonly renderThread?: ChatWorkspaceBodyRenderer;
  readonly renderHuddle?: ChatWorkspaceBodyRenderer;
  /** Authorized recipient cursor used by the default one-to-one timeline receipt UI. */
  readonly otherMemberReadState?: ConversationReadState;
  /** Used as the timeline body when `renderTimeline` is omitted. */
  readonly children?: ReactNode;
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly theme?: "light" | "dark";
  readonly ariaLabel?: string;
  readonly navigationLabel?: string;
  /** Display-only workspace identity; never inferred from scope or client state. */
  readonly workspaceIdentity?: ChatWorkspaceIdentityViewModel;
  /** Host content for a workspace-menu affordance or its button label. */
  readonly workspaceMenuContent?: ReactNode;
  /** When supplied, ChatWorkspace wires a workspace-menu button around its content. */
  readonly onWorkspaceMenuOpen?: () => void;
  /** Host settings affordance or button label; omission uses the reply-style settings dialog. */
  readonly workspaceSettingsContent?: ReactNode;
  /** When supplied, ChatWorkspace wires a workspace-settings button around its content. */
  readonly onWorkspaceSettingsOpen?: () => void;
  /**
   * Fail-closed host authorization for the default channel creation dialog.
   * Omit it or pass `canCreate: false` to render no creation affordance.
   */
  readonly channelCreationAvailability?: ChatWorkspaceChannelCreationAvailability;
  /**
   * Fail-closed host authorization for the default direct-conversation dialog.
   * Omit it or pass `canCreate: false` to render no creation affordance.
   */
  readonly directCreationAvailability?: ChatWorkspaceDirectCreationAvailability;
  /**
   * Fail-closed host authorization for the default group-direct dialog.
   * Omit it or pass `canCreate: false` to render no creation affordance.
   */
  readonly groupDirectCreationAvailability?: ChatWorkspaceGroupDirectCreationAvailability;
  /**
   * Overrides message-search result routing. Omit this callback for the default
   * conversation selection, hydration wait, scroll, and focus behavior. A host
   * may call `navigation.navigateDefault()` to compose custom routing with it.
   */
  readonly onMessageSearchResultActivate?: (
    navigation: ChatWorkspaceMessageSearchNavigation,
  ) => void | Promise<void>;
  /**
   * Fail-closed host visibility and per-user eligibility for member management.
   * Omission renders no member panel and no membership controls.
   */
  readonly memberManagementAvailability?: ChatWorkspaceMemberManagementAvailability;
  /** Host-authoritative composer restrictions; no role inference occurs. */
  readonly composerAvailability?: MessageComposerAvailability;
  /** Explicit host authority for the active thread and parent; omitted authority hides lifecycle actions. */
  readonly threadLifecycleAvailability?: ThreadPanelProps["lifecycleAvailability"];
  /**
   * The first 16 distinct canonical reaction keys, in preferred shortcut order.
   * They order existing aggregate chips but never create empty chips; the
   * catalog-backed picker and canonical aggregates outside the list still work.
   */
  readonly reactionKeys?: readonly string[];
  readonly readOnly?: boolean;
  /** Host-authoritative identity for author mutations and default huddle controls. */
  readonly currentUserId?: UserId;
  /** Host-authoritative per-message override for default timeline mutations. */
  readonly resolveMessageMutationAvailability?: MessageMutationAvailabilityResolver;
  /** Host-authoritative huddle capabilities; never derived from chat roles. */
  readonly huddlePermissions?: HuddleControlsPermissions;
  readonly huddleMediaSession?: HuddleControlsProps["mediaSession"];
  readonly huddleMediaRenderer?: HuddleMediaRenderer;
  readonly huddleParticipantLabel?: HuddleControlsProps["participantLabel"];
  readonly huddleDisabled?: boolean;
}

const EMPTY_CONVERSATION_ID = "" as ConversationId;
const MAX_CHAT_WORKSPACE_REACTION_KEYS = 16;
const CHAT_WORKSPACE_COMPACT_MAX_WIDTH = 640;
const GROUP_DIRECT_VISIBLE_AVATAR_COUNT = 3;
const CONVERSATION_NAVIGATION_ROW_ESTIMATED_HEIGHT_PX = 36;
const CONVERSATION_NAVIGATION_OVERSCAN_PX = 288;
const CONVERSATION_NAVIGATION_DEFAULT_VIEWPORT_HEIGHT_PX = 320;
const CHAT_WORKSPACE_MODAL_FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button",
  "input:not([type='hidden'])",
  "select",
  "textarea",
  "[contenteditable]:not([contenteditable='false'])",
  "[tabindex]",
].join(", ");

const modalFocusableElements = (root: HTMLElement): readonly HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>(CHAT_WORKSPACE_MODAL_FOCUSABLE_SELECTOR)]
    .filter((element) =>
      element.isConnected &&
      element.tabIndex >= 0 &&
      !element.matches(":disabled") &&
      element.closest("fieldset[disabled], [hidden], [inert], [aria-hidden='true']") === null
    );

const isDocumentHTMLElement = (
  ownerDocument: Document,
  value: Element | null,
): value is HTMLElement => {
  const HTMLElementConstructor = ownerDocument.defaultView?.HTMLElement;
  return HTMLElementConstructor !== undefined && value instanceof HTMLElementConstructor;
};

type ChatWorkspaceCompactPane = "list" | "detail";

const resolveReactionKeys = (
  reactionKeys: readonly string[] | undefined,
): readonly string[] | undefined => {
  if (reactionKeys === undefined) return undefined;
  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const reactionKey of reactionKeys) {
    if (
      typeof reactionKey !== "string" ||
      reactionKey.trim().length === 0 ||
      reactionKey.trim() !== reactionKey ||
      reactionKey.normalize("NFC") !== reactionKey ||
      new TextEncoder().encode(reactionKey).length > MAX_REACTION_KEY_UTF8_BYTES ||
      seen.has(reactionKey)
    ) continue;
    seen.add(reactionKey);
    resolved.push(reactionKey);
    if (resolved.length === MAX_CHAT_WORKSPACE_REACTION_KEYS) break;
  }
  return Object.freeze(resolved);
};

const conversationLabel = (conversation: Conversation): string => {
  if (conversation.type === "channel") return conversation.name;
  if (conversation.type === "direct") return "Direct conversation";
  if (conversation.type === "group_direct") return "Group conversation";
  return conversation.name ?? "Thread";
};

const normalizedConversationSearchText = (
  conversation: Conversation,
  participantLabels: readonly string[],
): string => [conversationLabel(conversation), ...participantLabels]
  .join(" ")
  .normalize("NFC")
  .toLocaleLowerCase();

const groupDirectParticipantLabel = (
  user: HostDirectoryUserSummary | undefined,
): string => {
  if (user?.kind === "active") return user.displayName;
  if (user?.kind === "redacted") return "Hidden user";
  if (user?.kind === "unavailable") return "Unavailable user";
  return "Unknown participant";
};

const typingStatusCopy = (labels: readonly string[]): string => {
  if (labels.length === 0) return "";
  if (labels.length === 1) return `${labels[0]} is typing…`;
  if (labels.length === 2) return `${labels[0]} and ${labels[1]} are typing…`;
  const otherCount = labels.length - 2;
  return `${labels[0]}, ${labels[1]}, and ${otherCount} ${
    otherCount === 1 ? "other" : "others"
  } are typing…`;
};

interface ConversationTypingIndicatorProps {
  readonly conversationId: ConversationId;
  readonly currentUserId?: UserId;
}

const ConversationTypingIndicator = ({
  conversationId,
  currentUserId,
}: ConversationTypingIndicatorProps): ReactElement => {
  const typingResult = useTyping(conversationId);
  const typingUserIds = useMemo<readonly UserId[]>(() => Object.freeze(
    [...new Set(
      (typingResult.data ?? [])
        .map(({ userId }) => userId)
        .filter((userId) => userId !== currentUserId),
    )],
  ), [currentUserId, typingResult.data]);
  const directoryResult = useDirectoryUsers(typingUserIds);
  const directoryUsersById = useMemo(
    () => new Map((directoryResult.data ?? []).map((user) => [user.userId, user])),
    [directoryResult.data],
  );
  const status = useMemo(
    () => typingStatusCopy(typingUserIds.map((userId) =>
      groupDirectParticipantLabel(directoryUsersById.get(userId)))),
    [directoryUsersById, typingUserIds],
  );

  return createElement(
    "div",
    {
      className: "handrail-chat__typing-indicator",
      "data-active": status.length > 0 ? "true" : "false",
    },
    createElement(
      "span",
      {
        "aria-atomic": "true",
        "aria-live": "polite",
        role: "status",
      },
      status,
    ),
  );
};

const participantState = (
  user: HostDirectoryUserSummary | undefined,
): ChatConversationIntroductionParticipant["state"] => {
  if (user?.kind === "active") return "active";
  if (user?.kind === "redacted") return "redacted";
  if (user?.kind === "unavailable") return "unavailable";
  return "unresolved";
};

const navigationParticipantAvailability = (
  user: HostDirectoryUserSummary | undefined,
): "online" | "away" | "busy" | "offline" | undefined =>
  user?.kind === "active" ? user.status?.availability : undefined;

const navigationParticipantAccessibleLabel = (
  user: HostDirectoryUserSummary | undefined,
): string => {
  const label = groupDirectParticipantLabel(user);
  const availability = navigationParticipantAvailability(user);
  return availability === undefined ? label : `${label} (${availability})`;
};

const conversationNavigationAvatar = (
  user: HostDirectoryUserSummary | undefined,
  label: string,
  key?: string,
): ReactElement => {
  const availability = navigationParticipantAvailability(user);
  return createElement(
    "span",
    {
      "aria-hidden": true,
      className: "handrail-chat__conversation-avatar-wrap",
      ...(key === undefined ? {} : { key }),
      title: label,
    },
    user?.kind === "active"
      ? createElement(DefaultMessageTimelineAvatar, {
          hostProps: { className: "handrail-chat__conversation-avatar" },
          size: "small",
          user,
        })
      : createElement(
          "span",
          { className: "handrail-chat__conversation-avatar-fallback" },
          label.slice(0, 1).toLocaleUpperCase(),
        ),
    availability === undefined
      ? null
      : createElement("span", {
          className: "handrail-chat__conversation-presence",
          "data-availability": availability,
        }),
  );
};

const directParticipantLabel = (
  user: HostDirectoryUserSummary | undefined,
  hasParticipant: boolean,
  loading: boolean,
): string => {
  if (user?.kind === "active") return user.displayName;
  if (user?.kind === "redacted") return "Hidden user";
  if (user?.kind === "unavailable") return "Unknown user";
  if (loading) return "Loading participant…";
  return hasParticipant ? "Unknown participant" : "Participant unavailable";
};

type ConversationNavigationKind =
  | "public-channel"
  | "private-channel"
  | "direct"
  | "group-direct"
  | "thread";

type ConversationCreationKind = "channel" | "direct" | "group-direct";

type NavigationIconName =
  | ConversationNavigationKind
  | "add"
  | "disclosure"
  | "search"
  | "settings"
  | "workspace-menu";

interface ConversationCreationMenuItem {
  readonly kind: ConversationCreationKind;
  readonly label: string;
}

const conversationNavigationKind = (
  conversation: Conversation,
): ConversationNavigationKind => {
  if (conversation.type === "channel") {
    return conversation.visibility === "private"
      ? "private-channel"
      : "public-channel";
  }
  if (conversation.type === "group_direct") return "group-direct";
  return conversation.type;
};

const navigationIcon = (
  name: NavigationIconName,
  className = "handrail-chat__navigation-icon",
): ReactElement => {
  const paths = name === "public-channel"
    ? [
        createElement("path", { d: "M10 3 8 21", key: "vertical-left" }),
        createElement("path", { d: "m16 3-2 18", key: "vertical-right" }),
        createElement("path", { d: "M4 9h16", key: "horizontal-top" }),
        createElement("path", { d: "M3 15h16", key: "horizontal-bottom" }),
      ]
    : name === "private-channel"
      ? [
          createElement("rect", {
            height: 10,
            key: "body",
            rx: 2,
            width: 14,
            x: 5,
            y: 11,
          }),
          createElement("path", {
            d: "M8 11V8a4 4 0 0 1 8 0v3",
            key: "shackle",
          }),
        ]
      : name === "direct"
        ? [
            createElement("circle", { cx: 12, cy: 8, key: "head", r: 4 }),
            createElement("path", {
              d: "M4 21a8 8 0 0 1 16 0",
              key: "shoulders",
            }),
          ]
        : name === "group-direct"
          ? [
              createElement("path", { d: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2", key: "front-body" }),
              createElement("circle", { cx: 9, cy: 7, key: "front-head", r: 4 }),
              createElement("path", { d: "M22 21v-2a4 4 0 0 0-3-3.87", key: "back-body" }),
              createElement("path", { d: "M16 3.13a4 4 0 0 1 0 7.75", key: "back-head" }),
            ]
          : name === "thread"
            ? [
                createElement("path", { d: "M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v8Z", key: "bubble" }),
                createElement("path", { d: "m9 8-3 3 3 3", key: "reply-arrow" }),
                createElement("path", { d: "M6 11h7a3 3 0 0 1 3 3", key: "reply-line" }),
              ]
            : name === "add"
              ? [
                  createElement("path", { d: "M12 5v14", key: "vertical" }),
                  createElement("path", { d: "M5 12h14", key: "horizontal" }),
                ]
              : name === "search"
                ? [
                    createElement("circle", { cx: 11, cy: 11, key: "lens", r: 7 }),
                    createElement("path", { d: "m20 20-4-4", key: "handle" }),
                  ]
                : name === "workspace-menu"
                ? [
                    createElement("circle", { cx: 5, cy: 12, key: "left", r: 1 }),
                    createElement("circle", { cx: 12, cy: 12, key: "center", r: 1 }),
                    createElement("circle", { cx: 19, cy: 12, key: "right", r: 1 }),
                  ]
                : name === "settings"
                  ? [
                      createElement("circle", { cx: 12, cy: 12, key: "center", r: 3 }),
                      createElement("path", {
                        d: "M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-4v-.08A1.7 1.7 0 0 0 8.94 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.57 15 1.7 1.7 0 0 0 3 14H3v-4h.08A1.7 1.7 0 0 0 4.6 8.94a1.7 1.7 0 0 0-.34-1.88L4.2 7l2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.57 1.7 1.7 0 0 0 10 3h4v.08A1.7 1.7 0 0 0 15.06 4.6a1.7 1.7 0 0 0 1.88-.34L17 4.2 19.83 7l-.06.06A1.7 1.7 0 0 0 19.43 9 1.7 1.7 0 0 0 21 10h.08v4H21a1.7 1.7 0 0 0-1.6 1Z",
                        key: "gear",
                      }),
                    ]
                  : [createElement("path", { d: "m9 18 6-6-6-6", key: "chevron" })];

  return createElement(
    "svg",
    {
      "aria-hidden": true,
      className,
      "data-navigation-icon": name,
      fill: "none",
      focusable: "false",
      stroke: "currentColor",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      strokeWidth: 2,
      viewBox: "0 0 24 24",
    },
    ...paths,
  );
};

const CONVERSATION_NAVIGATION_SECTIONS = Object.freeze([
  Object.freeze({
    emptyCopy: "No starred conversations yet.",
    kind: "starred",
    label: "Starred",
  }),
  Object.freeze({
    emptyCopy: "No direct messages yet.",
    kind: "direct-messages",
    label: "Direct messages",
  }),
  Object.freeze({
    emptyCopy: "No public channels yet.",
    kind: "public-channels",
    label: "Public channels",
  }),
  Object.freeze({
    emptyCopy: "No private channels yet.",
    kind: "private-channels",
    label: "Private channels",
  }),
  Object.freeze({
    emptyCopy: "No group conversations yet.",
    kind: "group-conversations",
    label: "Group conversations",
  }),
  Object.freeze({
    emptyCopy: "No recent threads. Browse a channel to find threads.",
    kind: "threads",
    label: "Recent threads",
  }),
] as const);

type ConversationNavigationSectionKind =
  (typeof CONVERSATION_NAVIGATION_SECTIONS)[number]["kind"];

interface ConversationNavigationModelRow {
  readonly conversation: ConversationListQueryConversation;
  readonly identity: string;
}

interface ConversationNavigationSection {
  readonly emptyCopy: string;
  readonly kind: ConversationNavigationSectionKind;
  readonly label: string;
  readonly rows: readonly ConversationNavigationModelRow[];
}

interface ConversationNavigationModel {
  readonly conversations: readonly ConversationListQueryConversation[];
  readonly sections: readonly ConversationNavigationSection[];
}

const conversationNavigationSectionKind = (
  conversation: Conversation,
): ConversationNavigationSectionKind => {
  const kind = conversationNavigationKind(conversation);
  if (kind === "public-channel") return "public-channels";
  if (kind === "private-channel") return "private-channels";
  if (kind === "group-direct") return "group-conversations";
  if (kind === "thread") return "threads";
  return "direct-messages";
};

const projectConversationNavigation = (
  conversations: readonly ConversationListQueryConversation[],
  starredConversationIds: ReadonlySet<ConversationId>,
  retainEmptySections = false,
): ConversationNavigationModel => {
  const buckets = new Map<
    ConversationNavigationSectionKind,
    ConversationListQueryConversation[]
  >(
    CONVERSATION_NAVIGATION_SECTIONS.map(({ kind }) => [kind, []]),
  );
  for (const conversation of conversations) {
    if (starredConversationIds.has(conversation.id)) {
      buckets.get("starred")?.push(conversation);
      continue;
    }
    buckets.get(conversationNavigationSectionKind(conversation))?.push(conversation);
  }

  const sections = CONVERSATION_NAVIGATION_SECTIONS.flatMap(({
    emptyCopy,
    kind,
    label,
  }) => {
    const sectionConversations = buckets.get(kind) ?? [];
    if (
      sectionConversations.length === 0 &&
      (kind === "starred" || !retainEmptySections)
    ) {
      return [];
    }
    const rows = sectionConversations.map((conversation) => Object.freeze({
      conversation,
      identity: `${kind}:${conversation.id}`,
    }));
    return [Object.freeze({
      emptyCopy,
      kind,
      label,
      rows: Object.freeze(rows),
    })];
  });
  const visualOrder = sections.flatMap(({ rows }) =>
    rows.map(({ conversation }) => conversation));

  return Object.freeze({
    conversations: Object.freeze(visualOrder),
    sections: Object.freeze(sections),
  });
};

interface ConversationNavigationRowProps {
  readonly buttonRef: (element: HTMLButtonElement | null) => void;
  readonly conversation: ConversationListQueryConversation;
  readonly currentUserId?: UserId;
  readonly index: number;
  readonly onKeyDown: (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => void;
  readonly onSelect: (conversationId: ConversationId) => void;
  readonly readOnly: boolean;
  readonly rowIdentity: string;
  readonly selected: boolean;
  readonly tabIndex: number;
}

const ConversationNavigationRow = ({
  buttonRef,
  conversation,
  currentUserId,
  index,
  onKeyDown,
  onSelect,
  readOnly,
  rowIdentity,
  selected,
  tabIndex,
}: ConversationNavigationRowProps): ReactElement => {
  const buttonId = useId();
  const readStateResult = useReadState(conversation.id);
  const unreadCount = readStateResult.data?.unreadCount;
  const unreadMentionCount = readStateResult.data?.unreadMentionCount;
  const hasUnread = unreadCount !== undefined && unreadCount > 0;
  const hasUnreadMentions = unreadMentionCount !== undefined && unreadMentionCount > 0;
  const preferenceSelector = useMemo<ChatWorkspacePreferenceSelector>(
    () => (state) => state.currentUser.preferences[conversation.id],
    [conversation.id],
  );
  const preference = useChatSelector(preferenceSelector);
  const preferencePendingSelector = useMemo<ChatWorkspacePreferencePendingSelector>(
    () => (state) =>
      state.currentUser.pendingPreferenceUpdates[conversation.id] !== undefined,
    [conversation.id],
  );
  const preferenceMutationPending = useChatSelector(preferencePendingSelector);
  const actions = useChatActions(conversation.id);
  const [starPending, setStarPending] = useState(false);
  const [starError, setStarError] = useState<string>();
  const starPendingRef = useRef(false);
  const rowMountedRef = useRef(true);
  const notificationLevel = preference?.notificationPreference ?? "all";
  const isStarred = preference?.isStarred ?? false;
  const muteState = conversationNavigationMuteState(preference);
  const muted = muteState !== "unmuted";
  const preferenceLabel = [
    conversationNavigationNotificationLabel(notificationLevel),
    conversationNavigationMuteLabel(preference),
  ].join("; ");
  const kind = conversationNavigationKind(conversation);
  const participantResult = useConversationParticipants(conversation.id, {
    enabled: kind === "direct" || kind === "group-direct",
  });
  const otherParticipants = (participantResult.data?.participants ?? []).filter(
    ({ userId }) => userId !== currentUserId,
  );
  const directParticipant = kind === "direct" ? otherParticipants[0] : undefined;
  const groupParticipants = kind === "group-direct" ? otherParticipants : [];
  const hasParticipantProjection = participantResult.data !== undefined;
  const label = kind === "direct"
    ? directParticipant === undefined
      ? hasParticipantProjection ? "Unknown participant" : conversationLabel(conversation)
      : groupDirectParticipantLabel(directParticipant.user)
    : kind === "group-direct"
      ? groupParticipants.length === 0
        ? hasParticipantProjection ? "Unknown participant" : conversationLabel(conversation)
        : groupParticipants.map(({ user }) => groupDirectParticipantLabel(user)).join(", ")
      : conversationLabel(conversation);
  const identityLabel = kind === "direct" && directParticipant !== undefined
    ? navigationParticipantAccessibleLabel(directParticipant.user)
    : kind === "group-direct" && groupParticipants.length > 0
      ? groupParticipants
          .map(({ user }) => navigationParticipantAccessibleLabel(user))
          .join(", ")
      : label;
  const unreadLabels = [
    hasUnread
      ? `${unreadCount} unread ${unreadCount === 1 ? "message" : "messages"}`
      : undefined,
    hasUnreadMentions
      ? `${unreadMentionCount} unread ${unreadMentionCount === 1 ? "mention" : "mentions"}`
      : undefined,
  ].filter((value): value is string => value !== undefined);
  const accessibleLabel = [
    identityLabel,
    ...unreadLabels,
    conversation.hasActiveHuddle ? "Active huddle" : undefined,
    `Notifications: ${preferenceLabel}`,
  ].filter((value): value is string => value !== undefined).join(", ");
  const visibleGroupParticipants = groupParticipants.slice(
    0,
    GROUP_DIRECT_VISIBLE_AVATAR_COUNT,
  );
  const hiddenGroupParticipantCount = Math.max(
    0,
    groupParticipants.length - visibleGroupParticipants.length,
  );
  const starDisabled = readOnly || preferenceMutationPending || starPending;
  const toggleStar = useCallback(async (
    event: ReactMouseEvent<HTMLButtonElement>,
  ): Promise<void> => {
    event.stopPropagation();
    if (readOnly || preferenceMutationPending || starPendingRef.current) return;

    const desiredStarred = !isStarred;
    const authoritativePreference = preference ??
      DEFAULT_CONVERSATION_NAVIGATION_PREFERENCE;
    starPendingRef.current = true;
    setStarPending(true);
    setStarError(undefined);
    try {
      let result = await actions.updateConversationPreference({
        notificationPreference: authoritativePreference.notificationPreference,
        isStarred: desiredStarred,
        mute: authoritativePreference.mute,
      });
      if (
        result.status === "success" &&
        result.value.reconciliationStatus === "preference_revision_conflict"
      ) {
        const currentPreference = result.value.preference;
        if (currentPreference.isStarred === desiredStarred) return;
        result = await actions.updateConversationPreference({
          notificationPreference: currentPreference.notificationPreference,
          isStarred: desiredStarred,
          mute: currentPreference.mute,
        });
      }
      if (!rowMountedRef.current) return;
      if (result.status !== "success") {
        setStarError(conversationStarFailureMessage(
          result,
          desiredStarred,
          identityLabel,
        ));
      } else if (
        result.value.reconciliationStatus === "preference_revision_conflict"
      ) {
        setStarError(
          `Could not ${desiredStarred ? "star" : "unstar"} ${identityLabel} because preferences changed elsewhere. Review the current state, then retry.`,
        );
      }
    } catch {
      if (rowMountedRef.current) {
        setStarError(
          `Could not ${desiredStarred ? "star" : "unstar"} ${identityLabel}. Check your connection, then retry.`,
        );
      }
    } finally {
      starPendingRef.current = false;
      if (rowMountedRef.current) setStarPending(false);
    }
  }, [
    actions,
    identityLabel,
    isStarred,
    preference,
    preferenceMutationPending,
    readOnly,
  ]);

  useEffect(() => {
    rowMountedRef.current = true;
    return () => {
      rowMountedRef.current = false;
    };
  }, []);
  const leading = kind === "direct" && directParticipant !== undefined
    ? conversationNavigationAvatar(
        directParticipant.user,
        groupDirectParticipantLabel(directParticipant.user),
      )
    : kind === "group-direct" && groupParticipants.length > 0
      ? createElement(
          "span",
          {
            "aria-hidden": true,
            className: "handrail-chat__conversation-avatar-stack",
          },
          ...visibleGroupParticipants.map(({ user, userId }) =>
            conversationNavigationAvatar(user, groupDirectParticipantLabel(user), userId)),
          hiddenGroupParticipantCount === 0
            ? null
            : createElement(
                "span",
                {
                  className: "handrail-chat__conversation-avatar-overflow",
                  "data-overflow-count": hiddenGroupParticipantCount,
                  title: `${hiddenGroupParticipantCount} more participants`,
                },
                `+${hiddenGroupParticipantCount}`,
              ),
        )
      : createElement(
          "span",
          {
            "aria-hidden": true,
            className: [
              "handrail-chat__conversation-icon",
              `handrail-chat__conversation-icon--${kind}`,
            ].join(" "),
            "data-conversation-kind": kind,
          },
          navigationIcon(kind),
        );

  return createElement(
    "li",
    {
      className: "handrail-chat__conversation-item",
      "data-selected": selected ? "true" : "false",
    },
    createElement(
      "button",
      {
        "aria-current": selected ? "page" : undefined,
        "aria-label": accessibleLabel,
        className: [
          "handrail-chat__conversation-button",
          hasUnread || hasUnreadMentions
            ? "handrail-chat__conversation-button--unread"
            : undefined,
          hasUnreadMentions
            ? "handrail-chat__conversation-button--mentioned"
            : undefined,
        ].filter(Boolean).join(" "),
        "data-conversation-id": conversation.id,
        "data-conversation-kind": kind,
        "data-huddle-state": conversation.hasActiveHuddle ? "active" : "inactive",
        "data-mute-state": muteState,
        "data-muted": muted ? "true" : "false",
        ...(preference?.mute.muted === true &&
            preference.mute.mutedUntil !== undefined
          ? { "data-muted-until": preference.mute.mutedUntil }
          : {}),
        "data-notification-level": notificationLevel,
        "data-navigation-row-id": rowIdentity,
        ...(unreadMentionCount === undefined
          ? {}
          : { "data-unread-mention-count": unreadMentionCount }),
        onClick: () => onSelect(conversation.id),
        onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) =>
          onKeyDown(event, index),
        id: buttonId,
        ref: buttonRef,
        tabIndex,
        title: accessibleLabel,
        type: "button",
      },
      leading,
      createElement(
        "span",
        { className: "handrail-chat__conversation-label" },
        label,
      ),
      createElement(
        "span",
        { className: "handrail-chat__conversation-status" },
        muted
          ? createElement(
              "span",
              {
                "aria-hidden": true,
                className: "handrail-chat__conversation-muted-indicator",
                "data-mute-state": muteState,
                title: conversationNavigationMuteLabel(preference),
              },
              createElement(
                "svg",
                {
                  fill: "none",
                  focusable: "false",
                  stroke: "currentColor",
                  strokeLinecap: "round",
                  strokeLinejoin: "round",
                  strokeWidth: 2,
                  viewBox: "0 0 24 24",
                },
                createElement("path", {
                  d: "M18 8a6 6 0 0 0-9.33-5M6.26 6.26A6 6 0 0 0 6 8c0 7-3 7-3 9h14",
                }),
                createElement("path", { d: "M13.73 21a2 2 0 0 1-3.46 0" }),
                createElement("path", { d: "M4 4l16 16" }),
              ),
            )
          : null,
        conversation.hasActiveHuddle
          ? createElement(
              "span",
              {
                "aria-hidden": true,
                className: "handrail-chat__conversation-huddle-indicator",
                "data-huddle-state": "active",
              },
              createElement(
                "svg",
                {
                  fill: "none",
                  focusable: "false",
                  stroke: "currentColor",
                  strokeLinecap: "round",
                  strokeLinejoin: "round",
                  strokeWidth: 2,
                  viewBox: "0 0 24 24",
                },
                createElement("path", { d: "M4 13v-1a8 8 0 0 1 16 0v1" }),
                createElement("path", { d: "M6 12H5a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h2v-7Z" }),
                createElement("path", { d: "M18 12h1a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-2v-7Z" }),
              ),
            )
          : null,
        hasUnreadMentions
          ? createElement(
              "span",
              {
                "aria-hidden": true,
                className: "handrail-chat__conversation-mention-badge",
                "data-unread-mention-count": unreadMentionCount,
              },
              `@${unreadMentionCount > 99 ? "99+" : String(unreadMentionCount)}`,
            )
          : hasUnread
          ? createElement(
              "span",
              {
                "aria-hidden": true,
                className: "handrail-chat__conversation-unread-badge",
                "data-unread-count": unreadCount,
              },
              unreadCount > 99 ? "99+" : String(unreadCount),
            )
          : null,
      ),
    ),
    createElement(
      "button",
      {
        "aria-busy": starDisabled && !readOnly ? true : undefined,
        "aria-label": `${isStarred ? "Unstar" : "Star"} ${identityLabel}`,
        "aria-pressed": isStarred,
        className: "handrail-chat__conversation-star",
        disabled: starDisabled,
        onClick: toggleStar,
        onKeyDown: (event) => event.stopPropagation(),
        onPointerDown: (event) => event.stopPropagation(),
        title: `${isStarred ? "Unstar" : "Star"} ${identityLabel}`,
        type: "button",
      },
      createElement(
        "svg",
        {
          "aria-hidden": true,
          className: "handrail-chat__conversation-star-icon",
          focusable: "false",
          viewBox: "0 0 24 24",
        },
        createElement("path", {
          d: "m12 3 2.78 5.63 6.22.9-4.5 4.39 1.06 6.2L12 17.2l-5.56 2.92 1.06-6.2L3 9.53l6.22-.9L12 3Z",
        }),
      ),
    ),
    starError === undefined
      ? null
      : createElement(
          "span",
          {
            className: "handrail-chat__conversation-star-error",
            role: "alert",
          },
          starError,
        ),
  );
};

interface ConversationHeaderMenuProps {
  readonly conversationId: ConversationId;
  readonly identityLabel: string;
  readonly readOnly: boolean;
}

const ConversationHeaderMenu = ({
  conversationId,
  identityLabel,
  readOnly,
}: ConversationHeaderMenuProps): ReactElement => {
  const preferenceSelector = useMemo<ChatWorkspacePreferenceSelector>(
    () => (state) => state.currentUser.preferences[conversationId],
    [conversationId],
  );
  const preference = useChatSelector(preferenceSelector);
  const preferencePendingSelector = useMemo<ChatWorkspacePreferencePendingSelector>(
    () => (state) =>
      state.currentUser.pendingPreferenceUpdates[conversationId] !== undefined,
    [conversationId],
  );
  const preferenceMutationPending = useChatSelector(preferencePendingSelector);
  const actions = useChatActions(conversationId);
  const [open, setOpen] = useState(false);
  const [starPending, setStarPending] = useState(false);
  const [starError, setStarError] = useState<string>();
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const itemRef = useRef<HTMLButtonElement | null>(null);
  const starPendingRef = useRef(false);
  const mountedRef = useRef(true);
  const focusItemOnOpenRef = useRef(false);
  const isStarred = preference?.isStarred ?? false;
  const starDisabled = readOnly || preferenceMutationPending || starPending;

  const closeMenu = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const openMenu = useCallback(() => {
    focusItemOnOpenRef.current = true;
    setOpen(true);
  }, []);

  useEffect(() => {
    if (!open || !focusItemOnOpenRef.current) return;
    focusItemOnOpenRef.current = false;
    itemRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const ownerDocument = rootRef.current?.ownerDocument;
    const onPointerDown = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && !rootRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    ownerDocument?.addEventListener("pointerdown", onPointerDown);
    return () => ownerDocument?.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const toggleStar = useCallback(async (): Promise<void> => {
    if (readOnly || preferenceMutationPending || starPendingRef.current) return;

    const desiredStarred = !isStarred;
    const authoritativePreference = preference ??
      DEFAULT_CONVERSATION_NAVIGATION_PREFERENCE;
    closeMenu(true);
    starPendingRef.current = true;
    setStarPending(true);
    setStarError(undefined);
    try {
      let result = await actions.updateConversationPreference({
        notificationPreference: authoritativePreference.notificationPreference,
        isStarred: desiredStarred,
        mute: authoritativePreference.mute,
      });
      if (
        result.status === "success" &&
        result.value.reconciliationStatus === "preference_revision_conflict"
      ) {
        const currentPreference = result.value.preference;
        if (currentPreference.isStarred === desiredStarred) return;
        result = await actions.updateConversationPreference({
          notificationPreference: currentPreference.notificationPreference,
          isStarred: desiredStarred,
          mute: currentPreference.mute,
        });
      }
      if (!mountedRef.current) return;
      if (result.status !== "success") {
        setStarError(conversationStarFailureMessage(
          result,
          desiredStarred,
          identityLabel,
        ));
      } else if (
        result.value.reconciliationStatus === "preference_revision_conflict"
      ) {
        setStarError(
          `Could not ${desiredStarred ? "star" : "unstar"} ${identityLabel} because preferences changed elsewhere. Review the current state, then retry.`,
        );
      }
    } catch {
      if (mountedRef.current) {
        setStarError(
          `Could not ${desiredStarred ? "star" : "unstar"} ${identityLabel}. Check your connection, then retry.`,
        );
      }
    } finally {
      starPendingRef.current = false;
      if (mountedRef.current) setStarPending(false);
    }
  }, [
    actions,
    closeMenu,
    identityLabel,
    isStarred,
    preference,
    preferenceMutationPending,
    readOnly,
  ]);

  return createElement(
    "div",
    {
      className: "handrail-chat__conversation-header-menu-root",
      ref: rootRef,
    },
    createElement(
      "button",
      {
        "aria-controls": menuId,
        "aria-expanded": open,
        "aria-haspopup": "menu",
        "aria-label": `More actions for ${identityLabel}`,
        className: "handrail-chat__conversation-header-menu-trigger",
        onClick: () => {
          if (open) closeMenu(false);
          else openMenu();
        },
        onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          openMenu();
        },
        ref: triggerRef,
        title: `More actions for ${identityLabel}`,
        type: "button",
      },
      createElement(
        "svg",
        {
          "aria-hidden": true,
          className: "handrail-chat__conversation-header-menu-icon",
          focusable: "false",
          viewBox: "0 0 24 24",
        },
        createElement("circle", { cx: 12, cy: 5, r: 1.5 }),
        createElement("circle", { cx: 12, cy: 12, r: 1.5 }),
        createElement("circle", { cx: 12, cy: 19, r: 1.5 }),
      ),
    ),
    !open
      ? null
      : createElement(
          "div",
          {
            "aria-label": `Conversation actions for ${identityLabel}`,
            className: "handrail-chat__conversation-header-menu",
            id: menuId,
            onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                closeMenu(true);
                return;
              }
              if (event.key === "Tab") {
                setOpen(false);
                return;
              }
              if (
                event.key === "ArrowDown" ||
                event.key === "ArrowUp" ||
                event.key === "Home" ||
                event.key === "End"
              ) {
                event.preventDefault();
                itemRef.current?.focus();
              }
            },
            role: "menu",
          },
          createElement(
            "button",
            {
              "aria-busy": starDisabled && !readOnly ? true : undefined,
              className: "handrail-chat__conversation-header-menu-item",
              disabled: starDisabled,
              onClick: () => { void toggleStar(); },
              ref: itemRef,
              role: "menuitem",
              tabIndex: -1,
              type: "button",
            },
            isStarred ? "Unstar conversation" : "Star conversation",
          ),
        ),
    starError === undefined
      ? null
      : createElement(
          "span",
          {
            className: "handrail-chat__conversation-header-menu-error",
            role: "alert",
          },
          starError,
        ),
  );
};

const toViewModel = (
  conversation: Conversation,
): ChatConversationViewModel => {
  const { tenantId: _tenantId, ...viewModel } = conversation;
  return Object.freeze(viewModel) as ChatConversationViewModel;
};

const DefaultChannelHeader = ({
  conversation,
  hostProps,
}: ChatChannelHeaderSlotProps) => {
  const channel = conversation.type === "channel" ? conversation : undefined;
  return createElement(
    "div",
    {
      ...hostProps,
      className: ["handrail-chat__channel-header", hostProps.className]
        .filter(Boolean)
        .join(" "),
      ...(channel === undefined
        ? {}
        : { "data-channel-visibility": channel.visibility }),
    },
    channel === undefined
      ? null
      : createElement(
          "span",
          {
            "aria-label": channel.visibility === "private"
              ? "Private channel"
              : "Public channel",
            className: [
              "handrail-chat__channel-glyph",
              `handrail-chat__channel-glyph--${channel.visibility}`,
            ].join(" "),
            role: "img",
          },
          navigationIcon(
            channel.visibility === "private" ? "private-channel" : "public-channel",
            "handrail-chat__channel-glyph-icon handrail-chat__navigation-icon",
          ),
        ),
    createElement(
      "h2",
      { className: "handrail-chat__channel-title" },
      conversationLabel(conversation as Conversation),
    ),
  );
};

const DefaultWorkspaceHeader = ({
  identity,
  controls,
  hostProps,
}: ChatWorkspaceHeaderSlotProps) => createElement(
  "div",
  {
    ...hostProps,
    className: ["handrail-chat__navigation-header", hostProps.className]
      .filter(Boolean)
      .join(" "),
    ...(identity?.id === undefined ? {} : { "data-workspace-id": identity.id }),
  },
  createElement(
    "div",
    {
      className: "handrail-chat__workspace-identity",
      style: { minInlineSize: 0 },
    },
    createElement(
      "h2",
      {
        className: "handrail-chat__navigation-title",
        style: {
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        },
        ...(identity === undefined ? {} : { title: identity.name }),
      },
      identity?.name ?? "Conversations",
    ),
    identity?.description === undefined
      ? null
      : createElement(
          "span",
          {
            className: "handrail-chat__workspace-description",
            style: {
              display: "block",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            },
            title: identity.description,
          },
          identity.description,
        ),
  ),
  createElement(
    "div",
    { className: "handrail-chat__navigation-actions" },
    controls.menu,
    controls.settings,
    controls.createConversation,
  ),
);

const DefaultUser = ({ user, hostProps }: ChatUserSlotProps) => createElement(
  "span",
  {
    ...hostProps,
    className: ["handrail-chat__user", hostProps.className].filter(Boolean).join(" "),
  },
  user.kind === "active"
    ? user.displayName
    : user.kind === "redacted"
      ? "Hidden user"
      : "Unknown user",
);

const DEFAULT_CHAT_WORKSPACE_SLOTS = Object.freeze({
  WorkspaceHeader: DefaultWorkspaceHeader,
  Avatar: DefaultMessageTimelineAvatar,
  Message: DefaultMessageRenderer,
  ChannelHeader: DefaultChannelHeader,
  Composer: DefaultMessageComposerRenderer,
  EmptyState: DefaultMessageTimelineEmptyState,
  Attachment: DefaultAttachmentRenderer,
  LinkPreview: DefaultLinkPreviewRenderer,
  SystemEvent: DefaultSystemEventRenderer,
  User: DefaultUser,
  EntityReference: DefaultEntityReferenceRenderer,
}) satisfies ChatWorkspaceSlots;

const statusRegion = (message: string): ReactElement => createElement(
  "div",
  {
    className: "handrail-chat__status",
    role: "status",
    "aria-live": "polite",
  },
  message,
);

const errorRegion = (message: string): ReactElement => createElement(
  "div",
  { className: "handrail-chat__error", role: "alert" },
  message,
);

type ChatWorkspaceDetailStateKind =
  | "workspace-loading"
  | "conversation-selecting"
  | "conversation-loading"
  | "workspace-error"
  | "conversation-error";

const detailStateRegion = (
  kind: ChatWorkspaceDetailStateKind,
  title: string,
  description?: string,
): ReactElement => {
  const error = kind.endsWith("-error");
  const loading = !error;
  return createElement(
    "section",
    {
      "aria-busy": loading ? true : undefined,
      "aria-live": error ? "assertive" : "polite",
      className: [
        "handrail-chat__state-panel",
        error
          ? "handrail-chat__state-panel--error"
          : "handrail-chat__state-panel--loading",
      ].join(" "),
      "data-state-kind": kind,
      role: error ? "alert" : "status",
    },
    error
      ? createElement(
          "span",
          { "aria-hidden": true, className: "handrail-chat__state-panel-visual" },
          "!",
        )
      : createElement(
          "span",
          {
            "aria-hidden": true,
            className:
              "handrail-chat__state-panel-visual handrail-chat__state-panel-progress",
          },
          ...[0, 1, 2].map((index) => createElement(
            "span",
            { className: "handrail-chat__state-panel-progress-dot", key: index },
          )),
        ),
    createElement("h2", { className: "handrail-chat__state-panel-title" }, title),
    description === undefined
      ? null
      : createElement(
          "p",
          { className: "handrail-chat__state-panel-description" },
          description,
        ),
  );
};

interface ForwardDestination {
  readonly id: ConversationId;
  readonly label: string;
}

interface ActiveForwardRequest {
  readonly returnFocusTarget: HTMLElement | null;
  readonly source: MessageForwardRequest;
}

interface ForwardNotice {
  readonly kind: "status" | "error";
  readonly message: string;
}

interface RenderedWorkspaceTarget {
  readonly conversationId: ConversationId;
  readonly messageId?: MessageId;
}

interface ForwardMessageDialogProps {
  readonly destinations: readonly ForwardDestination[];
  readonly onCancel: () => void;
  readonly onFailure: () => void;
  readonly onSuccess: (
    destinationConversationId: ConversationId,
    messageId: MessageId,
  ) => Promise<void>;
  readonly source: MessageForwardRequest;
}

const ForwardMessageDialog = ({
  destinations,
  onCancel,
  onFailure,
  onSuccess,
  source,
}: ForwardMessageDialogProps): ReactElement => {
  const [selectedDestinationId, setSelectedDestinationId] = useState<ConversationId>(
    destinations[0]?.id ?? EMPTY_CONVERSATION_ID,
  );
  const [pending, setPending] = useState(false);
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const choiceRefs = useRef(new Map<ConversationId, HTMLInputElement>());
  const actions = useChatActions(selectedDestinationId);
  const selectedDestination = destinations.find(({ id }) => id === selectedDestinationId);

  useEffect(() => {
    if (destinations.some(({ id }) => id === selectedDestinationId)) return;
    setSelectedDestinationId(destinations[0]?.id ?? EMPTY_CONVERSATION_ID);
  }, [destinations, selectedDestinationId]);

  const moveChoice = useCallback((
    event: KeyboardEvent<HTMLInputElement>,
    index: number,
  ) => {
    let nextIndex: number | undefined;
    switch (event.key) {
      case "ArrowDown":
      case "ArrowRight":
        nextIndex = (index + 1) % destinations.length;
        break;
      case "ArrowUp":
      case "ArrowLeft":
        nextIndex = (index - 1 + destinations.length) % destinations.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = destinations.length - 1;
        break;
      default:
        return;
    }
    const destination = destinations[nextIndex];
    if (destination === undefined) return;
    event.preventDefault();
    setSelectedDestinationId(destination.id);
    choiceRefs.current.get(destination.id)?.focus();
  }, [destinations]);

  const submit = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending || selectedDestination === undefined) return;
    setPending(true);
    try {
      const result = await actions.forwardMessage(source.sourceMessageId);
      if (result.status !== "success") {
        onFailure();
        return;
      }
      await onSuccess(
        result.value.destinationConversationId,
        result.value.message.id,
      );
    } catch {
      onFailure();
    }
  }, [actions, onFailure, onSuccess, pending, selectedDestination, source.sourceMessageId]);

  const containFocus = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (dialog === null) return;
    const focusable = [...dialog.querySelectorAll<HTMLElement>("button, input")]
      .filter((element) =>
        !element.matches(":disabled") &&
        element.tabIndex >= 0 &&
        (element.tagName !== "INPUT" ||
          (element as HTMLInputElement).type !== "radio" ||
          (element as HTMLInputElement).checked),
      );
    event.preventDefault();
    if (focusable.length === 0) {
      dialog.focus();
      return;
    }
    const activeIndex = focusable.indexOf(dialog.ownerDocument.activeElement as HTMLElement);
    const nextIndex = event.shiftKey
      ? activeIndex <= 0 ? focusable.length - 1 : activeIndex - 1
      : activeIndex < 0 || activeIndex === focusable.length - 1 ? 0 : activeIndex + 1;
    focusable[nextIndex]?.focus();
  }, []);

  return createElement(
    "div",
    {
      "aria-labelledby": titleId,
      "aria-modal": true,
      className: "handrail-chat__forward-dialog",
      onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key === "Tab") {
          containFocus(event);
          return;
        }
        if (event.key === "Escape" && !pending) {
          event.preventDefault();
          onCancel();
        }
      },
      ref: dialogRef,
      role: "dialog",
      tabIndex: -1,
    },
    createElement(
      "form",
      {
        className: "handrail-chat__forward-form",
        onSubmit: (event: FormEvent<HTMLFormElement>) => { void submit(event); },
      },
      createElement("h3", { id: titleId }, "Forward message"),
      createElement(
        "p",
        { className: "handrail-chat__forward-preview" },
        createElement("strong", null, "Message: "),
        createElement("q", null, source.preview),
      ),
      createElement(
        "fieldset",
        { className: "handrail-chat__forward-destinations", disabled: pending },
        createElement("legend", null, "Choose a destination"),
        ...destinations.map((destination, index) => createElement(
          "label",
          { className: "handrail-chat__forward-choice", key: destination.id },
          createElement("input", {
            autoFocus: index === 0,
            checked: selectedDestinationId === destination.id,
            disabled: pending,
            name: "forwardDestination",
            onChange: () => setSelectedDestinationId(destination.id),
            onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => moveChoice(event, index),
            ref: (element: HTMLInputElement | null) => {
              if (element === null) choiceRefs.current.delete(destination.id);
              else choiceRefs.current.set(destination.id, element);
            },
            type: "radio",
            value: destination.id,
          }),
          destination.label,
        )),
      ),
      selectedDestination === undefined
        ? null
        : createElement(
            "p",
            { className: "handrail-chat__forward-confirmation" },
            "Forward this message to ",
            createElement("strong", null, selectedDestination.label),
            "?",
          ),
      pending ? statusRegion("Forwarding message…") : null,
      createElement(
        "div",
        { className: "handrail-chat__forward-actions" },
        createElement(
          "button",
          {
            className: "handrail-chat__forward-action handrail-chat__forward-action--secondary",
            disabled: pending,
            onClick: onCancel,
            type: "button",
          },
          "Cancel",
        ),
        createElement(
          "button",
          {
            "aria-busy": pending ? true : undefined,
            className: "handrail-chat__forward-action handrail-chat__forward-action--primary",
            disabled: pending || selectedDestination === undefined,
            type: "submit",
          },
          pending ? "Forwarding…" : "Forward",
        ),
      ),
    ),
  );
};

const messageSearchHitKey = (hit: MessageSearchHit): string =>
  hit.type === "message"
    ? `message:${hit.messageId}`
    : `conversation:${hit.conversationId}`;

const toSearchTimestamp = (value: string): string | undefined => {
  if (value.length === 0) return undefined;
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.valueOf()) ? undefined : timestamp.toISOString();
};

interface MessageSearchNavigationNotice {
  readonly kind: "status" | "error";
  readonly message: string;
  readonly retryResult?: MessageSearchHit;
}

interface MessageSearchResultsProps {
  readonly filters?: MessageSearchFilters;
  readonly onActivate: (result: MessageSearchHit) => Promise<void>;
  readonly onInitialRetry: () => void;
  readonly query: string;
}

const MessageSearchResults = ({
  filters,
  onActivate,
  onInitialRetry,
  query,
}: MessageSearchResultsProps): ReactElement => {
  const result = useMessageSearch(query, {
    ...(filters === undefined ? {} : { filters }),
    pageSize: 20,
  });
  const hits = result.data?.hits ?? [];
  const [activeIndex, setActiveIndex] = useState(0);
  const [activatingKey, setActivatingKey] = useState<string>();
  const resultRefs = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    setActiveIndex((current) => Math.max(0, Math.min(current, hits.length - 1)));
  }, [hits.length]);

  const moveResultFocus = useCallback((
    event: KeyboardEvent<HTMLButtonElement>,
    nextIndex: number,
  ) => {
    const next = hits[nextIndex];
    if (next === undefined) return;
    event.preventDefault();
    setActiveIndex(nextIndex);
    resultRefs.current.get(messageSearchHitKey(next))?.focus();
  }, [hits]);

  const onResultKeyDown = useCallback((
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    if (hits.length === 0) return;
    switch (event.key) {
      case "ArrowDown":
      case "ArrowRight":
        moveResultFocus(event, (index + 1) % hits.length);
        break;
      case "ArrowUp":
      case "ArrowLeft":
        moveResultFocus(event, (index - 1 + hits.length) % hits.length);
        break;
      case "Home":
        moveResultFocus(event, 0);
        break;
      case "End":
        moveResultFocus(event, hits.length - 1);
        break;
      default:
        break;
    }
  }, [hits.length, moveResultFocus]);

  const activate = useCallback(async (hit: MessageSearchHit): Promise<void> => {
    const key = messageSearchHitKey(hit);
    setActivatingKey(key);
    try {
      await onActivate(hit);
    } finally {
      setActivatingKey((current) => current === key ? undefined : current);
    }
  }, [onActivate]);

  if (query.trim().length === 0) {
    return createElement(
      "p",
      { className: "handrail-chat__message-search-empty" },
      "Enter a search term to find messages.",
    );
  }

  const initialLoading = result.status === "loading" && hits.length === 0;
  const initialError = result.status === "error" && hits.length === 0;
  const paginationError = result.status === "error" && hits.length > 0;
  const loadMore = result.data?.hasNextPage !== true
    ? null
    : createElement(
        "button",
        {
          "aria-busy": result.data.isLoadingMore ? true : undefined,
          className: "handrail-chat__message-search-load-more",
          disabled: result.data.isLoadingMore,
          onClick: () => {
            if (result.data?.isLoadingMore === true) return;
            void result.data?.loadNextPage();
          },
          type: "button",
        },
        result.data.isLoadingMore ? "Loading more results…" : "Load more results",
      );

  return createElement(
    "div",
    {
      "aria-busy": initialLoading || result.data?.isLoadingMore === true,
      className: "handrail-chat__message-search-results",
    },
    initialLoading ? statusRegion("Searching messages…") : null,
    initialError
      ? createElement(
          "div",
          { className: "handrail-chat__message-search-error", role: "alert" },
          createElement("p", null, result.error.message),
          result.error.retryable
            ? createElement(
                "button",
                { onClick: onInitialRetry, type: "button" },
                "Retry search",
              )
            : createElement("p", null, "Review the search and filters, then try again."),
        )
      : null,
    result.status === "empty" && !initialLoading
      ? createElement(
          "p",
          { className: "handrail-chat__message-search-empty", role: "status" },
          "No messages found.",
        )
      : null,
    hits.length === 0
      ? null
      : createElement(
          "ul",
          {
            "aria-label": "Message search results",
            className: "handrail-chat__message-search-list",
            role: "listbox",
          },
          ...hits.map((hit, index) => {
            const key = messageSearchHitKey(hit);
            const title = hit.title ?? "Conversation";
            const author = hit.type === "message"
              ? hit.authorDisplayName ?? "Unknown author"
              : undefined;
            return createElement(
              "li",
              { className: "handrail-chat__message-search-item", key, role: "presentation" },
              createElement(
                "button",
                {
                  "aria-busy": activatingKey === key ? true : undefined,
                  "aria-selected": activeIndex === index,
                  className: "handrail-chat__message-search-result",
                  disabled: activatingKey !== undefined,
                  onClick: () => { void activate(hit); },
                  onFocus: () => setActiveIndex(index),
                  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) =>
                    onResultKeyDown(event, index),
                  ref: (element: HTMLButtonElement | null) => {
                    if (element === null) resultRefs.current.delete(key);
                    else resultRefs.current.set(key, element);
                  },
                  role: "option",
                  tabIndex: activeIndex === index ? 0 : -1,
                  type: "button",
                },
                createElement("strong", null, title),
                author === undefined
                  ? null
                  : createElement("span", null, author),
                createElement("span", { className: "handrail-chat__message-search-snippet" }, hit.snippet),
                hit.type !== "message" || hit.sentAt === undefined
                  ? null
                  : createElement(
                      "time",
                      { dateTime: hit.sentAt },
                      new Date(hit.sentAt).toLocaleString(),
                    ),
              ),
            );
          }),
        ),
    result.data?.isLoadingMore === true
      ? statusRegion("Loading more message results…")
      : null,
    paginationError
      ? createElement(
          "div",
          { className: "handrail-chat__message-search-error", role: "alert" },
          createElement("p", null, `More results could not be loaded. ${result.error.message}`),
          result.error.retryable
            ? createElement(
                "button",
                { onClick: () => { void result.data?.loadNextPage(); }, type: "button" },
                "Retry loading more",
              )
            : null,
        )
      : null,
    paginationError ? null : loadMore,
  );
};

type PaneControlIconName = "back" | "close";

const paneControlIcon = (name: PaneControlIconName): ReactElement =>
  createElement(
    "svg",
    {
      "aria-hidden": true,
      className: "handrail-chat__pane-control-icon",
      "data-pane-control-icon": name,
      fill: "none",
      focusable: "false",
      stroke: "currentColor",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      strokeWidth: 2,
      viewBox: "0 0 24 24",
    },
    name === "back"
      ? createElement("path", { d: "m15 18-6-6 6-6" })
      : createElement("path", { d: "m6 6 12 12M18 6 6 18" }),
  );

interface MessageSearchPanelProps {
  readonly conversations: readonly Conversation[];
  readonly id: string;
  readonly navigationNotice?: MessageSearchNavigationNotice;
  readonly onActivate: (result: MessageSearchHit) => Promise<void>;
  readonly onClose: () => void;
  readonly onRetryNavigation: (result: MessageSearchHit) => Promise<void>;
  readonly selectedConversationId: ConversationId;
}

const MessageSearchPanel = ({
  conversations,
  id,
  navigationNotice,
  onActivate,
  onClose,
  onRetryNavigation,
  selectedConversationId,
}: MessageSearchPanelProps): ReactElement => {
  const [query, setQuery] = useState("");
  const [conversationId, setConversationId] = useState<string>(
    selectedConversationId,
  );
  const [authorUserId, setAuthorUserId] = useState("");
  const [sentAfter, setSentAfter] = useState("");
  const [sentBefore, setSentBefore] = useState("");
  const [retryRevision, setRetryRevision] = useState(0);
  const queryId = useId();
  const filtersId = useId();
  const conversationIdControl = useId();
  const authorIdControl = useId();
  const sentAfterId = useId();
  const sentBeforeId = useId();
  const queryRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    queryRef.current?.focus();
  }, []);
  useEffect(() => {
    setConversationId(selectedConversationId);
  }, [selectedConversationId]);
  const filters = useMemo<MessageSearchFilters | undefined>(() => {
    const normalizedAuthor = authorUserId.trim();
    const after = toSearchTimestamp(sentAfter);
    const before = toSearchTimestamp(sentBefore);
    if (conversationId.length === 0 && normalizedAuthor.length === 0 &&
        after === undefined && before === undefined) return undefined;
    return Object.freeze({
      ...(conversationId.length === 0
        ? {}
        : { conversationIds: Object.freeze([conversationId as ConversationId]) }),
      ...(normalizedAuthor.length === 0
        ? {}
        : { authorUserIds: Object.freeze([normalizedAuthor as UserId]) }),
      ...(after === undefined ? {} : { sentAfter: after }),
      ...(before === undefined ? {} : { sentBefore: before }),
    });
  }, [authorUserId, conversationId, sentAfter, sentBefore]);

  return createElement(
    "section",
    {
      "aria-label": "Message search",
      className: "handrail-chat__message-search",
      id,
      onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      },
    },
    createElement(
      "div",
      { className: "handrail-chat__message-search-header" },
      createElement("strong", null, "Message search"),
      createElement(
        "button",
        {
          "aria-label": "Close message search",
          className: "handrail-chat__message-search-close",
          onClick: onClose,
          type: "button",
        },
        paneControlIcon("close"),
      ),
    ),
    createElement("label", { htmlFor: queryId }, "Search messages"),
    createElement("input", {
      autoComplete: "off",
      autoFocus: true,
      id: queryId,
      name: "messageSearchQuery",
      onInput: (event: FormEvent<HTMLInputElement>) => setQuery(event.currentTarget.value),
      placeholder: "Search message text",
      ref: queryRef,
      type: "search",
      value: query,
    }),
    createElement(
      "details",
      { className: "handrail-chat__message-search-filters", id: filtersId },
      createElement("summary", null, "Search filters"),
      createElement("label", { htmlFor: conversationIdControl }, "Conversation"),
      createElement(
        "select",
        {
          id: conversationIdControl,
          name: "messageSearchConversation",
          onChange: (event: FormEvent<HTMLSelectElement>) =>
            setConversationId(event.currentTarget.value),
          value: conversationId,
        },
        createElement("option", { value: "" }, "All conversations"),
        ...conversations.map((item) => createElement(
          "option",
          { key: item.id, value: item.id },
          conversationLabel(item),
        )),
      ),
      createElement("label", { htmlFor: authorIdControl }, "Author user ID"),
      createElement("input", {
        id: authorIdControl,
        name: "messageSearchAuthor",
        onInput: (event: FormEvent<HTMLInputElement>) =>
          setAuthorUserId(event.currentTarget.value),
        type: "text",
        value: authorUserId,
      }),
      createElement("label", { htmlFor: sentAfterId }, "Sent after"),
      createElement("input", {
        id: sentAfterId,
        name: "messageSearchSentAfter",
        onInput: (event: FormEvent<HTMLInputElement>) => setSentAfter(event.currentTarget.value),
        type: "datetime-local",
        value: sentAfter,
      }),
      createElement("label", { htmlFor: sentBeforeId }, "Sent before"),
      createElement("input", {
        id: sentBeforeId,
        name: "messageSearchSentBefore",
        onInput: (event: FormEvent<HTMLInputElement>) => setSentBefore(event.currentTarget.value),
        type: "datetime-local",
        value: sentBefore,
      }),
    ),
    query.trim().length === 0
      ? createElement(
          "p",
          { className: "handrail-chat__message-search-empty" },
          "Enter a search term to find messages.",
        )
      : createElement(MessageSearchResults, {
          ...(filters === undefined ? {} : { filters }),
          key: retryRevision,
          onActivate,
          onInitialRetry: () => setRetryRevision((current) => current + 1),
          query,
        }),
    navigationNotice === undefined
      ? null
      : createElement(
          "div",
          {
            className: navigationNotice.kind === "error"
              ? "handrail-chat__message-search-error"
              : "handrail-chat__message-search-navigation-status",
            role: navigationNotice.kind === "error" ? "alert" : "status",
          },
          navigationNotice.message,
          navigationNotice.retryResult === undefined
            ? null
            : createElement(
                "button",
                {
                  onClick: () => { void onRetryNavigation(navigationNotice.retryResult as MessageSearchHit); },
                  type: "button",
                },
                "Try opening result again",
              ),
        ),
  );
};

/**
 * Browser-safe layout orchestration built only on public React hooks and UI
 * contracts. Modal mode is a root-local layout; this component never portals.
 */
export function ChatWorkspace(props: ChatWorkspaceProps): ReactElement {
  const mode = props.mode ?? "full-screen";
  const chat = useChat();
  const [replyStyleSettingsOpen, setReplyStyleSettingsOpen] = useState(false);
  const workspaceIdentity = useMemo<ChatWorkspaceIdentityViewModel | undefined>(
    () => props.workspaceIdentity === undefined
      ? undefined
      : Object.freeze({
          ...(props.workspaceIdentity.id === undefined
            ? {}
            : { id: props.workspaceIdentity.id }),
          name: props.workspaceIdentity.name,
          ...(props.workspaceIdentity.description === undefined
            ? {}
            : { description: props.workspaceIdentity.description }),
        }),
    [props.workspaceIdentity],
  );
  const reactionKeys = useMemo(
    () => resolveReactionKeys(props.reactionKeys),
    [props.reactionKeys],
  );
  const listResult = useConversations({ scope: props.scope });
  const listData = listResult.data;
  const latestConversationListDataRef = useRef(listData);
  latestConversationListDataRef.current = listData;
  const pendingConversationPageRequestRef = useRef<{
    readonly loadMore: () => Promise<void>;
    readonly request: Promise<void>;
  } | undefined>(undefined);
  const requestMoreConversations = useCallback(() => {
    const current = latestConversationListDataRef.current;
    if (
      current?.nextCursor === undefined ||
      current.isLoadingMore ||
      pendingConversationPageRequestRef.current?.loadMore === current.loadMore
    ) {
      return;
    }

    const request = current.loadMore();
    const pending = Object.freeze({ loadMore: current.loadMore, request });
    pendingConversationPageRequestRef.current = pending;
    void request.then(
      () => {
        if (pendingConversationPageRequestRef.current === pending) {
          pendingConversationPageRequestRef.current = undefined;
        }
      },
      () => {
        if (pendingConversationPageRequestRef.current === pending) {
          pendingConversationPageRequestRef.current = undefined;
        }
      },
    );
  }, []);
  const listedConversations = listResult.data?.conversations ?? [];
  const cachedConversations = useChatSelector(state => state.entities.conversations);
  const [createdNavigationConversation, setCreatedNavigationConversation] = useState<
    ConversationListQueryConversation | undefined
  >();
  // Top-level snapshots deliberately exclude threads. Keep canonical threads
  // encountered this session in navigation, scoped to visible parents. Discovery
  // remains the authoritative way to browse all of a channel's threads.
  const conversations = useMemo<readonly ConversationListQueryConversation[]>(
    () => {
      const listed = createdNavigationConversation === undefined ||
        listedConversations.some(({ id }) => id === createdNavigationConversation.id)
      ? listedConversations
      : [createdNavigationConversation, ...listedConversations];
      const listedIds = new Set(listed.map(({ id }) => id));
      const recentThreads = Object.values(cachedConversations).flatMap(conversation => {
        if (conversation.type !== "thread" || listedIds.has(conversation.id) ||
            conversation.archivedAt !== undefined || !listedIds.has(conversation.parentConversationId)) return [];
        const parent = cachedConversations[conversation.parentConversationId];
        if (parent === undefined || parent.archivedAt !== undefined) return [];
        return [{ ...conversation, hasActiveHuddle: false }];
      });
      return recentThreads.length === 0 ? listed : Object.freeze([...listed, ...recentThreads]);
    },
    [cachedConversations, createdNavigationConversation, listedConversations],
  );
  const conversationPreferences = useChatSelector(selectConversationPreferences);
  const starredConversationIds = useMemo<ReadonlySet<ConversationId>>(
    () => new Set(conversations.flatMap(({ id }) =>
      conversationPreferences[id]?.isStarred === true ? [id] : [])),
    [conversationPreferences, conversations],
  );
  useEffect(() => {
    if (
      createdNavigationConversation === undefined ||
      !listedConversations.some(({ id }) => id === createdNavigationConversation.id)
    ) {
      return;
    }
    setCreatedNavigationConversation((current) =>
      current?.id === createdNavigationConversation.id ? undefined : current);
  }, [createdNavigationConversation, listedConversations]);
  const navigationModel = useMemo(
    () => projectConversationNavigation(conversations, starredConversationIds, true),
    [conversations, starredConversationIds],
  );
  const navigationConversations = navigationModel.conversations;
  const [conversationFilterQuery, setConversationFilterQuery] = useState("");
  const [collapsedNavigationSections, setCollapsedNavigationSections] = useState<
    ReadonlySet<ConversationNavigationSectionKind>
  >(() => new Set());
  const normalizedConversationFilterQuery = conversationFilterQuery
    .trim()
    .normalize("NFC")
    .toLocaleLowerCase();
  const conversationFilterActive = normalizedConversationFilterQuery.length > 0;
  const detailParticipantUserIds = useChatSelector(selectDetailParticipantUserIds);
  const listParticipantUserIds = useChatSelector(selectListParticipantUserIds);
  const participantUserIdsByConversation = useMemo(
    () => new Map(conversations.flatMap((conversation) => {
      if (conversation.type !== "direct" && conversation.type !== "group_direct") {
        return [];
      }
      const participantUserIds = detailParticipantUserIds[conversation.id] ??
        listParticipantUserIds[conversation.id];
      return participantUserIds === undefined
        ? []
        : [[conversation.id, participantUserIds] as const];
    })),
    [conversations, detailParticipantUserIds, listParticipantUserIds],
  );
  const conversationParticipantUserIds = useMemo<readonly UserId[]>(
    () => Object.freeze([...new Set(
      [...participantUserIdsByConversation.values()]
        .flat()
        .filter((userId) => userId !== props.currentUserId),
    )]),
    [participantUserIdsByConversation, props.currentUserId],
  );
  const participantDirectoryResult = useDirectoryUsers(
    conversationParticipantUserIds,
    { enabled: conversationFilterActive },
  );
  const participantSearchLabelsByConversation = useMemo(() => {
    const directoryUsersById = new Map(
      (participantDirectoryResult.data ?? []).map((user) => [user.userId, user]),
    );
    return new Map([...participantUserIdsByConversation].map(
      ([conversationId, participantUserIds]) => [
        conversationId,
        participantUserIds
          .filter((userId) => userId !== props.currentUserId)
          .map((userId) => groupDirectParticipantLabel(directoryUsersById.get(userId))),
      ] as const,
    ));
  }, [participantDirectoryResult.data, participantUserIdsByConversation, props.currentUserId]);
  const filteredNavigationModel = useMemo(
    () => projectConversationNavigation(
      !conversationFilterActive
        ? conversations
        : conversations.filter((conversation) => normalizedConversationSearchText(
            conversation,
            participantSearchLabelsByConversation.get(conversation.id) ?? [],
          ).includes(normalizedConversationFilterQuery)),
      starredConversationIds,
      !conversationFilterActive,
    ),
    [
      conversationFilterActive,
      conversations,
      normalizedConversationFilterQuery,
      participantSearchLabelsByConversation,
      starredConversationIds,
    ],
  );
  const filteredNavigationConversations = filteredNavigationModel.conversations;
  const visibleNavigationRows = useMemo(
    () => filteredNavigationModel.sections.flatMap((section) =>
      conversationFilterActive || !collapsedNavigationSections.has(section.kind)
        ? section.rows
        : []),
    [
      collapsedNavigationSections,
      conversationFilterActive,
      filteredNavigationModel.sections,
    ],
  );
  const visibleNavigationConversations = useMemo(
    () => visibleNavigationRows.map(({ conversation }) => conversation),
    [visibleNavigationRows],
  );
  const visibleNavigationIndexByIdentity = useMemo(
    () => new Map(visibleNavigationRows.map(({ identity }, index) => [
      identity,
      index,
    ])),
    [visibleNavigationRows],
  );
  const controlled = props.conversationId !== undefined;
  const [internalConversationId, setInternalConversationId] = useState<
    ConversationId | undefined
  >(() => props.defaultConversationId);
  const searchSelectedConversationIdRef = useRef<ConversationId | undefined>(undefined);
  const pendingCreatedConversationIdRef = useRef<ConversationId | undefined>(undefined);
  const rootRef = useRef<HTMLElement | null>(null);
  const modalLifecycleGenerationRef = useRef(0);
  const modalOpenerRef = useRef<HTMLElement | null>(null);
  const navigationRef = useRef<HTMLElement | null>(null);
  const pendingNavigationFocusIdentityRef = useRef<string | undefined>(undefined);
  const [navigationViewportMetrics, setNavigationViewportMetrics] = useState({
    offset: 0,
    height: CONVERSATION_NAVIGATION_DEFAULT_VIEWPORT_HEIGHT_PX,
  });
  const navigationWindowRows = useMemo<readonly TimelineWindowRow[]>(() =>
    Object.freeze(visibleNavigationRows.map(({ identity }) => Object.freeze({
      id: identity,
      estimatedHeight: CONVERSATION_NAVIGATION_ROW_ESTIMATED_HEIGHT_PX,
    }))), [visibleNavigationRows]);
  const navigationWindow = useMemo(() => calculateTimelineWindow({
    rows: navigationWindowRows,
    viewportOffset: navigationViewportMetrics.offset,
    viewportHeight: navigationViewportMetrics.height,
    overscan: CONVERSATION_NAVIGATION_OVERSCAN_PX,
  }), [navigationViewportMetrics, navigationWindowRows]);
  const mountedNavigationRowIdentities = useMemo(
    () => new Set(navigationWindow.mountedRowIds),
    [navigationWindow.mountedRowIds],
  );
  const mountedNavigationRowKey = navigationWindow.mountedRowIds.join("\u0000");
  const conversationLoadMoreSentinelRef = useRef<HTMLDivElement | null>(null);
  const conversationFilterInputRef = useRef<HTMLInputElement | null>(null);
  const pendingConversationFilterFocusRef = useRef(false);
  const conversationFilterShortcutRegistrationRef = useRef<
    ConversationFilterShortcutRegistration
  >({
    focusConversationFilter: () => false,
    root: null,
  });
  const [isCompactLayout, setIsCompactLayout] = useState(false);
  const [compactPane, setCompactPane] = useState<ChatWorkspaceCompactPane>("list");
  const compactLayoutRef = useRef(false);
  const searchNavigationGenerationRef = useRef(0);
  const [searchNavigationNotice, setSearchNavigationNotice] = useState<
    MessageSearchNavigationNotice | undefined
  >();
  const [forwardRequest, setForwardRequest] = useState<ActiveForwardRequest>();
  const [forwardNotice, setForwardNotice] = useState<ForwardNotice>();
  const [activeNavigationRowIdentity, setActiveNavigationRowIdentity] = useState<
    string | undefined
  >();
  const requestedConversationId = controlled
    ? props.conversationId ?? undefined
    : internalConversationId;
  const selectedConversationId = controlled || navigationConversations.length === 0
    ? requestedConversationId
    : requestedConversationId !== undefined && (
        navigationConversations.some(({ id }) => id === requestedConversationId) ||
        searchSelectedConversationIdRef.current === requestedConversationId ||
        pendingCreatedConversationIdRef.current === requestedConversationId
      )
      ? requestedConversationId
      : props.defaultConversationId !== undefined &&
          navigationConversations.some(({ id }) => id === props.defaultConversationId)
        ? props.defaultConversationId
        : navigationConversations[0]?.id;
  const activeNavigationRow = visibleNavigationRows.find(
    ({ identity: rowIdentity }) => rowIdentity === activeNavigationRowIdentity,
  );
  const selectedNavigationRow = visibleNavigationRows.find(
    ({ conversation }) => conversation.id === selectedConversationId,
  );
  const navigationTabStopRowIdentity =
    activeNavigationRow !== undefined &&
      activeNavigationRow.conversation.id === selectedConversationId
      ? activeNavigationRow.identity
      : selectedNavigationRow?.identity ?? visibleNavigationRows[0]?.identity;
  const mountedNavigationTabStopRowIdentity =
    navigationTabStopRowIdentity !== undefined &&
      mountedNavigationRowIdentities.has(navigationTabStopRowIdentity)
      ? navigationTabStopRowIdentity
      : navigationWindow.mountedRowIds[0];
  const selectedConversationIdRef = useRef(selectedConversationId);
  selectedConversationIdRef.current = selectedConversationId;

  useEffect(() => {
    if (!chat?.isReady || selectedConversationId === undefined) return;
    // useMessages loads missing timelines, but restored actor-local history can
    // predate confirmed sends. Refresh the actual selection, including the
    // workspace's automatic fallback, without waiting for a navigation click.
    if (chat.client.cache.getState().timelines[selectedConversationId] === undefined) return;
    const controller = new AbortController();
    void chat.client.getMessageTimeline({
      conversationId: selectedConversationId,
      direction: "backward",
      limit: 50,
    }, { signal: controller.signal });
    return () => controller.abort();
  }, [chat?.client, chat?.isReady, selectedConversationId]);

  const syncNavigationViewportMetrics = useCallback((navigation: HTMLElement): void => {
    const height = navigation.clientHeight > 0
      ? navigation.clientHeight
      : CONVERSATION_NAVIGATION_DEFAULT_VIEWPORT_HEIGHT_PX;
    const next = { offset: navigation.scrollTop, height };
    setNavigationViewportMetrics((current) =>
      current.offset === next.offset && current.height === next.height ? current : next);
  }, []);

  useLayoutEffect(() => {
    const navigation = navigationRef.current;
    if (navigation === null) return;
    syncNavigationViewportMetrics(navigation);
    const ResizeObserverConstructor =
      navigation.ownerDocument.defaultView?.ResizeObserver ?? globalThis.ResizeObserver;
    if (ResizeObserverConstructor === undefined) return;
    const observer = new ResizeObserverConstructor(() => {
      syncNavigationViewportMetrics(navigation);
    });
    observer.observe(navigation);
    return () => observer.disconnect();
  }, [syncNavigationViewportMetrics]);

  useEffect(() => {
    const root = navigationRef.current;
    const sentinel = conversationLoadMoreSentinelRef.current;
    if (root === null || sentinel === null || listData?.nextCursor === undefined) return;
    const IntersectionObserverConstructor =
      root.ownerDocument.defaultView?.IntersectionObserver ??
      globalThis.IntersectionObserver;
    if (IntersectionObserverConstructor === undefined) return;

    const observer = new IntersectionObserverConstructor((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      requestMoreConversations();
    }, {
      root,
      rootMargin: "0px 0px 160px 0px",
      threshold: 0,
    });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [listData?.loadMore, listData?.nextCursor, requestMoreConversations]);

  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const ResizeObserverConstructor =
      root.ownerDocument.defaultView?.ResizeObserver ?? globalThis.ResizeObserver;
    if (ResizeObserverConstructor === undefined) return;

    const observer = new ResizeObserverConstructor((entries) => {
      const entry = entries[0];
      if (entry === undefined) return;
      const nextCompact = entry.contentRect.width <= CHAT_WORKSPACE_COMPACT_MAX_WIDTH;
      if (nextCompact && !compactLayoutRef.current) {
        setCompactPane(
          selectedConversationIdRef.current === undefined ? "list" : "detail",
        );
      }
      compactLayoutRef.current = nextCompact;
      setIsCompactLayout(nextCompact);
    });
    observer.observe(root);
    return () => {
      compactLayoutRef.current = false;
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    if (isCompactLayout && selectedConversationId === undefined) {
      setCompactPane("list");
    }
  }, [isCompactLayout, selectedConversationId]);

  useEffect(() => {
    if (controlled || navigationConversations.length === 0) return;
    const pendingCreatedConversationId = pendingCreatedConversationIdRef.current;
    if (
      pendingCreatedConversationId !== undefined &&
      navigationConversations.some(({ id }) => id === pendingCreatedConversationId)
    ) {
      pendingCreatedConversationIdRef.current = undefined;
    }
    setInternalConversationId((current) => {
      const currentIsListed = current !== undefined &&
        navigationConversations.some(({ id }) => id === current);
      if (currentIsListed) return current;
      if (current !== undefined && (
        searchSelectedConversationIdRef.current === current ||
        pendingCreatedConversationIdRef.current === current
      )) {
        return current;
      }
      if (
        props.defaultConversationId !== undefined &&
        navigationConversations.some(({ id }) => id === props.defaultConversationId)
      ) {
        return props.defaultConversationId;
      }
      return navigationConversations[0]?.id;
    });
  }, [controlled, navigationConversations, props.defaultConversationId]);

  const detailResult = useConversation(
    selectedConversationId ?? EMPTY_CONVERSATION_ID,
    { enabled: selectedConversationId !== undefined },
  );
  const createdConversationDefinitivelyUnavailable =
    detailResult.status === "empty" ||
    (detailResult.status === "error" &&
      (detailResult.error.httpStatus === 404 ||
        detailResult.error.httpStatus === 410));
  useEffect(() => {
    if (controlled) return;
    const pendingCreatedConversationId = pendingCreatedConversationIdRef.current;
    if (
      pendingCreatedConversationId === undefined ||
      selectedConversationId !== pendingCreatedConversationId ||
      navigationConversations.some(({ id }) => id === pendingCreatedConversationId)
    ) {
      return;
    }
    if (!createdConversationDefinitivelyUnavailable) return;

    pendingCreatedConversationIdRef.current = undefined;
    setCreatedNavigationConversation((current) =>
      current?.id === pendingCreatedConversationId ? undefined : current);
    setInternalConversationId((current) => {
      if (current !== pendingCreatedConversationId) return current;
      if (
        props.defaultConversationId !== undefined &&
        navigationConversations.some(({ id }) => id === props.defaultConversationId)
      ) {
        return props.defaultConversationId;
      }
      return navigationConversations[0]?.id;
    });
  }, [
    controlled,
    createdConversationDefinitivelyUnavailable,
    navigationConversations,
    props.defaultConversationId,
    selectedConversationId,
  ]);
  const membersResult = useMembers(
    selectedConversationId ?? EMPTY_CONVERSATION_ID,
    { enabled: selectedConversationId !== undefined },
  );
  const workspaceHuddleResult = useHuddle(
    selectedConversationId ?? EMPTY_CONVERSATION_ID,
    {
      enabled: selectedConversationId !== undefined &&
        props.renderHuddle === undefined &&
        props.currentUserId !== undefined &&
        props.huddlePermissions !== undefined,
    },
  );
  const actions = useChatActions(selectedConversationId);
  const preferenceSelector = useMemo<ChatWorkspacePreferenceSelector>(
    () => (state) => selectedConversationId === undefined
    ? undefined
    : state.currentUser.preferences[selectedConversationId],
    [selectedConversationId],
  );
  const currentPreference = useChatSelector(preferenceSelector);
  const canCreateChannel = props.readOnly !== true &&
    props.channelCreationAvailability?.canCreate === true;
  const canCreateDirect = props.readOnly !== true &&
    props.directCreationAvailability?.canCreate === true;
  const canCreateGroupDirect = props.readOnly !== true &&
    props.groupDirectCreationAvailability?.canCreate === true;
  const creationMenuItems = useMemo<readonly ConversationCreationMenuItem[]>(() => {
    const items: ConversationCreationMenuItem[] = [];
    if (canCreateChannel) items.push({ kind: "channel", label: "Create channel" });
    if (canCreateDirect) {
      items.push({ kind: "direct", label: "Create direct conversation" });
    }
    if (canCreateGroupDirect) {
      items.push({ kind: "group-direct", label: "Create group conversation" });
    }
    return items;
  }, [canCreateChannel, canCreateDirect, canCreateGroupDirect]);
  const hasMessageSearchCapability = chat !== null &&
    typeof chat.client.searchMessages === "function" &&
    typeof chat.client.getMessageSearchState === "function" &&
    typeof chat.client.subscribeMessageSearch === "function" &&
    typeof chat.client.cancelMessageSearch === "function";
  const [messageSearchOpen, setMessageSearchOpen] = useState(false);
  const messageSearchPanelId = useId();
  const conversationFilterId = useId();
  const conversationFilterShortcutHintId = useId();
  const starredHeadingId = useId();
  const publicChannelsHeadingId = useId();
  const privateChannelsHeadingId = useId();
  const directMessagesHeadingId = useId();
  const groupConversationsHeadingId = useId();
  const threadsHeadingId = useId();
  const starredListId = useId();
  const publicChannelsListId = useId();
  const privateChannelsListId = useId();
  const directMessagesListId = useId();
  const groupConversationsListId = useId();
  const threadsListId = useId();
  const navigationSectionHeadingIds: Readonly<
    Record<ConversationNavigationSectionKind, string>
  > = Object.freeze({
    starred: starredHeadingId,
    "public-channels": publicChannelsHeadingId,
    "private-channels": privateChannelsHeadingId,
    "direct-messages": directMessagesHeadingId,
    "group-conversations": groupConversationsHeadingId,
    threads: threadsHeadingId,
  });
  const navigationSectionListIds: Readonly<
    Record<ConversationNavigationSectionKind, string>
  > = Object.freeze({
    starred: starredListId,
    "public-channels": publicChannelsListId,
    "private-channels": privateChannelsListId,
    "direct-messages": directMessagesListId,
    "group-conversations": groupConversationsListId,
    threads: threadsListId,
  });
  const focusConversationFilter = useCallback((): boolean => {
    const input = conversationFilterInputRef.current;
    if (input === null) return false;
    if (isCompactLayout && compactPane !== "list") {
      pendingConversationFilterFocusRef.current = true;
      setCompactPane("list");
      return true;
    }
    input.focus();
    input.select();
    return true;
  }, [compactPane, isCompactLayout]);
  useEffect(() => {
    if (!pendingConversationFilterFocusRef.current) return;
    if (isCompactLayout && compactPane !== "list") return;
    pendingConversationFilterFocusRef.current = false;
    conversationFilterInputRef.current?.focus();
    conversationFilterInputRef.current?.select();
  }, [compactPane, isCompactLayout]);
  useLayoutEffect(() => {
    conversationFilterShortcutRegistrationRef.current.focusConversationFilter =
      focusConversationFilter;
  }, [focusConversationFilter]);
  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const registration = conversationFilterShortcutRegistrationRef.current;
    registration.root = root;
    const unregister = registerConversationFilterShortcut(root.ownerDocument, registration);
    return () => {
      unregister();
      registration.root = null;
    };
  }, []);
  const claimBodyShortcut = useCallback(() => {
    claimConversationFilterShortcut(conversationFilterShortcutRegistrationRef.current);
  }, []);
  const onWorkspaceKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;

    const root = rootRef.current;
    const target = event.target as Element | null;
    if (root === null || target === null || typeof target.closest !== "function") return;
    if (!root.contains(target)) return;

    if (mode === "modal" && event.key === "Tab") {
      const focusable = modalFocusableElements(root);
      event.preventDefault();
      if (focusable.length === 0) {
        root.focus();
        return;
      }
      const activeIndex = focusable.indexOf(
        root.ownerDocument.activeElement as HTMLElement,
      );
      const nextIndex = event.shiftKey
        ? activeIndex <= 0 ? focusable.length - 1 : activeIndex - 1
        : activeIndex < 0 || activeIndex === focusable.length - 1
          ? 0
          : activeIndex + 1;
      focusable[nextIndex]?.focus();
      return;
    }

    if (mode === "modal" && event.key === "Escape") {
      if (props.onModalCloseRequest === undefined) return;
      event.preventDefault();
      props.onModalCloseRequest();
      return;
    }

    if (
      event.key !== "/" ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    ) {
      return;
    }

    if (target.closest(
      "input, textarea, select, [contenteditable], [role='textbox'], [role='combobox']",
    ) !== null) {
      return;
    }
    const blockedBoundary = target.closest(
      "[data-handrail-conversation-filter-shortcut-boundary], " +
      ".handrail-chat__composer-region, .handrail-chat__message-search, " +
      ".handrail-chat__creation-menu-root, [role='menu'], [role='dialog']",
    );
    if (blockedBoundary !== null && blockedBoundary !== root) return;
    if (target.closest(
      ".handrail-chat__navigation, .handrail-chat__timeline",
    ) === null) {
      return;
    }
    if (!focusConversationFilter()) return;
    event.preventDefault();
  }, [focusConversationFilter, mode, props.onModalCloseRequest]);
  useLayoutEffect(() => {
    if (mode !== "modal") return;
    const root = rootRef.current;
    if (root === null) return;
    const ownerDocument = root.ownerDocument;
    const activeElement = ownerDocument.activeElement;
    const generation = ++modalLifecycleGenerationRef.current;
    modalOpenerRef.current = isDocumentHTMLElement(ownerDocument, activeElement) &&
        activeElement.isConnected
      ? activeElement
      : null;

    const preferredTarget = conversationFilterInputRef.current;
    const focusable = modalFocusableElements(root);
    const focusTarget = preferredTarget !== null && focusable.includes(preferredTarget)
      ? preferredTarget
      : focusable[0] ?? root;
    focusTarget.focus();

    return () => {
      const opener = modalOpenerRef.current;
      modalOpenerRef.current = null;
      const currentFocus = ownerDocument.activeElement;
      if (!isDocumentHTMLElement(ownerDocument, currentFocus) || !root.contains(currentFocus)) {
        return;
      }
      queueMicrotask(() => {
        const latestFocus = ownerDocument.activeElement;
        if (
          modalLifecycleGenerationRef.current === generation &&
          opener?.isConnected === true &&
          (root.contains(latestFocus) || latestFocus === ownerDocument.body)
        ) {
          opener.focus();
        }
      });
    };
  }, [mode]);
  const messageSearchTriggerRef = useRef<HTMLButtonElement | null>(null);
  const closeMessageSearch = useCallback(() => {
    setMessageSearchOpen(false);
    messageSearchTriggerRef.current?.focus();
  }, []);
  useEffect(() => {
    if (hasMessageSearchCapability && selectedConversationId !== undefined) return;
    setMessageSearchOpen(false);
  }, [hasMessageSearchCapability, selectedConversationId]);
  const [creationMenuOpen, setCreationMenuOpen] = useState(false);
  const [activeCreationDialog, setActiveCreationDialog] = useState<
    "direct" | "group-direct" | undefined
  >();
  const creationMenuId = useId();
  const creationAddTriggerRef = useRef<HTMLButtonElement | null>(null);
  const creationDialogReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  const creationMenuRootRef = useRef<HTMLDivElement | null>(null);
  const creationMenuItemRefs = useRef(
    new Map<ConversationCreationKind, HTMLButtonElement>(),
  );
  const creationMenuInitialFocusRef = useRef<"first" | "last">("first");
  const [channelDialogOpen, setChannelDialogOpen] = useState(false);
  const [channelName, setChannelName] = useState("");
  const [channelVisibility, setChannelVisibility] = useState<
    "public" | "private" | undefined
  >();
  const [channelCreationPending, setChannelCreationPending] = useState(false);
  const [channelCreationError, setChannelCreationError] = useState<string>();
  const channelCreationPendingRef = useRef(false);
  const channelDialogRestoreFocusPendingRef = useRef(false);
  const channelDialogRef = useRef<HTMLDivElement | null>(null);
  const channelNameInputRef = useRef<HTMLInputElement | null>(null);
  const [threadRootMessageId, setThreadRootMessageId] = useState<
    MessageId | undefined
  >();
  const threadReturnFocusRef = useRef<HTMLElement | null>(null);
  const threadCreationDisabledReason = useThreadCreationRestriction(selectedConversationId, props.readOnly, props.composerAvailability);
  const threadCreationIdentity = useChatSelector(state => state.identity === null ? "" : JSON.stringify([state.identity.tenantId, state.identity.userId]));
  const threadCreationDrafts = useMemo(() => new Map<MessageId, ThreadCreationDraft>(), [chat?.client, threadCreationIdentity]);
  const [threadCreationRequest, setThreadCreationRequest] = useState<ThreadCreationRequest>();
  const threadCreationScope = useMemo(() => ({}), [selectedConversationId, chat?.client, threadCreationIdentity]);
  const replyStyle = useReplyStyle();
  const [threadDiscoveryScope, setThreadDiscoveryScope] = useState<object>();
  const [discoveredThread, setDiscoveredThread] = useState<ThreadListSelection>();
  const discoveryTriggerRef = useRef<HTMLButtonElement>(null);
  const threadDiscoveryOpen = threadDiscoveryScope === threadCreationScope;
  const activeDiscoveredThread = threadDiscoveryOpen ? discoveredThread : undefined;
  const closeDiscovery = useCallback(() => {
    setThreadDiscoveryScope(undefined);
    setDiscoveredThread(undefined);
    queueMicrotask(() => {
      const target = discoveryTriggerRef.current ?? rootRef.current?.querySelector<HTMLElement>("main");
      if (target?.isConnected) target.focus();
    });
  }, []);
  const threadCreationScopeRef = useRef(threadCreationScope);
  threadCreationScopeRef.current = threadCreationScope;
  const threadCreationRequestScopeRef = useRef(threadCreationScope);
  const activeThreadCreationRequest = threadCreationRequestScopeRef.current === threadCreationScope &&
    threadCreationRequest?.conversationId === selectedConversationId ? threadCreationRequest : undefined;
  const requestThreadCreation = useCallback((rootMessageId: MessageId, returnFocusTarget: HTMLElement | null) => {
    if (selectedConversationId === undefined || threadCreationDisabledReason !== undefined ||
      threadCreationScopeRef.current !== threadCreationScope) return;
    const draft = threadCreationDrafts.get(rootMessageId) ?? { name: "" };
    threadCreationDrafts.set(rootMessageId, draft);
    threadCreationRequestScopeRef.current = threadCreationScope;
    setThreadCreationRequest({ conversationId: selectedConversationId, rootMessageId, returnFocusTarget, draft });
  }, [selectedConversationId, threadCreationDisabledReason, threadCreationScope, threadCreationDrafts]);
  const messageTimelineEditControllerRef = useRef<MessageTimelineEditController>(null);
  const composerControlsRef = useRef<ChatComposerControls>(null);
  const selectReply = useCallback<ChatComposerControls["selectReply"]>((source) => {
    if (source.conversationId !== selectedConversationIdRef.current) return;
    composerControlsRef.current?.selectReply(source);
  }, []);
  const requestLatestMessageEdit = useCallback((
    returnFocusTarget: HTMLTextAreaElement,
  ): boolean => messageTimelineEditControllerRef.current
    ?.requestLatestMessageEdit(returnFocusTarget) ?? false, []);
  const [memberManagementConversationId, setMemberManagementConversationId] =
    useState<ConversationId>();
  const memberManagementTriggerRef = useRef<HTMLButtonElement | null>(null);
  const memberManagementPanelId = useId();
  const memberManagementTitleId = useId();
  const slots = useMemo(
    () => resolveChatWorkspaceSlots(
      DEFAULT_CHAT_WORKSPACE_SLOTS,
      props.components,
    ),
    [props.components],
  );
  const detail = detailResult.data;
  const viewModel = useMemo(
    () => detail === undefined ? undefined : toViewModel(detail),
    [detail],
  );
  const avatarUser = useMemo<HostDirectoryUserSummary | undefined>(
    () => membersResult.data?.members.find(({ user }) => user !== undefined)?.user,
    [membersResult.data?.members],
  );
  const directParticipant = useMemo(
    () => viewModel?.type !== "direct"
      ? undefined
      : membersResult.data?.members.find((member) =>
          member.userId !== props.currentUserId &&
          (member.membership === undefined || member.membership.state === "active")
        ),
    [membersResult.data?.members, props.currentUserId, viewModel?.type],
  );
  const directParticipantUser = directParticipant?.user;
  const resolvedDirectParticipantLabel = directParticipantLabel(
    directParticipantUser,
    directParticipant !== undefined,
    membersResult.status === "loading",
  );
  const directParticipantAvailability = directParticipantUser?.kind === "active"
    ? directParticipantUser.status?.availability
    : undefined;
  const groupDirectParticipants = useMemo(() => {
    if (viewModel?.type !== "group_direct") return [];
    return (membersResult.data?.members ?? [])
      .filter((member) =>
        member.userId !== props.currentUserId &&
        (member.membership === undefined || member.membership.state === "active")
      )
      .map((member) => Object.freeze({
        ...member,
        label: groupDirectParticipantLabel(member.user),
      }))
      .sort((left, right) =>
        left.label < right.label
          ? -1
          : left.label > right.label
            ? 1
            : left.userId < right.userId
              ? -1
              : left.userId > right.userId
                ? 1
                : 0
      );
  }, [membersResult.data?.members, props.currentUserId, viewModel?.type]);
  const groupDirectLabel = groupDirectParticipants.length > 0
    ? groupDirectParticipants.map(({ label }) => label).join(", ")
    : membersResult.status === "loading"
      ? "Loading participants…"
      : "Participants unavailable";
  const visibleGroupDirectParticipants = groupDirectParticipants.slice(
    0,
    GROUP_DIRECT_VISIBLE_AVATAR_COUNT,
  );
  const hiddenGroupDirectParticipantCount = Math.max(
    0,
    groupDirectParticipants.length - visibleGroupDirectParticipants.length,
  );
  const conversationIntroduction = useMemo<ChatConversationIntroductionViewModel>(() => {
    const archived = viewModel?.archivedAt !== undefined;
    const prompt = archived
      ? "This conversation is archived, so new messages are unavailable."
      : "Send the first message when you’re ready.";

    if (viewModel?.type === "channel") {
      return Object.freeze({
        conversationType: "channel",
        identity: `#${viewModel.name}`,
        context: viewModel.visibility === "public"
          ? "A public channel anyone in the workspace can find and join."
          : "A private channel for invited members.",
        visibility: viewModel.visibility,
        archived,
        ...(viewModel.entity === undefined
          ? {}
          : { entity: Object.freeze({ ...viewModel.entity }) }),
        prompt,
      });
    }

    if (viewModel?.type === "direct") {
      const loading = directParticipant === undefined && membersResult.status === "loading";
      const participants = directParticipant === undefined
        ? Object.freeze([]) as readonly ChatConversationIntroductionParticipant[]
        : Object.freeze([
            Object.freeze({
              label: resolvedDirectParticipantLabel,
              state: participantState(directParticipantUser),
            }),
          ]);
      const participantResolution = loading
        ? "loading"
        : directParticipant === undefined || directParticipantUser?.kind === "unavailable"
          ? "unavailable"
          : "ready";
      return Object.freeze({
        conversationType: "direct",
        identity: resolvedDirectParticipantLabel,
        context: participantResolution === "loading"
          ? "Participant details are still loading."
          : participantResolution === "unavailable"
            ? "Participant details are unavailable."
            : `This is the beginning of your private conversation with ${resolvedDirectParticipantLabel}.`,
        archived,
        participantResolution,
        participants,
        prompt,
      });
    }

    if (viewModel?.type === "group_direct") {
      const participantResolution = groupDirectParticipants.length > 0
        ? "ready"
        : membersResult.status === "loading"
          ? "loading"
          : "unavailable";
      const participants = Object.freeze(groupDirectParticipants.map(({ label, user }) =>
        Object.freeze({ label, state: participantState(user) })));
      return Object.freeze({
        conversationType: "group_direct",
        identity: groupDirectLabel,
        context: participantResolution === "loading"
          ? "Participant details are still loading."
          : participantResolution === "unavailable"
            ? "Participant details are unavailable."
            : "This is the beginning of your private group conversation.",
        archived,
        participantResolution,
        participants,
        prompt,
      });
    }

    return Object.freeze({
      conversationType: "thread",
      identity: "Thread",
      context: "This thread does not have any replies yet.",
      archived,
      prompt: archived ? prompt : "Write the first reply when you’re ready.",
    });
  }, [
    directParticipant,
    directParticipantUser,
    groupDirectLabel,
    groupDirectParticipants,
    membersResult.status,
    resolvedDirectParticipantLabel,
    viewModel,
  ]);
  const contextualComposerLabel = viewModel?.type === "channel"
    ? `Message #${viewModel.name}`
    : viewModel?.type === "direct"
      ? `Message ${resolvedDirectParticipantLabel}`
      : viewModel?.type === "group_direct"
        ? `Message ${groupDirectLabel}`
        : viewModel?.type === "thread"
          ? "Reply to thread"
          : "Message";

  const buttonRefs = useRef(new Map<string, HTMLButtonElement>());
  const compactReturnFocusRef = useRef<ConversationId | undefined>(undefined);
  const revealNavigationRow = useCallback((identity: string, focus: boolean): boolean => {
    const navigation = navigationRef.current;
    const row = navigationWindowRows.find(({ id }) => id === identity);
    if (navigation === null || row === undefined) return false;
    navigation.scrollTop = calculateTimelineAnchorOffsetCorrection({
      rows: navigationWindowRows,
      anchor: { rowId: identity, offsetWithinRow: 0 },
      viewportHeight: navigation.clientHeight > 0
        ? navigation.clientHeight
        : CONVERSATION_NAVIGATION_DEFAULT_VIEWPORT_HEIGHT_PX,
      fallbackViewportOffset: navigation.scrollTop,
    });
    if (focus) {
      const mountedTarget = buttonRefs.current.get(identity);
      if (mountedTarget === undefined) pendingNavigationFocusIdentityRef.current = identity;
      else {
        mountedTarget.scrollIntoView?.({ block: "nearest", inline: "nearest" });
        mountedTarget.focus({ preventScroll: true });
      }
    }
    syncNavigationViewportMetrics(navigation);
    return true;
  }, [navigationWindowRows, syncNavigationViewportMetrics]);

  useLayoutEffect(() => {
    const identity = pendingNavigationFocusIdentityRef.current;
    if (identity === undefined) return;
    const target = buttonRefs.current.get(identity);
    if (target === undefined) return;
    pendingNavigationFocusIdentityRef.current = undefined;
    target.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    target.focus({ preventScroll: true });
    const navigation = navigationRef.current;
    if (navigation !== null) syncNavigationViewportMetrics(navigation);
  }, [mountedNavigationRowKey, syncNavigationViewportMetrics]);

  const selectConversation = useCallback((
    conversationId: ConversationId,
    preserveSearchSelection = false,
    revealCompactDetail = true,
    preserveCreatedSelection = false,
  ) => {
    if (!preserveSearchSelection) searchSelectedConversationIdRef.current = undefined;
    pendingCreatedConversationIdRef.current = preserveCreatedSelection && !controlled
      ? conversationId
      : undefined;
    setThreadRootMessageId(undefined);
    if (!controlled) setInternalConversationId(conversationId);
    if (isCompactLayout && revealCompactDetail) setCompactPane("detail");
    props.onConversationChange?.(conversationId);
  }, [controlled, isCompactLayout, props.onConversationChange]);
  const selectCreatedConversation = useCallback((conversationId: ConversationId) => {
    selectConversation(conversationId, false, true, true);
  }, [selectConversation]);
  const returnToConversations = useCallback(() => {
    compactReturnFocusRef.current = selectedConversationId;
    setCompactPane("list");
  }, [selectedConversationId]);
  useEffect(() => {
    if (!isCompactLayout || compactPane !== "list") return;
    const conversationId = compactReturnFocusRef.current;
    if (conversationId === undefined) return;
    compactReturnFocusRef.current = undefined;
    const returnRow = visibleNavigationRows.find(
      ({ conversation }) => conversation.id === conversationId,
    );
    if (returnRow !== undefined) {
      setActiveNavigationRowIdentity(returnRow.identity);
      revealNavigationRow(returnRow.identity, true);
    }
  }, [compactPane, isCompactLayout, revealNavigationRow, visibleNavigationRows]);
  const findRenderedTarget = useCallback((
    result: RenderedWorkspaceTarget,
  ): HTMLElement | undefined => {
    const root = rootRef.current;
    if (root === null) return undefined;
    const conversation = [...root.querySelectorAll<HTMLElement>(
      ".handrail-chat__conversation[data-conversation-id]",
    )].find((element) => element.dataset.conversationId === result.conversationId);
    if (conversation === undefined) return undefined;
    if (result.messageId === undefined) {
      return conversation.querySelector<HTMLElement>("main") ?? undefined;
    }
    return [...conversation.querySelectorAll<HTMLElement>("[data-message-id]")]
      .find((element) => element.dataset.messageId === result.messageId);
  }, []);
  const waitForRenderedTarget = useCallback((
    result: RenderedWorkspaceTarget,
  ): Promise<HTMLElement | undefined> => {
    const revealWindowedMessage = (): void => {
      if (result.messageId !== undefined) {
        messageTimelineEditControllerRef.current?.revealMessage(result.messageId);
      }
    };
    let existing = findRenderedTarget(result);
    if (existing === undefined) {
      revealWindowedMessage();
      existing = findRenderedTarget(result);
    }
    if (existing !== undefined) return Promise.resolve(existing);
    const root = rootRef.current;
    if (root === null) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      let settled = false;
      const view = root.ownerDocument.defaultView;
      const finish = (element: HTMLElement | undefined) => {
        if (settled) return;
        settled = true;
        observer?.disconnect();
        view?.clearInterval(interval);
        view?.clearTimeout(timeout);
        resolve(element);
      };
      const check = () => {
        let target = findRenderedTarget(result);
        if (target === undefined) {
          revealWindowedMessage();
          target = findRenderedTarget(result);
        }
        if (target !== undefined) finish(target);
      };
      const Observer = view?.MutationObserver;
      const observer = Observer === undefined ? undefined : new Observer(check);
      observer?.observe(root, { childList: true, subtree: true });
      const interval = view?.setInterval(check, 25);
      const timeout = view?.setTimeout(() => finish(undefined), 1_500);
    });
  }, [findRenderedTarget]);
  const navigateToSearchResult = useCallback(async (
    result: MessageSearchHit,
  ): Promise<boolean> => {
    const generation = ++searchNavigationGenerationRef.current;
    setSearchNavigationNotice({ kind: "status", message: "Opening search result…" });
    searchSelectedConversationIdRef.current = result.conversationId;
    selectConversation(result.conversationId, true);
    const target = await waitForRenderedTarget(result);
    if (generation !== searchNavigationGenerationRef.current) return false;
    if (target === undefined) {
      setSearchNavigationNotice({
        kind: "error",
        message: "The result could not be opened. The conversation or message may have been deleted or is not available yet.",
        retryResult: result,
      });
      return false;
    }
    if (result.type === "message") {
      target.scrollIntoView?.({ block: "center", inline: "nearest" });
    }
    target.focus({ preventScroll: true });
    setSearchNavigationNotice({ kind: "status", message: "Search result opened." });
    return true;
  }, [selectConversation, waitForRenderedTarget]);
  const activateSearchResult = useCallback(async (
    result: MessageSearchHit,
  ): Promise<void> => {
    const navigateDefault = () => navigateToSearchResult(result);
    if (props.onMessageSearchResultActivate === undefined) {
      await navigateDefault();
      return;
    }
    setSearchNavigationNotice(undefined);
    try {
      await props.onMessageSearchResultActivate(Object.freeze({
        result,
        navigateDefault,
      }));
    } catch {
      setSearchNavigationNotice({
        kind: "error",
        message: "The host application could not open this search result. Try again.",
        retryResult: result,
      });
    }
  }, [navigateToSearchResult, props.onMessageSearchResultActivate]);
  useEffect(() => () => {
    searchNavigationGenerationRef.current += 1;
  }, []);
  const forwardDestinations = useMemo<readonly ForwardDestination[]>(() => {
    const sourceConversationId = forwardRequest?.source.sourceConversationId;
    if (sourceConversationId === undefined) return [];
    return conversations.flatMap((conversation) =>
      conversation.type === "thread" ||
      conversation.id === sourceConversationId ||
      conversation.archivedAt !== undefined
        ? []
        : [Object.freeze({
            id: conversation.id,
            label: conversationLabel(conversation),
          })],
    );
  }, [conversations, forwardRequest?.source.sourceConversationId]);
  const restoreForwardFocus = useCallback((target: HTMLElement | null) => {
    setTimeout(() => {
      if (target?.isConnected === true) target.focus();
    }, 0);
  }, []);
  const openForwardDialog = useCallback((
    source: MessageForwardRequest,
    returnFocusTarget: HTMLElement | null,
  ) => {
    const hasDestination = conversations.some((conversation) =>
      conversation.type !== "thread" &&
      conversation.id !== source.sourceConversationId &&
      conversation.archivedAt === undefined,
    );
    if (!hasDestination) {
      setForwardNotice({
        kind: "error",
        message: "No available destination conversation can receive this message.",
      });
      restoreForwardFocus(returnFocusTarget);
      return;
    }
    setForwardNotice(undefined);
    setForwardRequest(Object.freeze({ source, returnFocusTarget }));
  }, [conversations, restoreForwardFocus]);
  const closeForwardDialog = useCallback((notice?: ForwardNotice) => {
    const returnFocusTarget = forwardRequest?.returnFocusTarget ?? null;
    setForwardRequest(undefined);
    setForwardNotice(notice);
    restoreForwardFocus(returnFocusTarget);
  }, [forwardRequest?.returnFocusTarget, restoreForwardFocus]);
  const navigateToForwardedMessage = useCallback(async (
    destinationConversationId: ConversationId,
    messageId: MessageId,
  ): Promise<void> => {
    const generation = ++searchNavigationGenerationRef.current;
    setForwardRequest(undefined);
    setForwardNotice({ kind: "status", message: "Opening forwarded message…" });
    searchSelectedConversationIdRef.current = destinationConversationId;
    selectConversation(destinationConversationId, true);
    const target = await waitForRenderedTarget({
      conversationId: destinationConversationId,
      messageId,
    });
    if (generation !== searchNavigationGenerationRef.current) return;
    if (target === undefined) {
      setForwardNotice({
        kind: "error",
        message: "The message was forwarded, but its destination row could not be opened.",
      });
      return;
    }
    target.scrollIntoView?.({ block: "center", inline: "nearest" });
    target.focus({ preventScroll: true });
    setForwardNotice({ kind: "status", message: "Message forwarded and opened." });
  }, [selectConversation, waitForRenderedTarget]);
  const resetChannelCreationForm = useCallback(() => {
    channelCreationPendingRef.current = false;
    setChannelName("");
    setChannelVisibility(undefined);
    setChannelCreationPending(false);
    setChannelCreationError(undefined);
  }, []);
  const restoreCreationFocus = useCallback(() => {
    const returnTarget = creationDialogReturnFocusRef.current;
    creationDialogReturnFocusRef.current = null;
    if (returnTarget?.isConnected === true) returnTarget.focus();
    else creationAddTriggerRef.current?.focus();
  }, []);
  const closeCreationMenu = useCallback((restoreFocus = true) => {
    setCreationMenuOpen(false);
    if (restoreFocus) queueMicrotask(restoreCreationFocus);
  }, [restoreCreationFocus]);
  const openCreationMenu = useCallback((initialFocus: "first" | "last" = "first") => {
    creationMenuInitialFocusRef.current = initialFocus;
    setCreationMenuOpen(true);
  }, []);
  const openCreationDialog = useCallback((
    kind: ConversationCreationKind,
    returnFocusTarget: HTMLButtonElement | null = creationAddTriggerRef.current,
    initialChannelVisibility?: "public" | "private",
  ) => {
    creationDialogReturnFocusRef.current = returnFocusTarget;
    setCreationMenuOpen(false);
    setChannelCreationError(undefined);
    setChannelVisibility(kind === "channel" ? initialChannelVisibility : undefined);
    setChannelDialogOpen(kind === "channel");
    setActiveCreationDialog(
      kind === "direct" || kind === "group-direct" ? kind : undefined,
    );
  }, []);
  useEffect(() => {
    if (!creationMenuOpen) return;
    const item = creationMenuInitialFocusRef.current === "last"
      ? creationMenuItems.at(-1)
      : creationMenuItems[0];
    if (item === undefined) {
      setCreationMenuOpen(false);
      return;
    }
    creationMenuItemRefs.current.get(item.kind)?.focus();
  }, [creationMenuItems, creationMenuOpen]);
  useEffect(() => {
    if (!creationMenuOpen) return;
    const root = creationMenuRootRef.current;
    const ownerDocument = root?.ownerDocument;
    if (root === null || root === undefined || ownerDocument === undefined) return;
    const dismissOutside = (event: globalThis.MouseEvent) => {
      if (event.target instanceof Node && !root.contains(event.target)) {
        closeCreationMenu();
      }
    };
    ownerDocument.addEventListener("mousedown", dismissOutside);
    return () => ownerDocument.removeEventListener("mousedown", dismissOutside);
  }, [closeCreationMenu, creationMenuOpen]);
  const closeChannelDialog = useCallback(() => {
    if (channelCreationPendingRef.current) return;
    channelDialogRestoreFocusPendingRef.current = true;
    setChannelDialogOpen(false);
    resetChannelCreationForm();
  }, [resetChannelCreationForm]);
  const containChannelDialogFocus = useCallback((
    event: KeyboardEvent<HTMLDivElement>,
  ) => {
    if (event.key !== "Tab") return;
    const dialog = channelDialogRef.current;
    if (dialog === null) return;
    const focusable = [...dialog.querySelectorAll<HTMLElement>(
      "button, input, select, textarea, [href], [tabindex]",
    )].filter((element) =>
      (element as HTMLButtonElement | HTMLInputElement).disabled !== true &&
      element.closest("fieldset[disabled]") === null &&
      element.getAttribute("aria-hidden") !== "true" &&
      !element.hasAttribute("hidden") &&
      element.tabIndex >= 0
    );
    event.preventDefault();
    if (focusable.length === 0) {
      dialog.focus();
      return;
    }
    const activeIndex = focusable.indexOf(
      dialog.ownerDocument.activeElement as HTMLElement,
    );
    const nextIndex = event.shiftKey
      ? activeIndex <= 0 ? focusable.length - 1 : activeIndex - 1
      : activeIndex < 0 || activeIndex === focusable.length - 1
        ? 0
        : activeIndex + 1;
    focusable[nextIndex]?.focus();
  }, []);
  useEffect(() => {
    if (!channelDialogOpen) return;
    channelNameInputRef.current?.focus();
  }, [channelDialogOpen]);
  useLayoutEffect(() => {
    if (channelDialogOpen || !channelDialogRestoreFocusPendingRef.current) return;
    channelDialogRestoreFocusPendingRef.current = false;
    restoreCreationFocus();
  }, [channelDialogOpen, restoreCreationFocus]);
  const submitChannelCreation = useCallback(async (
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();
    if (channelCreationPendingRef.current) return;

    const name = channelName.trim().normalize("NFC");
    if (name.length === 0) {
      setChannelCreationError("Enter a channel name and try again.");
      return;
    }
    if (channelVisibility === undefined) {
      setChannelCreationError("Choose Public or Private and try again.");
      return;
    }

    channelCreationPendingRef.current = true;
    setChannelCreationPending(true);
    setChannelCreationError(undefined);
    try {
      const result = await actions.createChannel({
        name,
        visibility: channelVisibility,
        ...(props.scope.type === "entity" ? { entity: props.scope.entity } : {}),
      });
      if (result.status !== "success") {
        setChannelCreationError(
          `${result.message} Check the channel details and try again.`,
        );
        return;
      }

      setCreatedNavigationConversation(Object.freeze({
        ...result.value.conversation.conversation,
        hasActiveHuddle: false,
      }));
      selectCreatedConversation(result.value.conversation.conversation.id);
      channelDialogRestoreFocusPendingRef.current = true;
      setChannelDialogOpen(false);
      resetChannelCreationForm();
    } catch {
      setChannelCreationError(
        "The channel could not be created. Check your connection and try again.",
      );
    } finally {
      channelCreationPendingRef.current = false;
      setChannelCreationPending(false);
    }
  }, [
    actions,
    channelName,
    channelVisibility,
    props.scope,
    resetChannelCreationForm,
    selectCreatedConversation,
  ]);
  useEffect(() => {
    if (!canCreateChannel) {
      setChannelDialogOpen(false);
      resetChannelCreationForm();
    }
    setActiveCreationDialog((current) => {
      if (current === "direct" && !canCreateDirect) return undefined;
      if (current === "group-direct" && !canCreateGroupDirect) return undefined;
      return current;
    });
    if (creationMenuItems.length === 0) setCreationMenuOpen(false);
  }, [
    canCreateChannel,
    canCreateDirect,
    canCreateGroupDirect,
    creationMenuItems.length,
    resetChannelCreationForm,
  ]);
  useEffect(() => {
    setThreadRootMessageId(undefined);
    setMemberManagementConversationId(undefined);
  }, [selectedConversationId]);
  useEffect(() => {
    if (props.memberManagementAvailability?.canView !== true) {
      setMemberManagementConversationId(undefined);
    }
  }, [props.memberManagementAvailability?.canView]);
  const closeMemberManagement = useCallback((restoreFocus = true) => {
    const closingConversationId = memberManagementConversationId;
    setMemberManagementConversationId(undefined);
    if (!restoreFocus || closingConversationId === undefined) return;
    queueMicrotask(() => {
      const trigger = memberManagementTriggerRef.current;
      if (
        selectedConversationIdRef.current === closingConversationId &&
        trigger?.isConnected === true &&
        trigger.dataset.conversationId === closingConversationId
      ) {
        trigger.focus();
      }
    });
  }, [memberManagementConversationId]);
  const openThreadPanel = useCallback((
    rootMessageId: MessageId,
    returnFocusTarget: HTMLElement | null,
  ) => {
    setThreadDiscoveryScope(undefined);
    setDiscoveredThread(undefined);
    threadReturnFocusRef.current = returnFocusTarget;
    setThreadRootMessageId(rootMessageId);
  }, []);
  const closeThreadPanel = useCallback(() => {
    setDiscoveredThread(undefined);
    setThreadRootMessageId(undefined);
  }, []);
  const moveSelection = useCallback((
    event: KeyboardEvent<HTMLButtonElement>,
    nextIndex: number,
  ) => {
    const next = visibleNavigationRows[nextIndex];
    if (next === undefined) return;
    event.preventDefault();
    setActiveNavigationRowIdentity(next.identity);
    selectConversation(next.conversation.id, false, false);
    revealNavigationRow(next.identity, true);
  }, [revealNavigationRow, selectConversation, visibleNavigationRows]);
  const onNavigationKeyDown = useCallback((
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    if (visibleNavigationConversations.length === 0) return;
    switch (event.key) {
      case "ArrowDown":
      case "ArrowRight":
        moveSelection(event, (index + 1) % visibleNavigationConversations.length);
        break;
      case "ArrowUp":
      case "ArrowLeft":
        moveSelection(
          event,
          (index - 1 + visibleNavigationConversations.length) %
            visibleNavigationConversations.length,
        );
        break;
      case "Home":
        moveSelection(event, 0);
        break;
      case "End":
        moveSelection(event, visibleNavigationConversations.length - 1);
        break;
      default:
        break;
    }
  }, [moveSelection, visibleNavigationConversations.length]);
  const onCreationMenuKeyDown = useCallback((
    event: KeyboardEvent<HTMLDivElement>,
  ) => {
    const items = creationMenuItems
      .map(({ kind }) => creationMenuItemRefs.current.get(kind))
      .filter((item): item is HTMLButtonElement => item !== undefined);
    if (items.length === 0) return;
    const activeIndex = items.indexOf(
      event.currentTarget.ownerDocument.activeElement as HTMLButtonElement,
    );
    let nextIndex: number | undefined;
    switch (event.key) {
      case "ArrowDown":
        nextIndex = activeIndex < 0 ? 0 : (activeIndex + 1) % items.length;
        break;
      case "ArrowUp":
        nextIndex = activeIndex <= 0 ? items.length - 1 : activeIndex - 1;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = items.length - 1;
        break;
      case "Enter":
      case " ":
        if (activeIndex >= 0) {
          event.preventDefault();
          items[activeIndex]?.click();
        }
        return;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        closeCreationMenu();
        return;
      default:
        return;
    }
    event.preventDefault();
    items[nextIndex]?.focus();
  }, [closeCreationMenu, creationMenuItems]);

  const titleId = useId();
  const channelDialogId = useId();
  const channelDialogTitleId = useId();
  const channelNameId = useId();
  const normalizedChannelName = channelName.trim().normalize("NFC");
  const channelCreationControl = !canCreateChannel || !channelDialogOpen
    ? null
    : createElement(
        "div",
        {
          className: "handrail-chat__channel-creation",
          onClick: (event: ReactMouseEvent<HTMLDivElement>) => {
            if (event.target !== event.currentTarget || channelCreationPendingRef.current) return;
            closeChannelDialog();
          },
        },
        createElement(
          "div",
          {
            "aria-labelledby": channelDialogTitleId,
            "aria-modal": true,
            className: "handrail-chat__channel-creation-dialog",
            id: channelDialogId,
            onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
              if (event.key === "Tab") {
                containChannelDialogFocus(event);
                return;
              }
              if (event.key !== "Escape" || channelCreationPendingRef.current) return;
              event.preventDefault();
              closeChannelDialog();
            },
            ref: channelDialogRef,
            role: "dialog",
            tabIndex: -1,
          },
          createElement(
            "form",
            {
              className: "handrail-chat__channel-creation-form",
              onSubmit: (event: FormEvent<HTMLFormElement>) => {
                void submitChannelCreation(event);
              },
            },
            createElement(
              "h3",
              {
                className: "handrail-chat__channel-creation-title",
                id: channelDialogTitleId,
              },
              "Create channel",
            ),
            createElement(
              "label",
              {
                className: "handrail-chat__channel-creation-label",
                htmlFor: channelNameId,
              },
              "Channel name",
            ),
            createElement("input", {
              autoFocus: true,
              className: "handrail-chat__channel-creation-input",
              disabled: channelCreationPending,
              id: channelNameId,
              name: "channelName",
              onInput: (event: FormEvent<HTMLInputElement>) => {
                setChannelName(event.currentTarget.value);
                setChannelCreationError(undefined);
              },
              ref: channelNameInputRef,
              required: true,
              type: "text",
              value: channelName,
            }),
            createElement(
              "fieldset",
              {
                className: "handrail-chat__channel-creation-visibility",
                disabled: channelCreationPending,
              },
              createElement("legend", null, "Visibility"),
              ...(["public", "private"] as const).map((visibility) =>
                createElement(
                  "label",
                  {
                    className: "handrail-chat__channel-creation-choice",
                    key: visibility,
                  },
                  createElement("input", {
                    checked: channelVisibility === visibility,
                    name: "channelVisibility",
                    onChange: () => {
                      setChannelVisibility(visibility);
                      setChannelCreationError(undefined);
                    },
                    required: true,
                    type: "radio",
                    value: visibility,
                  }),
                  visibility === "public" ? "Public" : "Private",
                ),
              ),
            ),
            channelCreationPending
              ? statusRegion("Creating channel…")
              : null,
            channelCreationError === undefined
              ? null
              : errorRegion(channelCreationError),
            createElement(
              "div",
              { className: "handrail-chat__channel-creation-actions" },
              createElement(
                "button",
                {
                  className: "handrail-chat__channel-creation-cancel",
                  disabled: channelCreationPending,
                  onClick: closeChannelDialog,
                  type: "button",
                },
                "Cancel",
              ),
              createElement(
                "button",
                {
                  "aria-busy": channelCreationPending ? true : undefined,
                  className: "handrail-chat__channel-creation-submit",
                  disabled: channelCreationPending ||
                    normalizedChannelName.length === 0 ||
                    channelVisibility === undefined,
                  type: "submit",
                },
                channelCreationPending ? "Creating…" : "Create",
              ),
            ),
          ),
        ),
      );
  const directDialogOpen = canCreateDirect && activeCreationDialog === "direct";
  const groupDirectDialogOpen = canCreateGroupDirect &&
    activeCreationDialog === "group-direct";
  const directCreationControl = !canCreateDirect
    ? null
    : createElement(DirectConversationCreation, {
        actions,
        onOpenChange: (open) => {
          if (!open) setActiveCreationDialog(undefined);
        },
        onConversationResolved: (conversation) => {
          setCreatedNavigationConversation(Object.freeze({
            ...conversation,
            hasActiveHuddle: false,
          }));
        },
        onConversationSelected: selectCreatedConversation,
        open: directDialogOpen,
        renderTrigger: false,
        restoreFocus: restoreCreationFocus,
      });
  const groupDirectCreationControl = !canCreateGroupDirect
    ? null
    : createElement(GroupDirectConversationCreation, {
        actions,
        ...(props.currentUserId === undefined
          ? {}
          : { currentUserId: props.currentUserId }),
        onOpenChange: (open) => {
          if (!open) setActiveCreationDialog(undefined);
        },
        onConversationSelected: selectCreatedConversation,
        open: groupDirectDialogOpen,
        renderTrigger: false,
        restoreFocus: restoreCreationFocus,
      });
  const creationMenuControl = creationMenuItems.length === 0
    ? null
    : createElement(
        "div",
        {
          className: "handrail-chat__creation-menu-root",
          ref: creationMenuRootRef,
        },
        createElement(
          "button",
          {
            "aria-controls": creationMenuId,
            "aria-expanded": creationMenuOpen,
            "aria-haspopup": "menu",
            "aria-label": "Add conversation",
            className: "handrail-chat__creation-menu-trigger",
            onClick: () => {
              if (creationMenuOpen) closeCreationMenu();
              else openCreationMenu();
            },
            onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
              if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
              event.preventDefault();
              openCreationMenu(event.key === "ArrowUp" ? "last" : "first");
            },
            ref: creationAddTriggerRef,
            type: "button",
          },
          navigationIcon("add"),
        ),
        !creationMenuOpen
          ? null
          : createElement(
              "div",
              {
                "aria-label": "Create conversation",
                className: "handrail-chat__creation-menu",
                id: creationMenuId,
                onKeyDown: onCreationMenuKeyDown,
                role: "menu",
              },
              ...creationMenuItems.map((item) => createElement(
                "button",
                {
                  className: "handrail-chat__creation-menu-item",
                  key: item.kind,
                  onClick: () => openCreationDialog(
                    item.kind,
                    creationAddTriggerRef.current,
                  ),
                  ref: (element: HTMLButtonElement | null) => {
                    if (element === null) creationMenuItemRefs.current.delete(item.kind);
                    else creationMenuItemRefs.current.set(item.kind, element);
                  },
                  role: "menuitem",
                  tabIndex: -1,
                  type: "button",
                },
                item.label,
              )),
            ),
      );
  const messageSearchControl = !hasMessageSearchCapability || !messageSearchOpen ||
      selectedConversationId === undefined
    ? null
    : createElement(MessageSearchPanel, {
        conversations,
        id: messageSearchPanelId,
        ...(searchNavigationNotice === undefined
          ? {}
          : { navigationNotice: searchNavigationNotice }),
        onActivate: activateSearchResult,
        onClose: closeMessageSearch,
        onRetryNavigation: async (result) => { await navigateToSearchResult(result); },
        selectedConversationId,
      });
  const loadMoreControl = listData?.nextCursor === undefined
    ? null
    : createElement(
        "div",
        {
          className: "handrail-chat__conversation-load-more",
          ref: conversationLoadMoreSentinelRef,
        },
        createElement(
          "button",
          {
            "aria-busy": listData.isLoadingMore ? true : undefined,
            className: "handrail-chat__conversation-load-more-button",
            disabled: listData.isLoadingMore,
            onClick: requestMoreConversations,
            type: "button",
          },
          "Load more conversations",
        ),
        listData.isLoadingMore
          ? statusRegion("Loading more conversations…")
          : null,
      );
  const workspaceMenuControl = props.workspaceMenuContent === undefined &&
      props.onWorkspaceMenuOpen === undefined
    ? undefined
    : props.onWorkspaceMenuOpen === undefined
      ? props.workspaceMenuContent
      : createElement(
          "button",
          {
            "aria-label": "Open workspace menu",
            className: "handrail-chat__workspace-menu-trigger",
            onClick: props.onWorkspaceMenuOpen,
            type: "button",
          },
          props.workspaceMenuContent ?? navigationIcon("workspace-menu"),
        );
  const workspaceSettingsControl = props.workspaceSettingsContent === undefined &&
      props.onWorkspaceSettingsOpen === undefined
    ? createElement("button", {
        "aria-label": "Open workspace settings",
        "aria-haspopup": "dialog",
        "aria-expanded": replyStyleSettingsOpen,
        className: "handrail-chat__workspace-settings-trigger",
        onClick: () => setReplyStyleSettingsOpen(true),
        type: "button",
      }, navigationIcon("settings"))
    : props.onWorkspaceSettingsOpen === undefined
      ? props.workspaceSettingsContent
      : createElement(
          "button",
          {
            "aria-label": "Open workspace settings",
            className: "handrail-chat__workspace-settings-trigger",
            onClick: props.onWorkspaceSettingsOpen,
            type: "button",
          },
          props.workspaceSettingsContent ?? navigationIcon("settings"),
        );
  const workspaceHeaderControls = Object.freeze({
    ...(creationMenuControl === null
      ? {}
      : { createConversation: creationMenuControl }),
    ...(workspaceMenuControl === undefined ? {} : { menu: workspaceMenuControl }),
    ...(workspaceSettingsControl === undefined
      ? {}
      : { settings: workspaceSettingsControl }),
  });
  const navigation = createElement(
    "nav",
    {
      "aria-label": props.navigationLabel ?? "Conversations",
      className: "handrail-chat__navigation",
      hidden: isCompactLayout && compactPane !== "list",
      onScroll: (event: UIEvent<HTMLElement>) => {
        syncNavigationViewportMetrics(event.currentTarget);
      },
      ref: navigationRef,
    },
    createElement(slots.WorkspaceHeader, {
      ...(workspaceIdentity === undefined
        ? {}
        : { identity: workspaceIdentity }),
      controls: workspaceHeaderControls,
      hostProps: {
        "data-handrail-conversation-filter-shortcut-boundary": "workspace-header",
      },
    }),
    createElement(
      "div",
      { className: "handrail-chat__conversation-filter" },
      createElement(
        "label",
        {
          className: "handrail-chat__conversation-filter-label",
          htmlFor: conversationFilterId,
        },
        createElement(
          "span",
          { className: "handrail-chat__sr-only" },
          "Search conversations",
        ),
        navigationIcon("search", "handrail-chat__conversation-filter-icon"),
        createElement("input", {
          "aria-describedby": conversationFilterShortcutHintId,
          autoComplete: "off",
          className: "handrail-chat__conversation-filter-input",
          id: conversationFilterId,
          name: "conversationFilter",
          onInput: (event: FormEvent<HTMLInputElement>) => {
            setConversationFilterQuery(event.currentTarget.value);
          },
          onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
            if (event.key !== "Escape" || conversationFilterQuery.length === 0) return;
            event.preventDefault();
            event.stopPropagation();
            setConversationFilterQuery("");
          },
          placeholder: "Search conversations",
          ref: conversationFilterInputRef,
          spellCheck: false,
          type: "search",
          value: conversationFilterQuery,
        }),
      ),
      createElement(
        "kbd",
        {
          className: "handrail-chat__conversation-filter-shortcut",
          id: conversationFilterShortcutHintId,
        },
        createElement(
          "span",
          { className: "handrail-chat__sr-only" },
          "Keyboard shortcut: ",
        ),
        "/",
      ),
    ),
    listResult.status === "loading" && conversations.length === 0
      ? statusRegion("Loading conversations…")
      : null,
    listResult.status === "error"
      ? errorRegion(listResult.error.message)
      : null,
    normalizedConversationFilterQuery.length > 0 &&
        filteredNavigationConversations.length === 0
      ? createElement(
          "p",
          {
            "aria-live": "polite",
            className: "handrail-chat__conversation-filter-empty",
            role: "status",
          },
          "No conversations match your search.",
        )
      : null,
    conversationFilterActive && filteredNavigationConversations.length === 0
      ? null
      : createElement(
          "div",
          {
            className: "handrail-chat__conversation-sections",
            "data-navigation-window-end": navigationWindow.endIndex,
            "data-navigation-window-start": navigationWindow.startIndex,
          },
          ...filteredNavigationModel.sections.map((section) => {
            const headingId = navigationSectionHeadingIds[section.kind];
            const listId = navigationSectionListIds[section.kind];
            const expanded = conversationFilterActive ||
              !collapsedNavigationSections.has(section.kind);
            const sectionStartIndex = section.rows.length === 0
              ? undefined
              : visibleNavigationIndexByIdentity.get(section.rows[0]?.identity ?? "");
            const sectionEndIndex = sectionStartIndex === undefined
              ? undefined
              : sectionStartIndex + section.rows.length;
            const beforeRowCount = sectionStartIndex === undefined
              ? 0
              : Math.max(0, Math.min(
                  section.rows.length,
                  navigationWindow.startIndex - sectionStartIndex,
                ));
            const afterRowCount = sectionEndIndex === undefined
              ? 0
              : Math.max(0, Math.min(
                  section.rows.length,
                  sectionEndIndex - navigationWindow.endIndex,
                ));
            const mountedSectionRows = expanded
              ? section.rows.filter(({ identity }) =>
                  mountedNavigationRowIdentities.has(identity))
              : [];
            const creationActions: readonly ConversationCreationMenuItem[] =
              section.kind === "public-channels"
                ? canCreateChannel
                  ? [{ kind: "channel", label: "Create public channel" }]
                  : []
                : section.kind === "private-channels"
                  ? canCreateChannel
                    ? [{ kind: "channel", label: "Create private channel" }]
                    : []
                  : section.kind === "direct-messages"
                    ? canCreateDirect
                      ? [{
                          kind: "direct" as const,
                          label: "Create a direct conversation",
                        }]
                      : []
                    : section.kind === "group-conversations"
                      ? canCreateGroupDirect
                        ? [{
                            kind: "group-direct" as const,
                            label: "Create a group conversation",
                          }]
                        : []
                      : [];
            return createElement(
              "section",
              {
                "aria-labelledby": headingId,
                className: "handrail-chat__conversation-section",
                "data-conversation-section": section.kind,
                key: section.kind,
              },
              createElement(
                "h3",
                {
                  className: "handrail-chat__conversation-section-heading",
                },
                createElement(
                  "button",
                  {
                    "aria-controls": listId,
                    "aria-expanded": expanded,
                    className: "handrail-chat__conversation-section-disclosure",
                    disabled: conversationFilterActive,
                    id: headingId,
                    onClick: () => {
                      setCollapsedNavigationSections((current) => {
                        const next = new Set(current);
                        if (next.has(section.kind)) next.delete(section.kind);
                        else next.add(section.kind);
                        return next;
                      });
                    },
                    title: conversationFilterActive
                      ? "Sections remain expanded while filtering"
                      : section.kind === "threads"
                        ? "Threads encountered this session. Browse a channel for all threads."
                        : undefined,
                    type: "button",
                  },
                  navigationIcon(
                    "disclosure",
                    "handrail-chat__conversation-section-disclosure-icon handrail-chat__navigation-icon",
                  ),
                  createElement(
                    "span",
                    { className: "handrail-chat__conversation-section-label" },
                    section.label,
                  ),
                  createElement(
                    "span",
                    { className: "handrail-chat__conversation-section-count" },
                    section.rows.length,
                  ),
                ),
                creationActions.length === 0
                  ? null
                  : createElement(
                      "span",
                      {
                        "aria-label": `${section.label} actions`,
                        className: "handrail-chat__conversation-section-actions",
                        role: "group",
                      },
                      ...creationActions.map((action) => createElement(
                        "button",
                        {
                          "aria-label": action.label,
                          className: "handrail-chat__conversation-section-action",
                          key: action.kind,
                          onClick: (event: ReactMouseEvent<HTMLButtonElement>) => {
                            openCreationDialog(
                              action.kind,
                              event.currentTarget,
                              section.kind === "public-channels"
                                ? "public"
                                : section.kind === "private-channels"
                                  ? "private"
                                  : undefined,
                            );
                          },
                          title: action.label,
                          type: "button",
                        },
                        navigationIcon(action.kind === "channel" ? "add" : action.kind),
                      )),
                    ),
              ),
              createElement(
                "ul",
                {
                  "aria-labelledby": headingId,
                  className: "handrail-chat__conversation-list",
                  hidden: !expanded,
                  id: listId,
                },
                ...(expanded
                  ? section.rows.length === 0
                    ? [createElement(
                        "li",
                        {
                          className: "handrail-chat__conversation-section-empty",
                          key: "empty",
                        },
                        section.emptyCopy,
                      )]
                    : [
                        beforeRowCount === 0
                          ? null
                          : createElement("li", {
                              "aria-hidden": true,
                              className: "handrail-chat__conversation-window-spacer",
                              "data-navigation-window-spacer": "before",
                              "data-spacer-row-count": beforeRowCount,
                              key: "window-before",
                              role: "presentation",
                              style: {
                                blockSize: `${beforeRowCount * CONVERSATION_NAVIGATION_ROW_ESTIMATED_HEIGHT_PX}px`,
                              } satisfies CSSProperties,
                            }),
                        ...mountedSectionRows.map(({ conversation, identity }) => {
                      const index = visibleNavigationIndexByIdentity.get(identity);
                      if (index === undefined) return null;
                      return createElement(ConversationNavigationRow, {
                        buttonRef: (element: HTMLButtonElement | null) => {
                          if (element === null) buttonRefs.current.delete(identity);
                          else buttonRefs.current.set(identity, element);
                        },
                        conversation,
                        ...(props.currentUserId === undefined
                          ? {}
                          : { currentUserId: props.currentUserId }),
                        index,
                        key: identity,
                        onKeyDown: onNavigationKeyDown,
                        onSelect: (conversationId: ConversationId) => {
                          setActiveNavigationRowIdentity(identity);
                          selectConversation(conversationId);
                        },
                        readOnly: props.readOnly ?? false,
                        rowIdentity: identity,
                        selected: selectedConversationId === conversation.id,
                        tabIndex: mountedNavigationTabStopRowIdentity === identity ? 0 : -1,
                      });
                        }),
                        afterRowCount === 0
                          ? null
                          : createElement("li", {
                              "aria-hidden": true,
                              className: "handrail-chat__conversation-window-spacer",
                              "data-navigation-window-spacer": "after",
                              "data-spacer-row-count": afterRowCount,
                              key: "window-after",
                              role: "presentation",
                              style: {
                                blockSize: `${afterRowCount * CONVERSATION_NAVIGATION_ROW_ESTIMATED_HEIGHT_PX}px`,
                              } satisfies CSSProperties,
                            }),
                      ]
                  : []),
              ),
            );
          }),
        ),
    loadMoreControl,
  );

  let detailContent: ReactNode;
  if (listResult.status === "loading" && conversations.length === 0) {
    detailContent = detailStateRegion(
      "workspace-loading",
      "Loading chat workspace…",
    );
  } else if (listResult.status === "error" && conversations.length === 0) {
    detailContent = detailStateRegion(
      "workspace-error",
      "Unable to load chat workspace",
      listResult.error.message,
    );
  } else if (conversations.length === 0) {
    detailContent = createElement(slots.EmptyState, {
      kind: "no_conversation",
      title: "No conversations",
      description: "There are no conversations in this chat scope.",
      hostProps: {
        "aria-live": "polite",
        className: "handrail-chat__state-panel handrail-chat__state-panel--empty",
        "data-state-glyph": "#",
        "data-state-kind": "no-conversation",
        role: "status",
      },
    });
  } else if (selectedConversationId === undefined) {
    detailContent = detailStateRegion(
      "conversation-selecting",
      "Selecting a conversation…",
    );
  } else if (detailResult.status === "error") {
    detailContent = detailStateRegion(
      "conversation-error",
      "Unable to load conversation",
      detailResult.error.message,
    );
  } else if (detailResult.status === "loading") {
    detailContent = detailStateRegion(
      "conversation-loading",
      "Loading conversation…",
    );
  } else if (viewModel === undefined) {
    detailContent = createElement(slots.EmptyState, {
      kind: "unavailable",
      title: "Conversation unavailable",
      description: "The selected conversation is not available.",
      hostProps: {
        "aria-live": "polite",
        className: "handrail-chat__state-panel handrail-chat__state-panel--empty",
        "data-state-glyph": "?",
        "data-state-kind": "conversation-unavailable",
        role: "status",
      },
    });
  } else {
    const bodyProps = Object.freeze({
      conversation: viewModel,
      actions,
      slots,
    });
    const timeline = props.renderTimeline?.(bodyProps) ?? props.children ??
      createElement(MessageTimeline, {
        conversationId: viewModel.id,
        editControllerRef: messageTimelineEditControllerRef,
        introduction: conversationIntroduction,
        ...(props.readOnly === true ? {} : { onForwardMessage: openForwardDialog }),
        onOpenThread: openThreadPanel,
        ...(props.renderThread === undefined ? { onCreateThread: requestThreadCreation } : {}),
        ...(props.renderComposer === undefined ? { onReplyRequested: selectReply } : {}),
        readOnly: props.readOnly ?? false,
        ...(props.composerAvailability === undefined ? {} : { replyAvailability: props.composerAvailability }),
        ...(props.otherMemberReadState === undefined
          ? {}
          : { otherMemberReadState: props.otherMemberReadState }),
        ...(props.currentUserId === undefined ? {} : { currentUserId: props.currentUserId }),
        ...(props.resolveMessageMutationAvailability === undefined
          ? {}
          : { resolveMessageMutationAvailability: props.resolveMessageMutationAvailability }),
        ...(reactionKeys === undefined ? {} : { reactionKeys }),
        slots: {
          Avatar: slots.Avatar,
          Message: slots.Message,
          EmptyState: slots.EmptyState,
          Attachment: slots.Attachment,
          LinkPreview: slots.LinkPreview,
          SystemEvent: slots.SystemEvent,
          EntityReference: slots.EntityReference,
        },
      });
    const thread = props.renderThread === undefined
      ? (threadRootMessageId === undefined && activeDiscoveredThread === undefined
        ? null
        : createElement(ThreadPanel, {
            rootMessageId: activeDiscoveredThread?.rootMessageId ?? threadRootMessageId!,
            ...(activeDiscoveredThread === undefined ? {} : { ...activeDiscoveredThread, closeLabel: "Back to channel threads" }),
            ...(props.threadLifecycleAvailability === undefined ? {} : { lifecycleAvailability: props.threadLifecycleAvailability }),
            onClose: closeThreadPanel,
            returnFocusRef: threadReturnFocusRef,
            readOnly: props.readOnly ?? false,
            ...(props.currentUserId === undefined ? {} : { currentUserId: props.currentUserId }),
            ...(props.resolveMessageMutationAvailability === undefined
              ? {}
              : { resolveMessageMutationAvailability: props.resolveMessageMutationAvailability }),
            ...(reactionKeys === undefined ? {} : { reactionKeys }),
            timelineSlots: {
              Avatar: slots.Avatar,
              Message: slots.Message,
              EmptyState: slots.EmptyState,
              Attachment: slots.Attachment,
              LinkPreview: slots.LinkPreview,
              SystemEvent: slots.SystemEvent,
              EntityReference: slots.EntityReference,
            },
            composerComponents: { Composer: slots.Composer },
            ...(props.composerAvailability === undefined ? {} : { composerAvailability: props.composerAvailability }),
          }))
      : props.renderThread(bodyProps);
    const defaultHuddleIsInHeader = props.renderHuddle === undefined &&
      (workspaceHuddleResult.data?.canonicalState === undefined ||
        workspaceHuddleResult.data.canonicalState.status === "inactive");
    const huddle = props.renderHuddle === undefined
      ? (props.currentUserId === undefined || props.huddlePermissions === undefined
        ? null
        : createElement(HuddleControls, {
            conversationId: viewModel.id,
            currentUserId: props.currentUserId,
            permissions: props.huddlePermissions,
            ...(defaultHuddleIsInHeader ? { presentation: "header" as const } : {}),
            ...(props.huddleMediaSession === undefined ? {} : { mediaSession: props.huddleMediaSession }),
            ...(props.huddleMediaRenderer === undefined ? {} : { mediaRenderer: props.huddleMediaRenderer }),
            ...(props.huddleParticipantLabel === undefined ? {} : { participantLabel: props.huddleParticipantLabel }),
            ...(props.huddleDisabled === undefined ? {} : { disabled: props.huddleDisabled }),
          }))
      : props.renderHuddle(bodyProps);
    const headerHuddle = defaultHuddleIsInHeader ? huddle : null;
    const conversationHuddle = defaultHuddleIsInHeader ? null : huddle;
    const composer = props.renderComposer === undefined
      ? createElement(MessageComposer, {
          controlsRef: composerControlsRef,
          conversationId: viewModel.id,
          conversation: viewModel,
          inputLabel: contextualComposerLabel,
          placeholder: contextualComposerLabel,
          readOnly: props.readOnly ?? false,
          components: { Composer: slots.Composer },
          onEditLatestMessage: requestLatestMessageEdit,
          ...(props.composerAvailability === undefined ? {} : { availability: props.composerAvailability }),
        })
      : props.renderComposer(bodyProps);
    const canViewMemberManagement =
      props.memberManagementAvailability?.canView === true;
    const memberCount = membersResult.data?.members.length ?? 0;
    const memberCountLabel = `${memberCount} ${
      memberCount === 1 ? "member" : "members"
    }`;
    const memberManagementOpen = canViewMemberManagement &&
      memberManagementConversationId === viewModel.id;
    const memberManagement = !memberManagementOpen
      ? null
      : createElement(
          "aside",
          {
            "aria-labelledby": memberManagementTitleId,
            className: "handrail-chat__member-management-panel",
            id: memberManagementPanelId,
            onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              event.stopPropagation();
              closeMemberManagement();
            },
            role: "dialog",
          },
          createElement(
            "div",
            { className: "handrail-chat__member-management-panel-header" },
            createElement(
              "h2",
              {
                className: "handrail-chat__member-management-panel-title",
                id: memberManagementTitleId,
              },
              "Conversation members",
            ),
            createElement(
              "button",
              {
                "aria-label": "Close conversation members",
                autoFocus: true,
                className: "handrail-chat__member-management-panel-close",
                onClick: () => closeMemberManagement(),
                type: "button",
              },
              paneControlIcon("close"),
            ),
          ),
          createElement(MemberManagement, {
            actions,
            availability: props.memberManagementAvailability,
            conversationId: viewModel.id,
            key: viewModel.id,
            members: membersResult.data?.members ?? [],
            ...(membersResult.data?.memberListRevision === undefined
              ? {}
              : { memberListRevision: membersResult.data.memberListRevision }),
            ...(membersResult.status === "error"
              ? { membersError: membersResult.error.message }
              : {}),
            membersLoading: membersResult.status === "loading",
            readOnly: props.readOnly ?? false,
          }),
        );
    detailContent = createElement(
      "div",
      {
        className: "handrail-chat__conversation",
        "data-conversation-id": viewModel.id,
      },
      createElement(
        "header",
        { className: "handrail-chat__header" },
        isCompactLayout
          ? createElement(
              "button",
              {
                "aria-label": "Back to conversations",
                className: "handrail-chat__compact-back",
                "data-handrail-focus": true,
                onClick: returnToConversations,
                type: "button",
              },
              paneControlIcon("back"),
              createElement("span", null, "Back to conversations"),
            )
          : null,
        createElement(ConversationHeaderMenu, {
          conversationId: viewModel.id,
          identityLabel: conversationIntroduction.identity,
          readOnly: props.readOnly ?? false,
        }),
        createElement(
          "div",
          {
            className: [
              "handrail-chat__header-identity",
              viewModel.type === "channel"
                ? "handrail-chat__header-identity--channel"
                : "handrail-chat__header-identity--member",
            ].join(" "),
          },
          viewModel.type === "channel" || viewModel.type === "group_direct" ||
              (viewModel.type === "direct"
                ? directParticipantUser === undefined
                : avatarUser === undefined)
            ? null
            : createElement(slots.Avatar, {
                user: viewModel.type === "direct"
                  ? directParticipantUser as HostDirectoryUserSummary
                  : avatarUser as HostDirectoryUserSummary,
                size: "medium",
                hostProps: { "aria-hidden": true },
              }),
          viewModel.type === "direct"
            ? createElement(
                "div",
                { className: "handrail-chat__direct-participant" },
                createElement(
                  "h2",
                  {
                    ...(membersResult.status === "loading"
                      ? { "aria-busy": true }
                      : {}),
                    className: "handrail-chat__direct-participant-title",
                    id: titleId,
                    ...(directParticipantUser?.kind === "active"
                      ? { title: directParticipantUser.displayName }
                      : {}),
                  },
                  directParticipantUser === undefined
                    ? resolvedDirectParticipantLabel
                    : createElement(slots.User, {
                        user: directParticipantUser,
                        actions,
                        hostProps: {},
                      }),
                ),
                directParticipantAvailability === undefined
                  ? null
                  : createElement("span", {
                      "aria-label": `${directParticipantAvailability} availability`,
                      className: "handrail-chat__direct-participant-availability",
                      "data-availability": directParticipantAvailability,
                      role: "img",
                    }),
              )
            : viewModel.type === "group_direct"
              ? createElement(
                  "div",
                  { className: "handrail-chat__group-direct-participants" },
                  groupDirectParticipants.length === 0
                    ? null
                    : createElement(
                        "div",
                        {
                          "aria-label": "Participant avatars",
                          className: "handrail-chat__group-direct-avatar-stack",
                          role: "group",
                        },
                        ...visibleGroupDirectParticipants.map((participant) =>
                          participant.user === undefined
                            ? createElement(
                                "span",
                                {
                                  "aria-hidden": true,
                                  className:
                                    "handrail-chat__group-direct-avatar-fallback",
                                  key: participant.userId,
                                },
                                "?",
                              )
                            : createElement(slots.Avatar, {
                                user: participant.user,
                                size: "medium",
                                hostProps: {
                                  "aria-hidden": true,
                                  className:
                                    "handrail-chat__group-direct-participant-avatar",
                                },
                                key: participant.userId,
                              })),
                        hiddenGroupDirectParticipantCount === 0
                          ? null
                          : createElement(
                              "span",
                              {
                                "aria-label": `${hiddenGroupDirectParticipantCount} more ${
                                  hiddenGroupDirectParticipantCount === 1
                                    ? "participant"
                                    : "participants"
                                }`,
                                className:
                                  "handrail-chat__group-direct-avatar-overflow",
                                title: `${hiddenGroupDirectParticipantCount} more ${
                                  hiddenGroupDirectParticipantCount === 1
                                    ? "participant"
                                    : "participants"
                                }`,
                              },
                              `+${hiddenGroupDirectParticipantCount}`,
                            ),
                      ),
                  createElement(
                    "h2",
                    {
                      "aria-label": groupDirectLabel,
                      ...(membersResult.status === "loading"
                        ? { "aria-busy": true }
                        : {}),
                      className: "handrail-chat__group-direct-participant-title",
                      id: titleId,
                      title: groupDirectLabel,
                    },
                    groupDirectLabel,
                  ),
                )
            : createElement(
                Fragment,
                null,
                viewModel.type === "channel" || avatarUser === undefined
                  ? null
                  : createElement(slots.User, {
                      user: avatarUser,
                      actions,
                      hostProps: {},
                    }),
                createElement(slots.ChannelHeader, {
                  conversation: viewModel,
                  actions,
                  hostProps: { id: titleId },
                }),
              ),
        ),
        createElement(
          "div",
          {
            "aria-label": "Conversation actions",
            className: "handrail-chat__header-actions",
            role: "group",
          },
          headerHuddle,
          viewModel.type === "channel" && props.renderThread === undefined && (replyStyle.effectiveStyle === "discord" || threadDiscoveryOpen)
            ? createElement("button", {
                type: "button", className: "handrail-chat__button", "aria-label": "Browse channel threads",
                "aria-expanded": threadDiscoveryOpen, ref: discoveryTriggerRef,
                onClick: () => { setThreadRootMessageId(undefined); setDiscoveredThread(undefined); setThreadDiscoveryScope(threadCreationScope); },
              }, "Threads") : null,
          !hasMessageSearchCapability
            ? null
            : createElement(
                "button",
                {
                  "aria-controls": messageSearchPanelId,
                  "aria-expanded": messageSearchOpen,
                  "aria-label": "Search messages",
                  className: "handrail-chat__message-search-trigger",
                  onClick: () => setMessageSearchOpen(true),
                  ref: messageSearchTriggerRef,
                  title: "Search messages",
                  type: "button",
                },
                createElement(
                  "svg",
                  {
                    "aria-hidden": true,
                    className: "handrail-chat__message-search-trigger-icon",
                    fill: "none",
                    viewBox: "0 0 24 24",
                  },
                  createElement("circle", { cx: 11, cy: 11, r: 6 }),
                  createElement("path", { d: "m16 16 4 4" }),
                ),
              ),
          !canViewMemberManagement
            ? null
            : createElement(
                "button",
                {
                  "aria-controls": memberManagementPanelId,
                  "aria-expanded": memberManagementOpen,
                  "aria-label": `Open conversation members (${memberCountLabel})`,
                  className: "handrail-chat__member-management-trigger",
                  "data-conversation-id": viewModel.id,
                  onClick: () => setMemberManagementConversationId(viewModel.id),
                  ref: memberManagementTriggerRef,
                  title: `Open conversation members (${memberCountLabel})`,
                  type: "button",
                },
                createElement(
                  "svg",
                  {
                    "aria-hidden": true,
                    className: "handrail-chat__member-management-icon",
                    fill: "none",
                    focusable: "false",
                    viewBox: "0 0 24 24",
                  },
                  createElement("path", {
                    d: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2",
                  }),
                  createElement("circle", { cx: 9, cy: 7, r: 4 }),
                  createElement("path", { d: "M22 21v-2a4 4 0 0 0-3-3.87" }),
                  createElement("path", { d: "M16 3.13a4 4 0 0 1 0 7.75" }),
                ),
                createElement(
                  "span",
                  {
                    "aria-hidden": true,
                    className: "handrail-chat__member-management-count",
                  },
                  String(memberCount),
                ),
              ),
          currentPreference === undefined
            ? null
            : createElement(NotificationPreferences, {
                actions,
                key: viewModel.id,
                preference: currentPreference,
                readOnly: props.readOnly ?? false,
              }),
        ),
      ),
      messageSearchControl,
      createElement(
        "main",
        {
          "aria-labelledby": titleId,
          className: "handrail-chat__main",
          tabIndex: -1,
        },
        createElement(
          "div",
          {
            className: [
              "handrail-chat__conversation-body",
              thread === null && !threadDiscoveryOpen
                ? undefined
                : "handrail-chat__conversation-body--thread-open",
            ].filter(Boolean).join(" "),
          },
          createElement(
            "section",
            { "aria-label": "Conversation timeline", className: "handrail-chat__timeline" },
            timeline,
          ),
          thread === null && !threadDiscoveryOpen
            ? null
            : createElement(
              "section",
              { "aria-label": "Conversation thread", className: "handrail-chat__thread" },
              threadDiscoveryOpen && viewModel.type === "channel" ? createElement(ThreadList, {
                key: `${threadCreationIdentity}:${viewModel.id}`,
                parentConversationId: viewModel.id, parentLabel: viewModel.name ?? "channel",
                hidden: activeDiscoveredThread !== undefined,
                onBack: closeDiscovery,
                onUnavailable: closeThreadPanel,
                onOpen: (selection, target) => {
                  if (threadCreationScopeRef.current !== threadCreationScope) return;
                  threadReturnFocusRef.current = target;
                  setThreadRootMessageId(undefined);
                  setDiscoveredThread(selection);
                },
              }) : null,
              thread,
            ),
        ),
        conversationHuddle === null
          ? null
          : createElement(
              "section",
              {
                "aria-label": "Conversation huddle",
                className: "handrail-chat__huddle handrail-chat__huddle--call-bar",
              },
              conversationHuddle,
            ),
      ),
      memberManagement,
      createElement(
        "footer",
        { "aria-label": "Conversation composer", className: "handrail-chat__composer-region" },
        createElement(ConversationTypingIndicator, {
          conversationId: viewModel.id,
          ...(props.currentUserId === undefined ? {} : { currentUserId: props.currentUserId }),
        }),
        composer,
      ),
    );
  }

  const rootClassName = [
    "handrail-chat",
    "handrail-chat--workspace",
    `handrail-chat--${mode}`,
    props.className,
  ].filter(Boolean).join(" ");
  const ordinaryWorkspaceContentInert = forwardRequest !== undefined ||
    channelDialogOpen || directDialogOpen || groupDirectDialogOpen || replyStyleSettingsOpen || activeThreadCreationRequest !== undefined;

  return createElement(
    "section",
    {
      "aria-label": props.ariaLabel ?? "Chat workspace",
      "aria-modal": mode === "modal" ? true : undefined,
      className: rootClassName,
      "data-handrail-chat-mode": mode,
      "data-handrail-chat-scope": props.scope.type,
      "data-handrail-compact-layout": isCompactLayout ? "true" : "false",
      "data-handrail-compact-pane": isCompactLayout ? compactPane : undefined,
      "data-handrail-theme": props.theme,
      onFocusCapture: claimBodyShortcut,
      onKeyDown: onWorkspaceKeyDown,
      onPointerDownCapture: claimBodyShortcut,
      role: mode === "modal" ? "dialog" : undefined,
      ref: rootRef,
      style: props.style,
      tabIndex: mode === "modal" ? -1 : undefined,
    },
    createElement(
      "div",
      {
        className: "handrail-chat__workspace-content",
        inert: ordinaryWorkspaceContentInert ? true : undefined,
        style: { display: "contents" },
      },
      navigation,
    ),
    channelCreationControl,
    activeThreadCreationRequest === undefined ? null : createElement(ThreadCreationDialog, {
      key: activeThreadCreationRequest.rootMessageId,
      request: activeThreadCreationRequest,
      disabledReason: threadCreationDisabledReason,
      onCancel: () => setThreadCreationRequest(undefined),
      onCreated: () => {
        if (threadCreationScopeRef.current !== threadCreationScope) return;
        setThreadCreationRequest(undefined);
        openThreadPanel(activeThreadCreationRequest.rootMessageId, activeThreadCreationRequest.returnFocusTarget);
      },
    }),
    replyStyleSettingsOpen ? createElement(ReplyStyleSettingsDialog, {
      onClose: () => setReplyStyleSettingsOpen(false),
    }) : null,
    directCreationControl,
    groupDirectCreationControl,
    forwardNotice === undefined
      ? null
      : forwardNotice.kind === "error"
        ? errorRegion(forwardNotice.message)
        : statusRegion(forwardNotice.message),
    forwardRequest === undefined
      ? null
      : createElement(ForwardMessageDialog, {
          destinations: forwardDestinations,
          onCancel: () => closeForwardDialog(),
          onFailure: () => closeForwardDialog({
            kind: "error",
            message: "The message could not be forwarded. Try again.",
          }),
          onSuccess: navigateToForwardedMessage,
          source: forwardRequest.source,
        }),
    createElement(
      "div",
      {
        "aria-busy":
          listResult.status === "loading" ||
          (conversations.length > 0 && selectedConversationId === undefined) ||
          (selectedConversationId !== undefined && detailResult.status === "loading"),
        className: "handrail-chat__detail handrail-chat__workspace-content",
        hidden: isCompactLayout && compactPane !== "detail",
        inert: ordinaryWorkspaceContentInert ? true : undefined,
      },
      detailContent,
    ),
  );
}
