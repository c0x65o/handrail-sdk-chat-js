import type { ConversationId } from "../src/contracts/identifiers.js";
import type { MessageTimelineMessage } from "../src/contracts/message-timeline.js";
import type { ChatStorageAdapter, TrustedChatActorContext } from "../src/server/contracts.js";
import { rowToMessage, type StoredMessageRow } from "../src/server/message-timeline-query.js";

const row: StoredMessageRow = {
  message_id: "reply",
  sequence: "2",
  author_user_id: "bob",
  reply_to_message_id: "source",
  reply_notify_author: false,
  content: { format: "plain", text: "Friday" },
  current_revision: 1,
  created_at: "2030-01-01T00:00:00Z",
  updated_at: "2030-01-01T00:00:00Z",
  edited_at: null,
  edited_by_user_id: null,
  deleted_at: null,
  deleted_by_user_id: null,
  reactions: [{ reactionKey: "eyes", count: 1, reactedByCurrentUser: true }],
  attachments: [{ attachmentId: "attachment", storageKey: "private/key", fileName: "report.txt", contentType: "text/plain", sizeBytes: 12 }],
  thread_summary: { threadId: "thread", replyCount: 1, participantIds: ["alice"], unreadCount: 0 },
};

declare const actor: TrustedChatActorContext;
declare const storage: Pick<ChatStorageAdapter, "createDownloadUrl">;

// Exact-source callers provide no timeline entity, replay, pagination or direction fields.
const message: Promise<MessageTimelineMessage> = rowToMessage(
  row, { conversationId: "channel" as ConversationId }, actor, storage,
);
void message;
