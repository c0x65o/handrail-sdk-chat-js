import type { PostgresMigration } from "./postgres-migrations.js";

/**
 * Creates the tenant-scoped conversation streams and their host-user memberships.
 *
 * `root_message_id` intentionally has no foreign key yet: the ordered messages
 * migration owns adding that constraint after `chat_messages` exists.
 */
export const chatConversationsMembershipMigration: PostgresMigration =
  Object.freeze({
    id: "0001-chat-conversations-membership",
    order: 1,
    statements: Object.freeze([
      `CREATE TABLE chat_conversations (
         tenant_id text NOT NULL,
         id text NOT NULL,
         type text NOT NULL,
         visibility text NOT NULL,
         name text,
         entity_type text,
         entity_id text,
         parent_conversation_id text,
         root_message_id text,
         current_message_sequence bigint NOT NULL DEFAULT 0,
         archived_at timestamptz,
         archived_by_user_id text,
         created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
         updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
         CONSTRAINT chat_conversations_pkey
           PRIMARY KEY (tenant_id, id),
         CONSTRAINT chat_conversations_type_check
           CHECK (type IN ('channel', 'direct', 'group_direct', 'thread')),
         CONSTRAINT chat_conversations_visibility_check
           CHECK (visibility IN ('public', 'private')),
         CONSTRAINT chat_conversations_direct_visibility_check
           CHECK (
             type NOT IN ('direct', 'group_direct')
             OR visibility = 'private'
           ),
         CONSTRAINT chat_conversations_channel_shape_check
           CHECK (
             (type = 'channel' AND name IS NOT NULL)
             OR (
               type <> 'channel'
               AND name IS NULL
               AND entity_type IS NULL
               AND entity_id IS NULL
             )
           ),
         CONSTRAINT chat_conversations_entity_pair_check
           CHECK ((entity_type IS NULL) = (entity_id IS NULL)),
         CONSTRAINT chat_conversations_thread_shape_check
           CHECK (
             (
               type = 'thread'
               AND parent_conversation_id IS NOT NULL
               AND root_message_id IS NOT NULL
             )
             OR (
               type <> 'thread'
               AND parent_conversation_id IS NULL
               AND root_message_id IS NULL
             )
           ),
         CONSTRAINT chat_conversations_sequence_check
           CHECK (
             current_message_sequence >= 0
             AND current_message_sequence <= 9007199254740991
           ),
         CONSTRAINT chat_conversations_archive_pair_check
           CHECK ((archived_at IS NULL) = (archived_by_user_id IS NULL)),
         CONSTRAINT chat_conversations_parent_fkey
           FOREIGN KEY (tenant_id, parent_conversation_id)
           REFERENCES chat_conversations (tenant_id, id)
       )`,
      `CREATE INDEX chat_conversations_tenant_type_idx
         ON chat_conversations (tenant_id, type)`,
      `CREATE INDEX chat_conversations_parent_thread_idx
         ON chat_conversations (tenant_id, parent_conversation_id)
         WHERE type = 'thread'`,
      `CREATE INDEX chat_conversations_entity_idx
         ON chat_conversations (tenant_id, entity_type, entity_id)
         WHERE entity_type IS NOT NULL`,
      `CREATE TABLE chat_conversation_members (
         tenant_id text NOT NULL,
         conversation_id text NOT NULL,
         user_id text NOT NULL,
         role text NOT NULL,
         state text NOT NULL,
         joined_at timestamptz NOT NULL DEFAULT clock_timestamp(),
         updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
         CONSTRAINT chat_conversation_members_pkey
           PRIMARY KEY (tenant_id, conversation_id, user_id),
         CONSTRAINT chat_conversation_members_role_check
           CHECK (role IN ('owner', 'moderator', 'member')),
         CONSTRAINT chat_conversation_members_state_check
           CHECK (state IN ('active', 'left', 'removed')),
         CONSTRAINT chat_conversation_members_conversation_fkey
           FOREIGN KEY (tenant_id, conversation_id)
           REFERENCES chat_conversations (tenant_id, id)
       )`,
      `CREATE INDEX chat_conversation_members_user_idx
         ON chat_conversation_members (tenant_id, user_id, conversation_id)`,
    ]),
  });

/**
 * Adds ordered message persistence, append-only revisions, and the deferred
 * thread-root relationship back to a message in the parent conversation.
 */
export const chatMessagesRevisionMigration: PostgresMigration = Object.freeze({
  id: "0002-chat-messages-revisions",
  order: 2,
  statements: Object.freeze([
    `CREATE TABLE chat_messages (
       tenant_id text NOT NULL,
       id text NOT NULL,
       conversation_id text NOT NULL,
       sequence bigint NOT NULL,
       author_user_id text NOT NULL,
       client_message_id text NOT NULL,
       content jsonb,
       current_revision bigint NOT NULL DEFAULT 1,
       created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
       updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
       edited_at timestamptz,
       edited_by_user_id text,
       deleted_at timestamptz,
       deleted_by_user_id text,
       CONSTRAINT chat_messages_pkey
         PRIMARY KEY (tenant_id, id),
       CONSTRAINT chat_messages_conversation_sequence_key
         UNIQUE (tenant_id, conversation_id, sequence),
       CONSTRAINT chat_messages_author_client_message_key
         UNIQUE (tenant_id, author_user_id, client_message_id),
       CONSTRAINT chat_messages_conversation_identity_key
         UNIQUE (tenant_id, conversation_id, id),
       CONSTRAINT chat_messages_sequence_check
         CHECK (sequence >= 1 AND sequence <= 9007199254740991),
       CONSTRAINT chat_messages_current_revision_check
         CHECK (
           current_revision >= 1
           AND current_revision <= 9007199254740991
         ),
       CONSTRAINT chat_messages_content_check
         CHECK (
           content IS NULL
           OR (
             jsonb_typeof(content) = 'object'
             AND jsonb_typeof(content -> 'format') = 'string'
             AND content ->> 'format' IN ('plain', 'markdown')
             AND jsonb_typeof(content -> 'text') = 'string'
           ) IS TRUE
         ),
       CONSTRAINT chat_messages_content_deletion_check
         CHECK (content IS NOT NULL OR deleted_at IS NOT NULL),
       CONSTRAINT chat_messages_edited_pair_check
         CHECK ((edited_at IS NULL) = (edited_by_user_id IS NULL)),
       CONSTRAINT chat_messages_deletion_pair_check
         CHECK ((deleted_at IS NULL) = (deleted_by_user_id IS NULL)),
       CONSTRAINT chat_messages_timestamp_order_check
         CHECK (
           updated_at >= created_at
           AND (edited_at IS NULL OR edited_at >= created_at)
           AND (edited_at IS NULL OR updated_at >= edited_at)
           AND (deleted_at IS NULL OR deleted_at >= created_at)
           AND (deleted_at IS NULL OR updated_at >= deleted_at)
         ),
       CONSTRAINT chat_messages_conversation_fkey
         FOREIGN KEY (tenant_id, conversation_id)
         REFERENCES chat_conversations (tenant_id, id)
     )`,
    `CREATE INDEX chat_messages_conversation_timeline_idx
       ON chat_messages (tenant_id, conversation_id, sequence DESC)
       INCLUDE (id, created_at)`,
    `CREATE TABLE chat_message_revisions (
       tenant_id text NOT NULL,
       message_id text NOT NULL,
       revision_number bigint NOT NULL,
       content jsonb NOT NULL,
       created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
       created_by_user_id text NOT NULL,
       CONSTRAINT chat_message_revisions_pkey
         PRIMARY KEY (tenant_id, message_id, revision_number),
       CONSTRAINT chat_message_revisions_number_check
         CHECK (
           revision_number >= 1
           AND revision_number <= 9007199254740991
         ),
       CONSTRAINT chat_message_revisions_content_check
         CHECK (
           (
             jsonb_typeof(content) = 'object'
             AND jsonb_typeof(content -> 'format') = 'string'
             AND content ->> 'format' IN ('plain', 'markdown')
             AND jsonb_typeof(content -> 'text') = 'string'
           ) IS TRUE
         ),
       CONSTRAINT chat_message_revisions_message_fkey
         FOREIGN KEY (tenant_id, message_id)
         REFERENCES chat_messages (tenant_id, id)
     )`,
    `CREATE INDEX chat_message_revisions_lookup_idx
       ON chat_message_revisions
         (tenant_id, message_id, revision_number DESC)
       INCLUDE (content, created_at, created_by_user_id)`,
    `CREATE FUNCTION reject_chat_message_revision_mutation()
       RETURNS trigger
       LANGUAGE plpgsql
       AS $function$
       BEGIN
         RAISE EXCEPTION 'chat_message_revisions are append-only'
           USING ERRCODE = '55000';
       END;
       $function$`,
    `CREATE TRIGGER chat_message_revisions_reject_update_delete
       BEFORE UPDATE OR DELETE ON chat_message_revisions
       FOR EACH ROW
       EXECUTE FUNCTION reject_chat_message_revision_mutation()`,
    `CREATE TRIGGER chat_message_revisions_reject_truncate
       BEFORE TRUNCATE ON chat_message_revisions
       FOR EACH STATEMENT
       EXECUTE FUNCTION reject_chat_message_revision_mutation()`,
    `ALTER TABLE chat_conversations
       ADD CONSTRAINT chat_conversations_root_message_fkey
       FOREIGN KEY (tenant_id, parent_conversation_id, root_message_id)
       REFERENCES chat_messages (tenant_id, conversation_id, id)`,
  ]),
});

/**
 * Adds tenant-scoped message reactions.
 *
 * Reaction keys are a bounded wire/storage identity: 1-64 UTF-8 bytes, exact
 * Unicode NFC, and without leading or trailing whitespace. Callers normalize
 * before persistence so uniqueness has one canonical representation.
 */
export const chatReactionsMigration: PostgresMigration = Object.freeze({
  id: "0003-chat-reactions",
  order: 3,
  statements: Object.freeze([
    `CREATE TABLE chat_reactions (
       tenant_id text NOT NULL,
       message_id text NOT NULL,
       user_id text NOT NULL,
       reaction_key text NOT NULL,
       created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
       updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
       CONSTRAINT chat_reactions_pkey
         PRIMARY KEY (tenant_id, message_id, user_id, reaction_key),
       CONSTRAINT chat_reactions_reaction_key_check
         CHECK (
           octet_length(reaction_key) BETWEEN 1 AND 64
           AND reaction_key = normalize(reaction_key, NFC)
           AND reaction_key !~ '^[[:space:]]'
           AND reaction_key !~ '[[:space:]]$'
         ),
       CONSTRAINT chat_reactions_timestamp_order_check
         CHECK (updated_at >= created_at),
       CONSTRAINT chat_reactions_message_fkey
         FOREIGN KEY (tenant_id, message_id)
         REFERENCES chat_messages (tenant_id, id)
     )`,
    `CREATE INDEX chat_reactions_message_aggregate_idx
       ON chat_reactions (tenant_id, message_id, reaction_key)
       INCLUDE (user_id)`,
    `CREATE INDEX chat_reactions_user_toggle_idx
       ON chat_reactions (tenant_id, user_id, message_id, reaction_key)`,
  ]),
});

/** Adds one tenant-safe sequence cursor per conversation membership. */
export const chatReadCursorsMigration: PostgresMigration = Object.freeze({
  id: "0004-chat-read-cursors",
  order: 4,
  statements: Object.freeze([
    `CREATE TABLE chat_read_cursors (
       tenant_id text NOT NULL,
       conversation_id text NOT NULL,
       user_id text NOT NULL,
       last_read_sequence bigint NOT NULL,
       manual_unread_from_sequence bigint,
       updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
       CONSTRAINT chat_read_cursors_pkey
         PRIMARY KEY (tenant_id, conversation_id, user_id),
       CONSTRAINT chat_read_cursors_last_read_sequence_check
         CHECK (
           last_read_sequence >= 0
           AND last_read_sequence <= 9007199254740991
         ),
       CONSTRAINT chat_read_cursors_manual_unread_sequence_check
         CHECK (
           manual_unread_from_sequence IS NULL
           OR (
             manual_unread_from_sequence >= 1
             AND manual_unread_from_sequence <= last_read_sequence
           )
         ),
       CONSTRAINT chat_read_cursors_membership_fkey
         FOREIGN KEY (tenant_id, conversation_id, user_id)
         REFERENCES chat_conversation_members
           (tenant_id, conversation_id, user_id)
     )`,
    `CREATE INDEX chat_read_cursors_user_unread_idx
       ON chat_read_cursors (tenant_id, user_id, conversation_id)
       INCLUDE (
         last_read_sequence,
         manual_unread_from_sequence,
         updated_at
       )`,
  ]),
});

/**
 * Adds delivery-only persistence for the shared realtime event envelope.
 * Relational chat tables remain authoritative for all domain state.
 */
export const chatOutboxEventsMigration: PostgresMigration = Object.freeze({
  id: "0005-chat-outbox-events",
  order: 5,
  statements: Object.freeze([
    `CREATE TABLE chat_outbox_events (
       replay_position bigint GENERATED ALWAYS AS IDENTITY,
       event_id text NOT NULL,
       protocol_version bigint NOT NULL,
       tenant_id text NOT NULL,
       stream_id text NOT NULL,
       type text NOT NULL,
       occurred_at timestamptz NOT NULL,
       payload jsonb NOT NULL,
       publish_attempts bigint NOT NULL DEFAULT 0,
       claim_token text,
       claimed_at timestamptz,
       available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
       published_at timestamptz,
       expires_at timestamptz NOT NULL,
       CONSTRAINT chat_outbox_events_pkey
         PRIMARY KEY (replay_position),
       CONSTRAINT chat_outbox_events_event_id_key
         UNIQUE (event_id),
       CONSTRAINT chat_outbox_events_replay_position_check
         CHECK (
           replay_position >= 1
           AND replay_position <= 9007199254740991
         ),
       CONSTRAINT chat_outbox_events_event_id_check
         CHECK (event_id ~ '[^[:space:]]'),
       CONSTRAINT chat_outbox_events_protocol_version_check
         CHECK (
           protocol_version >= 1
           AND protocol_version <= 9007199254740991
         ),
       CONSTRAINT chat_outbox_events_tenant_id_check
         CHECK (tenant_id ~ '[^[:space:]]'),
       CONSTRAINT chat_outbox_events_stream_id_check
         CHECK (stream_id ~ '[^[:space:]]'),
       CONSTRAINT chat_outbox_events_type_check
         CHECK (type ~ '[^[:space:]]'),
       CONSTRAINT chat_outbox_events_publish_attempts_check
         CHECK (
           publish_attempts >= 0
           AND publish_attempts <= 9007199254740991
         ),
       CONSTRAINT chat_outbox_events_claim_check
         CHECK (
           (claim_token IS NULL) = (claimed_at IS NULL)
           AND (claim_token IS NULL OR claim_token ~ '[^[:space:]]')
         ),
       CONSTRAINT chat_outbox_events_published_claim_check
         CHECK (
           published_at IS NULL
           OR (claim_token IS NULL AND claimed_at IS NULL)
         ),
       CONSTRAINT chat_outbox_events_timestamp_check
         CHECK (
           occurred_at > '-infinity'::timestamptz
           AND occurred_at < 'infinity'::timestamptz
           AND available_at > '-infinity'::timestamptz
           AND available_at < 'infinity'::timestamptz
           AND expires_at > occurred_at
           AND expires_at < 'infinity'::timestamptz
           AND (claimed_at IS NULL OR claimed_at >= occurred_at)
           AND (published_at IS NULL OR published_at >= occurred_at)
         )
     )`,
    `CREATE INDEX chat_outbox_events_pending_idx
       ON chat_outbox_events (available_at, replay_position)
       INCLUDE (publish_attempts)
       WHERE published_at IS NULL`,
    `CREATE INDEX chat_outbox_events_tenant_stream_replay_idx
       ON chat_outbox_events (tenant_id, stream_id, replay_position)`,
    `CREATE FUNCTION reject_chat_outbox_event_envelope_mutation()
       RETURNS trigger
       LANGUAGE plpgsql
       AS $function$
       BEGIN
         IF NEW.replay_position IS DISTINCT FROM OLD.replay_position
            OR NEW.event_id IS DISTINCT FROM OLD.event_id
            OR NEW.protocol_version IS DISTINCT FROM OLD.protocol_version
            OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
            OR NEW.stream_id IS DISTINCT FROM OLD.stream_id
            OR NEW.type IS DISTINCT FROM OLD.type
            OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at
            OR NEW.payload IS DISTINCT FROM OLD.payload THEN
           RAISE EXCEPTION 'chat_outbox_events envelopes are immutable'
             USING ERRCODE = '55000';
         END IF;
         RETURN NEW;
       END;
       $function$`,
    `CREATE TRIGGER chat_outbox_events_reject_envelope_update
       BEFORE UPDATE ON chat_outbox_events
       FOR EACH ROW
       EXECUTE FUNCTION reject_chat_outbox_event_envelope_mutation()`,
  ]),
});

/**
 * Adds durable, actor-scoped mutation idempotency reservations and outcomes.
 *
 * `claim_chat_idempotency_key` is the atomic entry point: an equal request hash
 * returns the existing reservation/outcome, while a reused key with a different
 * hash returns no row. Callers complete the mutation and reservation in the same
 * database transaction so concurrent retries observe exactly one outcome.
 */
export const chatIdempotencyKeysMigration: PostgresMigration = Object.freeze({
  id: "0006-chat-idempotency-keys",
  order: 6,
  statements: Object.freeze([
    `CREATE TABLE chat_idempotency_keys (
       tenant_id text NOT NULL,
       user_id text NOT NULL,
       operation_name text NOT NULL,
       client_key text NOT NULL,
       request_hash text NOT NULL,
       state text NOT NULL DEFAULT 'pending',
       response_status smallint,
       response_body jsonb,
       response_reference text,
       created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
       updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
       completed_at timestamptz,
       expires_at timestamptz NOT NULL,
       CONSTRAINT chat_idempotency_keys_pkey
         PRIMARY KEY (tenant_id, user_id, operation_name, client_key),
       CONSTRAINT chat_idempotency_keys_tenant_id_check
         CHECK (
           octet_length(tenant_id) BETWEEN 1 AND 255
           AND tenant_id ~ '[^[:space:]]'
         ),
       CONSTRAINT chat_idempotency_keys_user_id_check
         CHECK (
           octet_length(user_id) BETWEEN 1 AND 255
           AND user_id ~ '[^[:space:]]'
         ),
       CONSTRAINT chat_idempotency_keys_operation_name_check
         CHECK (
           octet_length(operation_name) BETWEEN 1 AND 128
           AND operation_name ~ '[^[:space:]]'
         ),
       CONSTRAINT chat_idempotency_keys_client_key_check
         CHECK (
           octet_length(client_key) BETWEEN 1 AND 255
           AND client_key ~ '[^[:space:]]'
         ),
       CONSTRAINT chat_idempotency_keys_request_hash_check
         CHECK (request_hash ~ '^sha256:[0-9a-f]{64}$'),
       CONSTRAINT chat_idempotency_keys_state_check
         CHECK (state IN ('pending', 'completed')),
       CONSTRAINT chat_idempotency_keys_response_status_check
         CHECK (
           response_status IS NULL
           OR response_status BETWEEN 100 AND 599
         ),
       CONSTRAINT chat_idempotency_keys_response_reference_check
         CHECK (
           response_reference IS NULL
           OR (
             octet_length(response_reference) BETWEEN 1 AND 2048
             AND response_reference ~ '[^[:space:]]'
           )
         ),
       CONSTRAINT chat_idempotency_keys_lifecycle_check
         CHECK (
           (
             state = 'pending'
             AND response_status IS NULL
             AND response_body IS NULL
             AND response_reference IS NULL
             AND completed_at IS NULL
           )
           OR (
             state = 'completed'
             AND response_status IS NOT NULL
             AND num_nonnulls(response_body, response_reference) = 1
             AND completed_at IS NOT NULL
           )
         ),
       CONSTRAINT chat_idempotency_keys_timestamp_order_check
         CHECK (
           created_at > '-infinity'::timestamptz
           AND created_at < 'infinity'::timestamptz
           AND updated_at >= created_at
           AND updated_at < 'infinity'::timestamptz
           AND expires_at > updated_at
           AND expires_at < 'infinity'::timestamptz
           AND (
             completed_at IS NULL
             OR (
               completed_at >= created_at
               AND completed_at <= updated_at
               AND completed_at < expires_at
             )
           )
         )
     )`,
    `CREATE INDEX chat_idempotency_keys_expiry_cleanup_idx
       ON chat_idempotency_keys
         (expires_at, tenant_id, user_id, operation_name, client_key)`,
    `CREATE FUNCTION reject_chat_idempotency_key_mutation()
       RETURNS trigger
       LANGUAGE plpgsql
       SET search_path FROM CURRENT
       AS $function$
       BEGIN
         IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
            OR NEW.user_id IS DISTINCT FROM OLD.user_id
            OR NEW.operation_name IS DISTINCT FROM OLD.operation_name
            OR NEW.client_key IS DISTINCT FROM OLD.client_key
            OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
            OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
           RAISE EXCEPTION 'chat_idempotency_keys request identities are immutable'
             USING ERRCODE = '55000';
         END IF;

         IF OLD.state = 'completed'
            AND (
              NEW.state IS DISTINCT FROM OLD.state
              OR NEW.response_status IS DISTINCT FROM OLD.response_status
              OR NEW.response_body IS DISTINCT FROM OLD.response_body
              OR NEW.response_reference IS DISTINCT FROM OLD.response_reference
              OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
            ) THEN
           RAISE EXCEPTION 'completed chat_idempotency_keys outcomes are immutable'
             USING ERRCODE = '55000';
         END IF;

         RETURN NEW;
       END;
       $function$`,
    `CREATE TRIGGER chat_idempotency_keys_reject_identity_outcome_update
       BEFORE UPDATE ON chat_idempotency_keys
       FOR EACH ROW
       EXECUTE FUNCTION reject_chat_idempotency_key_mutation()`,
    `CREATE FUNCTION claim_chat_idempotency_key(
         p_tenant_id text,
         p_user_id text,
         p_operation_name text,
         p_client_key text,
         p_request_hash text,
         p_expires_at timestamptz
       )
       RETURNS TABLE (
         idempotency_state text,
         stored_response_status smallint,
         stored_response_body jsonb,
         stored_response_reference text,
         stored_created_at timestamptz,
         stored_updated_at timestamptz,
         stored_completed_at timestamptz,
         stored_expires_at timestamptz
       )
       LANGUAGE sql
       SET search_path FROM CURRENT
       AS $function$
         INSERT INTO chat_idempotency_keys (
           tenant_id,
           user_id,
           operation_name,
           client_key,
           request_hash,
           expires_at
         )
         VALUES (
           p_tenant_id,
           p_user_id,
           p_operation_name,
           p_client_key,
           p_request_hash,
           p_expires_at
         )
         ON CONFLICT ON CONSTRAINT chat_idempotency_keys_pkey
         DO UPDATE SET request_hash = chat_idempotency_keys.request_hash
         WHERE chat_idempotency_keys.request_hash = EXCLUDED.request_hash
         RETURNING
           chat_idempotency_keys.state,
           chat_idempotency_keys.response_status,
           chat_idempotency_keys.response_body,
           chat_idempotency_keys.response_reference,
           chat_idempotency_keys.created_at,
           chat_idempotency_keys.updated_at,
           chat_idempotency_keys.completed_at,
           chat_idempotency_keys.expires_at
       $function$`,
    `COMMENT ON FUNCTION claim_chat_idempotency_key(
         text, text, text, text, text, timestamptz
       ) IS
       'Claim inside the mutation transaction. One row means new or same-hash replay; no row means the actor operation/key tuple was already used with a different hash. Complete the pending row and domain mutation before committing.'`,
  ]),
});

/**
 * Adds one cross-device draft state per conversation membership.
 *
 * A null content value is an explicit clear tombstone. Retaining its revision
 * prevents an older device from restoring content after another device clears
 * the draft. `synchronize_chat_draft` atomically applies only newer revisions.
 */
export const chatDraftsMigration: PostgresMigration = Object.freeze({
  id: "0007-chat-drafts",
  order: 7,
  statements: Object.freeze([
    `CREATE FUNCTION is_valid_chat_draft_content(p_content jsonb)
       RETURNS boolean
       LANGUAGE plpgsql
       IMMUTABLE
       PARALLEL SAFE
       STRICT
       AS $function$
       DECLARE
         item jsonb;
       BEGIN
         IF jsonb_typeof(p_content) IS DISTINCT FROM 'object'
            OR jsonb_typeof(p_content -> 'format') IS DISTINCT FROM 'string'
            OR (p_content ->> 'format' IN ('plain', 'markdown')) IS NOT TRUE
            OR jsonb_typeof(p_content -> 'text') IS DISTINCT FROM 'string' THEN
           RETURN false;
         END IF;

         IF p_content ? 'mentions' THEN
           IF jsonb_typeof(p_content -> 'mentions') IS DISTINCT FROM 'array' THEN
             RETURN false;
           END IF;

           FOR item IN
             SELECT value FROM jsonb_array_elements(p_content -> 'mentions')
           LOOP
             IF jsonb_typeof(item) IS DISTINCT FROM 'object'
                OR jsonb_typeof(item -> 'type') IS DISTINCT FROM 'string' THEN
               RETURN false;
             END IF;

             IF item ->> 'type' = 'user' THEN
               IF jsonb_typeof(item -> 'userId') IS DISTINCT FROM 'string' THEN
                 RETURN false;
               END IF;
             ELSIF item ->> 'type' = 'conversation' THEN
               IF jsonb_typeof(item -> 'conversationId') IS DISTINCT FROM 'string' THEN
                 RETURN false;
               END IF;
             ELSIF item ->> 'type' = 'entity' THEN
               IF jsonb_typeof(item -> 'entity') IS DISTINCT FROM 'object'
                  OR jsonb_typeof(item -> 'entity' -> 'type') IS DISTINCT FROM 'string'
                  OR jsonb_typeof(item -> 'entity' -> 'id') IS DISTINCT FROM 'string' THEN
                 RETURN false;
               END IF;
             ELSE
               RETURN false;
             END IF;
           END LOOP;
         END IF;

         IF p_content ? 'attachments' THEN
           IF jsonb_typeof(p_content -> 'attachments') IS DISTINCT FROM 'array' THEN
             RETURN false;
           END IF;

           FOR item IN
             SELECT value FROM jsonb_array_elements(p_content -> 'attachments')
           LOOP
             IF jsonb_typeof(item) IS DISTINCT FROM 'object'
                OR jsonb_typeof(item -> 'attachmentId') IS DISTINCT FROM 'string' THEN
               RETURN false;
             END IF;
           END LOOP;
         END IF;

         IF p_content ? 'blocks' THEN
           IF jsonb_typeof(p_content -> 'blocks') IS DISTINCT FROM 'array' THEN
             RETURN false;
           END IF;

           FOR item IN
             SELECT value FROM jsonb_array_elements(p_content -> 'blocks')
           LOOP
             IF jsonb_typeof(item) IS DISTINCT FROM 'object'
                OR jsonb_typeof(item -> 'type') IS DISTINCT FROM 'string'
                OR NOT (item ? 'data') THEN
               RETURN false;
             END IF;
           END LOOP;
         END IF;

         RETURN true;
       END;
       $function$`,
    `CREATE TABLE chat_drafts (
       tenant_id text NOT NULL,
       conversation_id text NOT NULL,
       user_id text NOT NULL,
       content jsonb,
       revision bigint NOT NULL,
       created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
       updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
       CONSTRAINT chat_drafts_pkey
         PRIMARY KEY (tenant_id, conversation_id, user_id),
       CONSTRAINT chat_drafts_content_check
         CHECK (
           content IS NULL
           OR is_valid_chat_draft_content(content) IS TRUE
         ),
       CONSTRAINT chat_drafts_revision_check
         CHECK (revision >= 1 AND revision <= 9007199254740991),
       CONSTRAINT chat_drafts_timestamp_order_check
         CHECK (
           created_at > '-infinity'::timestamptz
           AND created_at < 'infinity'::timestamptz
           AND updated_at >= created_at
           AND updated_at < 'infinity'::timestamptz
         ),
       CONSTRAINT chat_drafts_membership_fkey
         FOREIGN KEY (tenant_id, conversation_id, user_id)
         REFERENCES chat_conversation_members
           (tenant_id, conversation_id, user_id)
     )`,
    `CREATE INDEX chat_drafts_tenant_user_idx
       ON chat_drafts (tenant_id, user_id, conversation_id)
       INCLUDE (content, revision, created_at, updated_at)
       WHERE content IS NOT NULL`,
    `CREATE FUNCTION reject_chat_draft_stale_mutation()
       RETURNS trigger
       LANGUAGE plpgsql
       SET search_path FROM CURRENT
       AS $function$
       BEGIN
         IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
            OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
            OR NEW.user_id IS DISTINCT FROM OLD.user_id
            OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
           RAISE EXCEPTION 'chat_drafts identities and creation timestamps are immutable'
             USING ERRCODE = '55000';
         END IF;

         IF NEW.revision <= OLD.revision THEN
           RAISE EXCEPTION 'chat_drafts revisions must increase'
             USING ERRCODE = '55000';
         END IF;

         IF NEW.updated_at < OLD.updated_at THEN
           RAISE EXCEPTION 'chat_drafts updated_at must not move backwards'
             USING ERRCODE = '55000';
         END IF;

         RETURN NEW;
       END;
       $function$`,
    `CREATE TRIGGER chat_drafts_reject_stale_update
       BEFORE UPDATE ON chat_drafts
       FOR EACH ROW
       EXECUTE FUNCTION reject_chat_draft_stale_mutation()`,
    `CREATE FUNCTION synchronize_chat_draft(
         p_tenant_id text,
         p_conversation_id text,
         p_user_id text,
         p_content jsonb,
         p_revision bigint,
         p_updated_at timestamptz
       )
       RETURNS TABLE (
         did_apply boolean,
         stored_revision bigint,
         stored_content jsonb,
         stored_created_at timestamptz,
         stored_updated_at timestamptz
       )
       LANGUAGE sql
       SET search_path FROM CURRENT
       AS $function$
         WITH mutation AS MATERIALIZED (
           INSERT INTO chat_drafts AS stored (
             tenant_id,
             conversation_id,
             user_id,
             content,
             revision,
             created_at,
             updated_at
           )
           VALUES (
             p_tenant_id,
             p_conversation_id,
             p_user_id,
             p_content,
             p_revision,
             p_updated_at,
             p_updated_at
           )
           ON CONFLICT ON CONSTRAINT chat_drafts_pkey
           DO UPDATE SET
             content = EXCLUDED.content,
             revision = EXCLUDED.revision,
             updated_at = EXCLUDED.updated_at
           WHERE stored.revision < EXCLUDED.revision
           RETURNING
             true,
             stored.revision,
             stored.content,
             stored.created_at,
             stored.updated_at
         )
         SELECT * FROM mutation
         UNION ALL
         SELECT
           false,
           stored.revision,
           stored.content,
           stored.created_at,
           stored.updated_at
         FROM chat_drafts AS stored
         WHERE stored.tenant_id = p_tenant_id
           AND stored.conversation_id = p_conversation_id
           AND stored.user_id = p_user_id
           AND NOT EXISTS (SELECT 1 FROM mutation)
         LIMIT 1
       $function$`,
    `COMMENT ON FUNCTION synchronize_chat_draft(
         text, text, text, jsonb, bigint, timestamptz
       ) IS
       'Atomically applies only a newer draft revision. Null content is a clear tombstone, so stale devices cannot restore cleared content; did_apply is false for stale or equal revisions.'`,
  ]),
});

/** Adds durable notification and mute preferences for conversation members. */
export const chatConversationPreferencesMigration: PostgresMigration =
  Object.freeze({
    id: "0008-chat-conversation-preferences",
    order: 8,
    statements: Object.freeze([
      `CREATE TABLE chat_conversation_preferences (
         tenant_id text NOT NULL,
         conversation_id text NOT NULL,
         user_id text NOT NULL,
         notification_level text NOT NULL DEFAULT 'all',
         muted boolean NOT NULL DEFAULT false,
         muted_until timestamptz,
         created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
         updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
         CONSTRAINT chat_conversation_preferences_pkey
           PRIMARY KEY (tenant_id, conversation_id, user_id),
         CONSTRAINT chat_conversation_preferences_notification_level_check
           CHECK (notification_level IN ('all', 'mentions', 'none')),
         CONSTRAINT chat_conversation_preferences_mute_shape_check
           CHECK (
             (muted AND muted_until IS NULL)
             OR (
               muted
               AND muted_until > '-infinity'::timestamptz
               AND muted_until < 'infinity'::timestamptz
             )
             OR (NOT muted AND muted_until IS NULL)
           ),
         CONSTRAINT chat_conversation_preferences_timestamp_order_check
           CHECK (
             created_at > '-infinity'::timestamptz
             AND created_at < 'infinity'::timestamptz
             AND updated_at >= created_at
             AND updated_at < 'infinity'::timestamptz
           ),
         CONSTRAINT chat_conversation_preferences_membership_fkey
           FOREIGN KEY (tenant_id, conversation_id, user_id)
           REFERENCES chat_conversation_members
             (tenant_id, conversation_id, user_id)
       )`,
      `CREATE INDEX chat_conversation_preferences_tenant_user_idx
         ON chat_conversation_preferences
           (tenant_id, user_id, conversation_id)
         INCLUDE (
           notification_level,
           muted,
           muted_until,
           created_at,
           updated_at
         )`,
    ]),
  });

/** Adds one durable explicit follow state per tenant-scoped thread and user. */
export const chatThreadFollowsMigration: PostgresMigration = Object.freeze({
  id: "0009-chat-thread-follows",
  order: 9,
  statements: Object.freeze([
    `CREATE TABLE chat_thread_follows (
       tenant_id text NOT NULL,
       conversation_id text NOT NULL,
       user_id text NOT NULL,
       is_following boolean NOT NULL,
       follow_source text NOT NULL DEFAULT 'manual',
       created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
       updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
       CONSTRAINT chat_thread_follows_pkey
         PRIMARY KEY (tenant_id, conversation_id, user_id),
       CONSTRAINT chat_thread_follows_source_check
         CHECK (follow_source IN ('manual', 'reply', 'mention')),
       CONSTRAINT chat_thread_follows_timestamp_order_check
         CHECK (
           created_at > '-infinity'::timestamptz
           AND created_at < 'infinity'::timestamptz
           AND updated_at >= created_at
           AND updated_at < 'infinity'::timestamptz
         ),
       CONSTRAINT chat_thread_follows_thread_fkey
         FOREIGN KEY (tenant_id, conversation_id)
         REFERENCES chat_conversations (tenant_id, id)
     )`,
    `CREATE FUNCTION validate_chat_thread_follow()
       RETURNS trigger
       LANGUAGE plpgsql
       SET search_path FROM CURRENT
       AS $function$
       DECLARE
         thread_parent_conversation_id text;
       BEGIN
         IF TG_OP = 'UPDATE' AND (
           NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
           OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
           OR NEW.user_id IS DISTINCT FROM OLD.user_id
           OR NEW.created_at IS DISTINCT FROM OLD.created_at
         ) THEN
           RAISE EXCEPTION
             'chat_thread_follows identities and creation timestamps are immutable'
             USING ERRCODE = '55000';
         END IF;

         IF TG_OP = 'UPDATE' AND NEW.updated_at < OLD.updated_at THEN
           RAISE EXCEPTION 'chat_thread_follows updated_at must not move backwards'
             USING ERRCODE = '55000';
         END IF;

         SELECT conversation.parent_conversation_id
         INTO thread_parent_conversation_id
         FROM chat_conversations AS conversation
         WHERE conversation.tenant_id = NEW.tenant_id
           AND conversation.id = NEW.conversation_id
           AND conversation.type = 'thread';

         IF NOT FOUND THEN
           RAISE EXCEPTION
             'chat_thread_follows target must be a tenant-scoped thread conversation'
             USING
               ERRCODE = '23514',
               CONSTRAINT = 'chat_thread_follows_thread_type_check';
         END IF;

         IF NOT EXISTS (
           SELECT 1
           FROM chat_conversation_members AS member
           WHERE member.tenant_id = NEW.tenant_id
             AND member.user_id = NEW.user_id
             AND member.state = 'active'
             AND member.conversation_id IN (
               NEW.conversation_id,
               thread_parent_conversation_id
             )
         ) THEN
           RAISE EXCEPTION
             'chat_thread_follows user must be an active parent or thread member'
             USING
               ERRCODE = '23514',
               CONSTRAINT = 'chat_thread_follows_active_membership_check';
         END IF;

         RETURN NEW;
       END;
       $function$`,
    `CREATE TRIGGER chat_thread_follows_validate_write
       BEFORE INSERT OR UPDATE ON chat_thread_follows
       FOR EACH ROW
       EXECUTE FUNCTION validate_chat_thread_follow()`,
    `CREATE INDEX chat_thread_follows_tenant_user_followed_idx
       ON chat_thread_follows
         (tenant_id, user_id, updated_at DESC, conversation_id)
       INCLUDE (follow_source, created_at)
       WHERE is_following IS TRUE`,
  ]),
});

/**
 * Adds tenant-scoped attachment metadata while object bytes remain in host
 * storage. Attachments start pending and may become attached or abandoned once.
 */
export const chatAttachmentsMigration: PostgresMigration = Object.freeze({
  id: "0010-chat-attachments",
  order: 10,
  statements: Object.freeze([
    `CREATE TABLE chat_attachments (
       tenant_id text NOT NULL,
       id text NOT NULL,
       uploader_user_id text NOT NULL,
       storage_key text NOT NULL,
       file_name text NOT NULL,
       content_type text NOT NULL,
       size_bytes bigint NOT NULL,
       checksum text,
       state text NOT NULL DEFAULT 'pending',
       attached_message_id text,
       created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
       updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
       attached_at timestamptz,
       abandoned_at timestamptz,
       expires_at timestamptz NOT NULL,
       CONSTRAINT chat_attachments_pkey
         PRIMARY KEY (tenant_id, id),
       CONSTRAINT chat_attachments_storage_key_key
         UNIQUE (tenant_id, storage_key),
       CONSTRAINT chat_attachments_tenant_id_check
         CHECK (
           octet_length(tenant_id) BETWEEN 1 AND 255
           AND tenant_id ~ '[^[:space:]]'
         ),
       CONSTRAINT chat_attachments_id_check
         CHECK (
           octet_length(id) BETWEEN 1 AND 255
           AND id ~ '[^[:space:]]'
         ),
       CONSTRAINT chat_attachments_uploader_user_id_check
         CHECK (
           octet_length(uploader_user_id) BETWEEN 1 AND 255
           AND uploader_user_id ~ '[^[:space:]]'
         ),
       CONSTRAINT chat_attachments_storage_key_check
         CHECK (
           octet_length(storage_key) BETWEEN 1 AND 2048
           AND storage_key ~ '[^[:space:]]'
         ),
       CONSTRAINT chat_attachments_file_name_check
         CHECK (
           octet_length(file_name) BETWEEN 1 AND 1024
           AND file_name ~ '[^[:space:]]'
         ),
       CONSTRAINT chat_attachments_content_type_check
         CHECK (
           octet_length(content_type) BETWEEN 1 AND 255
           AND content_type ~ '[^[:space:]]'
         ),
       CONSTRAINT chat_attachments_size_bytes_check
         CHECK (size_bytes BETWEEN 0 AND 9007199254740991),
       CONSTRAINT chat_attachments_checksum_check
         CHECK (
           checksum IS NULL
           OR checksum ~ '^sha256:[0-9a-f]{64}$'
         ),
       CONSTRAINT chat_attachments_state_check
         CHECK (state IN ('pending', 'attached', 'abandoned')),
       CONSTRAINT chat_attachments_lifecycle_shape_check
         CHECK (
           (
             state = 'pending'
             AND attached_message_id IS NULL
             AND attached_at IS NULL
             AND abandoned_at IS NULL
           )
           OR (
             state = 'attached'
             AND attached_message_id IS NOT NULL
             AND checksum IS NOT NULL
             AND attached_at IS NOT NULL
             AND abandoned_at IS NULL
           )
           OR (
             state = 'abandoned'
             AND attached_message_id IS NULL
             AND attached_at IS NULL
             AND abandoned_at IS NOT NULL
           )
         ),
       CONSTRAINT chat_attachments_timestamp_order_check
         CHECK (
           created_at > '-infinity'::timestamptz
           AND created_at < 'infinity'::timestamptz
           AND updated_at >= created_at
           AND updated_at < 'infinity'::timestamptz
           AND expires_at > created_at
           AND expires_at < 'infinity'::timestamptz
           AND (
             attached_at IS NULL
             OR (
               attached_at >= created_at
               AND attached_at = updated_at
               AND attached_at <= expires_at
             )
           )
           AND (
             abandoned_at IS NULL
             OR (
               abandoned_at >= created_at
               AND abandoned_at = updated_at
               AND abandoned_at < 'infinity'::timestamptz
             )
           )
         ),
       CONSTRAINT chat_attachments_message_fkey
         FOREIGN KEY (tenant_id, attached_message_id)
         REFERENCES chat_messages (tenant_id, id)
     )`,
    `CREATE FUNCTION validate_chat_attachment_lifecycle()
       RETURNS trigger
       LANGUAGE plpgsql
       SET search_path FROM CURRENT
       AS $function$
       BEGIN
         IF TG_OP = 'INSERT' THEN
           IF NEW.state <> 'pending' THEN
             RAISE EXCEPTION 'chat_attachments must be created pending'
               USING
                 ERRCODE = '23514',
                 CONSTRAINT = 'chat_attachments_initial_state_check';
           END IF;
           RETURN NEW;
         END IF;

         IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
            OR NEW.id IS DISTINCT FROM OLD.id
            OR NEW.uploader_user_id IS DISTINCT FROM OLD.uploader_user_id
            OR NEW.storage_key IS DISTINCT FROM OLD.storage_key
            OR NEW.file_name IS DISTINCT FROM OLD.file_name
            OR NEW.content_type IS DISTINCT FROM OLD.content_type
            OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
            OR NEW.created_at IS DISTINCT FROM OLD.created_at
            OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
           RAISE EXCEPTION
             'chat_attachments identities and creation metadata are immutable'
             USING ERRCODE = '55000';
         END IF;

         IF OLD.checksum IS NOT NULL
            AND NEW.checksum IS DISTINCT FROM OLD.checksum THEN
           RAISE EXCEPTION 'chat_attachments checksums are immutable once set'
             USING ERRCODE = '55000';
         END IF;

         IF NEW.updated_at < OLD.updated_at THEN
           RAISE EXCEPTION 'chat_attachments updated_at must not move backwards'
             USING ERRCODE = '55000';
         END IF;

         IF OLD.state <> 'pending' AND NEW IS DISTINCT FROM OLD THEN
           RAISE EXCEPTION 'terminal chat_attachments are immutable'
             USING ERRCODE = '55000';
         END IF;

         RETURN NEW;
       END;
       $function$`,
    `CREATE TRIGGER chat_attachments_validate_write
       BEFORE INSERT OR UPDATE ON chat_attachments
       FOR EACH ROW
       EXECUTE FUNCTION validate_chat_attachment_lifecycle()`,
    `CREATE INDEX chat_attachments_pending_expiry_idx
       ON chat_attachments (tenant_id, expires_at, id)
       INCLUDE (uploader_user_id, storage_key, updated_at)
       WHERE state = 'pending'`,
    `CREATE INDEX chat_attachments_message_idx
       ON chat_attachments (tenant_id, attached_message_id, id)
       INCLUDE (
         file_name,
         content_type,
         size_bytes,
         storage_key,
         checksum,
         created_at,
         attached_at
       )
       WHERE state = 'attached'`,
  ]),
});

/**
 * Adds durable, append-only audit history independent of realtime outbox
 * delivery. Polymorphic chat targets are validated by tenant in a trigger so
 * host-owned target types can coexist with locally represented entities.
 */
export const chatAuditEventsMigration: PostgresMigration = Object.freeze({
  id: "0011-chat-audit-events",
  order: 11,
  statements: Object.freeze([
    `CREATE FUNCTION chat_audit_metadata_is_safe(candidate jsonb)
       RETURNS boolean
       LANGUAGE plpgsql
       IMMUTABLE
       STRICT
       AS $function$
       DECLARE
         member record;
         normalized_key text;
       BEGIN
         IF jsonb_typeof(candidate) = 'object' THEN
           FOR member IN SELECT key, value FROM jsonb_each(candidate)
           LOOP
             normalized_key := lower(
               regexp_replace(member.key, '[^[:alnum:]]', '', 'g')
             );

             IF normalized_key IN (
               'message',
               'messagebody',
               'messagecontent',
               'body',
               'content',
               'payload',
               'text',
               'accesstoken',
               'refreshtoken',
               'idtoken',
               'authtoken',
               'bearertoken',
               'authorization',
               'authentication',
               'authheader',
               'authorizationheader',
               'apikey',
               'clientsecret',
               'privatekey',
               'password',
               'secret',
               'credential',
               'credentials',
               'cookie',
               'setcookie',
               'attachmentbytes',
               'attachmentcontent',
               'filecontent',
               'binary',
               'bytes'
             ) THEN
               RETURN FALSE;
             END IF;

             IF NOT chat_audit_metadata_is_safe(member.value) THEN
               RETURN FALSE;
             END IF;
           END LOOP;
         ELSIF jsonb_typeof(candidate) = 'array' THEN
           FOR member IN SELECT value FROM jsonb_array_elements(candidate)
           LOOP
             IF NOT chat_audit_metadata_is_safe(member.value) THEN
               RETURN FALSE;
             END IF;
           END LOOP;
         END IF;

         RETURN TRUE;
       END;
       $function$`,
    `CREATE TABLE chat_audit_events (
       tenant_id text NOT NULL,
       event_id text NOT NULL,
       actor_user_id text,
       action text NOT NULL,
       target_type text,
       target_id text,
       occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
       metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
       request_id text NOT NULL,
       correlation_id text,
       CONSTRAINT chat_audit_events_pkey
         PRIMARY KEY (tenant_id, event_id),
       CONSTRAINT chat_audit_events_tenant_id_check
         CHECK (
           octet_length(tenant_id) BETWEEN 1 AND 255
           AND tenant_id ~ '[^[:space:]]'
         ),
       CONSTRAINT chat_audit_events_event_id_check
         CHECK (
           octet_length(event_id) BETWEEN 1 AND 255
           AND event_id ~ '[^[:space:]]'
         ),
       CONSTRAINT chat_audit_events_actor_user_id_check
         CHECK (
           actor_user_id IS NULL
           OR (
             octet_length(actor_user_id) BETWEEN 1 AND 255
             AND actor_user_id ~ '[^[:space:]]'
           )
         ),
       CONSTRAINT chat_audit_events_action_check
         CHECK (
           octet_length(action) BETWEEN 1 AND 128
           AND action ~ '[^[:space:]]'
           AND action = btrim(action)
         ),
       CONSTRAINT chat_audit_events_target_pair_check
         CHECK ((target_type IS NULL) = (target_id IS NULL)),
       CONSTRAINT chat_audit_events_target_type_check
         CHECK (
           target_type IS NULL
           OR (
             octet_length(target_type) BETWEEN 1 AND 128
             AND target_type ~ '[^[:space:]]'
             AND target_type = btrim(target_type)
           )
         ),
       CONSTRAINT chat_audit_events_target_id_check
         CHECK (
           target_id IS NULL
           OR (
             octet_length(target_id) BETWEEN 1 AND 255
             AND target_id ~ '[^[:space:]]'
           )
         ),
       CONSTRAINT chat_audit_events_occurred_at_check
         CHECK (
           occurred_at > '-infinity'::timestamptz
           AND occurred_at < 'infinity'::timestamptz
         ),
       CONSTRAINT chat_audit_events_metadata_check
         CHECK (
           jsonb_typeof(metadata) = 'object'
           AND octet_length(metadata::text) <= 65536
           AND chat_audit_metadata_is_safe(metadata)
         ),
       CONSTRAINT chat_audit_events_request_id_check
         CHECK (
           octet_length(request_id) BETWEEN 1 AND 255
           AND request_id ~ '[^[:space:]]'
         ),
       CONSTRAINT chat_audit_events_correlation_id_check
         CHECK (
           correlation_id IS NULL
           OR (
             octet_length(correlation_id) BETWEEN 1 AND 255
             AND correlation_id ~ '[^[:space:]]'
           )
         )
     )`,
    `CREATE FUNCTION validate_chat_audit_event_target()
       RETURNS trigger
       LANGUAGE plpgsql
       SET search_path FROM CURRENT
       AS $function$
       BEGIN
         IF NEW.target_type IN ('conversation', 'chat_conversation') THEN
           PERFORM 1
           FROM chat_conversations
           WHERE tenant_id = NEW.tenant_id AND id = NEW.target_id;

           IF NOT FOUND THEN
             RAISE EXCEPTION
               'chat_audit_events conversation target must exist in the same tenant'
               USING
                 ERRCODE = '23503',
                 CONSTRAINT = 'chat_audit_events_conversation_target_fkey';
           END IF;
         ELSIF NEW.target_type IN ('message', 'chat_message') THEN
           PERFORM 1
           FROM chat_messages
           WHERE tenant_id = NEW.tenant_id AND id = NEW.target_id;

           IF NOT FOUND THEN
             RAISE EXCEPTION
               'chat_audit_events message target must exist in the same tenant'
               USING
                 ERRCODE = '23503',
                 CONSTRAINT = 'chat_audit_events_message_target_fkey';
           END IF;
         END IF;

         RETURN NEW;
       END;
       $function$`,
    `CREATE TRIGGER chat_audit_events_validate_target
       BEFORE INSERT ON chat_audit_events
       FOR EACH ROW
       EXECUTE FUNCTION validate_chat_audit_event_target()`,
    `CREATE FUNCTION reject_chat_audit_event_mutation()
       RETURNS trigger
       LANGUAGE plpgsql
       AS $function$
       BEGIN
         RAISE EXCEPTION 'chat_audit_events are append-only'
           USING ERRCODE = '55000';
       END;
       $function$`,
    `CREATE TRIGGER chat_audit_events_reject_update_delete
       BEFORE UPDATE OR DELETE ON chat_audit_events
       FOR EACH ROW
       EXECUTE FUNCTION reject_chat_audit_event_mutation()`,
    `CREATE TRIGGER chat_audit_events_reject_truncate
       BEFORE TRUNCATE ON chat_audit_events
       FOR EACH STATEMENT
       EXECUTE FUNCTION reject_chat_audit_event_mutation()`,
    `CREATE INDEX chat_audit_events_tenant_history_idx
       ON chat_audit_events (tenant_id, occurred_at DESC, event_id DESC)
       INCLUDE (
         actor_user_id,
         action,
         target_type,
         target_id,
         request_id,
         correlation_id
       )`,
    `CREATE INDEX chat_audit_events_target_history_idx
       ON chat_audit_events
         (tenant_id, target_type, target_id, occurred_at DESC, event_id DESC)
       INCLUDE (actor_user_id, action, request_id, correlation_id)
       WHERE target_type IS NOT NULL`,
  ]),
});

/**
 * Adds one durable saved-message record per tenant-scoped user and message.
 * Saves intentionally survive message soft deletion: a future saved-message
 * API must return the retained save with the message's redacted/deleted shell,
 * never content from an earlier revision.
 */
export const chatSavedMessagesMigration: PostgresMigration = Object.freeze({
  id: "0012-chat-saved-messages",
  order: 12,
  statements: Object.freeze([
    `CREATE TABLE chat_saved_messages (
       tenant_id text NOT NULL,
       user_id text NOT NULL,
       message_id text NOT NULL,
       conversation_id text NOT NULL,
       created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
       CONSTRAINT chat_saved_messages_pkey
         PRIMARY KEY (tenant_id, user_id, message_id),
       CONSTRAINT chat_saved_messages_created_at_check
         CHECK (
           created_at > '-infinity'::timestamptz
           AND created_at < 'infinity'::timestamptz
         ),
       CONSTRAINT chat_saved_messages_membership_fkey
         FOREIGN KEY (tenant_id, conversation_id, user_id)
         REFERENCES chat_conversation_members
           (tenant_id, conversation_id, user_id),
       CONSTRAINT chat_saved_messages_message_fkey
         FOREIGN KEY (tenant_id, conversation_id, message_id)
         REFERENCES chat_messages (tenant_id, conversation_id, id)
     )`,
    `CREATE FUNCTION validate_chat_saved_message()
       RETURNS trigger
       LANGUAGE plpgsql
       SET search_path FROM CURRENT
       AS $function$
       BEGIN
         IF TG_OP = 'UPDATE' AND (
           NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
           OR NEW.user_id IS DISTINCT FROM OLD.user_id
           OR NEW.message_id IS DISTINCT FROM OLD.message_id
           OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
           OR NEW.created_at IS DISTINCT FROM OLD.created_at
         ) THEN
           RAISE EXCEPTION
             'chat_saved_messages identities and creation timestamps are immutable'
             USING ERRCODE = '55000';
         END IF;

         IF NOT EXISTS (
           SELECT 1
           FROM chat_conversation_members AS member
           WHERE member.tenant_id = NEW.tenant_id
             AND member.conversation_id = NEW.conversation_id
             AND member.user_id = NEW.user_id
             AND member.state = 'active'
         ) THEN
           RAISE EXCEPTION
             'chat_saved_messages user must be an active conversation member'
             USING
               ERRCODE = '23514',
               CONSTRAINT = 'chat_saved_messages_active_membership_check';
         END IF;

         RETURN NEW;
       END;
       $function$`,
    `CREATE TRIGGER chat_saved_messages_validate_write
       BEFORE INSERT OR UPDATE ON chat_saved_messages
       FOR EACH ROW
       EXECUTE FUNCTION validate_chat_saved_message()`,
    `CREATE INDEX chat_saved_messages_tenant_user_created_idx
       ON chat_saved_messages
         (tenant_id, user_id, created_at DESC, message_id DESC)
       INCLUDE (conversation_id)`,
  ]),
});

/**
 * Adds tenant-scoped huddle lifecycle and participant history. Media join
 * descriptors and all provider transport/credential material remain outside
 * PostgreSQL; only the provider's opaque room reference is retained here.
 */
export const chatHuddleSessionsMigration: PostgresMigration = Object.freeze({
  id: "0013-chat-huddle-sessions",
  order: 13,
  statements: Object.freeze([
    `CREATE TABLE chat_huddle_sessions (
       tenant_id text NOT NULL,
       id text NOT NULL,
       conversation_id text NOT NULL,
       provider_room_reference text NOT NULL,
       status text NOT NULL DEFAULT 'starting',
       initiated_by_user_id text NOT NULL,
       started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
       activated_at timestamptz,
       ended_at timestamptz,
       ended_by_user_id text,
       active_screen_share_owner_user_id text,
       updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
       CONSTRAINT chat_huddle_sessions_pkey
         PRIMARY KEY (tenant_id, id),
       CONSTRAINT chat_huddle_sessions_id_check
         CHECK (
           octet_length(id) BETWEEN 1 AND 255
           AND id ~ '[^[:space:]]'
         ),
       CONSTRAINT chat_huddle_sessions_provider_room_reference_check
         CHECK (
           octet_length(provider_room_reference) BETWEEN 1 AND 2048
           AND provider_room_reference ~ '[^[:space:]]'
         ),
       CONSTRAINT chat_huddle_sessions_status_check
         CHECK (status IN ('starting', 'active', 'ended')),
       CONSTRAINT chat_huddle_sessions_initiated_by_user_id_check
         CHECK (
           octet_length(initiated_by_user_id) BETWEEN 1 AND 255
           AND initiated_by_user_id ~ '[^[:space:]]'
         ),
       CONSTRAINT chat_huddle_sessions_ended_by_user_id_check
         CHECK (
           ended_by_user_id IS NULL
           OR (
             octet_length(ended_by_user_id) BETWEEN 1 AND 255
             AND ended_by_user_id ~ '[^[:space:]]'
           )
         ),
       CONSTRAINT chat_huddle_sessions_screen_share_owner_check
         CHECK (
           active_screen_share_owner_user_id IS NULL
           OR (
             octet_length(active_screen_share_owner_user_id) BETWEEN 1 AND 255
             AND active_screen_share_owner_user_id ~ '[^[:space:]]'
           )
         ),
       CONSTRAINT chat_huddle_sessions_lifecycle_shape_check
         CHECK (
           (
             status = 'starting'
             AND activated_at IS NULL
             AND ended_at IS NULL
             AND ended_by_user_id IS NULL
             AND active_screen_share_owner_user_id IS NULL
           )
           OR (
             status = 'active'
             AND activated_at IS NOT NULL
             AND ended_at IS NULL
             AND ended_by_user_id IS NULL
           )
           OR (
             status = 'ended'
             AND ended_at IS NOT NULL
             AND ended_by_user_id IS NOT NULL
             AND active_screen_share_owner_user_id IS NULL
           )
         ),
       CONSTRAINT chat_huddle_sessions_timestamp_order_check
         CHECK (
           started_at > '-infinity'::timestamptz
           AND started_at < 'infinity'::timestamptz
           AND updated_at >= started_at
           AND updated_at < 'infinity'::timestamptz
           AND (
             activated_at IS NULL
             OR (
               activated_at >= started_at
               AND activated_at <= updated_at
               AND activated_at < 'infinity'::timestamptz
             )
           )
           AND (
             ended_at IS NULL
             OR (
               ended_at >= started_at
               AND ended_at >= COALESCE(activated_at, started_at)
               AND ended_at <= updated_at
               AND ended_at < 'infinity'::timestamptz
             )
           )
         ),
       CONSTRAINT chat_huddle_sessions_conversation_fkey
         FOREIGN KEY (tenant_id, conversation_id)
         REFERENCES chat_conversations (tenant_id, id),
       CONSTRAINT chat_huddle_sessions_initiator_membership_fkey
         FOREIGN KEY (tenant_id, conversation_id, initiated_by_user_id)
         REFERENCES chat_conversation_members
           (tenant_id, conversation_id, user_id)
     )`,
    `CREATE UNIQUE INDEX chat_huddle_sessions_active_conversation_idx
       ON chat_huddle_sessions (tenant_id, conversation_id)
       INCLUDE (id, status, started_at, active_screen_share_owner_user_id)
       WHERE status IN ('starting', 'active')`,
    `CREATE TABLE chat_huddle_participants (
       tenant_id text NOT NULL,
       huddle_session_id text NOT NULL,
       user_id text NOT NULL,
       joined_at timestamptz NOT NULL DEFAULT clock_timestamp(),
       left_at timestamptz,
       CONSTRAINT chat_huddle_participants_pkey
         PRIMARY KEY (tenant_id, huddle_session_id, user_id),
       CONSTRAINT chat_huddle_participants_user_id_check
         CHECK (
           octet_length(user_id) BETWEEN 1 AND 255
           AND user_id ~ '[^[:space:]]'
         ),
       CONSTRAINT chat_huddle_participants_timestamp_order_check
         CHECK (
           joined_at > '-infinity'::timestamptz
           AND joined_at < 'infinity'::timestamptz
           AND (
             left_at IS NULL
             OR (
               left_at >= joined_at
               AND left_at < 'infinity'::timestamptz
             )
           )
         ),
       CONSTRAINT chat_huddle_participants_session_fkey
         FOREIGN KEY (tenant_id, huddle_session_id)
         REFERENCES chat_huddle_sessions (tenant_id, id)
     )`,
    `ALTER TABLE chat_huddle_sessions
       ADD CONSTRAINT chat_huddle_sessions_screen_share_participant_fkey
       FOREIGN KEY (
         tenant_id,
         id,
         active_screen_share_owner_user_id
       )
       REFERENCES chat_huddle_participants
         (tenant_id, huddle_session_id, user_id)`,
    `CREATE FUNCTION validate_chat_huddle_session()
       RETURNS trigger
       LANGUAGE plpgsql
       SET search_path FROM CURRENT
       AS $function$
       BEGIN
         IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
           RAISE EXCEPTION 'chat_huddle_sessions are retained as history'
             USING ERRCODE = '55000';
         END IF;

         IF TG_OP = 'INSERT' AND NEW.status <> 'starting' THEN
           RAISE EXCEPTION 'chat_huddle_sessions must be created starting'
             USING
               ERRCODE = '23514',
               CONSTRAINT = 'chat_huddle_sessions_initial_state_check';
         END IF;

         IF TG_OP = 'UPDATE' THEN
           IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
              OR NEW.id IS DISTINCT FROM OLD.id
              OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
              OR NEW.provider_room_reference IS DISTINCT FROM OLD.provider_room_reference
              OR NEW.initiated_by_user_id IS DISTINCT FROM OLD.initiated_by_user_id
              OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
             RAISE EXCEPTION
               'chat_huddle_sessions identity and start metadata are immutable'
               USING ERRCODE = '55000';
           END IF;

           IF NEW.updated_at < OLD.updated_at THEN
             RAISE EXCEPTION 'chat_huddle_sessions updated_at must not move backwards'
               USING ERRCODE = '55000';
           END IF;

           IF OLD.activated_at IS NOT NULL
              AND NEW.activated_at IS DISTINCT FROM OLD.activated_at THEN
             RAISE EXCEPTION 'chat_huddle_sessions activated_at is immutable once set'
               USING ERRCODE = '55000';
           END IF;

           IF OLD.status = 'ended' AND NEW IS DISTINCT FROM OLD THEN
             RAISE EXCEPTION 'ended chat_huddle_sessions are immutable'
               USING ERRCODE = '55000';
           END IF;

           IF NOT (
             NEW.status = OLD.status
             OR (OLD.status = 'starting' AND NEW.status IN ('active', 'ended'))
             OR (OLD.status = 'active' AND NEW.status = 'ended')
           ) THEN
             RAISE EXCEPTION 'invalid chat_huddle_sessions lifecycle transition'
               USING
                 ERRCODE = '23514',
                 CONSTRAINT = 'chat_huddle_sessions_transition_check';
           END IF;

           IF OLD.status = 'starting'
              AND NEW.status = 'active'
              AND NOT EXISTS (
                SELECT 1
                FROM chat_huddle_participants AS participant
                WHERE participant.tenant_id = NEW.tenant_id
                  AND participant.huddle_session_id = NEW.id
                  AND participant.left_at IS NULL
              ) THEN
             RAISE EXCEPTION
               'active chat_huddle_sessions require a joined participant'
               USING
                 ERRCODE = '23514',
                 CONSTRAINT = 'chat_huddle_sessions_active_participant_check';
           END IF;
         END IF;

         IF NEW.active_screen_share_owner_user_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1
              FROM chat_huddle_participants AS participant
              WHERE participant.tenant_id = NEW.tenant_id
                AND participant.huddle_session_id = NEW.id
                AND participant.user_id = NEW.active_screen_share_owner_user_id
                AND participant.left_at IS NULL
            ) THEN
           RAISE EXCEPTION
             'screen-share owner must be an actively joined huddle participant'
             USING
               ERRCODE = '23514',
               CONSTRAINT = 'chat_huddle_sessions_active_screen_share_owner_check';
         END IF;

         IF NEW.status = 'ended' AND EXISTS (
           SELECT 1
           FROM chat_huddle_participants AS participant
           WHERE participant.tenant_id = NEW.tenant_id
             AND participant.huddle_session_id = NEW.id
             AND (
               participant.left_at IS NULL
               OR participant.left_at > NEW.ended_at
             )
         ) THEN
           RAISE EXCEPTION
             'ended chat_huddle_sessions require every participant to have left'
             USING
               ERRCODE = '23514',
               CONSTRAINT = 'chat_huddle_sessions_ended_participants_check';
         END IF;

         RETURN NEW;
       END;
       $function$`,
    `CREATE TRIGGER chat_huddle_sessions_validate_write
       BEFORE INSERT OR UPDATE OR DELETE ON chat_huddle_sessions
       FOR EACH ROW
       EXECUTE FUNCTION validate_chat_huddle_session()`,
    `CREATE TRIGGER chat_huddle_sessions_reject_truncate
       BEFORE TRUNCATE ON chat_huddle_sessions
       FOR EACH STATEMENT
       EXECUTE FUNCTION validate_chat_huddle_session()`,
    `CREATE FUNCTION validate_chat_huddle_participant()
       RETURNS trigger
       LANGUAGE plpgsql
       SET search_path FROM CURRENT
       AS $function$
       DECLARE
         session_started_at timestamptz;
         session_status text;
         screen_share_owner_user_id text;
       BEGIN
         IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
           RAISE EXCEPTION 'chat_huddle_participants are retained as history'
             USING ERRCODE = '55000';
         END IF;

         IF TG_OP = 'INSERT' AND NEW.left_at IS NOT NULL THEN
           RAISE EXCEPTION 'chat_huddle_participants must be created joined'
             USING
               ERRCODE = '23514',
               CONSTRAINT = 'chat_huddle_participants_initial_state_check';
         END IF;

         IF TG_OP = 'UPDATE' THEN
           IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
              OR NEW.huddle_session_id IS DISTINCT FROM OLD.huddle_session_id
              OR NEW.user_id IS DISTINCT FROM OLD.user_id
              OR NEW.joined_at IS DISTINCT FROM OLD.joined_at THEN
             RAISE EXCEPTION
               'chat_huddle_participants identity and join time are immutable'
               USING ERRCODE = '55000';
           END IF;

           IF OLD.left_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
             RAISE EXCEPTION 'left chat_huddle_participants are immutable'
               USING ERRCODE = '55000';
           END IF;
         END IF;

         SELECT session.started_at,
                session.status,
                session.active_screen_share_owner_user_id
         INTO session_started_at, session_status, screen_share_owner_user_id
         FROM chat_huddle_sessions AS session
         WHERE session.tenant_id = NEW.tenant_id
           AND session.id = NEW.huddle_session_id
         FOR NO KEY UPDATE;

         IF FOUND AND session_status = 'ended' THEN
           RAISE EXCEPTION 'ended chat_huddle_sessions cannot change participants'
             USING
               ERRCODE = '23514',
               CONSTRAINT = 'chat_huddle_participants_live_session_check';
         END IF;

         IF FOUND AND NEW.joined_at < session_started_at THEN
           RAISE EXCEPTION 'a huddle participant cannot join before the session starts'
             USING
               ERRCODE = '23514',
               CONSTRAINT = 'chat_huddle_participants_session_timestamp_check';
         END IF;

         IF TG_OP = 'UPDATE'
            AND OLD.left_at IS NULL
            AND NEW.left_at IS NOT NULL
            AND screen_share_owner_user_id = NEW.user_id THEN
           RAISE EXCEPTION 'screen-share owner must be cleared before leaving'
             USING
               ERRCODE = '23514',
               CONSTRAINT = 'chat_huddle_participants_active_screen_share_owner_check';
         END IF;

         RETURN NEW;
       END;
       $function$`,
    `CREATE TRIGGER chat_huddle_participants_validate_write
       BEFORE INSERT OR UPDATE OR DELETE ON chat_huddle_participants
       FOR EACH ROW
       EXECUTE FUNCTION validate_chat_huddle_participant()`,
    `CREATE TRIGGER chat_huddle_participants_reject_truncate
       BEFORE TRUNCATE ON chat_huddle_participants
       FOR EACH STATEMENT
       EXECUTE FUNCTION validate_chat_huddle_participant()`,
    `CREATE INDEX chat_huddle_participants_lookup_idx
       ON chat_huddle_participants
         (tenant_id, huddle_session_id, joined_at, user_id)
       INCLUDE (left_at)`,
  ]),
});

/**
 * Adds content-minimized, recipient-specific notification dispatch state.
 * Realtime publication remains owned by the outbox; this table only tracks an
 * optional host notification adapter's independent lease and retry lifecycle.
 */
export const chatNotificationDeliveriesMigration: PostgresMigration =
  Object.freeze({
    id: "0014-chat-notification-deliveries",
    order: 14,
    statements: Object.freeze([
      `ALTER TABLE chat_outbox_events
         ADD CONSTRAINT chat_outbox_events_tenant_event_key
         UNIQUE (tenant_id, event_id)`,
      `CREATE FUNCTION chat_notification_metadata_is_safe(candidate jsonb)
         RETURNS boolean
         LANGUAGE plpgsql
         IMMUTABLE
         PARALLEL SAFE
         STRICT
         AS $function$
         DECLARE
           member record;
           normalized_key text;
           member_count integer := 0;
         BEGIN
           IF jsonb_typeof(candidate) IS DISTINCT FROM 'object'
              OR octet_length(candidate::text) > 4096 THEN
             RETURN FALSE;
           END IF;

           FOR member IN SELECT key, value FROM jsonb_each(candidate)
           LOOP
             member_count := member_count + 1;
             IF member_count > 16
                OR octet_length(member.key) NOT BETWEEN 1 AND 64
                OR member.key IS DISTINCT FROM btrim(member.key) THEN
               RETURN FALSE;
             END IF;

             normalized_key := lower(
               regexp_replace(member.key, '[^[:alnum:]]', '', 'g')
             );
             IF normalized_key IN (
                  'messagebody',
                  'messagecontent',
                  'rawmessage',
                  'rawmessagecontent',
                  'body',
                  'content',
                  'text',
                  'providerrequest',
                  'providerresponse',
                  'privatekey',
                  'setcookie'
                )
                OR normalized_key ~ '(token|authorization|apikey|secret|credential|password|cookie|payload)' THEN
               RETURN FALSE;
             END IF;

             IF (jsonb_typeof(member.value) IN (
                   'string', 'number', 'boolean', 'null'
                 )) IS NOT TRUE THEN
               RETURN FALSE;
             END IF;
             IF jsonb_typeof(member.value) = 'string'
                AND octet_length(member.value #>> '{}') > 512 THEN
               RETURN FALSE;
             END IF;
           END LOOP;

           RETURN TRUE;
         END;
         $function$`,
      `CREATE TABLE chat_notification_deliveries (
         tenant_id text NOT NULL,
         source_event_id text NOT NULL,
         recipient_host_user_id text NOT NULL,
         notification_kind text NOT NULL,
         adapter_reference text,
         notification_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
         status text NOT NULL DEFAULT 'pending',
         attempt_count bigint NOT NULL DEFAULT 0,
         next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
         lease_token text,
         lease_acquired_at timestamptz,
         lease_expires_at timestamptz,
         delivered_at timestamptz,
         last_error_class text,
         last_error_at timestamptz,
         created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
         updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
         CONSTRAINT chat_notification_deliveries_pkey
           PRIMARY KEY (
             tenant_id,
             source_event_id,
             recipient_host_user_id,
             notification_kind
           ),
         CONSTRAINT chat_notification_deliveries_tenant_id_check
           CHECK (
             octet_length(tenant_id) BETWEEN 1 AND 255
             AND tenant_id ~ '[^[:space:]]'
           ),
         CONSTRAINT chat_notification_deliveries_source_event_id_check
           CHECK (
             octet_length(source_event_id) BETWEEN 1 AND 255
             AND source_event_id ~ '[^[:space:]]'
           ),
         CONSTRAINT chat_notification_deliveries_recipient_id_check
           CHECK (
             octet_length(recipient_host_user_id) BETWEEN 1 AND 255
             AND recipient_host_user_id ~ '[^[:space:]]'
           ),
         CONSTRAINT chat_notification_deliveries_kind_check
           CHECK (
             octet_length(notification_kind) BETWEEN 1 AND 64
             AND notification_kind ~ '^[a-z][a-z0-9_.-]*$'
           ),
         CONSTRAINT chat_notification_deliveries_adapter_reference_check
           CHECK (
             adapter_reference IS NULL
             OR (
               octet_length(adapter_reference) BETWEEN 1 AND 2048
               AND adapter_reference ~ '[^[:space:]]'
             )
           ),
         CONSTRAINT chat_notification_deliveries_metadata_check
           CHECK (chat_notification_metadata_is_safe(notification_metadata)),
         CONSTRAINT chat_notification_deliveries_status_check
           CHECK (status IN ('pending', 'leased', 'failed', 'delivered')),
         CONSTRAINT chat_notification_deliveries_attempt_count_check
           CHECK (attempt_count BETWEEN 0 AND 9007199254740991),
         CONSTRAINT chat_notification_deliveries_lease_token_check
           CHECK (
             lease_token IS NULL
             OR (
               octet_length(lease_token) BETWEEN 1 AND 255
               AND lease_token ~ '[^[:space:]]'
             )
           ),
         CONSTRAINT chat_notification_deliveries_error_class_check
           CHECK (
             last_error_class IS NULL
             OR last_error_class IN (
               'transient',
               'rate_limited',
               'rejected',
               'configuration',
               'unknown'
             )
           ),
         CONSTRAINT chat_notification_deliveries_lifecycle_shape_check
           CHECK (
             (
               status = 'pending'
               AND attempt_count = 0
               AND lease_token IS NULL
               AND lease_acquired_at IS NULL
               AND lease_expires_at IS NULL
               AND delivered_at IS NULL
               AND last_error_class IS NULL
               AND last_error_at IS NULL
             )
             OR (
               status = 'leased'
               AND attempt_count >= 1
               AND lease_token IS NOT NULL
               AND lease_acquired_at IS NOT NULL
               AND lease_expires_at IS NOT NULL
               AND delivered_at IS NULL
               AND last_error_class IS NULL
               AND last_error_at IS NULL
             )
             OR (
               status = 'failed'
               AND attempt_count >= 1
               AND lease_token IS NULL
               AND lease_acquired_at IS NULL
               AND lease_expires_at IS NULL
               AND delivered_at IS NULL
               AND last_error_class IS NOT NULL
               AND last_error_at IS NOT NULL
             )
             OR (
               status = 'delivered'
               AND attempt_count >= 1
               AND lease_token IS NULL
               AND lease_acquired_at IS NULL
               AND lease_expires_at IS NULL
               AND delivered_at IS NOT NULL
               AND last_error_class IS NULL
               AND last_error_at IS NULL
             )
           ),
         CONSTRAINT chat_notification_deliveries_timestamp_order_check
           CHECK (
             created_at > '-infinity'::timestamptz
             AND created_at < 'infinity'::timestamptz
             AND updated_at >= created_at
             AND updated_at < 'infinity'::timestamptz
             AND next_attempt_at >= created_at
             AND next_attempt_at < 'infinity'::timestamptz
             AND (
               lease_acquired_at IS NULL
               OR (
                 lease_acquired_at >= created_at
                 AND lease_acquired_at <= updated_at
                 AND lease_expires_at > lease_acquired_at
                 AND lease_expires_at < 'infinity'::timestamptz
               )
             )
             AND (
               delivered_at IS NULL
               OR (
                 delivered_at >= created_at
                 AND delivered_at <= updated_at
                 AND delivered_at < 'infinity'::timestamptz
               )
             )
             AND (
               last_error_at IS NULL
               OR (
                 last_error_at >= created_at
                 AND last_error_at <= updated_at
                 AND next_attempt_at >= last_error_at
                 AND last_error_at < 'infinity'::timestamptz
               )
             )
           ),
         CONSTRAINT chat_notification_deliveries_source_event_fkey
           FOREIGN KEY (tenant_id, source_event_id)
           REFERENCES chat_outbox_events (tenant_id, event_id)
       )`,
      `CREATE FUNCTION validate_chat_notification_delivery()
         RETURNS trigger
         LANGUAGE plpgsql
         SET search_path FROM CURRENT
         AS $function$
         BEGIN
           IF TG_OP = 'INSERT' THEN
             IF NEW.status <> 'pending' OR NEW.attempt_count <> 0 THEN
               RAISE EXCEPTION
                 'chat_notification_deliveries must be created pending and unattempted'
                 USING
                   ERRCODE = '23514',
                   CONSTRAINT = 'chat_notification_deliveries_initial_state_check';
             END IF;
             RETURN NEW;
           END IF;

           IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
              OR NEW.source_event_id IS DISTINCT FROM OLD.source_event_id
              OR NEW.recipient_host_user_id IS DISTINCT FROM OLD.recipient_host_user_id
              OR NEW.notification_kind IS DISTINCT FROM OLD.notification_kind
              OR NEW.adapter_reference IS DISTINCT FROM OLD.adapter_reference
              OR NEW.notification_metadata IS DISTINCT FROM OLD.notification_metadata
              OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
             RAISE EXCEPTION
               'chat_notification_deliveries identity and source metadata are immutable'
               USING ERRCODE = '55000';
           END IF;

           IF NEW.updated_at < OLD.updated_at THEN
             RAISE EXCEPTION
               'chat_notification_deliveries updated_at must not move backwards'
               USING ERRCODE = '55000';
           END IF;

           IF OLD.status = 'delivered' AND NEW IS DISTINCT FROM OLD THEN
             RAISE EXCEPTION
               'delivered chat_notification_deliveries are immutable'
               USING ERRCODE = '55000';
           END IF;

           IF NOT (
             NEW.status = OLD.status
             OR (OLD.status IN ('pending', 'failed') AND NEW.status = 'leased')
             OR (OLD.status = 'leased' AND NEW.status IN ('failed', 'delivered'))
           ) THEN
             RAISE EXCEPTION
               'invalid chat_notification_deliveries lifecycle transition'
               USING
                 ERRCODE = '23514',
                 CONSTRAINT = 'chat_notification_deliveries_transition_check';
           END IF;

           IF NEW.status = 'leased'
              AND OLD.status IN ('pending', 'failed') THEN
             IF NEW.attempt_count <> OLD.attempt_count + 1 THEN
               RAISE EXCEPTION
                 'claiming chat_notification_deliveries increments attempt_count once'
                 USING
                   ERRCODE = '23514',
                   CONSTRAINT = 'chat_notification_deliveries_attempt_transition_check';
             END IF;
           ELSIF NEW.status = 'leased' AND OLD.status = 'leased' THEN
             IF OLD.lease_expires_at > clock_timestamp()
                OR NEW.lease_token IS NOT DISTINCT FROM OLD.lease_token
                OR NEW.lease_acquired_at < OLD.lease_expires_at
                OR NEW.attempt_count <> OLD.attempt_count + 1 THEN
               RAISE EXCEPTION
                 'only expired chat_notification_deliveries leases may be reclaimed'
                 USING
                   ERRCODE = '23514',
                   CONSTRAINT = 'chat_notification_deliveries_reclaim_check';
             END IF;
           ELSIF NEW.attempt_count <> OLD.attempt_count THEN
             RAISE EXCEPTION
               'chat_notification_deliveries attempt_count changes only on claim'
               USING
                 ERRCODE = '23514',
                 CONSTRAINT = 'chat_notification_deliveries_attempt_transition_check';
           END IF;

           RETURN NEW;
         END;
         $function$`,
      `CREATE TRIGGER chat_notification_deliveries_validate_write
         BEFORE INSERT OR UPDATE ON chat_notification_deliveries
         FOR EACH ROW
         EXECUTE FUNCTION validate_chat_notification_delivery()`,
      `CREATE INDEX chat_notification_deliveries_ready_idx
         ON chat_notification_deliveries (
           tenant_id,
           next_attempt_at,
           source_event_id,
           recipient_host_user_id,
           notification_kind
         )
         INCLUDE (attempt_count)
         WHERE status IN ('pending', 'failed')`,
      `CREATE INDEX chat_notification_deliveries_expired_lease_idx
         ON chat_notification_deliveries (
           tenant_id,
           lease_expires_at,
           source_event_id,
           recipient_host_user_id,
           notification_kind
         )
         INCLUDE (attempt_count)
         WHERE status = 'leased'`,
    ]),
  });

/** Adds optimistic concurrency for explicit archive and restore transitions. */
export const chatConversationLifecycleRevisionMigration: PostgresMigration =
  Object.freeze({
    id: "0015-chat-conversation-lifecycle-revision",
    order: 15,
    statements: Object.freeze([
      `ALTER TABLE chat_conversations
         ADD COLUMN lifecycle_revision bigint NOT NULL DEFAULT 1`,
      `ALTER TABLE chat_conversations
         ADD CONSTRAINT chat_conversations_lifecycle_revision_check
         CHECK (
           lifecycle_revision >= 1
           AND lifecycle_revision <= 9007199254740991
         )`,
    ]),
  });

/** Adds durable compare-and-set revisions for explicit thread-follow intent. */
export const chatThreadFollowRevisionMigration: PostgresMigration =
  Object.freeze({
    id: "0016-chat-thread-follow-revision",
    order: 16,
    statements: Object.freeze([
      `ALTER TABLE chat_thread_follows
         ADD COLUMN follow_revision bigint NOT NULL DEFAULT 1`,
      `UPDATE chat_thread_follows
          SET follow_source = 'manual'
        WHERE is_following IS FALSE
          AND follow_source <> 'manual'`,
      `ALTER TABLE chat_thread_follows
         ADD CONSTRAINT chat_thread_follows_revision_check
         CHECK (
           follow_revision >= 1
           AND follow_revision <= 9007199254740991
         )`,
      `ALTER TABLE chat_thread_follows
         ADD CONSTRAINT chat_thread_follows_unfollow_source_check
         CHECK (is_following OR follow_source = 'manual')`,
      `CREATE OR REPLACE FUNCTION validate_chat_thread_follow()
         RETURNS trigger
         LANGUAGE plpgsql
         SET search_path FROM CURRENT
         AS $function$
         DECLARE
           parent_type text;
           parent_visibility text;
           thread_parent_conversation_id text;
         BEGIN
           IF TG_OP = 'UPDATE' AND (
             NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
             OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
             OR NEW.user_id IS DISTINCT FROM OLD.user_id
             OR NEW.created_at IS DISTINCT FROM OLD.created_at
           ) THEN
             RAISE EXCEPTION
               'chat_thread_follows identities and creation timestamps are immutable'
               USING ERRCODE = '55000';
           END IF;

           IF TG_OP = 'UPDATE' AND NEW.updated_at < OLD.updated_at THEN
             RAISE EXCEPTION 'chat_thread_follows updated_at must not move backwards'
               USING ERRCODE = '55000';
           END IF;

           IF TG_OP = 'UPDATE'
             AND OLD.is_following IS FALSE
             AND OLD.follow_source = 'manual'
             AND NEW.is_following IS TRUE
             AND NEW.follow_source IN ('reply', 'mention')
           THEN
             RAISE EXCEPTION
               'automatic thread follow cannot overwrite an explicit manual unfollow'
               USING
                 ERRCODE = '23514',
                 CONSTRAINT = 'chat_thread_follows_explicit_unfollow_check';
           END IF;

           SELECT
             thread.parent_conversation_id,
             parent.type,
             parent.visibility
           INTO
             thread_parent_conversation_id,
             parent_type,
             parent_visibility
           FROM chat_conversations AS thread
           INNER JOIN chat_conversations AS parent
             ON parent.tenant_id = thread.tenant_id
            AND parent.id = thread.parent_conversation_id
           WHERE thread.tenant_id = NEW.tenant_id
             AND thread.id = NEW.conversation_id
             AND thread.type = 'thread'
             AND parent.type <> 'thread';

           IF NOT FOUND THEN
             RAISE EXCEPTION
               'chat_thread_follows target must be a tenant-scoped thread conversation'
               USING
                 ERRCODE = '23514',
                 CONSTRAINT = 'chat_thread_follows_thread_type_check';
           END IF;

           IF NOT (
             (parent_type = 'channel' AND parent_visibility = 'public')
             OR EXISTS (
               SELECT 1
               FROM chat_conversation_members AS member
               WHERE member.tenant_id = NEW.tenant_id
                 AND member.conversation_id = thread_parent_conversation_id
                 AND member.user_id = NEW.user_id
                 AND member.state = 'active'
             )
           ) THEN
             RAISE EXCEPTION
               'chat_thread_follows user must have active access to the parent conversation'
               USING
                 ERRCODE = '23514',
                 CONSTRAINT = 'chat_thread_follows_active_membership_check';
           END IF;

           RETURN NEW;
         END;
         $function$`,
    ]),
  });

/** Adds durable optimistic concurrency for complete membership-list mutations. */
export const chatConversationMemberListRevisionMigration: PostgresMigration =
  Object.freeze({
    id: "0017-chat-conversation-member-list-revision",
    order: 17,
    statements: Object.freeze([
      `ALTER TABLE chat_conversations
         ADD COLUMN member_list_revision bigint NOT NULL DEFAULT 1`,
      `ALTER TABLE chat_conversations
         ADD CONSTRAINT chat_conversations_member_list_revision_check
         CHECK (
           member_list_revision >= 1
           AND member_list_revision <= 9007199254740991
         )`,
    ]),
  });

/** Adds durable compare-and-set revisions for explicit member preferences. */
export const chatConversationPreferenceRevisionMigration: PostgresMigration =
  Object.freeze({
    id: "0018-chat-conversation-preference-revision",
    order: 18,
    statements: Object.freeze([
      `ALTER TABLE chat_conversation_preferences
         ADD COLUMN preference_revision bigint NOT NULL DEFAULT 1`,
      `ALTER TABLE chat_conversation_preferences
         ADD CONSTRAINT chat_conversation_preferences_revision_check
         CHECK (
           preference_revision >= 1
           AND preference_revision <= 9007199254740991
         )`,
    ]),
  });

/** Adds explicit saved/unsaved state, private notes, and durable CAS revisions. */
export const chatSavedMessageMutationStateMigration: PostgresMigration =
  Object.freeze({
    id: "0019-chat-saved-message-mutation-state",
    order: 19,
    statements: Object.freeze([
      `ALTER TABLE chat_saved_messages
         ADD COLUMN is_saved boolean NOT NULL DEFAULT true,
         ADD COLUMN private_note text,
         ADD COLUMN saved_message_revision bigint NOT NULL DEFAULT 1,
         ADD COLUMN updated_at timestamptz NOT NULL DEFAULT clock_timestamp()`,
      `ALTER TABLE chat_saved_messages
         DROP CONSTRAINT chat_saved_messages_membership_fkey`,
      `ALTER TABLE chat_saved_messages
         ADD CONSTRAINT chat_saved_messages_private_note_check
         CHECK (
           private_note IS NULL
           OR (
             octet_length(private_note) BETWEEN 1 AND 4096
             AND private_note = normalize(private_note, NFC)
             AND private_note ~ '[^[:space:]]'
           )
         ),
         ADD CONSTRAINT chat_saved_messages_unsaved_note_check
         CHECK (is_saved OR private_note IS NULL),
         ADD CONSTRAINT chat_saved_messages_revision_check
         CHECK (
           saved_message_revision >= 1
           AND saved_message_revision <= 9007199254740991
         ),
         ADD CONSTRAINT chat_saved_messages_updated_at_check
         CHECK (
           updated_at >= created_at
           AND updated_at > '-infinity'::timestamptz
           AND updated_at < 'infinity'::timestamptz
         )`,
      `CREATE OR REPLACE FUNCTION validate_chat_saved_message()
         RETURNS trigger
         LANGUAGE plpgsql
         SET search_path FROM CURRENT
         AS $function$
         DECLARE
           conversation_type text;
           conversation_visibility text;
         BEGIN
           IF TG_OP = 'UPDATE' AND (
             NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
             OR NEW.user_id IS DISTINCT FROM OLD.user_id
             OR NEW.message_id IS DISTINCT FROM OLD.message_id
             OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
             OR NEW.created_at IS DISTINCT FROM OLD.created_at
           ) THEN
             RAISE EXCEPTION
               'chat_saved_messages identities and creation timestamps are immutable'
               USING ERRCODE = '55000';
           END IF;

           IF TG_OP = 'UPDATE' AND NEW.updated_at < OLD.updated_at THEN
             RAISE EXCEPTION 'chat_saved_messages updated_at must not move backwards'
               USING ERRCODE = '55000';
           END IF;

           SELECT conversation.type, conversation.visibility
             INTO conversation_type, conversation_visibility
             FROM chat_conversations AS conversation
            WHERE conversation.tenant_id = NEW.tenant_id
              AND conversation.id = NEW.conversation_id;

           IF NOT FOUND OR NOT (
             (conversation_type = 'channel' AND conversation_visibility = 'public')
             OR EXISTS (
               SELECT 1
                 FROM chat_conversation_members AS member
                WHERE member.tenant_id = NEW.tenant_id
                  AND member.conversation_id = NEW.conversation_id
                  AND member.user_id = NEW.user_id
                  AND member.state = 'active'
             )
           ) THEN
             RAISE EXCEPTION
               'chat_saved_messages user must have current conversation visibility'
               USING
                 ERRCODE = '23514',
                 CONSTRAINT = 'chat_saved_messages_current_visibility_check';
           END IF;

           RETURN NEW;
         END;
         $function$`,
    ]),
  });

/** Persists the bounded server-derived reason for an immutable participant leave. */
export const chatHuddleParticipantLeaveReasonMigration: PostgresMigration =
  Object.freeze({
    id: "0020-chat-huddle-participant-leave-reason",
    order: 20,
    statements: Object.freeze([
      `ALTER TABLE chat_huddle_participants
         ADD COLUMN leave_reason text`,
      `ALTER TABLE chat_huddle_participants
         DISABLE TRIGGER chat_huddle_participants_validate_write`,
      `UPDATE chat_huddle_participants
          SET leave_reason = 'legacy_unknown'
        WHERE left_at IS NOT NULL`,
      `ALTER TABLE chat_huddle_participants
         ENABLE TRIGGER chat_huddle_participants_validate_write`,
      `ALTER TABLE chat_huddle_participants
         ADD CONSTRAINT chat_huddle_participants_leave_reason_check
         CHECK (
           (left_at IS NULL AND leave_reason IS NULL)
           OR (
             left_at IS NOT NULL
             AND leave_reason IN (
               'explicit_leave', 'disconnect', 'huddle_ended', 'legacy_unknown'
             )
             AND octet_length(leave_reason) BETWEEN 1 AND 32
           )
         )`,
    ]),
  });

/**
 * Adds a private recovery state for provider termination. `ending` is never a
 * public transport state, but remains conversation-exclusive until the room is
 * confirmed terminated and the canonical ended state is committed.
 */
export const chatHuddleEndingRecoveryMigration: PostgresMigration =
  Object.freeze({
    id: "0021-chat-huddle-ending-recovery",
    order: 21,
    statements: Object.freeze([
      `ALTER TABLE chat_huddle_sessions
         DROP CONSTRAINT chat_huddle_sessions_status_check`,
      `ALTER TABLE chat_huddle_sessions
         ADD CONSTRAINT chat_huddle_sessions_status_check
         CHECK (status IN ('starting', 'active', 'ending', 'ended'))`,
      `ALTER TABLE chat_huddle_sessions
         DROP CONSTRAINT chat_huddle_sessions_lifecycle_shape_check`,
      `ALTER TABLE chat_huddle_sessions
         ADD CONSTRAINT chat_huddle_sessions_lifecycle_shape_check
         CHECK (
           (
             status = 'starting'
             AND activated_at IS NULL
             AND ended_at IS NULL
             AND ended_by_user_id IS NULL
             AND active_screen_share_owner_user_id IS NULL
           )
           OR (
             status = 'active'
             AND activated_at IS NOT NULL
             AND ended_at IS NULL
             AND ended_by_user_id IS NULL
           )
           OR (
             status = 'ending'
             AND ended_at IS NULL
             AND ended_by_user_id IS NOT NULL
           )
           OR (
             status = 'ended'
             AND ended_at IS NOT NULL
             AND ended_by_user_id IS NOT NULL
             AND active_screen_share_owner_user_id IS NULL
           )
         )`,
      `DROP INDEX chat_huddle_sessions_active_conversation_idx`,
      `CREATE UNIQUE INDEX chat_huddle_sessions_active_conversation_idx
         ON chat_huddle_sessions (tenant_id, conversation_id)
         INCLUDE (id, status, started_at, active_screen_share_owner_user_id)
         WHERE status IN ('starting', 'active', 'ending')`,
      `CREATE OR REPLACE FUNCTION validate_chat_huddle_session()
         RETURNS trigger
         LANGUAGE plpgsql
         SET search_path FROM CURRENT
         AS $function$
         BEGIN
           IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
             RAISE EXCEPTION 'chat_huddle_sessions are retained as history'
               USING ERRCODE = '55000';
           END IF;

           IF TG_OP = 'INSERT' AND NEW.status <> 'starting' THEN
             RAISE EXCEPTION 'chat_huddle_sessions must be created starting'
               USING
                 ERRCODE = '23514',
                 CONSTRAINT = 'chat_huddle_sessions_initial_state_check';
           END IF;

           IF TG_OP = 'UPDATE' THEN
             IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
                OR NEW.id IS DISTINCT FROM OLD.id
                OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
                OR NEW.provider_room_reference IS DISTINCT FROM OLD.provider_room_reference
                OR NEW.initiated_by_user_id IS DISTINCT FROM OLD.initiated_by_user_id
                OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
               RAISE EXCEPTION
                 'chat_huddle_sessions identity and start metadata are immutable'
                 USING ERRCODE = '55000';
             END IF;

             IF NEW.updated_at < OLD.updated_at THEN
               RAISE EXCEPTION 'chat_huddle_sessions updated_at must not move backwards'
                 USING ERRCODE = '55000';
             END IF;

             IF OLD.activated_at IS NOT NULL
                AND NEW.activated_at IS DISTINCT FROM OLD.activated_at THEN
               RAISE EXCEPTION 'chat_huddle_sessions activated_at is immutable once set'
                 USING ERRCODE = '55000';
             END IF;

             IF OLD.status = 'ended' AND NEW IS DISTINCT FROM OLD THEN
               RAISE EXCEPTION 'ended chat_huddle_sessions are immutable'
                 USING ERRCODE = '55000';
             END IF;

             IF NOT (
               NEW.status = OLD.status
               OR (OLD.status = 'starting' AND NEW.status IN ('active', 'ending'))
               OR (OLD.status = 'active' AND NEW.status = 'ending')
               OR (OLD.status = 'ending' AND NEW.status = 'ended')
             ) THEN
               RAISE EXCEPTION 'invalid chat_huddle_sessions lifecycle transition'
                 USING
                   ERRCODE = '23514',
                   CONSTRAINT = 'chat_huddle_sessions_transition_check';
             END IF;

             IF OLD.status = 'starting'
                AND NEW.status = 'active'
                AND NOT EXISTS (
                  SELECT 1
                    FROM chat_huddle_participants AS participant
                   WHERE participant.tenant_id = NEW.tenant_id
                     AND participant.huddle_session_id = NEW.id
                     AND participant.left_at IS NULL
                ) THEN
               RAISE EXCEPTION
                 'active chat_huddle_sessions require a joined participant'
                 USING
                   ERRCODE = '23514',
                   CONSTRAINT = 'chat_huddle_sessions_active_participant_check';
             END IF;
           END IF;

           IF NEW.active_screen_share_owner_user_id IS NOT NULL
              AND NOT EXISTS (
                SELECT 1
                  FROM chat_huddle_participants AS participant
                 WHERE participant.tenant_id = NEW.tenant_id
                   AND participant.huddle_session_id = NEW.id
                   AND participant.user_id = NEW.active_screen_share_owner_user_id
                   AND participant.left_at IS NULL
              ) THEN
             RAISE EXCEPTION
               'screen-share owner must be an actively joined huddle participant'
               USING
                 ERRCODE = '23514',
                 CONSTRAINT = 'chat_huddle_sessions_active_screen_share_owner_check';
           END IF;

           IF NEW.status = 'ended' AND EXISTS (
             SELECT 1
               FROM chat_huddle_participants AS participant
              WHERE participant.tenant_id = NEW.tenant_id
                AND participant.huddle_session_id = NEW.id
                AND (
                  participant.left_at IS NULL
                  OR participant.left_at > NEW.ended_at
                )
           ) THEN
             RAISE EXCEPTION
               'ended chat_huddle_sessions require every participant to have left'
               USING
                 ERRCODE = '23514',
                 CONSTRAINT = 'chat_huddle_sessions_ended_participants_check';
           END IF;

           RETURN NEW;
         END;
         $function$`,
    ]),
  });

/**
 * Persists one active provider token per tenant-scoped user device while
 * retaining revoked registrations. Opaque token material is private host state
 * and must never be projected into canonical state, diagnostics, or logs.
 */
export const chatDevicePushTokensMigration: PostgresMigration = Object.freeze({
  id: "0022-chat-device-push-tokens",
  order: 22,
  statements: Object.freeze([
    `CREATE TABLE chat_device_push_tokens (
       tenant_id text NOT NULL,
       user_id text NOT NULL,
       device_id text NOT NULL,
       platform text NOT NULL,
       provider text NOT NULL,
       environment text NOT NULL,
       opaque_token text NOT NULL,
       token_revision integer NOT NULL,
       created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
       activated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
       updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
       revoked_at timestamptz,
       CONSTRAINT chat_device_push_tokens_pkey
         PRIMARY KEY (tenant_id, user_id, device_id, token_revision),
       CONSTRAINT chat_device_push_tokens_tenant_id_check
         CHECK (
           octet_length(tenant_id) BETWEEN 1 AND 255
           AND tenant_id ~ '[^[:space:]]'
         ),
       CONSTRAINT chat_device_push_tokens_user_id_check
         CHECK (
           octet_length(user_id) BETWEEN 1 AND 255
           AND user_id ~ '[^[:space:]]'
         ),
       CONSTRAINT chat_device_push_tokens_device_id_check
         CHECK (
           octet_length(device_id) BETWEEN 1 AND 255
           AND device_id ~ '[^[:space:]]'
         ),
       CONSTRAINT chat_device_push_tokens_provider_target_check
         CHECK (
           (
             platform = 'ios'
             AND provider = 'apns'
             AND environment IN ('sandbox', 'production')
           )
           OR (
             platform = 'android'
             AND provider = 'fcm'
             AND environment = 'production'
           )
         ),
       CONSTRAINT chat_device_push_tokens_opaque_token_check
         CHECK (
           octet_length(opaque_token) BETWEEN 1 AND 4096
           AND opaque_token ~ '[^[:space:]]'
         ),
       CONSTRAINT chat_device_push_tokens_revision_check
         CHECK (token_revision BETWEEN 1 AND 2147483647),
       CONSTRAINT chat_device_push_tokens_timestamp_order_check
         CHECK (
           created_at > '-infinity'::timestamptz
           AND created_at < 'infinity'::timestamptz
           AND activated_at >= created_at
           AND activated_at < 'infinity'::timestamptz
           AND updated_at >= activated_at
           AND updated_at < 'infinity'::timestamptz
           AND (
             revoked_at IS NULL
             OR (
               revoked_at >= activated_at
               AND revoked_at <= updated_at
               AND revoked_at < 'infinity'::timestamptz
             )
           )
         )
     )`,
    `COMMENT ON COLUMN chat_device_push_tokens.opaque_token IS
       'Private opaque or host-encrypted provider token material. Never expose in canonical state, diagnostics, or logs.'`,
    `CREATE FUNCTION validate_chat_device_push_token()
       RETURNS trigger
       LANGUAGE plpgsql
       SET search_path FROM CURRENT
       AS $function$
       BEGIN
         IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
           RAISE EXCEPTION 'chat_device_push_tokens are retained as history'
             USING ERRCODE = '55000';
         END IF;

         IF TG_OP = 'INSERT' THEN
           IF NEW.revoked_at IS NOT NULL THEN
             RAISE EXCEPTION 'chat_device_push_tokens must be created active'
               USING
                 ERRCODE = '23514',
                 CONSTRAINT = 'chat_device_push_tokens_initial_state_check';
           END IF;

           IF EXISTS (
             SELECT 1
             FROM chat_device_push_tokens AS stored
             WHERE stored.tenant_id = NEW.tenant_id
               AND stored.user_id = NEW.user_id
               AND stored.device_id = NEW.device_id
               AND stored.token_revision >= NEW.token_revision
           ) THEN
             RAISE EXCEPTION 'chat_device_push_tokens revisions must increase'
               USING
                 ERRCODE = '23514',
                 CONSTRAINT = 'chat_device_push_tokens_revision_monotonic_check';
           END IF;

           RETURN NEW;
         END IF;

         IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
            OR NEW.user_id IS DISTINCT FROM OLD.user_id
            OR NEW.device_id IS DISTINCT FROM OLD.device_id
            OR NEW.created_at IS DISTINCT FROM OLD.created_at
            OR NEW.activated_at IS DISTINCT FROM OLD.activated_at THEN
           RAISE EXCEPTION
             'chat_device_push_tokens identity and activation timestamps are immutable'
             USING ERRCODE = '55000';
         END IF;

         IF OLD.revoked_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
           RAISE EXCEPTION 'revoked chat_device_push_tokens are immutable'
             USING ERRCODE = '55000';
         END IF;

         IF NEW.token_revision <= OLD.token_revision THEN
           RAISE EXCEPTION 'chat_device_push_tokens revisions must increase'
             USING
               ERRCODE = '23514',
               CONSTRAINT = 'chat_device_push_tokens_revision_monotonic_check';
         END IF;

         IF NEW.updated_at < OLD.updated_at THEN
           RAISE EXCEPTION
             'chat_device_push_tokens updated_at must not move backwards'
             USING ERRCODE = '55000';
         END IF;

         IF NEW.revoked_at IS NOT NULL AND (
           NEW.platform IS DISTINCT FROM OLD.platform
           OR NEW.provider IS DISTINCT FROM OLD.provider
           OR NEW.environment IS DISTINCT FROM OLD.environment
           OR NEW.opaque_token IS DISTINCT FROM OLD.opaque_token
         ) THEN
           RAISE EXCEPTION
             'unregistering chat_device_push_tokens cannot replace provider state'
             USING ERRCODE = '55000';
         END IF;

         RETURN NEW;
       END;
       $function$`,
    `CREATE TRIGGER chat_device_push_tokens_validate_write
       BEFORE INSERT OR UPDATE OR DELETE ON chat_device_push_tokens
       FOR EACH ROW
       EXECUTE FUNCTION validate_chat_device_push_token()`,
    `CREATE TRIGGER chat_device_push_tokens_reject_truncate
       BEFORE TRUNCATE ON chat_device_push_tokens
       FOR EACH STATEMENT
       EXECUTE FUNCTION validate_chat_device_push_token()`,
    `CREATE UNIQUE INDEX chat_device_push_tokens_active_device_idx
       ON chat_device_push_tokens (tenant_id, user_id, device_id)
       INCLUDE (platform, provider, environment, token_revision, updated_at)
       WHERE revoked_at IS NULL`,
    `CREATE INDEX chat_device_push_tokens_tenant_lookup_idx
       ON chat_device_push_tokens
         (tenant_id, user_id, device_id, token_revision DESC)
       INCLUDE (
         platform,
         provider,
         environment,
         activated_at,
         revoked_at,
         updated_at
       )`,
    `CREATE INDEX chat_device_push_tokens_revoked_idx
       ON chat_device_push_tokens
         (tenant_id, revoked_at, user_id, device_id)
       INCLUDE (provider, environment, token_revision)
       WHERE revoked_at IS NOT NULL`,
  ]),
});

/** Keeps active organization and entity conversation keyset pages index-ordered. */
export const chatConversationListOrderingMigration: PostgresMigration =
  Object.freeze({
    id: "0023-chat-conversation-list-ordering",
    order: 23,
    statements: Object.freeze([
      `CREATE INDEX chat_conversations_active_organization_list_idx
         ON chat_conversations (tenant_id, updated_at DESC, id DESC)
         WHERE archived_at IS NULL`,
      `CREATE INDEX chat_conversations_active_entity_list_idx
         ON chat_conversations
           (tenant_id, entity_type, entity_id, updated_at DESC, id DESC)
         WHERE archived_at IS NULL`,
    ]),
  });

/** Keeps unpublished per-stream outbox head checks proportional to pending work. */
export const chatOutboxUnpublishedStreamHeadsMigration: PostgresMigration =
  Object.freeze({
    id: "0024-chat-outbox-unpublished-stream-heads",
    order: 24,
    statements: Object.freeze([
      `CREATE INDEX chat_outbox_events_unpublished_stream_head_idx
         ON chat_outbox_events (tenant_id, stream_id, replay_position)
         WHERE published_at IS NULL`,
    ]),
  });

/** Keeps tenant-wide latest-event and replay-cursor reads index-ordered. */
export const chatOutboxTenantReplayPositionsMigration: PostgresMigration =
  Object.freeze({
    id: "0025-chat-outbox-tenant-replay-positions",
    order: 25,
    statements: Object.freeze([
      `CREATE INDEX chat_outbox_events_tenant_replay_idx
         ON chat_outbox_events (tenant_id, replay_position DESC)`,
    ]),
  });

/** Keeps global ready-delivery and expired-lease claims time-selective. */
export const chatNotificationGlobalClaimIndexesMigration: PostgresMigration =
  Object.freeze({
    id: "0026-chat-notification-global-claim-indexes",
    order: 26,
    statements: Object.freeze([
      `CREATE INDEX chat_notification_deliveries_global_ready_idx
         ON chat_notification_deliveries (
           next_attempt_at,
           tenant_id,
           source_event_id,
           recipient_host_user_id,
           notification_kind
         )
         INCLUDE (status, attempt_count, last_error_class)
         WHERE status IN ('pending', 'failed')`,
      `CREATE INDEX chat_notification_deliveries_global_expired_lease_idx
         ON chat_notification_deliveries (
           lease_expires_at,
           tenant_id,
           source_event_id,
           recipient_host_user_id,
           notification_kind
         )
         INCLUDE (attempt_count)
         WHERE status = 'leased'`,
    ]),
  });

/** Persists bounded progress for versioned notification materializers. */
export const chatNotificationMaterializerOffsetsMigration: PostgresMigration =
  Object.freeze({
    id: "0027-chat-notification-materializer-offsets",
    order: 27,
    statements: Object.freeze([
      `CREATE TABLE chat_notification_materializer_offsets (
         materializer_name varchar(128) PRIMARY KEY,
         last_replay_position bigint NOT NULL,
         updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
         CONSTRAINT chat_notification_materializer_offsets_name_check CHECK (
           materializer_name ~
             '^[a-z][a-z0-9]*([._-][a-z0-9]+)*:v[1-9][0-9]*$'
         ),
         CONSTRAINT chat_notification_materializer_offsets_position_check CHECK (
           last_replay_position BETWEEN 0 AND 9007199254740991
         ),
         CONSTRAINT chat_notification_materializer_offsets_updated_at_check CHECK (
           isfinite(updated_at)
         )
       )`,
    ]),
  });

/** Keeps bounded expiry cleanup ordered across all publication states. */
export const chatOutboxExpiryCleanupMigration: PostgresMigration =
  Object.freeze({
    id: "0028-chat-outbox-expiry-cleanup",
    order: 28,
    statements: Object.freeze([
      `CREATE INDEX chat_outbox_events_expiry_cleanup_idx
         ON chat_outbox_events (expires_at, replay_position)`,
    ]),
  });

/** Indexes only current, user-visible message text for authorized search queries. */
export const chatMessageSearchVectorMigration: PostgresMigration =
  Object.freeze({
    id: "0029-chat-message-search-vector",
    order: 29,
    statements: Object.freeze([
      `ALTER TABLE chat_messages
         ADD COLUMN search_vector tsvector
         GENERATED ALWAYS AS (
           to_tsvector('simple', COALESCE(content ->> 'text', ''))
         ) STORED`,
      `CREATE INDEX chat_messages_search_vector_idx
         ON chat_messages USING GIN (search_vector)
         WHERE deleted_at IS NULL`,
    ]),
  });

/** Persists actor-private message reminders and their terminal delivery state. */
export const chatMessageRemindersMigration: PostgresMigration = Object.freeze({
  id: "0030-chat-message-reminders",
  order: 30,
  statements: Object.freeze([
    `CREATE TABLE chat_message_reminders (
       tenant_id text NOT NULL,
       user_id text NOT NULL,
       message_id text NOT NULL,
       conversation_id text NOT NULL,
       remind_at timestamptz NOT NULL,
       reminder_revision bigint NOT NULL DEFAULT 1,
       status text NOT NULL DEFAULT 'active',
       delivered_at timestamptz,
       cancelled_at timestamptz,
       created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
       updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
       CONSTRAINT chat_message_reminders_pkey
         PRIMARY KEY (tenant_id, user_id, message_id),
       CONSTRAINT chat_message_reminders_message_fkey
         FOREIGN KEY (tenant_id, conversation_id, message_id)
         REFERENCES chat_messages (tenant_id, conversation_id, id),
       CONSTRAINT chat_message_reminders_revision_check
         CHECK (
           reminder_revision >= 1
           AND reminder_revision <= 9007199254740991
         ),
       CONSTRAINT chat_message_reminders_timestamp_order_check
         CHECK (
           isfinite(remind_at)
           AND isfinite(created_at)
           AND isfinite(updated_at)
           AND remind_at >= created_at
           AND updated_at >= created_at
           AND (delivered_at IS NULL OR (
             isfinite(delivered_at)
             AND delivered_at >= remind_at
             AND delivered_at <= updated_at
           ))
           AND (cancelled_at IS NULL OR (
             isfinite(cancelled_at)
             AND cancelled_at >= created_at
             AND cancelled_at <= updated_at
           ))
         ),
       CONSTRAINT chat_message_reminders_lifecycle_check
         CHECK (
           (status = 'active' AND delivered_at IS NULL AND cancelled_at IS NULL)
           OR (
             status = 'delivered'
             AND delivered_at IS NOT NULL
             AND cancelled_at IS NULL
           )
           OR (
             status = 'cancelled'
             AND delivered_at IS NULL
             AND cancelled_at IS NOT NULL
           )
         )
     )`,
    `CREATE FUNCTION validate_chat_message_reminder()
       RETURNS trigger
       LANGUAGE plpgsql
       SET search_path FROM CURRENT
       AS $function$
       DECLARE
         conversation_type text;
         conversation_visibility text;
       BEGIN
         IF TG_OP = 'UPDATE' AND (
           NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
           OR NEW.user_id IS DISTINCT FROM OLD.user_id
           OR NEW.message_id IS DISTINCT FROM OLD.message_id
           OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
           OR NEW.created_at IS DISTINCT FROM OLD.created_at
         ) THEN
           RAISE EXCEPTION
             'chat_message_reminders identities and creation timestamps are immutable'
             USING ERRCODE = '55000';
         END IF;

         IF TG_OP = 'UPDATE' AND OLD.status <> 'active' THEN
           RAISE EXCEPTION 'chat_message_reminders terminal state is immutable'
             USING ERRCODE = '55000';
         END IF;

         IF TG_OP = 'UPDATE'
           AND NEW.reminder_revision <> OLD.reminder_revision + 1
         THEN
           RAISE EXCEPTION
             'chat_message_reminders revision must advance by exactly one'
             USING ERRCODE = '55000';
         END IF;

         IF TG_OP = 'UPDATE' AND NEW.updated_at < OLD.updated_at THEN
           RAISE EXCEPTION 'chat_message_reminders updated_at must not move backwards'
             USING ERRCODE = '55000';
         END IF;

         IF TG_OP = 'UPDATE' AND NEW.status = 'active'
           AND NEW.remind_at IS NOT DISTINCT FROM OLD.remind_at
         THEN
           RAISE EXCEPTION 'chat_message_reminders reschedule must change remind_at'
             USING ERRCODE = '55000';
         END IF;

         IF TG_OP = 'UPDATE' AND NEW.status <> 'active'
           AND NEW.remind_at IS DISTINCT FROM OLD.remind_at
         THEN
           RAISE EXCEPTION
             'chat_message_reminders terminal transition cannot reschedule'
             USING ERRCODE = '55000';
         END IF;

         SELECT conversation.type, conversation.visibility
           INTO conversation_type, conversation_visibility
           FROM chat_conversations AS conversation
          WHERE conversation.tenant_id = NEW.tenant_id
            AND conversation.id = NEW.conversation_id;

         IF NOT FOUND OR NOT (
           (conversation_type = 'channel' AND conversation_visibility = 'public')
           OR EXISTS (
             SELECT 1
               FROM chat_conversation_members AS member
              WHERE member.tenant_id = NEW.tenant_id
                AND member.conversation_id = NEW.conversation_id
                AND member.user_id = NEW.user_id
                AND member.state = 'active'
           )
         ) THEN
           RAISE EXCEPTION
             'chat_message_reminders user must have current conversation visibility'
             USING
               ERRCODE = '23514',
               CONSTRAINT = 'chat_message_reminders_current_visibility_check';
         END IF;

         RETURN NEW;
       END;
       $function$`,
    `CREATE TRIGGER chat_message_reminders_validate_write
       BEFORE INSERT OR UPDATE ON chat_message_reminders
       FOR EACH ROW
       EXECUTE FUNCTION validate_chat_message_reminder()`,
    `CREATE INDEX chat_message_reminders_global_due_idx
       ON chat_message_reminders
         (remind_at, tenant_id, user_id, message_id)
       INCLUDE (conversation_id, reminder_revision)
       WHERE status = 'active'`,
  ]),
});

/** Records reminder materialization without weakening notification source identity. */
export const chatMessageReminderNotificationsMigration: PostgresMigration =
  Object.freeze({
    id: "0031-chat-message-reminder-notifications",
    order: 31,
    statements: Object.freeze([
      `ALTER TABLE chat_message_reminders
         ADD COLUMN materialized_revision bigint,
         ADD COLUMN materialized_at timestamptz,
         ADD COLUMN materialized_source_event_id text,
         ADD CONSTRAINT chat_message_reminders_materialization_check CHECK (
           (
             materialized_revision IS NULL
             AND materialized_at IS NULL
             AND materialized_source_event_id IS NULL
           )
           OR (
             materialized_revision BETWEEN 1 AND 9007199254740991
             AND materialized_revision <= reminder_revision
             AND isfinite(materialized_at)
             AND materialized_at >= created_at
             AND materialized_at <= updated_at
             AND octet_length(materialized_source_event_id) BETWEEN 1 AND 255
             AND materialized_source_event_id ~ '[^[:space:]]'
           )
         )`,
      `CREATE OR REPLACE FUNCTION validate_chat_message_reminder()
         RETURNS trigger
         LANGUAGE plpgsql
         SET search_path FROM CURRENT
         AS $function$
         DECLARE
           conversation_type text;
           conversation_visibility text;
           materialization_only boolean := false;
         BEGIN
           IF TG_OP = 'UPDATE' AND (
             NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
             OR NEW.user_id IS DISTINCT FROM OLD.user_id
             OR NEW.message_id IS DISTINCT FROM OLD.message_id
             OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
             OR NEW.created_at IS DISTINCT FROM OLD.created_at
           ) THEN
             RAISE EXCEPTION
               'chat_message_reminders identities and creation timestamps are immutable'
               USING ERRCODE = '55000';
           END IF;

           IF TG_OP = 'UPDATE' THEN
             materialization_only :=
               NEW.status = 'active'
               AND OLD.status = 'active'
               AND NEW.reminder_revision = OLD.reminder_revision
               AND NEW.remind_at IS NOT DISTINCT FROM OLD.remind_at
               AND NEW.delivered_at IS NOT DISTINCT FROM OLD.delivered_at
               AND NEW.cancelled_at IS NOT DISTINCT FROM OLD.cancelled_at
               AND OLD.materialized_revision IS DISTINCT FROM OLD.reminder_revision
               AND NEW.materialized_revision = OLD.reminder_revision
               AND NEW.materialized_at IS NOT NULL
               AND NEW.materialized_source_event_id IS NOT NULL;
           END IF;

           IF TG_OP = 'UPDATE' AND OLD.status <> 'active' THEN
             RAISE EXCEPTION 'chat_message_reminders terminal state is immutable'
               USING ERRCODE = '55000';
           END IF;

           IF TG_OP = 'UPDATE' AND NOT materialization_only
             AND NEW.reminder_revision <> OLD.reminder_revision + 1
           THEN
             RAISE EXCEPTION
               'chat_message_reminders revision must advance by exactly one'
               USING ERRCODE = '55000';
           END IF;

           IF TG_OP = 'UPDATE' AND NEW.updated_at < OLD.updated_at THEN
             RAISE EXCEPTION 'chat_message_reminders updated_at must not move backwards'
               USING ERRCODE = '55000';
           END IF;

           IF TG_OP = 'UPDATE' AND NOT materialization_only
             AND NEW.status = 'active'
             AND NEW.remind_at IS NOT DISTINCT FROM OLD.remind_at
           THEN
             RAISE EXCEPTION 'chat_message_reminders reschedule must change remind_at'
               USING ERRCODE = '55000';
           END IF;

           IF TG_OP = 'UPDATE' AND NEW.status <> 'active'
             AND NEW.remind_at IS DISTINCT FROM OLD.remind_at
           THEN
             RAISE EXCEPTION
               'chat_message_reminders terminal transition cannot reschedule'
               USING ERRCODE = '55000';
           END IF;

           IF materialization_only OR NEW.status <> 'active' THEN
             RETURN NEW;
           END IF;

           SELECT conversation.type, conversation.visibility
             INTO conversation_type, conversation_visibility
             FROM chat_conversations AS conversation
            WHERE conversation.tenant_id = NEW.tenant_id
              AND conversation.id = NEW.conversation_id;

           IF NOT FOUND OR NOT (
             (conversation_type = 'channel' AND conversation_visibility = 'public')
             OR EXISTS (
               SELECT 1
                 FROM chat_conversation_members AS member
                WHERE member.tenant_id = NEW.tenant_id
                  AND member.conversation_id = NEW.conversation_id
                  AND member.user_id = NEW.user_id
                  AND member.state = 'active'
             )
           ) THEN
             RAISE EXCEPTION
               'chat_message_reminders user must have current conversation visibility'
               USING
                 ERRCODE = '23514',
                 CONSTRAINT = 'chat_message_reminders_current_visibility_check';
           END IF;

           RETURN NEW;
         END;
         $function$`,
      `DROP INDEX chat_message_reminders_global_due_idx`,
      `CREATE INDEX chat_message_reminders_global_due_idx
         ON chat_message_reminders
           (remind_at, tenant_id, user_id, message_id)
         INCLUDE (
           conversation_id, reminder_revision, materialized_revision
         )
         WHERE status = 'active'`,
    ]),
  });

/** Adds durable private starred state for conversation members. */
export const chatConversationPreferenceStarredMigration: PostgresMigration =
  Object.freeze({
    id: "0032-chat-conversation-preference-starred",
    order: 32,
    statements: Object.freeze([
      `ALTER TABLE chat_conversation_preferences
         ADD COLUMN is_starred boolean NOT NULL DEFAULT false`,
      `CREATE INDEX chat_conversation_preferences_starred_actor_idx
         ON chat_conversation_preferences
           (tenant_id, user_id, conversation_id)
         WHERE is_starred`,
    ]),
  });

/**
 * Labels legacy push tokens and provides coherent metadata for host-encrypted
 * envelopes without inspecting or rewriting the private token material.
 */
export const chatDevicePushTokenProtectionMetadataMigration: PostgresMigration =
  Object.freeze({
    id: "0033-chat-device-push-token-protection-metadata",
    order: 33,
    statements: Object.freeze([
      `ALTER TABLE chat_device_push_tokens
         ADD COLUMN token_protection_scheme text NOT NULL
           DEFAULT 'legacy_plaintext',
         ADD COLUMN token_protection_key_id text,
         ADD CONSTRAINT chat_device_push_tokens_protection_coherence_check
           CHECK (
             (
               token_protection_scheme = 'legacy_plaintext'
               AND token_protection_key_id IS NULL
             )
             OR (
               token_protection_scheme = 'host_encrypted'
               AND token_protection_key_id IS NOT NULL
               AND octet_length(token_protection_key_id) BETWEEN 1 AND 255
               AND token_protection_key_id ~ '[^[:space:]]'
             )
           )`,
      `COMMENT ON TABLE chat_device_push_tokens IS
         'Private device push-token registrations. New application writes must use host_encrypted protection; token material must never enter canonical state, diagnostics, or logs.'`,
      `COMMENT ON COLUMN chat_device_push_tokens.opaque_token IS
         'Private provider token or host-encrypted envelope. Never expose in canonical state, diagnostics, or logs.'`,
      `COMMENT ON COLUMN chat_device_push_tokens.token_protection_scheme IS
         'Closed protection discriminator: legacy_plaintext for rollout-compatible legacy writes or host_encrypted for protected envelopes.'`,
      `COMMENT ON COLUMN chat_device_push_tokens.token_protection_key_id IS
         'Host key identifier required for host_encrypted envelopes and forbidden for legacy_plaintext rows; never contains token material.'`,
    ]),
  });

/** Allows an unregister transition to discard private push-token material. */
export const chatDevicePushTokenFreeRevocationMigration: PostgresMigration =
  Object.freeze({
    id: "0034-chat-device-push-token-free-revocation",
    order: 34,
    statements: Object.freeze([
      `ALTER TABLE chat_device_push_tokens
         ALTER COLUMN opaque_token DROP NOT NULL,
         DROP CONSTRAINT chat_device_push_tokens_opaque_token_check,
         ADD CONSTRAINT chat_device_push_tokens_opaque_token_check
           CHECK (
             (
               opaque_token IS NOT NULL
               AND octet_length(opaque_token) BETWEEN 1 AND 4096
               AND opaque_token ~ '[^[:space:]]'
             )
             OR (
               opaque_token IS NULL
               AND revoked_at IS NOT NULL
             )
           ),
         DROP CONSTRAINT chat_device_push_tokens_protection_coherence_check,
         ADD CONSTRAINT chat_device_push_tokens_protection_coherence_check
           CHECK (
             (
               token_protection_scheme = 'legacy_plaintext'
               AND token_protection_key_id IS NULL
             )
             OR (
               token_protection_scheme = 'host_encrypted'
               AND (
                 (
                   opaque_token IS NOT NULL
                   AND token_protection_key_id IS NOT NULL
                   AND octet_length(token_protection_key_id) BETWEEN 1 AND 255
                   AND token_protection_key_id ~ '[^[:space:]]'
                 )
                 OR (
                   opaque_token IS NULL
                   AND token_protection_key_id IS NULL
                   AND revoked_at IS NOT NULL
                 )
               )
             )
           )`,
      `CREATE OR REPLACE FUNCTION validate_chat_device_push_token()
         RETURNS trigger
         LANGUAGE plpgsql
         SET search_path FROM CURRENT
         AS $function$
         BEGIN
           IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
             RAISE EXCEPTION 'chat_device_push_tokens are retained as history'
               USING ERRCODE = '55000';
           END IF;

           IF TG_OP = 'INSERT' THEN
             IF NEW.revoked_at IS NOT NULL THEN
               RAISE EXCEPTION 'chat_device_push_tokens must be created active'
                 USING
                   ERRCODE = '23514',
                   CONSTRAINT = 'chat_device_push_tokens_initial_state_check';
             END IF;

             IF EXISTS (
               SELECT 1
               FROM chat_device_push_tokens AS stored
               WHERE stored.tenant_id = NEW.tenant_id
                 AND stored.user_id = NEW.user_id
                 AND stored.device_id = NEW.device_id
                 AND stored.token_revision >= NEW.token_revision
             ) THEN
               RAISE EXCEPTION 'chat_device_push_tokens revisions must increase'
                 USING
                   ERRCODE = '23514',
                   CONSTRAINT = 'chat_device_push_tokens_revision_monotonic_check';
             END IF;

             RETURN NEW;
           END IF;

           IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
              OR NEW.user_id IS DISTINCT FROM OLD.user_id
              OR NEW.device_id IS DISTINCT FROM OLD.device_id
              OR NEW.created_at IS DISTINCT FROM OLD.created_at
              OR NEW.activated_at IS DISTINCT FROM OLD.activated_at THEN
             RAISE EXCEPTION
               'chat_device_push_tokens identity and activation timestamps are immutable'
               USING ERRCODE = '55000';
           END IF;

           IF OLD.revoked_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
             RAISE EXCEPTION 'revoked chat_device_push_tokens are immutable'
               USING ERRCODE = '55000';
           END IF;

           IF NEW.token_revision <= OLD.token_revision THEN
             RAISE EXCEPTION 'chat_device_push_tokens revisions must increase'
               USING
                 ERRCODE = '23514',
                 CONSTRAINT = 'chat_device_push_tokens_revision_monotonic_check';
           END IF;

           IF NEW.updated_at < OLD.updated_at THEN
             RAISE EXCEPTION
               'chat_device_push_tokens updated_at must not move backwards'
               USING ERRCODE = '55000';
           END IF;

           IF NEW.revoked_at IS NOT NULL AND (
             NEW.platform IS DISTINCT FROM OLD.platform
             OR NEW.provider IS DISTINCT FROM OLD.provider
             OR NEW.environment IS DISTINCT FROM OLD.environment
             OR NEW.token_protection_scheme IS DISTINCT FROM
               OLD.token_protection_scheme
             OR (
               NEW.token_protection_key_id IS DISTINCT FROM
                 OLD.token_protection_key_id
               AND (
                 NEW.token_protection_key_id IS NOT NULL
                 OR NEW.opaque_token IS NOT NULL
               )
             )
             OR (
               NEW.opaque_token IS DISTINCT FROM OLD.opaque_token
               AND NEW.opaque_token IS NOT NULL
             )
           ) THEN
             RAISE EXCEPTION
               'unregistering chat_device_push_tokens cannot replace provider state'
               USING ERRCODE = '55000';
           END IF;

           RETURN NEW;
         END;
         $function$`,
      `COMMENT ON COLUMN chat_device_push_tokens.opaque_token IS
         'Private provider token or host-encrypted envelope. Required while active and may be cleared only when revoking; never expose in canonical state, diagnostics, or logs.'`,
      `COMMENT ON COLUMN chat_device_push_tokens.token_protection_key_id IS
         'Host key identifier required while a host_encrypted envelope is retained and cleared atomically with that envelope during revocation; never contains token material.'`,
    ]),
  });

/**
 * Retires legacy plaintext registrations without inspecting their provider
 * token material and requires all future active registrations to be protected.
 */
export const chatDevicePushTokenLegacyRetirementMigration: PostgresMigration =
  Object.freeze({
    id: "0035-chat-device-push-token-legacy-retirement",
    order: 35,
    statements: Object.freeze([
      `ALTER TABLE chat_device_push_tokens
         DISABLE TRIGGER chat_device_push_tokens_validate_write`,
      `UPDATE chat_device_push_tokens AS retiring
       SET opaque_token = NULL,
           token_protection_key_id = NULL,
           token_revision = CASE
             WHEN retiring.token_protection_scheme = 'legacy_plaintext'
                  AND retiring.revoked_at IS NULL THEN (
               SELECT max(stored.token_revision) + 1
               FROM chat_device_push_tokens AS stored
               WHERE stored.tenant_id = retiring.tenant_id
                 AND stored.user_id = retiring.user_id
                 AND stored.device_id = retiring.device_id
             )
             ELSE retiring.token_revision
           END,
           revoked_at = CASE
             WHEN retiring.token_protection_scheme = 'legacy_plaintext'
               THEN coalesce(retiring.revoked_at, retiring.updated_at)
             ELSE retiring.revoked_at
           END
       WHERE retiring.token_protection_scheme = 'legacy_plaintext'
          OR retiring.revoked_at IS NOT NULL`,
      `ALTER TABLE chat_device_push_tokens
         ALTER COLUMN token_protection_scheme DROP DEFAULT,
         DROP CONSTRAINT chat_device_push_tokens_opaque_token_check,
         ADD CONSTRAINT chat_device_push_tokens_opaque_token_check
           CHECK (
             (
               revoked_at IS NULL
               AND opaque_token IS NOT NULL
               AND octet_length(opaque_token) BETWEEN 1 AND 4096
               AND opaque_token ~ '[^[:space:]]'
             )
             OR (
               revoked_at IS NOT NULL
               AND opaque_token IS NULL
             )
           ) NOT VALID,
         DROP CONSTRAINT chat_device_push_tokens_protection_coherence_check,
         ADD CONSTRAINT chat_device_push_tokens_protection_coherence_check
           CHECK (
             (
               revoked_at IS NULL
               AND token_protection_scheme = 'host_encrypted'
               AND opaque_token IS NOT NULL
               AND octet_length(opaque_token) BETWEEN 1 AND 4096
               AND opaque_token ~ '[^[:space:]]'
               AND token_protection_key_id IS NOT NULL
               AND octet_length(token_protection_key_id) BETWEEN 1 AND 255
               AND token_protection_key_id ~ '[^[:space:]]'
             )
             OR (
               revoked_at IS NOT NULL
               AND token_protection_scheme IN (
                 'legacy_plaintext',
                 'host_encrypted'
               )
               AND opaque_token IS NULL
               AND token_protection_key_id IS NULL
             )
           ) NOT VALID`,
      `ALTER TABLE chat_device_push_tokens
         VALIDATE CONSTRAINT chat_device_push_tokens_opaque_token_check`,
      `ALTER TABLE chat_device_push_tokens
         VALIDATE CONSTRAINT
           chat_device_push_tokens_protection_coherence_check`,
      `ALTER TABLE chat_device_push_tokens
         ENABLE TRIGGER chat_device_push_tokens_validate_write`,
      `COMMENT ON COLUMN chat_device_push_tokens.opaque_token IS
         'Private host-encrypted provider-token envelope. Required while active and cleared atomically during revocation; never expose in canonical state, diagnostics, or logs.'`,
      `COMMENT ON COLUMN chat_device_push_tokens.token_protection_scheme IS
         'Closed protection discriminator: host_encrypted for active protected envelopes; legacy_plaintext is retained only on retired historical rows.'`,
      `COMMENT ON COLUMN chat_device_push_tokens.token_protection_key_id IS
         'Host key identifier required while an active host_encrypted envelope is retained and cleared atomically during revocation; never contains token material.'`,
    ]),
  });

/**
 * Adds content-free, durable delivery intent for newly appended audit events.
 * The trigger only creates local delivery mechanics; external adapters remain
 * the responsibility of the separately deployed audit dispatcher.
 */
export const chatAuditDeliveriesMigration: PostgresMigration = Object.freeze({
  id: "0036-chat-audit-deliveries",
  order: 36,
  statements: Object.freeze([
    `CREATE TABLE chat_audit_deliveries (
       tenant_id text NOT NULL,
       audit_event_id text NOT NULL,
       attempt_count bigint NOT NULL DEFAULT 0,
       next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
       lease_owner text,
       lease_expires_at timestamptz,
       delivered_at timestamptz,
       terminal_at timestamptz,
       failure_class text,
       CONSTRAINT chat_audit_deliveries_pkey
         PRIMARY KEY (tenant_id, audit_event_id),
       CONSTRAINT chat_audit_deliveries_tenant_id_check
         CHECK (
           octet_length(tenant_id) BETWEEN 1 AND 255
           AND tenant_id ~ '[^[:space:]]'
         ),
       CONSTRAINT chat_audit_deliveries_audit_event_id_check
         CHECK (
           octet_length(audit_event_id) BETWEEN 1 AND 255
           AND audit_event_id ~ '[^[:space:]]'
         ),
       CONSTRAINT chat_audit_deliveries_attempt_count_check
         CHECK (attempt_count BETWEEN 0 AND 9007199254740991),
       CONSTRAINT chat_audit_deliveries_lease_owner_check
         CHECK (
           lease_owner IS NULL
           OR (
             octet_length(lease_owner) BETWEEN 1 AND 255
             AND lease_owner = btrim(lease_owner)
             AND lease_owner ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
           )
         ),
       CONSTRAINT chat_audit_deliveries_failure_class_check
         CHECK (
           failure_class IS NULL
           OR failure_class IN (
             'transient',
             'rate_limited',
             'rejected',
             'configuration',
             'unknown'
           )
         ),
       CONSTRAINT chat_audit_deliveries_lease_pair_check
         CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
       CONSTRAINT chat_audit_deliveries_terminal_pair_check
         CHECK (NOT (delivered_at IS NOT NULL AND terminal_at IS NOT NULL)),
       CONSTRAINT chat_audit_deliveries_lifecycle_shape_check
         CHECK (
           (
             delivered_at IS NULL
             AND terminal_at IS NULL
             AND (
               (
                 lease_owner IS NULL
                 AND (
                   (attempt_count = 0 AND failure_class IS NULL)
                   OR (attempt_count >= 1 AND failure_class IS NOT NULL)
                 )
               )
               OR (
                 lease_owner IS NOT NULL
                 AND attempt_count >= 1
                 AND failure_class IS NULL
               )
             )
           )
           OR (
             delivered_at IS NOT NULL
             AND terminal_at IS NULL
             AND attempt_count >= 1
             AND lease_owner IS NULL
             AND failure_class IS NULL
           )
           OR (
             terminal_at IS NOT NULL
             AND delivered_at IS NULL
             AND attempt_count >= 1
             AND lease_owner IS NULL
             AND failure_class IS NOT NULL
           )
         ),
       CONSTRAINT chat_audit_deliveries_timestamp_check
         CHECK (
           next_attempt_at > '-infinity'::timestamptz
           AND next_attempt_at < 'infinity'::timestamptz
           AND (
             lease_expires_at IS NULL
             OR (
               lease_expires_at > '-infinity'::timestamptz
               AND lease_expires_at < 'infinity'::timestamptz
             )
           )
           AND (
             delivered_at IS NULL
             OR (
               delivered_at >= next_attempt_at
               AND delivered_at < 'infinity'::timestamptz
             )
           )
           AND (
             terminal_at IS NULL
             OR (
               terminal_at >= next_attempt_at
               AND terminal_at < 'infinity'::timestamptz
             )
           )
         ),
       CONSTRAINT chat_audit_deliveries_audit_event_fkey
         FOREIGN KEY (tenant_id, audit_event_id)
         REFERENCES chat_audit_events (tenant_id, event_id)
     )`,
    `CREATE FUNCTION validate_chat_audit_delivery()
       RETURNS trigger
       LANGUAGE plpgsql
       SET search_path FROM CURRENT
       AS $function$
       BEGIN
         IF TG_OP = 'INSERT' THEN
           IF NEW.attempt_count <> 0
              OR NEW.lease_owner IS NOT NULL
              OR NEW.lease_expires_at IS NOT NULL
              OR NEW.delivered_at IS NOT NULL
              OR NEW.terminal_at IS NOT NULL
              OR NEW.failure_class IS NOT NULL THEN
             RAISE EXCEPTION
               'chat_audit_deliveries must be created ready and unattempted'
               USING
                 ERRCODE = '23514',
                 CONSTRAINT = 'chat_audit_deliveries_initial_state_check';
           END IF;
           RETURN NEW;
         END IF;

         IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
            OR NEW.audit_event_id IS DISTINCT FROM OLD.audit_event_id THEN
           RAISE EXCEPTION 'chat_audit_deliveries identity is immutable'
             USING ERRCODE = '55000';
         END IF;

         IF (OLD.delivered_at IS NOT NULL OR OLD.terminal_at IS NOT NULL)
            AND NEW IS DISTINCT FROM OLD THEN
           RAISE EXCEPTION 'terminal chat_audit_deliveries are immutable'
             USING ERRCODE = '55000';
         END IF;

         IF NEW IS NOT DISTINCT FROM OLD THEN
           RETURN NEW;
         END IF;

         IF NEW.next_attempt_at < OLD.next_attempt_at THEN
           RAISE EXCEPTION
             'chat_audit_deliveries next_attempt_at must not move backwards'
             USING ERRCODE = '55000';
         END IF;

         IF NEW.lease_owner IS NOT NULL THEN
           IF OLD.lease_owner IS NULL
              AND OLD.delivered_at IS NULL
              AND OLD.terminal_at IS NULL THEN
             IF NEW.attempt_count <> OLD.attempt_count + 1 THEN
               RAISE EXCEPTION
                 'claiming chat_audit_deliveries increments attempt_count once'
                 USING
                   ERRCODE = '23514',
                   CONSTRAINT = 'chat_audit_deliveries_attempt_transition_check';
             END IF;
           ELSIF OLD.lease_owner IS NOT NULL THEN
             IF OLD.lease_expires_at > clock_timestamp()
                OR NEW.lease_owner IS NOT DISTINCT FROM OLD.lease_owner
                OR NEW.lease_expires_at <= OLD.lease_expires_at
                OR NEW.attempt_count <> OLD.attempt_count + 1 THEN
               RAISE EXCEPTION
                 'only expired chat_audit_deliveries leases may be reclaimed'
                 USING
                   ERRCODE = '23514',
                   CONSTRAINT = 'chat_audit_deliveries_reclaim_check';
             END IF;
           ELSE
             RAISE EXCEPTION
               'invalid chat_audit_deliveries lifecycle transition'
               USING
                 ERRCODE = '23514',
                 CONSTRAINT = 'chat_audit_deliveries_transition_check';
           END IF;
         ELSIF OLD.lease_owner IS NOT NULL THEN
           IF NEW.attempt_count <> OLD.attempt_count THEN
             RAISE EXCEPTION
               'chat_audit_deliveries attempt_count changes only on claim'
               USING
                 ERRCODE = '23514',
                 CONSTRAINT = 'chat_audit_deliveries_attempt_transition_check';
           END IF;
         ELSE
           RAISE EXCEPTION
             'invalid chat_audit_deliveries lifecycle transition'
             USING
               ERRCODE = '23514',
               CONSTRAINT = 'chat_audit_deliveries_transition_check';
         END IF;

         RETURN NEW;
       END;
       $function$`,
    `CREATE TRIGGER chat_audit_deliveries_validate_write
       BEFORE INSERT OR UPDATE ON chat_audit_deliveries
       FOR EACH ROW
       EXECUTE FUNCTION validate_chat_audit_delivery()`,
    `CREATE FUNCTION enqueue_chat_audit_delivery()
       RETURNS trigger
       LANGUAGE plpgsql
       SET search_path FROM CURRENT
       AS $function$
       BEGIN
         INSERT INTO chat_audit_deliveries (tenant_id, audit_event_id)
         VALUES (NEW.tenant_id, NEW.event_id);
         RETURN NEW;
       END;
       $function$`,
    `CREATE TRIGGER chat_audit_events_enqueue_delivery
       AFTER INSERT ON chat_audit_events
       FOR EACH ROW
       EXECUTE FUNCTION enqueue_chat_audit_delivery()`,
    `CREATE INDEX chat_audit_deliveries_global_ready_idx
       ON chat_audit_deliveries (
         next_attempt_at,
         tenant_id,
         audit_event_id
       )
       INCLUDE (attempt_count)
       WHERE lease_owner IS NULL
         AND delivered_at IS NULL
         AND terminal_at IS NULL`,
    `CREATE INDEX chat_audit_deliveries_global_expired_lease_idx
       ON chat_audit_deliveries (
         lease_expires_at,
         tenant_id,
         audit_event_id
       )
       INCLUDE (attempt_count)
       WHERE lease_owner IS NOT NULL
         AND delivered_at IS NULL
         AND terminal_at IS NULL`,
    `COMMENT ON TABLE chat_audit_deliveries IS
       'Content-free delivery mechanics for newly appended audit events. External work is performed only by the audit dispatcher; application rollback leaves this expansion in place.'`,
  ]),
});

/**
 * Adds durable, tenant-scoped deletion work for attachment objects that were
 * already abandoned. Dispatch and enqueue-on-abandon behavior are introduced
 * separately; this expansion only establishes the lifecycle and backfills
 * recoverable work without performing external deletion.
 */
export const chatAttachmentCleanupDeliveriesMigration: PostgresMigration =
  Object.freeze({
    id: "0037-chat-attachment-cleanup-deliveries",
    order: 37,
    statements: Object.freeze([
      `CREATE TABLE chat_attachment_cleanup_deliveries (
         tenant_id text NOT NULL,
         attachment_id text NOT NULL,
         storage_key text NOT NULL,
         state text NOT NULL DEFAULT 'pending',
         attempt_count bigint NOT NULL DEFAULT 0,
         next_attempt_at timestamptz NOT NULL DEFAULT statement_timestamp(),
         lease_owner text,
         lease_expires_at timestamptz,
         last_error_code text,
         created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
         updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
         delivered_at timestamptz,
         CONSTRAINT chat_attachment_cleanup_deliveries_pkey
           PRIMARY KEY (tenant_id, attachment_id),
         CONSTRAINT chat_attachment_cleanup_deliveries_tenant_id_check
           CHECK (
             octet_length(tenant_id) BETWEEN 1 AND 255
             AND tenant_id ~ '[^[:space:]]'
           ),
         CONSTRAINT chat_attachment_cleanup_deliveries_attachment_id_check
           CHECK (
             octet_length(attachment_id) BETWEEN 1 AND 255
             AND attachment_id ~ '[^[:space:]]'
           ),
         CONSTRAINT chat_attachment_cleanup_deliveries_storage_key_check
           CHECK (
             octet_length(storage_key) BETWEEN 1 AND 2048
             AND storage_key ~ '[^[:space:]]'
           ),
         CONSTRAINT chat_attachment_cleanup_deliveries_state_check
           CHECK (state IN ('pending', 'leased', 'failed', 'delivered')),
         CONSTRAINT chat_attachment_cleanup_deliveries_attempt_count_check
           CHECK (attempt_count BETWEEN 0 AND 9007199254740991),
         CONSTRAINT chat_attachment_cleanup_deliveries_lease_owner_check
           CHECK (
             lease_owner IS NULL
             OR (
               octet_length(lease_owner) BETWEEN 1 AND 255
               AND lease_owner = btrim(lease_owner)
               AND lease_owner ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
             )
           ),
         CONSTRAINT chat_attachment_cleanup_deliveries_error_code_check
           CHECK (
             last_error_code IS NULL
             OR (
               octet_length(last_error_code) BETWEEN 1 AND 255
               AND last_error_code = btrim(last_error_code)
               AND last_error_code ~ '^[A-Za-z0-9][A-Za-z0-9._:-]*$'
             )
           ),
         CONSTRAINT chat_attachment_cleanup_deliveries_lifecycle_shape_check
           CHECK (
             (
               state = 'pending'
               AND attempt_count = 0
               AND lease_owner IS NULL
               AND lease_expires_at IS NULL
               AND last_error_code IS NULL
               AND delivered_at IS NULL
             )
             OR (
               state = 'leased'
               AND attempt_count >= 1
               AND lease_owner IS NOT NULL
               AND lease_expires_at IS NOT NULL
               AND last_error_code IS NULL
               AND delivered_at IS NULL
             )
             OR (
               state = 'failed'
               AND attempt_count >= 1
               AND lease_owner IS NULL
               AND lease_expires_at IS NULL
               AND last_error_code IS NOT NULL
               AND delivered_at IS NULL
             )
             OR (
               state = 'delivered'
               AND attempt_count >= 1
               AND lease_owner IS NULL
               AND lease_expires_at IS NULL
               AND last_error_code IS NULL
               AND delivered_at IS NOT NULL
             )
           ),
         CONSTRAINT chat_attachment_cleanup_deliveries_timestamp_check
           CHECK (
             created_at > '-infinity'::timestamptz
             AND created_at < 'infinity'::timestamptz
             AND updated_at >= created_at
             AND updated_at < 'infinity'::timestamptz
             AND next_attempt_at >= created_at
             AND next_attempt_at < 'infinity'::timestamptz
             AND (
               state <> 'failed'
               OR next_attempt_at >= updated_at
             )
             AND (
               lease_expires_at IS NULL
               OR (
                 lease_expires_at > updated_at
                 AND lease_expires_at < 'infinity'::timestamptz
               )
             )
             AND (
               delivered_at IS NULL
               OR (
                 delivered_at = updated_at
                 AND delivered_at < 'infinity'::timestamptz
               )
             )
           ),
         CONSTRAINT chat_attachment_cleanup_deliveries_attachment_fkey
           FOREIGN KEY (tenant_id, attachment_id)
           REFERENCES chat_attachments (tenant_id, id)
       )`,
      `CREATE FUNCTION validate_chat_attachment_cleanup_delivery()
         RETURNS trigger
         LANGUAGE plpgsql
         SET search_path FROM CURRENT
         AS $function$
         BEGIN
           IF TG_OP = 'DELETE' THEN
             IF OLD.state = 'delivered' THEN
               RAISE EXCEPTION
                 'delivered chat_attachment_cleanup_deliveries are immutable'
                 USING ERRCODE = '55000';
             END IF;
             RETURN OLD;
           END IF;

           IF TG_OP = 'INSERT' THEN
             IF NEW.state <> 'pending'
                OR NEW.attempt_count <> 0
                OR NEW.lease_owner IS NOT NULL
                OR NEW.lease_expires_at IS NOT NULL
                OR NEW.last_error_code IS NOT NULL
                OR NEW.delivered_at IS NOT NULL THEN
               RAISE EXCEPTION
                 'chat_attachment_cleanup_deliveries must be created pending and unattempted'
                 USING
                   ERRCODE = '23514',
                   CONSTRAINT = 'chat_attachment_cleanup_deliveries_initial_state_check';
             END IF;

             IF NOT EXISTS (
               SELECT 1
               FROM chat_attachments AS attachment
               WHERE attachment.tenant_id = NEW.tenant_id
                 AND attachment.id = NEW.attachment_id
                 AND attachment.storage_key = NEW.storage_key
                 AND attachment.state = 'abandoned'
             ) THEN
               RAISE EXCEPTION
                 'chat_attachment_cleanup_deliveries must match an abandoned attachment object'
                 USING
                   ERRCODE = '23514',
                   CONSTRAINT = 'chat_attachment_cleanup_deliveries_attachment_match_check';
             END IF;

             RETURN NEW;
           END IF;

           IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
              OR NEW.attachment_id IS DISTINCT FROM OLD.attachment_id
              OR NEW.storage_key IS DISTINCT FROM OLD.storage_key
              OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
             RAISE EXCEPTION
               'chat_attachment_cleanup_deliveries identity, object key, and creation timestamp are immutable'
               USING ERRCODE = '55000';
           END IF;

           IF OLD.state = 'delivered' AND NEW IS DISTINCT FROM OLD THEN
             RAISE EXCEPTION
               'delivered chat_attachment_cleanup_deliveries are immutable'
               USING ERRCODE = '55000';
           END IF;

           IF NEW IS NOT DISTINCT FROM OLD THEN
             RETURN NEW;
           END IF;

           IF NEW.attempt_count < OLD.attempt_count THEN
             RAISE EXCEPTION
               'chat_attachment_cleanup_deliveries attempt_count must not move backwards'
               USING ERRCODE = '55000';
           END IF;

           IF NEW.updated_at < OLD.updated_at
              OR NEW.next_attempt_at < OLD.next_attempt_at THEN
             RAISE EXCEPTION
               'chat_attachment_cleanup_deliveries timestamps must not move backwards'
               USING ERRCODE = '55000';
           END IF;

           IF OLD.state IN ('pending', 'failed') AND NEW.state = 'leased' THEN
             IF OLD.next_attempt_at > clock_timestamp()
                OR NEW.attempt_count <> OLD.attempt_count + 1 THEN
               RAISE EXCEPTION
                 'claiming ready chat_attachment_cleanup_deliveries increments attempt_count once'
                 USING
                   ERRCODE = '23514',
                   CONSTRAINT = 'chat_attachment_cleanup_deliveries_claim_check';
             END IF;
           ELSIF OLD.state = 'leased' AND NEW.state = 'leased' THEN
             IF OLD.lease_expires_at > clock_timestamp()
                OR NEW.lease_owner IS NOT DISTINCT FROM OLD.lease_owner
                OR NEW.lease_expires_at <= OLD.lease_expires_at
                OR NEW.attempt_count <> OLD.attempt_count + 1 THEN
               RAISE EXCEPTION
                 'only expired chat_attachment_cleanup_deliveries leases may be reclaimed'
                 USING
                   ERRCODE = '23514',
                   CONSTRAINT = 'chat_attachment_cleanup_deliveries_reclaim_check';
             END IF;
           ELSIF OLD.state = 'leased' AND NEW.state IN ('failed', 'delivered') THEN
             IF NEW.attempt_count <> OLD.attempt_count THEN
               RAISE EXCEPTION
                 'chat_attachment_cleanup_deliveries attempt_count changes only on claim'
                 USING
                   ERRCODE = '23514',
                   CONSTRAINT = 'chat_attachment_cleanup_deliveries_attempt_transition_check';
             END IF;
           ELSE
             RAISE EXCEPTION
               'invalid chat_attachment_cleanup_deliveries lifecycle transition'
               USING
                 ERRCODE = '23514',
                 CONSTRAINT = 'chat_attachment_cleanup_deliveries_transition_check';
           END IF;

           RETURN NEW;
         END;
         $function$`,
      `CREATE TRIGGER chat_attachment_cleanup_deliveries_validate_write
         BEFORE INSERT OR UPDATE OR DELETE
         ON chat_attachment_cleanup_deliveries
         FOR EACH ROW
         EXECUTE FUNCTION validate_chat_attachment_cleanup_delivery()`,
      `CREATE INDEX chat_attachment_cleanup_deliveries_global_ready_idx
         ON chat_attachment_cleanup_deliveries (
           next_attempt_at,
           tenant_id,
           attachment_id
         )
         INCLUDE (attempt_count, storage_key)
         WHERE state IN ('pending', 'failed')`,
      `CREATE INDEX chat_attachment_cleanup_deliveries_global_expired_lease_idx
         ON chat_attachment_cleanup_deliveries (
           lease_expires_at,
           tenant_id,
           attachment_id
         )
         INCLUDE (attempt_count, storage_key)
         WHERE state = 'leased'`,
      `WITH seed_time AS (
         SELECT statement_timestamp() AS seeded_at
       )
       INSERT INTO chat_attachment_cleanup_deliveries (
         tenant_id,
         attachment_id,
         storage_key,
         state,
         attempt_count,
         next_attempt_at,
         created_at,
         updated_at
       )
       SELECT
         attachment.tenant_id,
         attachment.id,
         attachment.storage_key,
         'pending',
         0,
         seed_time.seeded_at,
         seed_time.seeded_at,
         seed_time.seeded_at
       FROM chat_attachments AS attachment
       CROSS JOIN seed_time
       WHERE attachment.state = 'abandoned'
       ON CONFLICT (tenant_id, attachment_id) DO NOTHING`,
      `COMMENT ON TABLE chat_attachment_cleanup_deliveries IS
         'Durable, payload-free deletion delivery mechanics for abandoned attachment objects. Rows retain only immutable object identity and bounded retry state; external deletion is performed separately.'`,
    ]),
  });

export const chatHuddleRejoinMigration: PostgresMigration = Object.freeze({
  id: "0038-chat-huddle-rejoin",
  order: 38,
  description: "Allow new participant visits in a live huddle while retaining past visits",
  statements: Object.freeze([
    `CREATE TABLE chat_huddle_participant_visits (
      tenant_id text NOT NULL,
      huddle_session_id text NOT NULL,
      user_id text NOT NULL,
      joined_at timestamptz NOT NULL,
      left_at timestamptz NOT NULL,
      leave_reason text NOT NULL,
      PRIMARY KEY (tenant_id, huddle_session_id, user_id, joined_at),
      FOREIGN KEY (tenant_id, huddle_session_id) REFERENCES chat_huddle_sessions (tenant_id, id),
      CHECK (left_at >= joined_at)
    )`,
    `CREATE OR REPLACE FUNCTION validate_chat_huddle_participant()
       RETURNS trigger
       LANGUAGE plpgsql
       SET search_path FROM CURRENT
       AS $function$
       DECLARE
         session_started_at timestamptz;
         session_status text;
         screen_share_owner_user_id text;
       BEGIN
         IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
           RAISE EXCEPTION 'chat_huddle_participants are retained as history'
             USING ERRCODE = '55000';
         END IF;

         IF TG_OP = 'INSERT' AND NEW.left_at IS NOT NULL THEN
           RAISE EXCEPTION 'chat_huddle_participants must be created joined'
             USING
               ERRCODE = '23514',
               CONSTRAINT = 'chat_huddle_participants_initial_state_check';
         END IF;

         IF TG_OP = 'UPDATE' THEN
           IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
              OR NEW.huddle_session_id IS DISTINCT FROM OLD.huddle_session_id
              OR NEW.user_id IS DISTINCT FROM OLD.user_id
              THEN
             RAISE EXCEPTION
               'chat_huddle_participants identity and join time are immutable'
               USING ERRCODE = '55000';
           END IF;

           IF OLD.left_at IS NOT NULL AND NEW.left_at IS NULL
              AND NEW.joined_at >= OLD.left_at AND NEW.leave_reason IS NULL THEN
             INSERT INTO chat_huddle_participant_visits
               (tenant_id, huddle_session_id, user_id, joined_at, left_at, leave_reason)
             VALUES (OLD.tenant_id, OLD.huddle_session_id, OLD.user_id,
                     OLD.joined_at, OLD.left_at, OLD.leave_reason);
           ELSIF NEW.joined_at IS DISTINCT FROM OLD.joined_at
              OR (OLD.left_at IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
             RAISE EXCEPTION 'participant visit is immutable except for a new join'
               USING ERRCODE = '55000';
           END IF;
         END IF;

         SELECT session.started_at,
                session.status,
                session.active_screen_share_owner_user_id
         INTO session_started_at, session_status, screen_share_owner_user_id
         FROM chat_huddle_sessions AS session
         WHERE session.tenant_id = NEW.tenant_id
           AND session.id = NEW.huddle_session_id
         FOR NO KEY UPDATE;

         IF FOUND AND session_status = 'ended' THEN
           RAISE EXCEPTION 'ended chat_huddle_sessions cannot change participants'
             USING
               ERRCODE = '23514',
               CONSTRAINT = 'chat_huddle_participants_live_session_check';
         END IF;

         IF FOUND AND NEW.joined_at < session_started_at THEN
           RAISE EXCEPTION 'a huddle participant cannot join before the session starts'
             USING
               ERRCODE = '23514',
               CONSTRAINT = 'chat_huddle_participants_session_timestamp_check';
         END IF;

         IF TG_OP = 'UPDATE'
            AND OLD.left_at IS NULL
            AND NEW.left_at IS NOT NULL
            AND screen_share_owner_user_id = NEW.user_id THEN
           RAISE EXCEPTION 'screen-share owner must be cleared before leaving'
             USING
               ERRCODE = '23514',
               CONSTRAINT = 'chat_huddle_participants_active_screen_share_owner_check';
         END IF;

         RETURN NEW;
       END;
       $function$`,
  ]),
});

/**
 * Stores inline replies within their source's tenant and conversation. Reply
 * metadata lives outside editable content; soft deletion retains the source
 * shell and references, and hard deletion never cascades to replying messages.
 */
export const chatMessageRepliesMigration: PostgresMigration = Object.freeze({
  id: "0039-chat-message-replies",
  order: 39,
  statements: Object.freeze([
    `ALTER TABLE chat_messages
       ADD COLUMN reply_to_message_id text,
       ADD COLUMN reply_notify_author boolean NOT NULL DEFAULT false,
       ADD CONSTRAINT chat_messages_reply_source_fkey
         FOREIGN KEY (tenant_id, conversation_id, reply_to_message_id)
         REFERENCES chat_messages (tenant_id, conversation_id, id)
         ON DELETE NO ACTION,
       ADD CONSTRAINT chat_messages_reply_not_self_check
         CHECK (reply_to_message_id IS NULL OR reply_to_message_id <> id),
       ADD CONSTRAINT chat_messages_reply_notify_author_check
         CHECK (NOT reply_notify_author OR reply_to_message_id IS NOT NULL)`,
    `CREATE INDEX chat_messages_reply_source_idx
       ON chat_messages (tenant_id, conversation_id, reply_to_message_id)
       WHERE reply_to_message_id IS NOT NULL`,
  ]),
});

/**
 * Permits optional thread names without rewriting legacy streams or history.
 * PostgreSQL UTF-8 char_length counts Unicode scalar values, not UTF-16 units.
 * The explicit trim set matches contracts/models/conversation.json; comparing
 * with the trimmed value rejects boundary whitespace without normalizing input.
 */
export const chatThreadNamesMigration: PostgresMigration = Object.freeze({
  id: "0040-chat-thread-names",
  order: 40,
  statements: Object.freeze([
    `ALTER TABLE chat_conversations
       DROP CONSTRAINT chat_conversations_channel_shape_check,
       ADD CONSTRAINT chat_conversations_channel_shape_check
         CHECK (
           (type = 'channel' AND name IS NOT NULL)
           OR (
             type <> 'channel'
             AND (type = 'thread' OR name IS NULL)
             AND entity_type IS NULL
             AND entity_id IS NULL
           )
         ),
       ADD CONSTRAINT chat_conversations_thread_name_check
         CHECK (
           type <> 'thread'
           OR name IS NULL
           OR (
             char_length(name) BETWEEN 1 AND 100
             AND name = btrim(name, U&'\\0009\\000A\\000B\\000C\\000D\\0020\\0085\\00A0\\1680\\2000\\2001\\2002\\2003\\2004\\2005\\2006\\2007\\2008\\2009\\200A\\2028\\2029\\202F\\205F\\3000\\FEFF')
           )
         )`,
  ]),
});

/**
 * Stores one explicit reply-style choice per trusted host tenant and user.
 * Absence remains no row; revision zero is reserved for the absent wire state.
 * Host identities do not require a local user directory or conversation membership.
 */
export const chatUserReplyStylePreferencesMigration: PostgresMigration =
  Object.freeze({
    id: "0041-chat-user-reply-style-preferences",
    order: 41,
    statements: Object.freeze([
      `CREATE TABLE chat_user_reply_style_preferences (
         tenant_id text NOT NULL,
         user_id text NOT NULL,
         style text NOT NULL,
         revision bigint NOT NULL,
         updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
         CONSTRAINT chat_user_reply_style_preferences_pkey
           PRIMARY KEY (tenant_id, user_id),
         CONSTRAINT chat_user_reply_style_preferences_tenant_id_check
           CHECK (
             octet_length(tenant_id) BETWEEN 1 AND 255
             AND tenant_id ~ '[^[:space:]]'
           ),
         CONSTRAINT chat_user_reply_style_preferences_user_id_check
           CHECK (
             octet_length(user_id) BETWEEN 1 AND 255
             AND user_id ~ '[^[:space:]]'
           ),
         CONSTRAINT chat_user_reply_style_preferences_style_check
           CHECK (style IN ('current', 'discord')),
         CONSTRAINT chat_user_reply_style_preferences_revision_check
           CHECK (revision BETWEEN 1 AND 9007199254740991),
         CONSTRAINT chat_user_reply_style_preferences_updated_at_check
           CHECK (
             updated_at > '-infinity'::timestamptz
             AND updated_at < 'infinity'::timestamptz
           )
       )`,
    ]),
  });

/** Adds optional canonical reply metadata while retaining every legacy content rule. */
export const chatDraftRepliesMigration: PostgresMigration = Object.freeze({
  id: "0042-chat-draft-replies",
  order: 42,
  statements: Object.freeze([
    `CREATE OR REPLACE FUNCTION is_valid_chat_draft_content(p_content jsonb)
       RETURNS boolean
       LANGUAGE plpgsql
       IMMUTABLE
       PARALLEL SAFE
       STRICT
       AS $function$
       DECLARE
         item jsonb;
         reply_id text;
         codepoint integer;
       BEGIN
         IF jsonb_typeof(p_content) IS DISTINCT FROM 'object'
            OR jsonb_typeof(p_content -> 'format') IS DISTINCT FROM 'string'
            OR (p_content ->> 'format' IN ('plain', 'markdown')) IS NOT TRUE
            OR jsonb_typeof(p_content -> 'text') IS DISTINCT FROM 'string' THEN
           RETURN false;
         END IF;

         IF p_content ? 'mentions' THEN
           IF jsonb_typeof(p_content -> 'mentions') IS DISTINCT FROM 'array' THEN
             RETURN false;
           END IF;

           FOR item IN
             SELECT value FROM jsonb_array_elements(p_content -> 'mentions')
           LOOP
             IF jsonb_typeof(item) IS DISTINCT FROM 'object'
                OR jsonb_typeof(item -> 'type') IS DISTINCT FROM 'string' THEN
               RETURN false;
             END IF;

             IF item ->> 'type' = 'user' THEN
               IF jsonb_typeof(item -> 'userId') IS DISTINCT FROM 'string' THEN
                 RETURN false;
               END IF;
             ELSIF item ->> 'type' = 'conversation' THEN
               IF jsonb_typeof(item -> 'conversationId') IS DISTINCT FROM 'string' THEN
                 RETURN false;
               END IF;
             ELSIF item ->> 'type' = 'entity' THEN
               IF jsonb_typeof(item -> 'entity') IS DISTINCT FROM 'object'
                  OR jsonb_typeof(item -> 'entity' -> 'type') IS DISTINCT FROM 'string'
                  OR jsonb_typeof(item -> 'entity' -> 'id') IS DISTINCT FROM 'string' THEN
                 RETURN false;
               END IF;
             ELSE
               RETURN false;
             END IF;
           END LOOP;
         END IF;

         IF p_content ? 'attachments' THEN
           IF jsonb_typeof(p_content -> 'attachments') IS DISTINCT FROM 'array' THEN
             RETURN false;
           END IF;

           FOR item IN
             SELECT value FROM jsonb_array_elements(p_content -> 'attachments')
           LOOP
             IF jsonb_typeof(item) IS DISTINCT FROM 'object'
                OR jsonb_typeof(item -> 'attachmentId') IS DISTINCT FROM 'string' THEN
               RETURN false;
             END IF;
           END LOOP;
         END IF;

         IF p_content ? 'blocks' THEN
           IF jsonb_typeof(p_content -> 'blocks') IS DISTINCT FROM 'array' THEN
             RETURN false;
           END IF;

           FOR item IN
             SELECT value FROM jsonb_array_elements(p_content -> 'blocks')
           LOOP
             IF jsonb_typeof(item) IS DISTINCT FROM 'object'
                OR jsonb_typeof(item -> 'type') IS DISTINCT FROM 'string'
                OR NOT (item ? 'data') THEN
               RETURN false;
             END IF;
           END LOOP;
         END IF;


         IF p_content ? 'replyTo' THEN
           item := p_content -> 'replyTo';
           IF jsonb_typeof(item) IS DISTINCT FROM 'object' THEN
             RETURN false;
           END IF;
           IF jsonb_typeof(item -> 'messageId') IS DISTINCT FROM 'string'
              OR jsonb_typeof(item -> 'notifyAuthor') IS DISTINCT FROM 'boolean'
              OR (item - 'messageId' - 'notifyAuthor') <> '{}'::jsonb THEN
             RETURN false;
           END IF;
           reply_id := item ->> 'messageId';
           -- Match ECMAScript trim, NFC and the canonical 255 UTF-8 byte limit.
           -- PostgreSQL jsonb rejects NUL and unpaired Unicode surrogates itself.
           IF octet_length(reply_id) NOT BETWEEN 1 AND 255
              OR reply_id <> btrim(reply_id, U&'\\0009\\000A\\000B\\000C\\000D\\0020\\00A0\\1680\\2000\\2001\\2002\\2003\\2004\\2005\\2006\\2007\\2008\\2009\\200A\\2028\\2029\\202F\\205F\\3000\\FEFF')
              OR reply_id IS NOT NFC NORMALIZED THEN
             RETURN false;
           END IF;
           FOR codepoint IN
             SELECT ascii(substr(reply_id, position, 1))
             FROM generate_series(1, char_length(reply_id)) AS position
           LOOP
             IF codepoint BETWEEN 0 AND 31 OR codepoint BETWEEN 127 AND 159
                OR codepoint IN (8232, 8233) THEN
               RETURN false;
             END IF;
           END LOOP;
         END IF;

         RETURN true;
       END;
       $function$`,
  ]),
});

/**
 * Stores shared thread closure/lock state independently of administrative archive.
 * Reuses migration 0015's bounded lifecycle_revision for every conversation type;
 * legacy rows and inserts remain open/unlocked without resetting their revisions.
 * Hiding is computed discovery policy and has no stored lifecycle flag.
 */
export const chatThreadLifecycleMigration: PostgresMigration = Object.freeze({
  id: "0043-chat-thread-lifecycle",
  order: 43,
  statements: Object.freeze([
    `ALTER TABLE chat_conversations
       ADD COLUMN closed_at timestamptz,
       ADD COLUMN closed_by_user_id text,
       ADD COLUMN locked boolean NOT NULL DEFAULT false,
       ADD CONSTRAINT chat_conversations_thread_lifecycle_check
         CHECK (
           type = 'thread'
           OR (closed_at IS NULL AND closed_by_user_id IS NULL AND NOT locked)
         ),
       ADD CONSTRAINT chat_conversations_closure_pair_check
         CHECK ((closed_at IS NULL) = (closed_by_user_id IS NULL)),
       ADD CONSTRAINT chat_conversations_closed_at_check
         CHECK (
           closed_at IS NULL
           OR (closed_at > '-infinity'::timestamptz AND closed_at < 'infinity'::timestamptz)
         ),
       ADD CONSTRAINT chat_conversations_locked_closed_check
         CHECK (NOT locked OR closed_at IS NOT NULL)`,
  ]),
});

/** Built-in migrations for the single-version `@handrail/chat` product. */
export const handrailChatPostgresMigrations: readonly PostgresMigration[] =
  Object.freeze([
    chatConversationsMembershipMigration,
    chatMessagesRevisionMigration,
    chatReactionsMigration,
    chatReadCursorsMigration,
    chatOutboxEventsMigration,
    chatIdempotencyKeysMigration,
    chatDraftsMigration,
    chatConversationPreferencesMigration,
    chatThreadFollowsMigration,
    chatAttachmentsMigration,
    chatAuditEventsMigration,
    chatSavedMessagesMigration,
    chatHuddleSessionsMigration,
    chatNotificationDeliveriesMigration,
    chatConversationLifecycleRevisionMigration,
    chatThreadFollowRevisionMigration,
    chatConversationMemberListRevisionMigration,
    chatConversationPreferenceRevisionMigration,
    chatSavedMessageMutationStateMigration,
    chatHuddleParticipantLeaveReasonMigration,
    chatHuddleEndingRecoveryMigration,
    chatDevicePushTokensMigration,
    chatConversationListOrderingMigration,
    chatOutboxUnpublishedStreamHeadsMigration,
    chatOutboxTenantReplayPositionsMigration,
    chatNotificationGlobalClaimIndexesMigration,
    chatNotificationMaterializerOffsetsMigration,
    chatOutboxExpiryCleanupMigration,
    chatMessageSearchVectorMigration,
    chatMessageRemindersMigration,
    chatMessageReminderNotificationsMigration,
    chatConversationPreferenceStarredMigration,
    chatDevicePushTokenProtectionMetadataMigration,
    chatDevicePushTokenFreeRevocationMigration,
    chatDevicePushTokenLegacyRetirementMigration,
    chatAuditDeliveriesMigration,
    chatAttachmentCleanupDeliveriesMigration,
    chatHuddleRejoinMigration,
    chatMessageRepliesMigration,
    chatThreadNamesMigration,
    chatUserReplyStylePreferencesMigration,
    chatDraftRepliesMigration,
    chatThreadLifecycleMigration,
  ]);
