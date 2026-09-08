import {
  parseSynchronizeDraftInput,
  parseSynchronizeDraftResult,
  type ClearDraftInput,
  type ClearDraftResult,
  type DraftContent,
  type ReplaceDraftInput,
  type ReplaceDraftResult,
  type SynchronizeDraftInput,
  type SynchronizeDraftResult,
} from "../src/contracts/draft-mutation.js";
import type { AttachmentId, ConversationId, MessageId, UserId } from "../src/contracts/identifiers.js";

const conversationId = "conversation-1" as ConversationId;
const mentionedUserId = "user-reviewer" as UserId;
const attachmentId = "attachment-1" as AttachmentId;
const content: DraftContent = {
  format: "markdown",
  text: "Review **invoice 42**",
  replyTo: { messageId: "message-source" as MessageId, notifyAuthor: false },
  mentions: [
    { type: "user", userId: mentionedUserId },
    { type: "conversation", conversationId },
    { type: "entity", entity: { type: "invoice", id: "invoice-42" } },
  ],
  attachments: [{ attachmentId }],
};
const legacyContentWithoutMentions: DraftContent = {
  format: "plain",
  text: "Legacy draft",
  attachments: [],
};

const replaceInput: ReplaceDraftInput = {
  operation: "synchronize_draft",
  intent: "replace",
  conversationId,
  baseRevision: 4,
  deviceMutationId: "browser-a:mutation-17",
  idempotencyKey: "draft:replace:17",
  content,
};
const clearInput: ClearDraftInput = {
  operation: "synchronize_draft",
  intent: "clear",
  conversationId,
  baseRevision: 5,
  deviceMutationId: "phone-b:mutation-8",
  idempotencyKey: "draft:clear:8",
};

// @ts-expect-error Replace requires canonical draft content.
const replaceWithoutContent: ReplaceDraftInput = {
  operation: "synchronize_draft",
  intent: "replace",
  conversationId,
  baseRevision: 4,
  deviceMutationId: "browser-a:mutation-17",
  idempotencyKey: "draft:replace:17",
};
const clearWithContent: ClearDraftInput = {
  ...clearInput,
  // @ts-expect-error Clear is an explicit tombstone and cannot carry content.
  content,
};
const toggleInput: SynchronizeDraftInput = {
  ...replaceInput,
  // @ts-expect-error Toggle intent is ambiguous and unsupported.
  intent: "toggle",
};
const booleanState: ReplaceDraftInput = {
  ...replaceInput,
  // @ts-expect-error Boolean desired state is not part of the contract.
  cleared: false,
};
const unsupportedFormat: DraftContent = {
  // @ts-expect-error Draft text is plain or markdown, never raw HTML.
  format: "html",
  text: "<strong>unsafe</strong>",
  attachments: [],
};

const tenantSpoof: ReplaceDraftInput = {
  ...replaceInput,
  // @ts-expect-error Tenant identity comes from the trusted host session.
  tenantId: "tenant-spoof",
};
const actorSpoof: ClearDraftInput = {
  ...clearInput,
  // @ts-expect-error Actor identity comes from the trusted host session.
  actorUserId: "user-spoof",
};
const sessionSpoof: ReplaceDraftInput = {
  ...replaceInput,
  // @ts-expect-error Session identity comes from the trusted host session.
  sessionId: "session-spoof",
};
const permissionSpoof: ClearDraftInput = {
  ...clearInput,
  // @ts-expect-error Authorization remains server-derived.
  permissions: ["draft:any"],
};

const replaceApplied: ReplaceDraftResult = {
  operation: "synchronize_draft",
  intent: "replace",
  reconciliationStatus: "applied",
  conversationId,
  baseRevision: 4,
  deviceMutationId: replaceInput.deviceMutationId,
  idempotencyKey: replaceInput.idempotencyKey,
  canonicalRevision: 5,
  canonicalUpdatedAt: "2026-08-26T05:15:00.000Z",
  draft: { kind: "replaced", content },
};
const clearReplayed: ClearDraftResult = {
  operation: "synchronize_draft",
  intent: "clear",
  reconciliationStatus: "replayed",
  conversationId,
  baseRevision: 5,
  deviceMutationId: clearInput.deviceMutationId,
  idempotencyKey: clearInput.idempotencyKey,
  canonicalRevision: 6,
  canonicalUpdatedAt: "2026-08-26T05:16:00.000Z",
  draft: { kind: "clear_tombstone", content: null },
};
const clearStale: ClearDraftResult = {
  ...clearReplayed,
  reconciliationStatus: "stale_base",
  canonicalRevision: 9,
  draft: { kind: "replaced", content },
};

// @ts-expect-error Settled replace results must carry replaced content.
const replaceAppliedWithTombstone: ReplaceDraftResult = {
  ...replaceApplied,
  draft: { kind: "clear_tombstone", content: null },
};
// @ts-expect-error Settled clear results must carry a clear tombstone.
const clearReplayedWithContent: ClearDraftResult = {
  ...clearReplayed,
  draft: { kind: "replaced", content },
};

function reconcile(result: SynchronizeDraftResult): number {
  if (result.reconciliationStatus === "stale_base") {
    const state: "replaced" | "clear_tombstone" = result.draft.kind;
    void state;
  } else if (result.intent === "replace") {
    const state: "replaced" = result.draft.kind;
    void state;
  } else {
    const state: "clear_tombstone" = result.draft.kind;
    void state;
  }
  return result.canonicalRevision;
}

parseSynchronizeDraftInput(replaceInput);
parseSynchronizeDraftInput(clearInput);
parseSynchronizeDraftResult(replaceApplied, replaceInput);
parseSynchronizeDraftResult(clearReplayed, clearInput);
reconcile(clearStale);

void [
  replaceWithoutContent,
  clearWithContent,
  toggleInput,
  booleanState,
  unsupportedFormat,
  tenantSpoof,
  actorSpoof,
  sessionSpoof,
  permissionSpoof,
  legacyContentWithoutMentions,
  replaceAppliedWithTombstone,
  clearReplayedWithContent,
];

const missingReplyPing: DraftContent = {
  ...content,
  // @ts-expect-error A reply requires an explicit ping choice.
  replyTo: { messageId: "source" as MessageId },
};
const invalidReplyPing: DraftContent = {
  ...content,
  // @ts-expect-error Ping choice is a boolean.
  replyTo: { messageId: "source" as MessageId, notifyAuthor: "false" },
};
const nullReply: DraftContent = {
  ...content,
  // @ts-expect-error Omit the reference instead of sending null.
  replyTo: null,
};
const replySnapshot: DraftContent = {
  ...content,
  // @ts-expect-error Reply metadata never carries source snapshots.
  replyTo: { messageId: "source" as MessageId, notifyAuthor: false, content: "source" },
};
void [missingReplyPing, invalidReplyPing, nullReply, replySnapshot];
