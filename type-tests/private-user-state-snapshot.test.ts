import {
  ACTOR_PRIVATE_USER_STATE_PRIVACY,
  parseConversationDraftSnapshot,
  parseConversationDraftSnapshotInput,
  parseSavedMessageListSnapshot,
  parseSavedMessageListSnapshotInput,
  type AbsentConversationDraftSnapshot,
  type ActorPrivateSavedMessageNote,
  type ConversationDraftSnapshotInput,
  type PresentConversationDraftSnapshot,
  type SavedMessageListSnapshot,
  type SavedMessageListSnapshotInput,
  type SavedMessageSnapshotEntry,
  type SavedMessageCurrentProjection,
} from "../src/contracts/private-user-state-snapshot.js";
import type {
  ConversationId,
  MessageId,
} from "../src/contracts/identifiers.js";

const conversationId = "conversation-private" as ConversationId;
const messageId = "message-saved" as MessageId;

const draftInput: ConversationDraftSnapshotInput = { conversationId };
const savedInput: SavedMessageListSnapshotInput = { limit: 25 };

const present: PresentConversationDraftSnapshot = {
  kind: "conversation_draft",
  privacy: ACTOR_PRIVATE_USER_STATE_PRIVACY,
  conversationId,
  state: "present",
  canonicalRevision: 2,
  canonicalUpdatedAt: "2026-08-26T12:00:00.000Z",
  content: {
    privacy: ACTOR_PRIVATE_USER_STATE_PRIVACY,
    value: { format: "plain", text: "Private draft", attachments: [] },
  },
};
for (const notifyAuthor of [true, false]) {
  const replyDraft: PresentConversationDraftSnapshot = {
    ...present,
    content: {
      ...present.content,
      value: { ...present.content.value, replyTo: { messageId, notifyAuthor } },
    },
  };
  const parsed = parseConversationDraftSnapshot(replyDraft, draftInput);
  if (parsed.state === "present") {
    const target: MessageId | undefined = parsed.content.value.replyTo?.messageId;
    const ping: boolean | undefined = parsed.content.value.replyTo?.notifyAuthor;
    void [target, ping];
  }
}

type DraftReply = NonNullable<PresentConversationDraftSnapshot["content"]["value"]["replyTo"]>;
// @ts-expect-error A reply must specify the author's notification choice.
const replyWithoutPing: DraftReply = { messageId };
// @ts-expect-error Notification choices must be boolean.
const replyWithInvalidPing: DraftReply = { messageId, notifyAuthor: "false" };
// @ts-expect-error Supplied replies cannot be null.
const nullReply: DraftReply = null;
const replyWithDestination: DraftReply = {
  messageId,
  notifyAuthor: false,
  // @ts-expect-error Replies inherit the draft conversation rather than selecting a destination.
  conversationId,
};
void [replyWithoutPing, replyWithInvalidPing, nullReply, replyWithDestination];

const absent: AbsentConversationDraftSnapshot = {
  kind: "conversation_draft",
  privacy: ACTOR_PRIVATE_USER_STATE_PRIVACY,
  conversationId,
  state: "absent",
  canonicalRevision: 0,
  canonicalUpdatedAt: null,
  content: null,
};

const note: ActorPrivateSavedMessageNote = {
  privacy: ACTOR_PRIVATE_USER_STATE_PRIVACY,
  text: "Actor-only reminder",
};
const visibleEntry: SavedMessageSnapshotEntry = {
  messageId,
  savedMessageRevision: 2,
  savedAt: "2026-08-26T12:00:00.000Z",
  updatedAt: "2026-08-26T12:00:00.000Z",
  privateNote: note,
  message: {
    availability: "available",
    current: {
      id: messageId,
      conversationId,
      author: { type: "user", userId: "author" as never },
      sequence: 4,
      createdAt: "2026-08-26T11:00:00.000Z",
      updatedAt: "2026-08-26T11:00:00.000Z",
      revision: { revision: 1 },
      content: { format: "plain", text: "Visible current message" },
      attachmentMetadata: [],
    },
  },
};
const unavailableEntry: SavedMessageSnapshotEntry = {
  messageId: "message-inaccessible" as MessageId,
  savedMessageRevision: 1,
  savedAt: "2026-08-26T11:00:00.000Z",
  updatedAt: "2026-08-26T11:00:00.000Z",
  message: { availability: "unavailable", reason: "inaccessible" },
};
const savedSnapshot: SavedMessageListSnapshot = {
  kind: "saved_message_list",
  privacy: ACTOR_PRIVATE_USER_STATE_PRIVACY,
  items: [visibleEntry, unavailableEntry],
  page: { nextCursor: null },
};

const tenantSpoof: ConversationDraftSnapshotInput = {
  conversationId,
  // @ts-expect-error Tenant identity is server-derived.
  tenantId: "tenant-spoof",
};
const actorSpoof: SavedMessageListSnapshotInput = {
  limit: 25,
  // @ts-expect-error Current-user identity is server-derived.
  currentUserId: "user-spoof",
};
const otherUserSpoof: SavedMessageListSnapshotInput = {
  limit: 25,
  // @ts-expect-error A client cannot select another user's private state.
  otherUserId: "user-other",
};
const roleSpoof: SavedMessageListSnapshotInput = {
  limit: 25,
  // @ts-expect-error Roles and authorization are server-derived.
  roles: ["admin"],
};
const unmarkedNote: ActorPrivateSavedMessageNote = {
  // @ts-expect-error Private notes require the explicit actor-private marker.
  privacy: "private",
  text: "secret",
};
const unavailableWithContent: SavedMessageSnapshotEntry = {
  ...unavailableEntry,
  message: {
    availability: "unavailable",
    reason: "deleted",
    // @ts-expect-error Unavailable tombstones cannot retain stale content.
    content: { format: "plain", text: "stale" },
  },
};
const absentWithContent: AbsentConversationDraftSnapshot = {
  ...absent,
  // @ts-expect-error An absent draft cannot contain private content.
  content: present.content,
};

parseConversationDraftSnapshotInput(draftInput);
parseConversationDraftSnapshot(present, draftInput);
parseConversationDraftSnapshot(absent, draftInput);
parseSavedMessageListSnapshotInput(savedInput);
parseSavedMessageListSnapshot(savedSnapshot, savedInput);

void [
  tenantSpoof,
  actorSpoof,
  otherUserSpoof,
  roleSpoof,
  unmarkedNote,
  unavailableWithContent,
  absentWithContent,
];


for (const notifyAuthor of [true, false]) {
  if (visibleEntry.message.availability === "available") {
    const current: SavedMessageCurrentProjection = {
      ...visibleEntry.message.current, replyTo: { messageId, notifyAuthor },
    };
    const target: MessageId | undefined = current.replyTo?.messageId;
    const ping: boolean | undefined = current.replyTo?.notifyAuthor;
    void [target, ping];
  }
}
type SavedReply = NonNullable<SavedMessageCurrentProjection["replyTo"]>;
// @ts-expect-error Supplied saved replies cannot be null.
const nullSavedReply: SavedReply = null;
// @ts-expect-error The notification choice is required.
const missingSavedPing: SavedReply = { messageId };
// @ts-expect-error The notification choice is boolean.
const invalidSavedPing: SavedReply = { messageId, notifyAuthor: "false" };
const destinationSavedReply: SavedReply = {
  messageId, notifyAuthor: false,
  // @ts-expect-error Reply identity inherits the containing conversation.
  conversationId,
};
const unavailableWithReply: SavedMessageSnapshotEntry = {
  ...unavailableEntry,
  message: {
    availability: "unavailable", reason: "deleted",
    // @ts-expect-error Unavailable shells cannot retain reply metadata.
    replyTo: { messageId, notifyAuthor: false },
  },
};
void [nullSavedReply, missingSavedPing, invalidSavedPing, destinationSavedReply, unavailableWithReply];
