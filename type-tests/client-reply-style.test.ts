import { createChatClient, type ChatReplyStyle, type ChatReplyStyleState, type ReplyStylePreferenceState } from "../src/client/index.js";
const client = createChatClient({ endpoint: "/chat", getAccessToken: () => "token", replyStyle: { hostDefault: "discord", enforcedOverride: "current" } });
const api: ChatReplyStyle = client.replyStyle;
const state: ChatReplyStyleState = api.select();
const confirmed: ReplyStylePreferenceState | undefined = state.confirmedPreference;
const load: Promise<ChatReplyStyleState> = api.load();
const update: Promise<ChatReplyStyleState> = api.update("discord");
const retry: Promise<ChatReplyStyleState> = api.retry();
const release: () => void = api.subscribe(() => {});
api.configure({ hostDefault: "future-style" });
// @ts-expect-error Unsupported strings cannot be persisted.
api.update("future-style");
// @ts-expect-error Caller identity must never enter this private operation.
api.update({ style: "current", userId: "other" });
// @ts-expect-error Observable state is readonly.
state.effectiveStyle = "discord";
void [confirmed, load, update, retry, release];
