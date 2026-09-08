import type {
  UpdateConversationPreferenceInput,
  UpdateConversationPreferenceResult,
} from "../src/index.js";

const input: UpdateConversationPreferenceInput = {
  operation: "update_conversation_preference",
  conversationId: "conversation-1" as never,
  expectedPreferenceRevision: 0,
  idempotencyKey: "preference-1",
  notificationPreference: "mentions",
  isStarred: true,
  mute: { muted: true },
};

// @ts-expect-error Explicit starred state is required; toggle/default semantics are absent.
const missingStarred: UpdateConversationPreferenceInput = {
  operation: "update_conversation_preference",
  conversationId: "conversation-1" as never,
  expectedPreferenceRevision: 0,
  idempotencyKey: "preference-missing-starred",
  notificationPreference: "mentions",
  mute: { muted: true },
};

const finiteMute: UpdateConversationPreferenceInput = {
  ...input,
  mute: { muted: true, mutedUntil: "2030-02-03T04:05:06.000Z" as never },
};

const invalidNotification: UpdateConversationPreferenceInput = {
  ...input,
  // @ts-expect-error Notification preferences are explicit known values.
  notificationPreference: "important",
};
const toggle: UpdateConversationPreferenceInput = {
  ...input,
  // @ts-expect-error Toggle semantics are absent from the contract.
  toggleMute: true,
};
const starToggle: UpdateConversationPreferenceInput = {
  ...input,
  // @ts-expect-error Star toggle semantics are absent from the contract.
  toggleIsStarred: true,
};
const tenantSpoof: UpdateConversationPreferenceInput = {
  ...input,
  // @ts-expect-error Tenant identity is trusted server context.
  tenantId: "tenant-spoof",
};
const actorSpoof: UpdateConversationPreferenceInput = {
  ...input,
  // @ts-expect-error Actor identity is trusted server context.
  actorUserId: "user-spoof",
};

const result = {} as UpdateConversationPreferenceResult;
if (result.reconciliationStatus === "preference_revision_conflict") {
  result.preferenceRevision;
  result.preference.updatedAt;
}

void [
  finiteMute,
  missingStarred,
  invalidNotification,
  toggle,
  starToggle,
  tenantSpoof,
  actorSpoof,
];
