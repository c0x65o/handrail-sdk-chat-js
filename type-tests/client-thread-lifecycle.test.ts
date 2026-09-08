import type { ChatClient, ChatThreadLifecycle, ChatThreadLifecycleState, ThreadLifecycleIntent } from "../src/client/index.js";
import { useThreadLifecycle } from "../src/react/index.js";
import type { ConversationId } from "../src/contracts/identifiers.js";

declare const client: ChatClient;
declare const threadId: ConversationId;
declare const parentId: ConversationId;
const lifecycle: ChatThreadLifecycle = client.threadLifecycle;
const load: Promise<ChatThreadLifecycleState> = lifecycle.load(threadId, parentId);
const close: Promise<ChatThreadLifecycleState> = lifecycle.close(threadId);
const reopen: Promise<ChatThreadLifecycleState> = lifecycle.reopen(threadId);
const lock: Promise<ChatThreadLifecycleState> = lifecycle.lock(threadId);
const unlock: Promise<ChatThreadLifecycleState> = lifecycle.unlock(threadId);
const retry: Promise<ChatThreadLifecycleState> = lifecycle.retry(threadId);
const unsubscribe: () => void = lifecycle.subscribe(threadId, () => {});
const hook = useThreadLifecycle(threadId, parentId);
const hookRetry: Promise<ChatThreadLifecycleState> = hook.actions.retry();
const revision: number | undefined = hook.lifecycle?.revision;
const intent: ThreadLifecycleIntent | undefined = hook.pendingInput?.intent;
// @ts-expect-error Parent scope is mandatory for authorized lifecycle hydration.
lifecycle.load(threadId);
// @ts-expect-error Lifecycle writes expose explicit intents, never toggle operations.
lifecycle.toggle(threadId);
// @ts-expect-error Canonical revisions are readonly.
hook.lifecycle!.revision = 10;
void [load, close, reopen, lock, unlock, retry, unsubscribe, hookRetry, revision, intent];
