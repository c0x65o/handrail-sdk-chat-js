import type { ChatClient, ChatThreadList, ChatThreadListState, ChatThreadListQuery, ThreadListView, ThreadListResult } from "../src/client/index.js";
import { useThreadList } from "../src/react/index.js";
import type { ConversationId } from "../src/contracts/identifiers.js";
declare const client: ChatClient;
declare const parentConversationId: ConversationId;
const query: ChatThreadListQuery = { parentConversationId, view: "active", limit: 25 };
const api: ChatThreadList = client.threadList;
const view: ThreadListView = "all";
const state: ChatThreadListState = api.getState(query);
const result: ThreadListResult | undefined = state.result;
const unsubscribe: () => void = api.subscribe(query, () => {});
const refresh: Promise<ChatThreadListState> = api.refresh(query);
const more: Promise<ChatThreadListState> = api.loadMore(query);
const retry: Promise<ChatThreadListState> = api.retry(query);
const hook = useThreadList(query);
const hookRetry: Promise<ChatThreadListState> = hook.actions.retry();
// @ts-expect-error Discovery requires explicit parent scope.
api.refresh({ view });
// @ts-expect-error The runtime owns cursor progression.
api.loadMore({ parentConversationId, cursor: "injected" });
// @ts-expect-error Discovery has no write/open actions.
api.openThread(parentConversationId);
// @ts-expect-error Observable rows are readonly.
state.items.push(state.items[0]);
void [result, unsubscribe, refresh, more, retry, hookRetry];
