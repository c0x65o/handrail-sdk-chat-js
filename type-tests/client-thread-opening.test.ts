import {
  createChatClient,
  type ChatThreadOpeningListener,
  type ChatThreadOpeningState,
} from "../src/client/index.js";
import type { MessageId } from "../src/contracts/identifiers.js";

const client = createChatClient({
  endpoint: "/api/chat",
  getAccessToken: () => "token",
});
const rootMessageId = "root-message" as MessageId;

const opening: Promise<ChatThreadOpeningState> = client.openThread(rootMessageId);
const current: ChatThreadOpeningState = client.getThreadOpeningState(rootMessageId);
const listener: ChatThreadOpeningListener = (next, previous) => {
  if (next.state === "ready") {
    next.threadConversationId;
    next.reconciliationStatus;
  }
  previous.rootMessageId;
};
const unsubscribe: () => void = client.subscribeThreadOpening(
  rootMessageId,
  listener,
);

void opening;
void current;
unsubscribe();

// @ts-expect-error A canonical branded message identifier is required.
client.openThread("root-message");

const named: Promise<ChatThreadOpeningState> = client.createThread({ rootMessageId, name: "Launch planning" });
void named;
client.createThread({ rootMessageId });
// @ts-expect-error A canonical branded message identifier is required.
client.createThread({ rootMessageId: "root-message", name: "Launch" });
// @ts-expect-error Names must be strings.
client.createThread({ rootMessageId, name: 42 });
// @ts-expect-error The client owns idempotency keys.
client.createThread({ rootMessageId, idempotencyKey: "caller-key" });

import type {
  ChatCreateThreadInput,
  ChatExistingThreadOpeningState,
  ChatExistingThreadOpeningListener,
} from "../src/client/index.js";
import type { ConversationId } from "../src/contracts/identifiers.js";
import type { ThreadCreationReconciliationStatus } from "../src/contracts/thread-creation.js";
const threadId = "canonical-thread" as ConversationId;
const creationInput: ChatCreateThreadInput = { rootMessageId, name: "Discussion" };
const existing: Promise<ChatExistingThreadOpeningState> = client.openExistingThread(threadId);
const existingCurrent: ChatExistingThreadOpeningState = client.getExistingThreadOpeningState(threadId);
const existingListener: ChatExistingThreadOpeningListener = (next, previous) => {
  previous.threadConversationId;
  if (next.state === "ready") {
    const root: MessageId = next.rootMessageId;
    const parent: ConversationId = next.parentConversationId;
    const context: "available" | "deleted" | "unavailable" = next.rootContext;
    const name: string | undefined = next.name;
    // @ts-expect-error Reading has no creation reconciliation outcome.
    next.reconciliationStatus;
    void [root, parent, context, name];
  }
};
client.subscribeExistingThreadOpening(threadId, existingListener)();
// @ts-expect-error Requires a conversation identifier, not a message identifier.
client.openExistingThread(rootMessageId);
// @ts-expect-error Requires a branded conversation identifier.
client.openExistingThread("thread");
opening.then((state) => {
  if (state.state === "ready") {
    // Legacy callers retain a required reconciliation result.
    const status: ThreadCreationReconciliationStatus = state.reconciliationStatus;
    void status;
  }
});
void [creationInput, existing, existingCurrent];
