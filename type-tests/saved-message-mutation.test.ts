import {
  parseSetSavedMessageInput,
  parseSetSavedMessageResult,
  type ActorPrivateSetSavedMessageResult,
  type CanonicalActorPrivateSavedMessageState,
  type MessageId,
  type SavedMessageMutationReconciliationStatus,
  type SetSavedMessageInput,
  type SetSavedMessageResult,
} from "../src/index.js";

const messageId = "message-1" as MessageId;
const saveInput: SetSavedMessageInput = {
  operation: "set_saved_message",
  intent: "save",
  messageId,
  expectedSavedMessageRevision: 4,
  idempotencyKey: "saved-message:message-1:5",
  privateNote: "Follow up",
};
const unsaveInput: SetSavedMessageInput = {
  operation: "set_saved_message",
  intent: "unsave",
  messageId,
  expectedSavedMessageRevision: 4,
  idempotencyKey: "saved-message:message-1:unsave:5",
};

const toggleIntent: SetSavedMessageInput = {
  ...saveInput,
  // @ts-expect-error Toggle intent is ambiguous and unsupported.
  intent: "toggle",
};
const booleanAlias: SetSavedMessageInput = {
  ...saveInput,
  // @ts-expect-error Explicit save or unsave intent replaces boolean state.
  isSaved: true,
};
const toggleAlias: SetSavedMessageInput = {
  ...saveInput,
  // @ts-expect-error Toggle-shaped commands are unsupported.
  toggleSavedMessage: true,
};
const tenantSpoof: SetSavedMessageInput = {
  ...saveInput,
  // @ts-expect-error Tenant identity comes from trusted server context.
  tenantId: "tenant-spoof",
};
const userSpoof: SetSavedMessageInput = {
  ...saveInput,
  // @ts-expect-error User identity comes from trusted server context.
  userId: "user-spoof",
};
const actorSpoof: SetSavedMessageInput = {
  ...saveInput,
  // @ts-expect-error Actor identity comes from trusted server context.
  actorUserId: "user-spoof",
};
const sessionSpoof: SetSavedMessageInput = {
  ...saveInput,
  // @ts-expect-error Authentication context is never caller-authored.
  sessionId: "session-spoof",
};
const permissionSpoof: SetSavedMessageInput = {
  ...saveInput,
  // @ts-expect-error Authorization remains server-derived.
  permissions: ["saved-message:any"],
};
const unsupportedNoteAlias: SetSavedMessageInput = {
  ...saveInput,
  // @ts-expect-error Only the canonical privateNote field is supported.
  memo: "unsupported",
};
// @ts-expect-error Unsaved state cannot retain a private note.
const noteOnUnsave: SetSavedMessageInput = {
  ...unsaveInput,
  privateNote: "unsupported",
};

const canonicalSaved: CanonicalActorPrivateSavedMessageState = {
  messageId,
  isSaved: true,
  privateNote: "Follow up",
};
const applied: SetSavedMessageResult = {
  operation: "set_saved_message",
  intent: "save",
  reconciliationStatus: "applied",
  messageId,
  expectedSavedMessageRevision: 4,
  idempotencyKey: saveInput.idempotencyKey,
  savedMessageRevision: 5,
  savedMessage: canonicalSaved,
};
const conflict: ActorPrivateSetSavedMessageResult = {
  ...applied,
  intent: "unsave",
  reconciliationStatus: "saved_message_revision_conflict",
  savedMessageRevision: 8,
};
const invalidStatus: SetSavedMessageResult = {
  ...applied,
  // @ts-expect-error Result statuses are closed and deterministic.
  reconciliationStatus: "conflict",
};
const identityLeakingResult: SetSavedMessageResult = {
  ...applied,
  // @ts-expect-error Actor-private results never expose actor identity.
  actorUserId: "user-spoof",
};
const publicTargetResult: SetSavedMessageResult = {
  ...applied,
  // @ts-expect-error Actor-private results have no conversation delivery target.
  conversationId: "conversation-public",
};

function reconcile(result: SetSavedMessageResult): number {
  const status: SavedMessageMutationReconciliationStatus =
    result.reconciliationStatus;
  void status;
  return result.savedMessageRevision;
}

parseSetSavedMessageInput(saveInput);
parseSetSavedMessageInput(unsaveInput);
parseSetSavedMessageResult(applied, saveInput);
reconcile(conflict);

void [
  toggleIntent,
  booleanAlias,
  toggleAlias,
  tenantSpoof,
  userSpoof,
  actorSpoof,
  sessionSpoof,
  permissionSpoof,
  unsupportedNoteAlias,
  noteOnUnsave,
  invalidStatus,
  identityLeakingResult,
  publicTargetResult,
];
