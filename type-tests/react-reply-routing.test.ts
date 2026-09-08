import type { ConversationId, MessageId } from "../src/contracts/index.js";
declare const conversationId: ConversationId;
declare const messageId: MessageId;
import { createElement, createRef } from "react";
import { MessageTimeline, MessageComposer, ThreadPanel, type ChatMessageActions, type ChatComposerControls,
  type MessageTimelineProps } from "../src/ui/index.js";
const controls = createRef<ChatComposerControls>();
const select: NonNullable<MessageTimelineProps["onReplyRequested"]> = source => controls.current?.selectReply(source);
createElement(MessageTimeline, { conversationId, onReplyRequested: select,
  readOnly: false, replyAvailability: { canSend: true } });
createElement(MessageComposer, { conversationId, controlsRef: controls });
createElement(ThreadPanel, { rootMessageId: messageId, composerAvailability: { canSend: false } });
function customMessage(actions: ChatMessageActions) {
  actions.selectReply?.(messageId);
  const explanation: string | undefined = actions.replyDisabledReason;
  void explanation;
  // @ts-expect-error Inline selection accepts a message identity, not a destination override.
  actions.selectReply?.({ conversationId: "another", messageId: "source" });
}
void customMessage;
// @ts-expect-error Source identity must include the current conversation.
select({ messageId });

import type { ChatActions } from "../src/react/index.js";
declare const actions: ChatActions;
void actions.createThread({ rootMessageId: messageId, name: "Launch date" });
// @ts-expect-error The public bridge preserves the client name type.
void actions.createThread({ rootMessageId: messageId, name: 42 });
createElement(MessageTimeline, { conversationId, onCreateThread: (root, target) => { void root; void target; } });
