import { createElement, type ReactNode } from "react";
import type { ChatHuddleMediaSession } from "../src/client/index.js";

import type {
  ConversationId,
  ConversationSnapshotScope,
  UserId,
} from "../src/contracts/index.js";
import {
  ChatWorkspace,
  MessageTimeline,
  ThreadPanel,
  type ChatWorkspaceBodyProps,
  type ChatWorkspaceGroupDirectCreationAvailability,
  type ChatWorkspaceMemberManagementAvailability,
  type ChatWorkspaceMessageSearchNavigation,
  type ChatWorkspaceMode,
  type ChatWorkspaceProps,
  type MessageMutationAvailabilityResolver,
} from "../src/ui/index.js";

declare const conversationId: ConversationId;
declare const currentUserId: UserId;
declare const body: ChatWorkspaceBodyProps;
declare const huddleMediaSession: ChatHuddleMediaSession;

const resolveMessageMutationAvailability = (({ authorUserId }) => ({
  canEdit: authorUserId === currentUserId,
  canDelete: true,
})) satisfies MessageMutationAvailabilityResolver;

const organizationScope = {
  type: "organization",
} satisfies ConversationSnapshotScope;
const entityScope = {
  type: "entity",
  entity: { type: "invoice", id: "INV-42" },
} satisfies ConversationSnapshotScope;
const modes = [
  "full-screen",
  "side-panel",
  "modal",
  "record",
] satisfies readonly ChatWorkspaceMode[];
const groupDirectCreationAvailability = {
  canCreate: true,
} satisfies ChatWorkspaceGroupDirectCreationAvailability;
const memberManagementAvailability = {
  canView: true,
  canAddMember: (user) => user.kind === "active",
  canRemoveMember: (member) => member.membership?.state === "active",
} satisfies ChatWorkspaceMemberManagementAvailability;

const renderBody = ({ conversation, actions, slots }: ChatWorkspaceBodyProps): ReactNode => {
  return createElement(slots.ChannelHeader, {
    conversation,
    actions,
    hostProps: {},
  });
};

const controlled = {
  scope: entityScope,
  conversationId: null,
  onConversationChange: (_next: ConversationId) => undefined,
  mode: "record",
  onModalCloseRequest: () => undefined,
  renderTimeline: renderBody,
  renderComposer: renderBody,
  renderThread: renderBody,
  renderHuddle: renderBody,
  reactionKeys: ["👍", "eyes"] as const,
  directCreationAvailability: { canCreate: true },
  groupDirectCreationAvailability,
  memberManagementAvailability,
  onMessageSearchResultActivate: async (
    navigation: ChatWorkspaceMessageSearchNavigation,
  ) => {
    navigation.result.snippet.toUpperCase();
    await navigation.navigateDefault();
  },
  currentUserId,
  resolveMessageMutationAvailability,
} satisfies ChatWorkspaceProps;

const uncontrolled = createElement(ChatWorkspace, {
  scope: organizationScope,
  defaultConversationId: conversationId,
  children: createElement("div"),
  readOnly: true,
  currentUserId: "host-user" as never,
  huddleMediaSession,
  huddlePermissions: {
    canStart: true,
    canJoin: true,
    canLeave: true,
    canControlMicrophone: true,
    canShareScreen: true,
    canSelectDevices: true,
    canRetry: true,
    canRejoin: true,
    canEnd: true,
  },
});

const invalidModeProps: ChatWorkspaceProps = {
  scope: organizationScope,
  // @ts-expect-error ChatWorkspace exposes only the four documented modes.
  mode: "drawer",
};

const timeline = createElement(MessageTimeline, {
  conversationId,
  currentUserId,
  resolveMessageMutationAvailability,
});
const thread = createElement(ThreadPanel, {
  rootMessageId: "message-id" as never,
  currentUserId,
  resolveMessageMutationAvailability,
});

void [body, controlled, invalidModeProps, modes, renderBody, thread, timeline, uncontrolled];
