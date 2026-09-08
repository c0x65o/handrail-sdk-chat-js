import {
  parseThreadCreationInput,
  parseThreadCreationResult,
  type ThreadCreationDetailSnapshot,
  type ThreadCreationInput,
  type ThreadCreationResult,
} from "../src/contracts/thread-creation.js";
import type { ConversationId, MessageId } from "../src/contracts/identifiers.js";
import type { ConversationSnapshotMetadata } from "../src/contracts/conversation-snapshot.js";
import type { ThreadSummary } from "../src/contracts/message.js";

const parentConversationId = "conversation-parent" as ConversationId;
const rootMessageId = "message-root" as MessageId;

const input: ThreadCreationInput = {
  operation: "create_thread",
  parentConversationId,
  rootMessageId,
  initialFollow: true,
  idempotencyKey: "create-thread-1",
};

// @ts-expect-error Thread creation requires an idempotency key.
const missingIdempotency: ThreadCreationInput = {
  operation: "create_thread",
  parentConversationId,
  rootMessageId,
};
// @ts-expect-error Thread creation requires a parent conversation ID.
const missingParent: ThreadCreationInput = {
  operation: "create_thread",
  rootMessageId,
  idempotencyKey: "create-thread-1",
};
// @ts-expect-error Thread creation requires a root message ID.
const missingRoot: ThreadCreationInput = {
  operation: "create_thread",
  parentConversationId,
  idempotencyKey: "create-thread-1",
};

const tenantSpoof: ThreadCreationInput = {
  ...input,
  // @ts-expect-error Tenant identity comes from the trusted host session.
  tenantId: "tenant-spoof",
};
const actorSpoof: ThreadCreationInput = {
  ...input,
  // @ts-expect-error Actor identity comes from the trusted host session.
  actor: { userId: "user-spoof" },
};
const sessionSpoof: ThreadCreationInput = {
  ...input,
  // @ts-expect-error Session identity comes from the trusted host session.
  sessionId: "session-spoof",
};
const authorizationSpoof: ThreadCreationInput = {
  ...input,
  // @ts-expect-error Authorization comes from trusted server context.
  authorization: "Bearer spoof",
};
const rolesSpoof: ThreadCreationInput = {
  ...input,
  // @ts-expect-error Roles come from trusted server context.
  roles: ["admin"],
};
const capabilitiesSpoof: ThreadCreationInput = {
  ...input,
  // @ts-expect-error Capabilities come from trusted server context.
  capabilities: ["chat.admin"],
};

const metadata = {} as ConversationSnapshotMetadata;
const thread = {} as ThreadCreationDetailSnapshot["conversation"];
const rootThreadSummary = {} as ThreadSummary;

const created: ThreadCreationResult = {
  operation: "create_thread",
  reconciliationStatus: "created",
  parentConversationId,
  rootMessageId,
  conversation: {
    kind: "conversation_detail",
    conversation: thread,
    _meta: metadata,
  },
  rootThreadSummary,
};
const existingForRoot: ThreadCreationResult = {
  ...created,
  reconciliationStatus: "existing_for_root",
};
const replayed: ThreadCreationResult = {
  ...created,
  reconciliationStatus: "replayed",
};

// @ts-expect-error Every outcome requires the canonical root summary.
const resultWithoutSummary: ThreadCreationResult = {
  operation: "create_thread",
  reconciliationStatus: "replayed",
  parentConversationId,
  rootMessageId,
  conversation: created.conversation,
};
const ambiguousExistingResult: ThreadCreationResult = {
  operation: "create_thread",
  reconciliationStatus: "existing_for_root",
  parentConversationId,
  rootMessageId,
  // @ts-expect-error Status does not create a second result shape.
  existingThreadId: thread.id,
};

parseThreadCreationInput(input);
parseThreadCreationResult(created, input);
parseThreadCreationResult(existingForRoot, input);
parseThreadCreationResult(replayed, input);

void [
  missingIdempotency,
  missingParent,
  missingRoot,
  tenantSpoof,
  actorSpoof,
  sessionSpoof,
  authorizationSpoof,
  rolesSpoof,
  capabilitiesSpoof,
  resultWithoutSummary,
  ambiguousExistingResult,
];

const named: ThreadCreationInput = { ...input, name: "Launch 🚀" };
const parsedName: string | undefined = parseThreadCreationInput(named).name;
const canonicalName: string | undefined = replayed.conversation.conversation.name;
// @ts-expect-error Explicit null is not an omitted name.
const nullName: ThreadCreationInput = { ...input, name: null };
// @ts-expect-error Supplied names must be strings.
const numericName: ThreadCreationInput = { ...input, name: 42 };
void [parsedName, canonicalName, nullName, numericName];
