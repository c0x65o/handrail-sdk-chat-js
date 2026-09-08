import { useContext, useMemo } from "react";

import type {
  ChatClient,
  ChatDeleteMessageInput,
  ChatDeleteMessageResult,
  ChatEditMessageInput,
  ChatEditMessageResult,
  ChatForwardMessageResult,
  ChatSetMessageReminderInput,
  ChatSendMessageInput,
  ChatSendMessageResult,
  ChatSetConversationArchiveInput,
  ChatSetThreadFollowInput,
  ChatUpdateConversationPreferenceInput,
} from "../client/create-chat-client.js";
import type {
  ChatAttachmentUploadHandle,
  ChatAttachmentUploadInput,
} from "../client/attachment-uploader.js";
import type {
  ChatCloseDraftOptions,
  ChatConversationDraftState,
  ChatDraftFlushResult,
  ChatReplaceDraftInput,
} from "../client/draft-runtime.js";
import type {
  ChatMarkReadInput,
  ChatMarkUnreadInput,
} from "../client/read-state.js";
import type { ConversationId } from "../contracts/identifiers.js";
import type { MessageBlock } from "../contracts/message.js";
import { ChatContext } from "./index.js";

type WithoutConversationId<Input> = Omit<Input, "conversationId">;

export type ChatSendMessageActionInput<
  Block extends MessageBlock = MessageBlock,
> = WithoutConversationId<ChatSendMessageInput<Block>>;
export type ChatArchiveConversationActionInput =
  WithoutConversationId<ChatSetConversationArchiveInput>;
export type ChatJoinConversationActionInput = WithoutConversationId<
  Parameters<ChatClient["joinConversation"]>[0]
>;
export type ChatLeaveConversationActionInput = WithoutConversationId<
  Parameters<ChatClient["leaveConversation"]>[0]
>;
export type ChatAddConversationMemberActionInput = WithoutConversationId<
  Parameters<ChatClient["addConversationMember"]>[0]
>;
export type ChatRemoveConversationMemberActionInput = WithoutConversationId<
  Parameters<ChatClient["removeConversationMember"]>[0]
>;
export type ChatChangeConversationMemberRoleActionInput = WithoutConversationId<
  Parameters<ChatClient["changeConversationMemberRole"]>[0]
>;
export type ChatMarkReadActionInput = WithoutConversationId<ChatMarkReadInput>;
export type ChatMarkUnreadActionInput = WithoutConversationId<ChatMarkUnreadInput>;
export type ChatReplaceDraftActionInput = WithoutConversationId<ChatReplaceDraftInput>;
export type ChatUpdateConversationPreferenceActionInput =
  WithoutConversationId<ChatUpdateConversationPreferenceInput>;
export type ChatSetThreadFollowActionInput =
  WithoutConversationId<ChatSetThreadFollowInput>;
export type ChatUploadAttachmentActionInput =
  WithoutConversationId<ChatAttachmentUploadInput>;
export type ChatSetMessageReminderActionInput =
  WithoutConversationId<ChatSetMessageReminderInput>;

/** Stable headless commands backed exclusively by the provider's public client. */
export interface ChatActions {
  sendMessage<Block extends MessageBlock = MessageBlock>(
    input: ChatSendMessageActionInput<Block>,
  ): Promise<ChatSendMessageResult<Block>>;
  retryMessage: ChatClient["retryMessage"];
  forwardMessage(
    sourceMessageId: Parameters<ChatClient["forwardMessage"]>[0]["sourceMessageId"],
  ): Promise<ChatForwardMessageResult>;
  editMessage<Block extends MessageBlock = MessageBlock>(
    input: ChatEditMessageInput<Block>,
  ): Promise<ChatEditMessageResult<Block>>;
  deleteMessage<Block extends MessageBlock = MessageBlock>(
    input: ChatDeleteMessageInput,
  ): Promise<ChatDeleteMessageResult<Block>>;
  setReaction: ChatClient["setReaction"];

  createChannel: ChatClient["createChannel"];
  createDirect: ChatClient["createDirect"];
  createGroupDirect: ChatClient["createGroupDirect"];
  archiveConversation(
    input: ChatArchiveConversationActionInput,
  ): ReturnType<ChatClient["archiveConversation"]>;
  restoreConversation(
    input: ChatArchiveConversationActionInput,
  ): ReturnType<ChatClient["restoreConversation"]>;
  joinConversation(
    input: ChatJoinConversationActionInput,
  ): ReturnType<ChatClient["joinConversation"]>;
  leaveConversation(
    input: ChatLeaveConversationActionInput,
  ): ReturnType<ChatClient["leaveConversation"]>;
  addConversationMember(
    input: ChatAddConversationMemberActionInput,
  ): ReturnType<ChatClient["addConversationMember"]>;
  removeConversationMember(
    input: ChatRemoveConversationMemberActionInput,
  ): ReturnType<ChatClient["removeConversationMember"]>;
  changeConversationMemberRole(
    input: ChatChangeConversationMemberRoleActionInput,
  ): ReturnType<ChatClient["changeConversationMemberRole"]>;

  markRead(input: ChatMarkReadActionInput): ReturnType<ChatClient["markRead"]>;
  markUnread(
    input: ChatMarkUnreadActionInput,
  ): ReturnType<ChatClient["markUnread"]>;
  openThread: ChatClient["openThread"];
  createThread: ChatClient["createThread"];

  openConversationDraft(): Promise<ChatConversationDraftState>;
  replaceConversationDraft(
    input: ChatReplaceDraftActionInput,
  ): ChatConversationDraftState;
  clearConversationDraft(): ChatConversationDraftState;
  flushConversationDraft(): Promise<ChatDraftFlushResult>;
  retryConversationDraft(): Promise<ChatDraftFlushResult>;
  closeConversationDraft(
    options?: ChatCloseDraftOptions,
  ): Promise<ChatDraftFlushResult>;

  updateConversationPreference(
    input: ChatUpdateConversationPreferenceActionInput,
  ): ReturnType<ChatClient["updateConversationPreference"]>;
  setThreadFollow(
    input: ChatSetThreadFollowActionInput,
  ): ReturnType<ChatClient["setThreadFollow"]>;
  followThread(): ReturnType<ChatClient["followThread"]>;
  unfollowThread(): ReturnType<ChatClient["unfollowThread"]>;
  saveMessage: ChatClient["saveMessage"];
  unsaveMessage: ChatClient["unsaveMessage"];
  retrySavedMessage: ChatClient["retrySavedMessage"];
  setMessageReminder(
    input: ChatSetMessageReminderActionInput,
  ): ReturnType<ChatClient["setMessageReminder"]>;
  cancelMessageReminder(messageId: Parameters<ChatClient["cancelMessageReminder"]>[0]["messageId"]): ReturnType<ChatClient["cancelMessageReminder"]>;
  retryMessageReminder: ChatClient["retryMessageReminder"];

  uploadAttachment(
    input: ChatUploadAttachmentActionInput,
  ): ChatAttachmentUploadHandle;
  startTyping(visibility?: "public" | "private"): boolean;
  stopTyping(): void;
  setPresence: ChatClient["setPresence"];
  notifyActivity: ChatClient["notifyActivity"];

  hydrateHuddle(): ReturnType<ChatClient["hydrateHuddle"]>;
  startHuddle(): ReturnType<ChatClient["startHuddle"]>;
  joinHuddle(): ReturnType<ChatClient["joinHuddle"]>;
  leaveHuddle(): ReturnType<ChatClient["leaveHuddle"]>;
  setHuddleScreenShare(): ReturnType<ChatClient["setHuddleScreenShare"]>;
  clearHuddleScreenShare(): ReturnType<ChatClient["clearHuddleScreenShare"]>;
  endHuddle(): ReturnType<ChatClient["endHuddle"]>;
  retryHuddle(): ReturnType<ChatClient["retryHuddle"]>;
  rejoinHuddle(): ReturnType<ChatClient["rejoinHuddle"]>;
}

const missingConversation = (action: keyof ChatActions): never => {
  throw new TypeError(
    `useChatActions.${action} requires a conversationId; pass one to useChatActions(conversationId).`,
  );
};

/**
 * Returns stable callbacks for the public ChatClient action surface. Conversation-
 * scoped callbacks bind `conversationId`; all other arguments pass through unchanged.
 */
export function useChatActions(conversationId?: ConversationId): ChatActions {
  const context = useContext(ChatContext);
  const client = context?.client;
  const requireConversation = (action: keyof ChatActions): ConversationId =>
    conversationId === undefined ? missingConversation(action) : conversationId;

  const actions = useMemo<ChatActions | null>(() => {
    if (client === undefined) return null;
    const actions: ChatActions = {
      sendMessage<Block extends MessageBlock = MessageBlock>(
        input: ChatSendMessageActionInput<Block>,
      ) {
        return client.sendMessage({
          ...input,
          conversationId: requireConversation("sendMessage"),
        });
      },
      retryMessage<Block extends MessageBlock = MessageBlock>(
        clientMessageId: string,
      ) {
        return client.retryMessage<Block>(clientMessageId);
      },
      forwardMessage: (sourceMessageId) => client.forwardMessage({
        sourceMessageId,
        destinationConversationId: requireConversation("forwardMessage"),
      }),
      editMessage<Block extends MessageBlock = MessageBlock>(
        input: ChatEditMessageInput<Block>,
      ) {
        return client.editMessage(input);
      },
      deleteMessage<Block extends MessageBlock = MessageBlock>(
        input: ChatDeleteMessageInput,
      ) {
        return client.deleteMessage<Block>(input);
      },
      setReaction: (input) => client.setReaction(input),

      createChannel: (input) => client.createChannel(input),
      createDirect: (input) => client.createDirect(input),
      createGroupDirect: (input) => client.createGroupDirect(input),
      archiveConversation: (input) => client.archiveConversation({
        ...input,
        conversationId: requireConversation("archiveConversation"),
      }),
      restoreConversation: (input) => client.restoreConversation({
        ...input,
        conversationId: requireConversation("restoreConversation"),
      }),
      joinConversation: (input) => client.joinConversation({
        ...input,
        conversationId: requireConversation("joinConversation"),
      }),
      leaveConversation: (input) => client.leaveConversation({
        ...input,
        conversationId: requireConversation("leaveConversation"),
      }),
      addConversationMember: (input) => client.addConversationMember({
        ...input,
        conversationId: requireConversation("addConversationMember"),
      }),
      removeConversationMember: (input) => client.removeConversationMember({
        ...input,
        conversationId: requireConversation("removeConversationMember"),
      }),
      changeConversationMemberRole: (input) =>
        client.changeConversationMemberRole({
          ...input,
          conversationId: requireConversation("changeConversationMemberRole"),
        }),

      markRead: (input) => client.markRead({
        ...input,
        conversationId: requireConversation("markRead"),
      }),
      markUnread: (input) => client.markUnread({
        ...input,
        conversationId: requireConversation("markUnread"),
      }),
      openThread: (rootMessageId) => client.openThread(rootMessageId),
      createThread: (input) => client.createThread(input),

      openConversationDraft: () =>
        client.openConversationDraft(requireConversation("openConversationDraft")),
      replaceConversationDraft: (input) => client.replaceConversationDraft({
        ...input,
        conversationId: requireConversation("replaceConversationDraft"),
      }),
      clearConversationDraft: () =>
        client.clearConversationDraft(requireConversation("clearConversationDraft")),
      flushConversationDraft: () =>
        client.flushConversationDraft(requireConversation("flushConversationDraft")),
      retryConversationDraft: () =>
        client.retryConversationDraft(requireConversation("retryConversationDraft")),
      closeConversationDraft: (options) => {
        const id = requireConversation("closeConversationDraft");
        return options === undefined
          ? client.closeConversationDraft(id)
          : client.closeConversationDraft(id, options);
      },

      updateConversationPreference: (input) =>
        client.updateConversationPreference({
          ...input,
          conversationId: requireConversation("updateConversationPreference"),
        }),
      setThreadFollow: (input) => client.setThreadFollow({
        ...input,
        threadId: requireConversation("setThreadFollow"),
      }),
      followThread: () => client.followThread(requireConversation("followThread")),
      unfollowThread: () =>
        client.unfollowThread(requireConversation("unfollowThread")),
      saveMessage: (input) => client.saveMessage(input),
      unsaveMessage: (input) => client.unsaveMessage(input),
      retrySavedMessage: (messageId) => client.retrySavedMessage(messageId),
      setMessageReminder: (input) => client.setMessageReminder({
        ...input,
        conversationId: requireConversation("setMessageReminder"),
      }),
      cancelMessageReminder: (messageId) => client.cancelMessageReminder({
        messageId,
        conversationId: requireConversation("cancelMessageReminder"),
      }),
      retryMessageReminder: (messageId) => client.retryMessageReminder(messageId),

      uploadAttachment: (input) => client.uploadAttachment({
        ...input,
        conversationId: requireConversation("uploadAttachment"),
      }),
      startTyping: (visibility) => {
        const id = requireConversation("startTyping");
        return visibility === undefined
          ? client.startTyping(id)
          : client.startTyping(id, visibility);
      },
      stopTyping: () => client.stopTyping(requireConversation("stopTyping")),
      setPresence: (state) => client.setPresence(state),
      notifyActivity: () => client.notifyActivity(),

      hydrateHuddle: () =>
        client.hydrateHuddle(requireConversation("hydrateHuddle")),
      startHuddle: () => client.startHuddle(requireConversation("startHuddle")),
      joinHuddle: () => client.joinHuddle(requireConversation("joinHuddle")),
      leaveHuddle: () => client.leaveHuddle(requireConversation("leaveHuddle")),
      setHuddleScreenShare: () =>
        client.setHuddleScreenShare(requireConversation("setHuddleScreenShare")),
      clearHuddleScreenShare: () =>
        client.clearHuddleScreenShare(
          requireConversation("clearHuddleScreenShare"),
        ),
      endHuddle: () => client.endHuddle(requireConversation("endHuddle")),
      retryHuddle: () => client.retryHuddle(requireConversation("retryHuddle")),
      rejoinHuddle: () => client.rejoinHuddle(requireConversation("rejoinHuddle")),
    };
    return Object.freeze(actions);
  }, [client, conversationId]);
  if (actions === null) {
    throw new TypeError("useChatActions must be used inside ChatProvider.");
  }
  return actions;
}
