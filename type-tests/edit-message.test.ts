import type { MessageId } from "../src/contracts/identifiers.js";
import type { MessageReplyReference } from "../src/contracts/message.js";
import type { EditMessageInput, EditMessageResult } from "../src/contracts/message-mutations.js";
import { parseEditMessageInput, parseEditMessageResult } from "../src/contracts/message-mutations.js";

const input: EditMessageInput = {
  operation: "edit", messageId: "message-1" as MessageId, expectedRevision: 2,
  content: { format: "plain", text: "Friday" }, idempotencyKey: "edit-1",
};
const reply: MessageReplyReference = { messageId: "source-1" as MessageId, notifyAuthor: false };
const parsed: EditMessageInput = parseEditMessageInput(input);
const result: EditMessageResult = parseEditMessageResult({});
const reference: MessageReplyReference | undefined = result.message.replyTo;

// @ts-expect-error An edit cannot retarget reply identity.
const retarget: EditMessageInput = { ...input, replyTo: reply };
const enrichedInput = { ...input, replyTo: reply };
// @ts-expect-error Reject reply metadata even through structural assignment.
const structuralRetarget: EditMessageInput = enrichedInput;
// @ts-expect-error Explicit null cannot clear a reply.
const clear: EditMessageInput = { ...input, replyTo: null };
// @ts-expect-error Explicit undefined is not an edit field.
const explicitUndefined: EditMessageInput = { ...input, replyTo: undefined };
// @ts-expect-error Reply metadata cannot be smuggled into replacement content.
const nested: EditMessageInput = { ...input, content: { ...input.content, replyTo: reply } };

void [parsed, reference, retarget, structuralRetarget, clear, explicitUndefined, nested];
