import {
  createChatClient,
  selectCurrentUserThreadFollowState,
  selectIsCurrentUserFollowingThread,
  type ChatSetThreadFollowInput,
  type ChatSetThreadFollowResult,
  type NormalizedChatCacheState,
} from "@handrail/chat/client";

const threadId = "thread-1" as never;
const input = {
  threadId,
  intent: "follow",
} as const satisfies ChatSetThreadFollowInput;

const client = createChatClient({
  endpoint: "/chat",
  getAccessToken: () => "token",
});
const setResult: Promise<ChatSetThreadFollowResult> = client.setThreadFollow(input);
void setResult;
void client.followThread(threadId);
void client.unfollowThread(threadId);

declare const state: NormalizedChatCacheState;
const selected = selectCurrentUserThreadFollowState(state, threadId);
selected.authoritativeRevision satisfies number;
selected.follow?.source satisfies "manual" | "reply" | "mention" | undefined;
selected.pending?.intent satisfies "follow" | "unfollow" | undefined;
selectIsCurrentUserFollowingThread(state, threadId) satisfies boolean | undefined;

void client.setThreadFollow({
  threadId,
  // @ts-expect-error toggle semantics are not part of the public API
  toggle: true,
});

void client.setThreadFollow({
  threadId,
  intent: "follow",
  // @ts-expect-error revisions are derived from authoritative private cache state
  expectedFollowRevision: 1,
});
