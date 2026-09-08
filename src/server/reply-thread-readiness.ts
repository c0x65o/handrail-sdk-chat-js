import { CHAT_REPLY_THREAD_FEATURES as F, type ChatReplyThreadFeature } from "../contracts/generated/realtime-handshake.js";
import type { PostgresMigrationDatabase, PostgresMigrationStatus } from "./postgres-migrations.js";
import {
  chatConversationsMembershipMigration, chatMessagesRevisionMigration,
  chatReadCursorsMigration, chatOutboxEventsMigration, chatIdempotencyKeysMigration,
  chatConversationPreferencesMigration, chatThreadFollowsMigration,
  chatAttachmentsMigration, chatAuditEventsMigration,
  chatConversationLifecycleRevisionMigration, chatThreadFollowRevisionMigration,
  chatConversationMemberListRevisionMigration, chatConversationPreferenceRevisionMigration,
  chatConversationListOrderingMigration, chatConversationPreferenceStarredMigration,
  chatMessageRepliesMigration, chatThreadNamesMigration, chatThreadLifecycleMigration,
} from "./postgres-schema-migrations.js";

// These are storage dependencies of the wired parent-safe readers, subscriptions,
// notification eligibility and unread projections, not a broad schema version.
// Source implementation guarantees and their regression evidence are documented
// in docs/reply-thread-capabilities.md. No optional delivery adapter is required.
const reads = [chatConversationsMembershipMigration, chatMessagesRevisionMigration,
  chatReadCursorsMigration, chatConversationPreferencesMigration, chatThreadFollowsMigration,
  chatConversationLifecycleRevisionMigration, chatThreadFollowRevisionMigration,
  chatConversationMemberListRevisionMigration, chatConversationPreferenceRevisionMigration,
  chatConversationListOrderingMigration, chatConversationPreferenceStarredMigration,
  chatMessageRepliesMigration, chatThreadLifecycleMigration];
const writes = [chatOutboxEventsMigration, chatIdempotencyKeysMigration, chatAuditEventsMigration];
const readTables = ["chat_conversations", "chat_conversation_members", "chat_messages",
  "chat_thread_follows", "chat_read_cursors", "chat_conversation_preferences"];
const privilegesFor = (feature: ChatReplyThreadFeature): [string, string][] => {
  const tables = feature === F.threadLifecycle
    ? ["chat_conversations", "chat_conversation_members"] : readTables;
  const required: [string, string][] = tables.map(table => [table, "SELECT"]);
  if (feature === F.threadDiscovery || feature === F.threadInactivity) return required;
  for (const table of ["chat_idempotency_keys", "chat_outbox_events"]) {
    required.push([table, "SELECT"], [table, "INSERT"]);
  }
  required.push(["chat_idempotency_keys", "UPDATE"], ["chat_conversations", "UPDATE"],
    // Parent/member locking uses FOR SHARE/UPDATE even without changing members.
    ["chat_conversation_members", "UPDATE"]);
  if (feature === F.inlineReplies || feature === F.namedThreads) {
    required.push(["chat_audit_events", "INSERT"]);
    for (const table of ["chat_conversation_members", "chat_thread_follows", "chat_read_cursors"]) {
      required.push([table, "INSERT"], [table, "UPDATE"]);
    }
    required.push(["chat_attachments", "SELECT"], ["chat_attachments", "INSERT"], ["chat_attachments", "UPDATE"]);
  }
  if (feature === F.inlineReplies) required.push(["chat_messages", "INSERT"], ["chat_messages", "UPDATE"],
    ["chat_message_revisions", "SELECT"], ["chat_message_revisions", "INSERT"]);
  if (feature === F.namedThreads) required.push(["chat_conversations", "INSERT"], ["chat_messages", "UPDATE"]);
  return required;
};

/** Read-only and uncached; deployment availability never grants actor access. */
export async function replyThreadStorageReady(options: {
  readonly feature: ChatReplyThreadFeature;
  readonly database: PostgresMigrationDatabase;
  readonly schema: string;
  readonly status: PostgresMigrationStatus;
}): Promise<boolean> {
  const { feature, database, schema, status } = options;
  const write = feature !== F.threadDiscovery && feature !== F.threadInactivity;
  const migrations = feature === F.threadLifecycle
    ? [chatConversationsMembershipMigration, chatConversationLifecycleRevisionMigration,
       chatThreadLifecycleMigration, chatOutboxEventsMigration, chatIdempotencyKeysMigration]
    : [...reads, ...(write ? writes : []),
    ...(feature === F.inlineReplies || feature === F.namedThreads ? [chatAttachmentsMigration] : []),
    ...(feature === F.namedThreads ? [chatThreadNamesMigration] : [])];
  if (status.incompatible.length > 0 || migrations.some(migration =>
    !status.applied.some(applied => applied.id === migration.id))) return false;
  const prefix = `"${schema.replaceAll('"', '""')}"`;
  try {
    const privileges = privilegesFor(feature);
    const result = await database.query<{ ready: boolean }>(
      `SELECT has_schema_privilege($1, 'USAGE')
        AND (NOT $2::boolean OR (current_setting('transaction_read_only') = 'off'
          AND has_function_privilege($3, 'EXECUTE')))
        AND bool_and(has_table_privilege(relation, privilege)) AS ready
       FROM unnest($4::text[], $5::text[]) AS required(relation, privilege)`,
      [schema, write, `${prefix}.claim_chat_idempotency_key(text,text,text,text,text,timestamptz)`,
        privileges.map(([table]) => `${prefix}.${table}`), privileges.map(([, privilege]) => privilege)],
    );
    if (result.rows[0]?.ready !== true) return false;
    // Detect missing columns even if a deployment's migration ledger is stale.
    await database.query(`SELECT parent_conversation_id, root_message_id, name,
      lifecycle_revision, closed_at, closed_by_user_id, locked
      FROM ${prefix}.chat_conversations LIMIT 0`);
    if (feature !== F.threadLifecycle) {
      await database.query(`SELECT reply_to_message_id, reply_notify_author
        FROM ${prefix}.chat_messages LIMIT 0`);
    }
    return true;
  } catch {
    return false;
  }
}
