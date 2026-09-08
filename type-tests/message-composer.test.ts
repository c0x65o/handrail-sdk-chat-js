import { createElement, createRef, type ComponentType } from "react";

import {
  MessageComposer,
  type ChatComposerSlotProps,
  type ChatComposerControls,
  type ChatComposerState,
  type ChatConversationViewModel,
} from "../src/ui/index.js";

declare const conversation: ChatConversationViewModel;
declare const state: ChatComposerState;

const Override = ((props: ChatComposerSlotProps) => {
  if (props.state.replyTo !== undefined) {
    props.controls.selectReply({ conversationId: props.conversation.id, messageId: props.state.replyTo.messageId });
    props.controls.setReplyNotifyAuthor(false);
    const ping: boolean = props.state.replyTo.notifyAuthor;
    const preview: string | undefined = props.state.replyContext?.preview;
    void [ping, preview];
  }
  props.controls.clearReply();
  void props.controls.retryReplySource();
  // @ts-expect-error The source conversation is required; replies cannot silently retarget a send.
  props.controls.selectReply({ messageId: props.state.replyTo!.messageId });
  // @ts-expect-error Ping choices are explicit booleans.
  props.controls.setReplyNotifyAuthor("false");
  props.controls.setText(props.state.text);
  props.controls.setFormat("markdown");
  void props.controls.send();
  return null;
}) satisfies ComponentType<ChatComposerSlotProps>;

const composer = createElement(MessageComposer, {
  conversationId: conversation.id,
  controlsRef: createRef<ChatComposerControls>(),
  conversation,
  availability: { membershipState: "active", canSend: true },
  components: { Composer: Override },
  inputLabel: "Reply",
});

const privateState: ChatComposerState = {
  ...state,
  // @ts-expect-error Secret-bearing fields cannot enter normalized Composer state.
  accessToken: "private",
};

void [composer, privateState];
