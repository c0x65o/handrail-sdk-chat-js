import {
  createChatClient,
  type ChatHuddleActionResult,
  type ChatHuddleViewState,
  type HuddleMediaJoinDescriptor,
} from "../src/client/index.js";
import type { ConversationId } from "../src/contracts/identifiers.js";

const conversationId = "conversation" as ConversationId;
const client = createChatClient({
  endpoint: "/chat",
  getAccessToken: () => "token",
});

const state: ChatHuddleViewState = client.getHuddleState(conversationId);
const hydrate: Promise<ChatHuddleActionResult> = client.hydrateHuddle(conversationId);
const start: Promise<ChatHuddleActionResult> = client.startHuddle(conversationId);
const join: Promise<ChatHuddleActionResult> = client.joinHuddle(conversationId);
const leave: Promise<ChatHuddleActionResult> = client.leaveHuddle(conversationId);
const share: Promise<ChatHuddleActionResult> = client.setHuddleScreenShare(conversationId);
const clear: Promise<ChatHuddleActionResult> = client.clearHuddleScreenShare(conversationId);
const end: Promise<ChatHuddleActionResult> = client.endHuddle(conversationId);
const retry: Promise<ChatHuddleActionResult> = client.retryHuddle(conversationId);
const rejoin: Promise<ChatHuddleActionResult> = client.rejoinHuddle(conversationId);
const descriptor: HuddleMediaJoinDescriptor | undefined =
  client.getHuddleMediaJoinDescriptor(conversationId);
const unsubscribe: () => void = client.subscribeHuddle(
  conversationId,
  (next, previous) => `${next.media.state}:${previous.media.state}`,
);

void [state, hydrate, start, join, leave, share, clear, end, retry, rejoin, descriptor, unsubscribe];

client.startHuddle(
  // @ts-expect-error Huddle actions require a branded conversation id.
  123,
);
