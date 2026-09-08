import {
  APPLICATION_CHAT_CONVERSATION_CREATION_CONTRACT_VERSION,
  APPLICATION_CHAT_CONVERSATION_ARCHIVE_CONTRACT_VERSION,
  APPLICATION_CHAT_CONVERSATION_PREFERENCE_CONTRACT_VERSION,
  APPLICATION_CHAT_DRAFT_MUTATION_CONTRACT_VERSION,
  APPLICATION_CHAT_MESSAGE_REMINDER_CONTRACT_VERSION,
  APPLICATION_CHAT_SAVED_MESSAGE_CONTRACT_VERSION,
  APPLICATION_CHAT_THREAD_FOLLOW_CONTRACT_VERSION,
  ApplicationChatStorageRecordKind,
  MAX_APPLICATION_CHAT_CONVERSATION_CREATION_MEMBERS,
  MAX_APPLICATION_CHAT_QUEUED_CONVERSATION_CREATION_INTENT_BYTES,
  MAX_APPLICATION_CHAT_QUEUED_CONVERSATION_CREATION_INTENTS,
  MAX_APPLICATION_CHAT_QUEUED_CONVERSATION_ARCHIVE_INTENT_BYTES,
  MAX_APPLICATION_CHAT_QUEUED_CONVERSATION_ARCHIVE_INTENTS,
  MAX_APPLICATION_CHAT_QUEUED_CONVERSATION_PREFERENCE_INTENT_BYTES,
  MAX_APPLICATION_CHAT_QUEUED_CONVERSATION_PREFERENCE_INTENTS,
  MAX_APPLICATION_CHAT_QUEUED_DRAFT_CONVERSATIONS,
  MAX_APPLICATION_CHAT_QUEUED_DRAFT_INTENT_BYTES,
  MAX_APPLICATION_CHAT_QUEUED_MESSAGE_REMINDER_INTENT_BYTES,
  MAX_APPLICATION_CHAT_QUEUED_MESSAGE_REMINDER_INTENTS,
  MAX_APPLICATION_CHAT_QUEUED_SAVED_MESSAGE_INTENT_BYTES,
  MAX_APPLICATION_CHAT_QUEUED_SAVED_MESSAGE_INTENTS,
  MAX_APPLICATION_CHAT_QUEUED_THREAD_FOLLOW_INTENT_BYTES,
  MAX_APPLICATION_CHAT_QUEUED_THREAD_FOLLOW_INTENTS,
  createApplicationChatQueuedConversationCreationIntent,
  createApplicationChatQueuedConversationCreationIntentsRecord,
  createApplicationChatQueuedConversationArchiveIntent,
  createApplicationChatQueuedConversationArchiveIntentsRecord,
  createApplicationChatQueuedConversationPreferenceIntent,
  createApplicationChatQueuedConversationPreferenceIntentsRecord,
  createApplicationChatQueuedDraftIntent,
  createApplicationChatQueuedDraftIntentsRecord,
  createApplicationChatQueuedMessageMutationIntent,
  createApplicationChatQueuedMessageMutationIntentsRecord,
  createApplicationChatQueuedMessageReminderIntent,
  createApplicationChatQueuedMessageReminderIntentsRecord,
  createApplicationChatQueuedSavedMessageIntent,
  createApplicationChatQueuedSavedMessageIntentsRecord,
  createApplicationChatQueuedThreadFollowIntent,
  createApplicationChatQueuedThreadFollowIntentsRecord,
  createApplicationChatStorage,
  type ApplicationChatNormalizedSnapshotRecord,
  type ApplicationChatQueuedConversationCreationIntentsRecord,
  type ApplicationChatQueuedConversationArchiveIntent,
  type ApplicationChatQueuedConversationArchiveIntentsRecord,
  type ApplicationChatQueuedConversationPreferenceIntentsRecord,
  type ApplicationChatQueuedDraftIntent,
  type ApplicationChatQueuedDraftIntentsRecord,
  type ApplicationChatQueuedMessageMutationIntentsRecord,
  type ApplicationChatQueuedMessageReminderIntent,
  type ApplicationChatQueuedMessageReminderIntentsRecord,
  type ApplicationChatQueuedReadCursorIntentsRecord,
  type ApplicationChatQueuedSavedMessageIntent,
  type ApplicationChatQueuedSavedMessageIntentsRecord,
  type ApplicationChatQueuedThreadFollowIntent,
  type ApplicationChatQueuedThreadFollowIntentsRecord,
  type ApplicationChatStorageAdapter,
  type ApplicationChatStorageIdentity,
  type ApplicationChatStorageUpdater,
} from "../src/client/index.js";
import type { ConversationId, MessageId, UserId } from "../src/contracts/identifiers.js";

const identity = {
  tenantId: "tenant-1",
  userId: "user-1",
  deviceId: "device-1",
} as ApplicationChatStorageIdentity;

const adapter: ApplicationChatStorageAdapter = {
  async read(_identity, _kind) {
    return null;
  },
  async replace(_identity, _kind, _encodedRecord) {},
  async remove(_identity, _kind) {},
  async clearForLogout(_identity) {},
};

const storage = createApplicationChatStorage(adapter);

const atomicAdapter: ApplicationChatStorageAdapter = {
  ...adapter,
  async compareExchange(
    _identity,
    _kind,
    expectedEncodedRecord,
    replacementEncodedRecord,
  ) {
    const expected: string | null = expectedEncodedRecord;
    const replacement: string | null = replacementEncodedRecord;
    void expected;
    void replacement;
    return true;
  },
};
const atomicStorage = createApplicationChatStorage(atomicAdapter);
const compareExchange = atomicStorage.compareExchange;
if (compareExchange !== undefined) {
  const exchanged: Promise<boolean> = compareExchange(
    identity,
    ApplicationChatStorageRecordKind.queuedSendMessageIntents,
    null,
    "encoded replacement",
  );
  const removed: Promise<boolean> = compareExchange(
    identity,
    ApplicationChatStorageRecordKind.queuedSendMessageIntents,
    "encoded expected value",
    null,
  );
  void exchanged;
  void removed;

  // @ts-expect-error Expected values must be encoded strings or null.
  compareExchange(identity, ApplicationChatStorageRecordKind.normalizedSnapshot, undefined, null);
  // @ts-expect-error Replacements must be encoded strings or null.
  compareExchange(identity, ApplicationChatStorageRecordKind.normalizedSnapshot, null, {});
  // @ts-expect-error The record kind must be a declared storage kind.
  compareExchange(identity, "unknown_kind", null, null);
  // @ts-expect-error A complete storage identity is required.
  compareExchange({ tenantId: identity.tenantId, userId: identity.userId }, ApplicationChatStorageRecordKind.normalizedSnapshot, null, null);
}

const invalidAtomicAdapter: ApplicationChatStorageAdapter = {
  ...adapter,
  // @ts-expect-error compareExchange must resolve to a boolean.
  async compareExchange() {
    return "committed";
  },
};
void invalidAtomicAdapter;

const updateReadCursors: ApplicationChatStorageUpdater<
  typeof ApplicationChatStorageRecordKind.queuedReadCursorIntents
> = (current) => current;
const mutatedReadCursors: Promise<
  ApplicationChatQueuedReadCursorIntentsRecord | null
> = storage.mutate(
  identity,
  ApplicationChatStorageRecordKind.queuedReadCursorIntents,
  updateReadCursors,
);
void mutatedReadCursors;

storage.mutate(
  identity,
  ApplicationChatStorageRecordKind.queuedReadCursorIntents,
  (current) => {
    const typed: ApplicationChatQueuedReadCursorIntentsRecord | null = current;
    return typed === null ? null : typed;
  },
);

// @ts-expect-error Mutation updaters must be synchronous.
storage.mutate(identity, ApplicationChatStorageRecordKind.queuedReadCursorIntents, async (current) => current);
// @ts-expect-error Mutation results must retain the requested record kind.
storage.mutate(identity, ApplicationChatStorageRecordKind.queuedReadCursorIntents, () => ({} as ApplicationChatNormalizedSnapshotRecord));
// @ts-expect-error Mutation results must be a record or null.
storage.mutate(identity, ApplicationChatStorageRecordKind.queuedReadCursorIntents, () => undefined);
// @ts-expect-error The record kind must be a declared storage kind.
storage.mutate(identity, "unknown_kind", () => null);
// @ts-expect-error A complete storage identity is required.
storage.mutate({ tenantId: identity.tenantId }, ApplicationChatStorageRecordKind.queuedReadCursorIntents, () => null);

const snapshot: Promise<ApplicationChatNormalizedSnapshotRecord | null> = storage.read(
  identity,
  ApplicationChatStorageRecordKind.normalizedSnapshot,
);
void snapshot;

const readCursorIntents: Promise<ApplicationChatQueuedReadCursorIntentsRecord | null> =
  storage.read(
    identity,
    ApplicationChatStorageRecordKind.queuedReadCursorIntents,
  );
void readCursorIntents;

const messageMutationIntents: Promise<ApplicationChatQueuedMessageMutationIntentsRecord | null> =
  storage.read(
    identity,
    ApplicationChatStorageRecordKind.queuedMessageMutationIntents,
  );
void messageMutationIntents;

const conversationCreationIntents:
  Promise<ApplicationChatQueuedConversationCreationIntentsRecord | null> = storage.read(
    identity,
    ApplicationChatStorageRecordKind.queuedConversationCreationIntents,
  );
void conversationCreationIntents;

const conversationPreferenceIntents:
  Promise<ApplicationChatQueuedConversationPreferenceIntentsRecord | null> = storage.read(
    identity,
    ApplicationChatStorageRecordKind.queuedConversationPreferenceIntents,
  );
void conversationPreferenceIntents;

const threadFollowIntents:
  Promise<ApplicationChatQueuedThreadFollowIntentsRecord | null> = storage.read(
    identity,
    ApplicationChatStorageRecordKind.queuedThreadFollowIntents,
  );
void threadFollowIntents;

const savedMessageIntents:
  Promise<ApplicationChatQueuedSavedMessageIntentsRecord | null> = storage.read(
    identity,
    ApplicationChatStorageRecordKind.queuedSavedMessageIntents,
  );
void savedMessageIntents;

const messageReminderIntents:
  Promise<ApplicationChatQueuedMessageReminderIntentsRecord | null> = storage.read(
    identity,
    ApplicationChatStorageRecordKind.queuedMessageReminderIntents,
  );
void messageReminderIntents;

const conversationArchiveIntents:
  Promise<ApplicationChatQueuedConversationArchiveIntentsRecord | null> = storage.read(
    identity,
    ApplicationChatStorageRecordKind.queuedConversationArchiveIntents,
  );
void conversationArchiveIntents;

const draftIntents: Promise<ApplicationChatQueuedDraftIntentsRecord | null> =
  storage.read(identity, ApplicationChatStorageRecordKind.queuedDraftIntents);
void draftIntents;

readCursorIntents.then((record) => {
  const request = record?.intents[0]?.request;
  if (request?.operation === "mark_read") {
    const throughSequence: number = request.throughSequence;
    void throughSequence;
    // @ts-expect-error The discriminated mark-read shape has no fromSequence.
    request.fromSequence;
  }
});

messageMutationIntents.then((record) => {
  const request = record?.intents[0]?.request;
  if (request?.operation === "forward_message.v1") {
    const correlation: string = request.clientCorrelationId;
    const destination: string = request.destinationConversationId;
    void correlation;
    void destination;
    // @ts-expect-error Forward requests have no expectedRevision.
    request.expectedRevision;
  } else if (request?.operation === "edit") {
    const revision: number = request.expectedRevision;
    const text: string = request.content.text;
    void revision;
    void text;
    // @ts-expect-error Edit requests have no reactionKey.
    request.reactionKey;
  } else if (request?.operation === "soft_delete") {
    const revision: number = request.expectedRevision;
    void revision;
    // @ts-expect-error Soft-delete requests have no content.
    request.content;
  } else if (request?.operation === "add_reaction") {
    const reactionKey: string = request.reactionKey;
    void reactionKey;
    // @ts-expect-error Reaction requests have no expectedRevision.
    request.expectedRevision;
  } else if (request?.operation === "remove_reaction") {
    const idempotencyKey: string = request.idempotencyKey;
    void idempotencyKey;
  }
});

conversationCreationIntents.then((record) => {
  const request = record?.intents[0]?.request;
  if (request?.type === "channel") {
    const name: string = request.name;
    const noIntendedMembers: undefined = request.intendedMemberUserIds;
    void name;
    void noIntendedMembers;
  } else if (request?.type === "group_direct") {
    const firstMember: string = request.intendedMemberUserIds[0];
    const noName: undefined = request.name;
    void firstMember;
    void noName;
  }
});

conversationPreferenceIntents.then((record) => {
  const request = record?.intents[0]?.request;
  if (request !== undefined) {
    const revision: number = request.expectedPreferenceRevision;
    const notification: "all" | "mentions" | "none" = request.notificationPreference;
    const starred: boolean = request.isStarred;
    const mutedUntil: string | undefined = request.mute.muted
      ? request.mute.mutedUntil
      : undefined;
    void revision;
    void notification;
    void starred;
    void mutedUntil;
  }
});

threadFollowIntents.then((record) => {
  const request = record?.intents[0]?.request;
  if (request?.intent === "follow") {
    const threadId: ConversationId = request.target.id;
    const revision: number = request.expectedFollowRevision;
    void threadId;
    void revision;
    // @ts-expect-error A canonical thread-follow target is not a parent channel target.
    request.target.channelId;
  } else if (request?.intent === "unfollow") {
    const correlation: string = request.idempotencyKey;
    void correlation;
    // @ts-expect-error Explicit follow mutations never persist a caller-authored source.
    request.source = "manual";
  }
});

savedMessageIntents.then((record) => {
  const request = record?.intents[0]?.request;
  if (request?.intent === "save") {
    const messageId: MessageId = request.messageId;
    const privateNote: string | undefined = request.privateNote;
    const revision: number = request.expectedSavedMessageRevision;
    void messageId;
    void privateNote;
    void revision;
    // @ts-expect-error Saved-message requests never expose caller-authored identity.
    request.tenantId = identity.tenantId;
  } else if (request?.intent === "unsave") {
    const correlation: string = request.idempotencyKey;
    const noPrivateNote: undefined = request.privateNote;
    void correlation;
    void noPrivateNote;
    // @ts-expect-error Unsave requests cannot carry a private note.
    const privateNote: string = request.privateNote;
    void privateNote;
  }
});

messageReminderIntents.then((record) => {
  const request = record?.intents[0]?.request;
  if (request?.intent === "set") {
    const conversationId: ConversationId = request.conversationId;
    const messageId: MessageId = request.messageId;
    const dueAt: string = request.dueAt;
    const revision: number = request.expectedReminderRevision;
    void conversationId;
    void messageId;
    void dueAt;
    void revision;
    // @ts-expect-error Reminder requests never expose caller-authored identity.
    request.tenantId = identity.tenantId;
  } else if (request?.intent === "cancel") {
    const correlation: string = request.idempotencyKey;
    const noDueAt: undefined = request.dueAt;
    void correlation;
    void noDueAt;
    // @ts-expect-error Cancel requests cannot carry a due time.
    const dueAt: string = request.dueAt;
    void dueAt;
  }
});

conversationArchiveIntents.then((record) => {
  const request = record?.intents[0]?.request;
  if (request?.intent === "archive") {
    const conversationId: ConversationId = request.conversationId;
    const revision: number = request.expectedLifecycleRevision;
    const correlation: string = request.idempotencyKey;
    void conversationId;
    void revision;
    void correlation;
    // @ts-expect-error Archive requests never expose caller-authored identity.
    request.tenantId = identity.tenantId;
  } else if (request?.intent === "restore") {
    const operation: "set_conversation_archive" = request.operation;
    void operation;
    // @ts-expect-error Restore requests cannot carry authoritative archive state.
    request.archiveState;
  }
});

draftIntents.then((record) => {
  const request = record?.intents[0]?.request;
  if (request?.intent === "replace") {
    const text: string = request.content.text;
    const attachmentId: string | undefined = request.content.attachments[0]?.attachmentId;
    void text;
    void attachmentId;
  } else if (request?.intent === "clear") {
    const revision: number = request.baseRevision;
    void revision;
    // @ts-expect-error Clear draft requests never carry content.
    request.content.text;
  }
});

const replaceDraftIntent: ApplicationChatQueuedDraftIntent =
  createApplicationChatQueuedDraftIntent({
    operation: "synchronize_draft",
    intent: "replace",
    conversationId: "conversation-1" as ConversationId,
    baseRevision: 2,
    deviceMutationId: "draft-device-mutation-1",
    idempotencyKey: "draft-idempotency-1",
    content: {
      format: "markdown",
      text: "draft",
      mentions: [{ type: "user", userId: identity.userId }],
      attachments: [],
    },
  }, {
    enqueueOrder: 1,
    enqueuedAt: "2026-09-03T12:00:00Z",
  });
const clearDraftIntent = createApplicationChatQueuedDraftIntent({
  operation: "synchronize_draft",
  intent: "clear",
  conversationId: "conversation-2" as ConversationId,
  baseRevision: 4,
  deviceMutationId: "draft-device-mutation-2",
  idempotencyKey: "draft-idempotency-2",
}, {
  enqueueOrder: 2,
  enqueuedAt: "2026-09-03T12:01:00Z",
});
const draftRecord: ApplicationChatQueuedDraftIntentsRecord =
  createApplicationChatQueuedDraftIntentsRecord(
    identity,
    [replaceDraftIntent, clearDraftIntent],
  );
const draftContractVersion: 1 = APPLICATION_CHAT_DRAFT_MUTATION_CONTRACT_VERSION;
const draftConversationLimit: number = MAX_APPLICATION_CHAT_QUEUED_DRAFT_CONVERSATIONS;
const draftIntentByteLimit: number = MAX_APPLICATION_CHAT_QUEUED_DRAFT_INTENT_BYTES;
void draftRecord;
void draftContractVersion;
void draftConversationLimit;
void draftIntentByteLimit;

const forwardIntent = createApplicationChatQueuedMessageMutationIntent({
  operation: "forward_message.v1",
  sourceMessageId: "message-1" as MessageId,
  destinationConversationId: "conversation-2" as ConversationId,
  clientCorrelationId: "correlation-1",
  idempotencyKey: "idempotency-1",
}, {
  enqueueOrder: 1,
  enqueuedAt: "2026-09-03T12:00:00Z",
});
const mutationRecord: ApplicationChatQueuedMessageMutationIntentsRecord =
  createApplicationChatQueuedMessageMutationIntentsRecord(identity, [forwardIntent]);
void mutationRecord;

const creationIntent = createApplicationChatQueuedConversationCreationIntent({
  operation: "create_conversation",
  type: "group_direct",
  visibility: "private",
  intendedMemberUserIds: ["user-3" as UserId, "user-2" as UserId],
  clientRequestId: "creation-request-1",
  idempotencyKey: "creation-idempotency-1",
}, {
  enqueueOrder: 1,
  enqueuedAt: "2026-09-04T05:00:00Z",
});
const creationRecord: ApplicationChatQueuedConversationCreationIntentsRecord =
  createApplicationChatQueuedConversationCreationIntentsRecord(identity, [creationIntent]);
const creationContractVersion: 1 = APPLICATION_CHAT_CONVERSATION_CREATION_CONTRACT_VERSION;
const creationIntentLimit: number = MAX_APPLICATION_CHAT_QUEUED_CONVERSATION_CREATION_INTENTS;
const creationIntentByteLimit: number =
  MAX_APPLICATION_CHAT_QUEUED_CONVERSATION_CREATION_INTENT_BYTES;
const creationMemberLimit: number = MAX_APPLICATION_CHAT_CONVERSATION_CREATION_MEMBERS;
void creationRecord;
void creationContractVersion;
void creationIntentLimit;
void creationIntentByteLimit;
void creationMemberLimit;

const preferenceIntent = createApplicationChatQueuedConversationPreferenceIntent({
  operation: "update_conversation_preference",
  conversationId: "conversation-1" as ConversationId,
  expectedPreferenceRevision: 3,
  idempotencyKey: "preference-idempotency-1",
  notificationPreference: "mentions",
  isStarred: true,
  mute: { muted: true, mutedUntil: "2026-09-05T05:00:00Z" },
}, {
  enqueueOrder: 1,
  enqueuedAt: "2026-09-04T05:00:00Z",
});
const preferenceRecord: ApplicationChatQueuedConversationPreferenceIntentsRecord =
  createApplicationChatQueuedConversationPreferenceIntentsRecord(identity, [preferenceIntent]);
const preferenceContractVersion: 1 = APPLICATION_CHAT_CONVERSATION_PREFERENCE_CONTRACT_VERSION;
const preferenceIntentLimit: number = MAX_APPLICATION_CHAT_QUEUED_CONVERSATION_PREFERENCE_INTENTS;
const preferenceIntentByteLimit: number =
  MAX_APPLICATION_CHAT_QUEUED_CONVERSATION_PREFERENCE_INTENT_BYTES;
void preferenceRecord;
void preferenceContractVersion;
void preferenceIntentLimit;
void preferenceIntentByteLimit;

const followIntent: ApplicationChatQueuedThreadFollowIntent =
  createApplicationChatQueuedThreadFollowIntent({
    operation: "set_thread_follow",
    intent: "follow",
    target: { type: "thread", id: "thread-1" as ConversationId },
    expectedFollowRevision: 4,
    idempotencyKey: "thread-follow-idempotency-1",
  }, {
    enqueueOrder: 1,
    enqueuedAt: "2026-09-04T08:00:00Z",
  });
const unfollowIntent = createApplicationChatQueuedThreadFollowIntent({
  operation: "set_thread_follow",
  intent: "unfollow",
  target: { type: "thread", id: "thread-2" as ConversationId },
  expectedFollowRevision: 7,
  idempotencyKey: "thread-unfollow-idempotency-2",
}, {
  enqueueOrder: 2,
  enqueuedAt: "2026-09-04T08:01:00Z",
});
const threadFollowRecord: ApplicationChatQueuedThreadFollowIntentsRecord =
  createApplicationChatQueuedThreadFollowIntentsRecord(
    identity,
    [followIntent, unfollowIntent],
  );
const threadFollowContractVersion: 1 = APPLICATION_CHAT_THREAD_FOLLOW_CONTRACT_VERSION;
const threadFollowIntentLimit: number = MAX_APPLICATION_CHAT_QUEUED_THREAD_FOLLOW_INTENTS;
const threadFollowIntentByteLimit: number =
  MAX_APPLICATION_CHAT_QUEUED_THREAD_FOLLOW_INTENT_BYTES;
void threadFollowRecord;
void threadFollowContractVersion;
void threadFollowIntentLimit;
void threadFollowIntentByteLimit;

const saveIntent: ApplicationChatQueuedSavedMessageIntent =
  createApplicationChatQueuedSavedMessageIntent({
    operation: "set_saved_message",
    intent: "save",
    messageId: "message-1" as MessageId,
    expectedSavedMessageRevision: 4,
    idempotencyKey: "saved-message-idempotency-1",
    privateNote: "Review in the next planning session",
  }, {
    enqueueOrder: 1,
    enqueuedAt: "2026-09-04T08:00:00Z",
  });
const unsaveIntent = createApplicationChatQueuedSavedMessageIntent({
  operation: "set_saved_message",
  intent: "unsave",
  messageId: "message-2" as MessageId,
  expectedSavedMessageRevision: 7,
  idempotencyKey: "saved-message-idempotency-2",
}, {
  enqueueOrder: 2,
  enqueuedAt: "2026-09-04T08:01:00Z",
});
const savedMessageRecord: ApplicationChatQueuedSavedMessageIntentsRecord =
  createApplicationChatQueuedSavedMessageIntentsRecord(
    identity,
    [saveIntent, unsaveIntent],
  );
const savedMessageContractVersion: 1 = APPLICATION_CHAT_SAVED_MESSAGE_CONTRACT_VERSION;
const savedMessageIntentLimit: number = MAX_APPLICATION_CHAT_QUEUED_SAVED_MESSAGE_INTENTS;
const savedMessageIntentByteLimit: number =
  MAX_APPLICATION_CHAT_QUEUED_SAVED_MESSAGE_INTENT_BYTES;
void savedMessageRecord;
void savedMessageContractVersion;
void savedMessageIntentLimit;
void savedMessageIntentByteLimit;

const setReminderIntent: ApplicationChatQueuedMessageReminderIntent =
  createApplicationChatQueuedMessageReminderIntent({
    operation: "message_reminder.v1",
    intent: "set",
    conversationId: "conversation-1" as ConversationId,
    messageId: "message-1" as MessageId,
    expectedReminderRevision: 4,
    idempotencyKey: "message-reminder-idempotency-1",
    dueAt: "2026-09-05T08:00:00Z",
  }, {
    enqueueOrder: 1,
    enqueuedAt: "2026-09-04T08:00:00Z",
  });
const cancelReminderIntent = createApplicationChatQueuedMessageReminderIntent({
  operation: "message_reminder.v1",
  intent: "cancel",
  conversationId: "conversation-1" as ConversationId,
  messageId: "message-2" as MessageId,
  expectedReminderRevision: 7,
  idempotencyKey: "message-reminder-idempotency-2",
}, {
  enqueueOrder: 2,
  enqueuedAt: "2026-09-04T08:01:00Z",
});
const messageReminderRecord: ApplicationChatQueuedMessageReminderIntentsRecord =
  createApplicationChatQueuedMessageReminderIntentsRecord(
    identity,
    [setReminderIntent, cancelReminderIntent],
  );
const messageReminderContractVersion: 1 = APPLICATION_CHAT_MESSAGE_REMINDER_CONTRACT_VERSION;
const messageReminderIntentLimit: number = MAX_APPLICATION_CHAT_QUEUED_MESSAGE_REMINDER_INTENTS;
const messageReminderIntentByteLimit: number =
  MAX_APPLICATION_CHAT_QUEUED_MESSAGE_REMINDER_INTENT_BYTES;
void messageReminderRecord;
void messageReminderContractVersion;
void messageReminderIntentLimit;
void messageReminderIntentByteLimit;

const archiveConversationIntent: ApplicationChatQueuedConversationArchiveIntent =
  createApplicationChatQueuedConversationArchiveIntent({
    operation: "set_conversation_archive",
    intent: "archive",
    conversationId: "conversation-1" as ConversationId,
    expectedLifecycleRevision: 4,
    idempotencyKey: "conversation-archive-idempotency-1",
  }, {
    enqueueOrder: 1,
    enqueuedAt: "2026-09-04T08:00:00Z",
  });
const restoreConversationIntent = createApplicationChatQueuedConversationArchiveIntent({
  operation: "set_conversation_archive",
  intent: "restore",
  conversationId: "conversation-2" as ConversationId,
  expectedLifecycleRevision: 7,
  idempotencyKey: "conversation-restore-idempotency-2",
}, {
  enqueueOrder: 2,
  enqueuedAt: "2026-09-04T08:01:00Z",
});
const conversationArchiveRecord: ApplicationChatQueuedConversationArchiveIntentsRecord =
  createApplicationChatQueuedConversationArchiveIntentsRecord(
    identity,
    [archiveConversationIntent, restoreConversationIntent],
  );
const conversationArchiveContractVersion: 1 =
  APPLICATION_CHAT_CONVERSATION_ARCHIVE_CONTRACT_VERSION;
const conversationArchiveIntentLimit: number =
  MAX_APPLICATION_CHAT_QUEUED_CONVERSATION_ARCHIVE_INTENTS;
const conversationArchiveIntentByteLimit: number =
  MAX_APPLICATION_CHAT_QUEUED_CONVERSATION_ARCHIVE_INTENT_BYTES;
void conversationArchiveRecord;
void conversationArchiveContractVersion;
void conversationArchiveIntentLimit;
void conversationArchiveIntentByteLimit;

const sendRequest = {
  operation: "send",
  conversationId: "conversation-1",
  content: { format: "plain", text: "hello" },
  clientMessageId: "client-1",
  idempotencyKey: "idempotency-1",
} as const;
// @ts-expect-error Send-message requests belong to the separate queued-send record.
createApplicationChatQueuedMessageMutationIntent(sendRequest, {
  enqueueOrder: 1,
  enqueuedAt: "2026-09-03T12:00:00Z",
});

const logoutClear: Promise<void> = storage.clearForLogout(identity);
void logoutClear;

// @ts-expect-error Logout clearing always requires one exact identity.
storage.clearForLogout();

// @ts-expect-error Global host-storage clearing is intentionally not part of the contract.
storage.clear();
