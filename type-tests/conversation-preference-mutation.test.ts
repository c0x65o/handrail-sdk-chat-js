import {
  parseUpdateConversationPreferenceInput,
  parseUpdateConversationPreferenceResult,
  type CanonicalConversationPreferenceState,
  type ConversationId,
  type ConversationPreferenceDesiredState,
  type ConversationPreferenceMutationReconciliationStatus,
  type UpdateConversationPreferenceInput,
  type UpdateConversationPreferenceResult,
} from "../src/index.js";

const conversationId = "conversation-1" as ConversationId;
const desired: ConversationPreferenceDesiredState = {
  notificationPreference: "mentions",
  isStarred: false,
  mute: { muted: true, mutedUntil: "2030-02-03T04:05:06.000Z" as never },
};
const input: UpdateConversationPreferenceInput = {
  operation: "update_conversation_preference",
  conversationId,
  expectedPreferenceRevision: 4,
  idempotencyKey: "preference:conversation-1:5",
  ...desired,
};

const indefiniteMute: UpdateConversationPreferenceInput = {
  ...input,
  notificationPreference: "none",
  mute: { muted: true },
};
const unmuted: UpdateConversationPreferenceInput = {
  ...input,
  notificationPreference: "all",
  mute: { muted: false },
};

const invalidNotification: UpdateConversationPreferenceInput = {
  ...input,
  // @ts-expect-error Only all, mentions, and none are supported.
  notificationPreference: "important",
};
const toggleOperation: UpdateConversationPreferenceInput = {
  ...input,
  // @ts-expect-error Toggle semantics are ambiguous and unsupported.
  operation: "toggle_conversation_preference",
};
const booleanToggle: UpdateConversationPreferenceInput = {
  ...input,
  // @ts-expect-error The caller must provide the complete desired mute state.
  toggleMute: true,
};
const impossibleUnmutedState: UpdateConversationPreferenceInput = {
  ...input,
  // @ts-expect-error An inactive mute cannot carry an expiry.
  mute: {
    muted: false,
    mutedUntil: "2030-02-03T04:05:06.000Z",
  },
};

const tenantSpoof: UpdateConversationPreferenceInput = {
  ...input,
  // @ts-expect-error Tenant identity comes from trusted server context.
  tenantId: "tenant-spoof",
};
const userSpoof: UpdateConversationPreferenceInput = {
  ...input,
  // @ts-expect-error The affected user is always the trusted current user.
  userId: "user-spoof",
};
const actorSpoof: UpdateConversationPreferenceInput = {
  ...input,
  // @ts-expect-error Actor identity comes from trusted server context.
  actorUserId: "user-spoof",
};
const sessionSpoof: UpdateConversationPreferenceInput = {
  ...input,
  // @ts-expect-error Authentication context is never caller-authored.
  sessionId: "session-spoof",
};
const permissionSpoof: UpdateConversationPreferenceInput = {
  ...input,
  // @ts-expect-error Authorization remains server-derived.
  permissions: ["preference:any"],
};

const canonical: CanonicalConversationPreferenceState = {
  ...desired,
  updatedAt: "2026-08-26T05:30:00.000Z" as never,
};
const applied: UpdateConversationPreferenceResult = {
  operation: "update_conversation_preference",
  reconciliationStatus: "applied",
  conversationId,
  expectedPreferenceRevision: 4,
  idempotencyKey: input.idempotencyKey,
  requestedPreference: desired,
  preferenceRevision: 5,
  preference: canonical,
};
const conflict: UpdateConversationPreferenceResult = {
  ...applied,
  reconciliationStatus: "preference_revision_conflict",
  preferenceRevision: 7,
  preference: {
    notificationPreference: "none",
    isStarred: false,
    mute: { muted: true },
    updatedAt: "2026-08-26T05:31:00.000Z" as never,
  },
};
const invalidStatus: UpdateConversationPreferenceResult = {
  ...applied,
  // @ts-expect-error Reconciliation statuses are closed and deterministic.
  reconciliationStatus: "conflict",
};
const leakedUser: UpdateConversationPreferenceResult = {
  ...applied,
  // @ts-expect-error Private delivery context identifies the affected user.
  userId: "user-1",
};

function reconcile(result: UpdateConversationPreferenceResult): number {
  const status: ConversationPreferenceMutationReconciliationStatus =
    result.reconciliationStatus;
  void status;
  return result.preferenceRevision;
}

parseUpdateConversationPreferenceInput(input);
parseUpdateConversationPreferenceInput(indefiniteMute);
parseUpdateConversationPreferenceInput(unmuted);
parseUpdateConversationPreferenceResult(applied, input);
reconcile(conflict);

void [
  invalidNotification,
  toggleOperation,
  booleanToggle,
  impossibleUnmutedState,
  tenantSpoof,
  userSpoof,
  actorSpoof,
  sessionSpoof,
  permissionSpoof,
  invalidStatus,
  leakedUser,
];
