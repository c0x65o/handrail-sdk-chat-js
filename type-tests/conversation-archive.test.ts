import {
  parseConversationArchiveInput,
  parseConversationArchiveResult,
  type ArchiveConversationResult,
  type ConversationArchiveInput,
  type ConversationArchiveResult,
  type ConversationId,
  type RestoreConversationResult,
} from "../src/index.js";

const conversationId = "conversation-1" as ConversationId;

const archiveInput: ConversationArchiveInput = {
  operation: "set_conversation_archive",
  intent: "archive",
  conversationId,
  expectedLifecycleRevision: 4,
  idempotencyKey: "archive-conversation-1",
};
const restoreInput: ConversationArchiveInput = {
  operation: "set_conversation_archive",
  intent: "restore",
  conversationId,
  expectedLifecycleRevision: 9,
  idempotencyKey: "restore-conversation-1",
};

// @ts-expect-error Archive intent requires a conversation ID.
const missingConversationId: ConversationArchiveInput = {
  operation: "set_conversation_archive",
  intent: "archive",
  expectedLifecycleRevision: 4,
  idempotencyKey: "archive-conversation-1",
};
// @ts-expect-error Archive intent requires an expected lifecycle revision.
const missingExpectedRevision: ConversationArchiveInput = {
  operation: "set_conversation_archive",
  intent: "archive",
  conversationId,
  idempotencyKey: "archive-conversation-1",
};
// @ts-expect-error Archive intent requires an idempotency key.
const missingIdempotencyKey: ConversationArchiveInput = {
  operation: "set_conversation_archive",
  intent: "archive",
  conversationId,
  expectedLifecycleRevision: 4,
};
const ambiguousToggleIntent: ConversationArchiveInput = {
  operation: "set_conversation_archive",
  // @ts-expect-error Toggle is ambiguous; callers must explicitly archive or restore.
  intent: "toggle",
  conversationId,
  expectedLifecycleRevision: 4,
  idempotencyKey: "archive-conversation-1",
};
const booleanArchiveIntent: ConversationArchiveInput = {
  operation: "set_conversation_archive",
  intent: "archive",
  conversationId,
  expectedLifecycleRevision: 4,
  idempotencyKey: "archive-conversation-1",
  // @ts-expect-error Boolean/toggle archive state is not accepted.
  archived: true,
};

const tenantSpoof: ConversationArchiveInput = {
  ...archiveInput,
  // @ts-expect-error Tenant identity comes from the trusted host session.
  tenantId: "tenant-spoof",
};
const actorSpoof: ConversationArchiveInput = {
  ...archiveInput,
  // @ts-expect-error Actor identity comes from the trusted host session.
  actorUserId: "user-spoof",
};
const sessionSpoof: ConversationArchiveInput = {
  ...archiveInput,
  // @ts-expect-error Session identity comes from the trusted host session.
  sessionId: "session-spoof",
};
const authorizationSpoof: ConversationArchiveInput = {
  ...archiveInput,
  // @ts-expect-error Authorization comes from trusted server context.
  authorization: "Bearer spoof",
};
const roleSpoof: ConversationArchiveInput = {
  ...archiveInput,
  // @ts-expect-error Roles come from trusted server context.
  roles: ["admin"],
};
const capabilitySpoof: ConversationArchiveInput = {
  ...archiveInput,
  // @ts-expect-error Capabilities come from trusted server context.
  capabilities: ["chat.archive"],
};
const permissionSpoof: ConversationArchiveInput = {
  ...archiveInput,
  // @ts-expect-error Permissions come from trusted server context.
  permissions: ["archive:any"],
};
const entitySpoof: ConversationArchiveInput = {
  ...archiveInput,
  // @ts-expect-error Host-entity authorization is server-derived.
  entity: { type: "invoice", id: "invoice-1" },
};

const archiveApplied: ArchiveConversationResult = {
  operation: "set_conversation_archive",
  intent: "archive",
  reconciliationStatus: "applied",
  conversationId,
  expectedLifecycleRevision: 4,
  lifecycleRevision: 5,
  archiveState: {
    status: "archived",
    archivedAt: "2026-08-25T22:00:00.000Z",
    archivedByUserId: "user-actor" as never,
  },
};
const archiveConflict: ArchiveConversationResult = {
  operation: "set_conversation_archive",
  intent: "archive",
  reconciliationStatus: "lifecycle_conflict",
  conversationId,
  expectedLifecycleRevision: 4,
  lifecycleRevision: 7,
  archiveState: { status: "active" },
};
const restoreAlreadyActive: RestoreConversationResult = {
  operation: "set_conversation_archive",
  intent: "restore",
  reconciliationStatus: "already_requested_state",
  conversationId,
  expectedLifecycleRevision: 9,
  lifecycleRevision: 12,
  archiveState: { status: "active" },
};
const restoreConflict: RestoreConversationResult = {
  operation: "set_conversation_archive",
  intent: "restore",
  reconciliationStatus: "lifecycle_conflict",
  conversationId,
  expectedLifecycleRevision: 9,
  lifecycleRevision: 11,
  archiveState: {
    status: "archived",
    archivedAt: "2026-08-25T22:00:00.000Z",
    archivedByUserId: "user-actor" as never,
  },
};

// @ts-expect-error A settled archive result must carry archived state.
const archiveWithActiveAppliedState: ArchiveConversationResult = {
  ...archiveApplied,
  archiveState: { status: "active" },
};
// @ts-expect-error A restore conflict must carry authoritative archived state.
const restoreWithArchivedConflictState: RestoreConversationResult = {
  ...restoreConflict,
  archiveState: { status: "active" },
};

function handleResult(result: ConversationArchiveResult): number {
  if (result.reconciliationStatus === "lifecycle_conflict") {
    if (result.intent === "archive") {
      const status: "active" = result.archiveState.status;
      void status;
    } else {
      const status: "archived" = result.archiveState.status;
      void status;
    }
    return result.lifecycleRevision;
  }

  const settledStatus:
    | "applied"
    | "replayed"
    | "already_requested_state" = result.reconciliationStatus;
  void settledStatus;
  if (result.intent === "archive") {
    const status: "archived" = result.archiveState.status;
    void status;
  } else {
    const status: "active" = result.archiveState.status;
    void status;
  }
  return result.lifecycleRevision;
}

parseConversationArchiveInput(archiveInput);
parseConversationArchiveInput(restoreInput);
parseConversationArchiveResult(archiveApplied, archiveInput);
parseConversationArchiveResult(restoreAlreadyActive, restoreInput);
handleResult(archiveConflict);
handleResult(restoreConflict);

void [
  missingConversationId,
  missingExpectedRevision,
  missingIdempotencyKey,
  ambiguousToggleIntent,
  booleanArchiveIntent,
  tenantSpoof,
  actorSpoof,
  sessionSpoof,
  authorizationSpoof,
  roleSpoof,
  capabilitySpoof,
  permissionSpoof,
  entitySpoof,
  archiveWithActiveAppliedState,
  restoreWithArchivedConflictState,
];
