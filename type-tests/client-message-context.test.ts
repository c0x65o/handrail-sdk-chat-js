import type { ChatClient, ChatMessageContext, ChatMessageContextState, MessageContextRequest, MessageContextResult } from "../src/client/index.js";
declare const client: ChatClient;
declare const target: MessageContextRequest;
const context: ChatMessageContext = client.messageContext;
const resolve: Promise<ChatMessageContextState> = context.resolve(target);
const window: Promise<ChatMessageContextState> = context.loadSourceWindow(target);
const retry: Promise<ChatMessageContextState> = context.retry(target);
const release: () => void = context.subscribe(target, () => {});
const result: MessageContextResult | undefined = context.getState(target).result;
if (result?.status === "available") result.message.content.text;
// @ts-expect-error Source navigation accepts IDs only, never a copied preview.
context.resolve({ ...target, preview: "secret" });
// @ts-expect-error Navigation has no thread-opening action.
context.openThread(target);
void [resolve, window, retry, release];
