import { createElement } from "react";
import { useReplyStyle, useReplyStyleActions, type ReplyStyleActions } from "../src/react/index.js";
import { ReplyStyleSettings, type ReplyStyleSettingsProps } from "../src/ui/index.js";
import type { ChatReplyStyleState } from "../src/client/index.js";

function HostSettings() {
  const state: ChatReplyStyleState = useReplyStyle();
  const actions: ReplyStyleActions = useReplyStyleActions();
  void actions.load();
  void actions.update("discord");
  void actions.update("current");
  void actions.retry();
  // @ts-expect-error Only canonical choices can be saved.
  void actions.update("Discord-style");
  const props: ReplyStyleSettingsProps = { className: state.origin };
  return createElement(ReplyStyleSettings, props);
}
void HostSettings;
