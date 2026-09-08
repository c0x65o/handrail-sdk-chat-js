import {
  createChatClient,
  createChatCrossTabChannelName,
  createChatCrossTabCoordinator,
  type ChatClientCrossTabOptions,
  type ChatCrossTabChannel,
  type ChatCrossTabClock,
  type ChatCrossTabCoordinator,
  type ChatCrossTabStatus,
} from "../src/client/index.js";

declare const channel: ChatCrossTabChannel;
declare const clock: ChatCrossTabClock;

const options = {
  sessionFingerprint: "tenant:user:session",
  tabId: "tab-a",
  channelFactory: () => channel,
  clock,
} satisfies ChatClientCrossTabOptions;

const coordinator: ChatCrossTabCoordinator = createChatCrossTabCoordinator({
  endpoint: "/api/chat",
  sessionFingerprint: "tenant:user:session",
  channelFactory: () => channel,
  clock,
  tabId: "tab-a",
});
const status: ChatCrossTabStatus = coordinator.status;
const channelName: string = createChatCrossTabChannelName(
  "/api/chat",
  "tenant:user:session",
);

const client = createChatClient({
  endpoint: "/api/chat",
  getAccessToken: () => "token",
  crossTab: options,
});

void [status, channelName, client.coordination];
