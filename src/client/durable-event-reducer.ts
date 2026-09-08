import {
  parseConversationMembershipMutationInput,
  parseConversationMembershipMutationResult,
} from "../contracts/conversation-membership.js";
import {
  parseSynchronizeDraftInput,
  parseSynchronizeDraftResult,
} from "../contracts/draft-mutation.js";
import {
  CHAT_DURABLE_EVENT_TYPES,
  DurableEventParseError,
  parseKnownDurableEvent,
  type ChatDurableEventType,
} from "../contracts/generated/durable-events.js";
import { parseHuddleSessionState } from "../contracts/huddle-session.js";
import type {
  ConversationId,
  IsoTimestamp,
  MessageId,
  UserId,
} from "../contracts/identifiers.js";
import {
  parseEditMessageResult,
  parseSendMessageResult,
  parseSoftDeleteMessageResult,
} from "../contracts/message-mutations.js";
import type { Message, ThreadSummary } from "../contracts/message.js";
import { validateThreadConversationName, validateThreadLifecycle, type Conversation } from "../contracts/conversation.js";
import {
  parseUpdateConversationPreferenceInput,
  parseUpdateConversationPreferenceResult,
  type UpdateConversationPreferenceInput,
  type UpdateConversationPreferenceResult,
} from "../contracts/conversation-preference-mutation.js";
import type { ConversationMemberPreference } from "../contracts/member-read-state.js";
import { parseReactionMutationResult } from "../contracts/reaction-mutations.js";
import { parseReadCursorUpdatedEvent } from "../contracts/read-cursor-mutation.js";
import {
  parseSetThreadFollowInput,
  parseSetThreadFollowResult,
  type CanonicalThreadFollowState,
  type SetThreadFollowInput,
  type SetThreadFollowResult,
} from "../contracts/thread-follow-mutation.js";
import {
  CHAT_PROTOCOL_VERSION,
  type ChatEvent,
} from "../contracts/realtime.js";
import type {
  MessageAttachmentMetadata,
  MessageReactionAggregate,
  MessageTimelineMessage,
} from "../contracts/message-timeline.js";
import type {
  ChatCacheEntities,
  DurableStreamCacheMetadata,
  NormalizedChatCacheState,
} from "./normalized-cache.js";
import {
  markConversationSavedMessagesUnavailable,
  markSavedMessageUnavailable,
  reconcileSavedMessageEvent,
} from "./saved-message-state.js";
import { reconcileMessageReminderEvent } from "./message-reminder-state.js";

const RECENT_EVENT_LIMIT = 64;

export { CHAT_DURABLE_EVENT_TYPES };
export type { ChatDurableEventType };

export type DurableEventRecoveryReason =
  | "event_gap"
  | "event_incompatible"
  | "event_invalid";

export type DurableEventDiagnosticCode =
  | "identity_required"
  | "tenant_mismatch"
  | "private_stream_mismatch"
  | "protocol_mismatch"
  | "unknown_event_type"
  | "ordering_gap"
  | "incoherent_payload";

export interface DurableEventDiagnostic {
  readonly code: DurableEventDiagnosticCode;
  readonly reason: DurableEventRecoveryReason;
  readonly eventId: string;
  readonly streamId: string;
  readonly eventType: string;
  /** Stable and safe to serialize; payloads and thrown values are never included. */
  readonly message: string;
}

export class DurableEventReductionError extends Error {
  readonly diagnostic: DurableEventDiagnostic;

  constructor(diagnostic: DurableEventDiagnostic) {
    super(diagnostic.message);
    this.name = "DurableEventReductionError";
    this.diagnostic = diagnostic;
  }
}

export type DurableEventReductionStatus = "applied" | "duplicate" | "stale";

export interface DurableEventReduction {
  readonly status: DurableEventReductionStatus;
  readonly state: NormalizedChatCacheState;
}

/**
 * Atomically validates and reduces one durable event. Any thrown error leaves
 * the caller-owned state and cursor untouched.
 */
export function reduceDurableChatEvent(
  state: NormalizedChatCacheState,
  event: ChatEvent,
): DurableEventReduction {
  const identity = state.identity;
  if (identity === null) fail(event, "identity_required", "event_invalid", "The cache has no trusted session identity.");
  if (event.tenantId !== identity.tenantId) fail(event, "tenant_mismatch", "event_invalid", "The event tenant does not match the trusted cache tenant.");
  if (event.protocolVersion !== CHAT_PROTOCOL_VERSION) fail(event, "protocol_mismatch", "event_incompatible", "The durable event protocol is incompatible with this client.");

  const stream = state.metadata.durableStreams[event.streamId];
  if (stream?.recentEventIds.includes(event.eventId) === true) {
    return Object.freeze({ status: "duplicate", state });
  }
  // Read cursors, preferences, drafts, thread follows, saved messages, and reminders
  // share a private user stream across independently clocked resources. After validation,
  // resource revisions (per-message for saved messages and reminders) govern canonical freshness;
  // read state is ordered per conversation by lastReadSequence, then readState.updatedAt.
  // Replay arrival advances the transport cursor; envelope occurredAt retains only
  // a stream timestamp high-water value for these families.
  // Membership freshness belongs to per-conversation memberListRevision after payload
  // and conversation/affected-user private stream validation. On either delivery stream,
  // replay arrival advances the transport cursor; occurredAt is only a timestamp high-water.
  // Message creation order is governed by canonical conversation sequence after validation.
  // Replay arrival advances the transport cursor; envelope occurredAt is retained
  // as a stream timestamp high-water value even when message clocks tie or regress.
  // Per-message revision governs edit freshness after validation; envelope wall time
  // does not order independently updated messages in the conversation stream.
  // Deletions likewise use consecutive per-message revisions after payload and identity
  // validation, even when envelope clocks tie or regress; occurredAt remains a high-water value.
  // Archive/restore transitions use canonical lifecycle revisions after payload, stream
  // identity, intent/state and consecutive-revision validation. Arrival advances the cursor;
  // envelope time is only a high-water value. Legacy full-conversation snapshots retain
  // timestamp admission and must not be classified as revision-bearing transitions.
  if (
    stream !== undefined &&
    !((event.type === CHAT_DURABLE_EVENT_TYPES.conversationArchived ||
       event.type === CHAT_DURABLE_EVENT_TYPES.conversationRestored) &&
      (event.payload as Record<string, unknown> | null)?.conversation === undefined) &&
    event.type !== CHAT_DURABLE_EVENT_TYPES.replyStyleUpdated &&
    event.type !== CHAT_DURABLE_EVENT_TYPES.threadLifecycleUpdated &&
    event.type !== CHAT_DURABLE_EVENT_TYPES.threadLifecycleChanged &&
    event.type !== CHAT_DURABLE_EVENT_TYPES.messageCreated &&
    event.type !== CHAT_DURABLE_EVENT_TYPES.messageUpdated &&
    event.type !== CHAT_DURABLE_EVENT_TYPES.messageDeleted &&
    event.type !== CHAT_DURABLE_EVENT_TYPES.threadSummaryUpdated &&
    event.type !== CHAT_DURABLE_EVENT_TYPES.membershipUpdated &&
    event.type !== CHAT_DURABLE_EVENT_TYPES.readCursorUpdated &&
    event.type !== CHAT_DURABLE_EVENT_TYPES.preferenceUpdated &&
    event.type !== CHAT_DURABLE_EVENT_TYPES.draftUpdated &&
    event.type !== CHAT_DURABLE_EVENT_TYPES.threadFollowUpdated &&
    event.type !== CHAT_DURABLE_EVENT_TYPES.savedMessageUpdated &&
    event.type !== CHAT_DURABLE_EVENT_TYPES.messageReminderUpdated
  ) {
    const order = timestamp(event.occurredAt) - timestamp(stream.lastOccurredAt);
    if (order < 0) return Object.freeze({ status: "stale", state });
    if (order === 0 && event.eventId !== stream.lastEventId) {
      fail(event, "ordering_gap", "event_gap", "Two distinct durable events have an ambiguous stream order.");
    }
  }

  let next: NormalizedChatCacheState;
  try {
    next = reduceKnownEvent(state, event, identity.userId);
  } catch (error) {
    if (error instanceof DurableEventReductionError) throw error;
    fail(event, "incoherent_payload", "event_invalid", "The durable event payload is malformed or incoherent with known state.");
  }

  const recentEventIds = Object.freeze(
    [...(stream?.recentEventIds ?? []), event.eventId].slice(-RECENT_EVENT_LIMIT),
  );
  const durableStream: DurableStreamCacheMetadata = Object.freeze({
    lastEventId: event.eventId,
    lastOccurredAt: stream !== undefined && timestamp(stream.lastOccurredAt) > timestamp(event.occurredAt)
      ? stream.lastOccurredAt
      : event.occurredAt,
    recentEventIds,
  });
  next = freezeState({
    ...next,
    metadata: Object.freeze({
      ...next.metadata,
      realtimeCursor: Object.freeze({ eventId: event.eventId }),
      durableStreams: freezeRecord({
        ...next.metadata.durableStreams,
        [event.streamId]: durableStream,
      }),
    }),
  });
  return Object.freeze({ status: "applied", state: next });
}

function reduceKnownEvent(
  state: NormalizedChatCacheState,
  event: ChatEvent,
  currentUserId: UserId,
): NormalizedChatCacheState {
  switch (event.type) {
    case CHAT_DURABLE_EVENT_TYPES.replyStyleUpdated: {
      try { parseKnownDurableEvent(event, state.identity!); }
      catch (error) {
        if (error instanceof DurableEventParseError && error.code === "private_stream_mismatch") privateMismatch(event);
        throw error;
      }
      // The focused runtime owns saved preference revisions and mutation correlation.
      return state;
    }
    case CHAT_DURABLE_EVENT_TYPES.threadLifecycleUpdated:
    case CHAT_DURABLE_EVENT_TYPES.threadLifecycleChanged: {
      const parsed = parseKnownDurableEvent(event, state.identity!);
      if (parsed.type !== "thread.lifecycle.updated" && parsed.type !== "thread.lifecycle.changed") return state;
      const thread = state.entities.conversations[parsed.payload.threadId];
      if (thread !== undefined && (thread.type !== "thread" || thread.parentConversationId !== parsed.payload.parentConversationId)) {
        fail(event, "incoherent_payload", "event_invalid", "The lifecycle parent scope does not match the known thread.");
      }
      // The focused lifecycle runtime owns revision reconciliation and authorized
      // hydration. Parent events contain only an invalidation revision.
      return state;
    }
    case CHAT_DURABLE_EVENT_TYPES.conversationCreated:
    case CHAT_DURABLE_EVENT_TYPES.threadCreated:
      return reduceConversation(state, event);
    case CHAT_DURABLE_EVENT_TYPES.conversationArchived:
    case CHAT_DURABLE_EVENT_TYPES.conversationRestored:
      return reduceConversationLifecycle(state, event);
    case CHAT_DURABLE_EVENT_TYPES.membershipUpdated:
      return reduceMembership(state, event, currentUserId);
    case CHAT_DURABLE_EVENT_TYPES.messageCreated:
      return reduceMessageCreated(state, event);
    case CHAT_DURABLE_EVENT_TYPES.messageUpdated:
      return reduceMessageRevision(state, event, false);
    case CHAT_DURABLE_EVENT_TYPES.messageDeleted:
      return reduceMessageRevision(state, event, true);
    case CHAT_DURABLE_EVENT_TYPES.threadSummaryUpdated:
      return reduceThreadSummary(state, event);
    case CHAT_DURABLE_EVENT_TYPES.reactionUpdated:
      return reduceReaction(state, event);
    case CHAT_DURABLE_EVENT_TYPES.readCursorUpdated:
      return reduceReadCursor(state, event, currentUserId);
    case CHAT_DURABLE_EVENT_TYPES.preferenceUpdated:
      return reducePreference(state, event, currentUserId);
    case CHAT_DURABLE_EVENT_TYPES.threadFollowUpdated:
      return reduceThreadFollow(state, event, currentUserId);
    case CHAT_DURABLE_EVENT_TYPES.savedMessageUpdated:
      return reduceSavedMessage(state, event, currentUserId);
    case CHAT_DURABLE_EVENT_TYPES.messageReminderUpdated:
      return reduceMessageReminder(state, event, currentUserId);
    case CHAT_DURABLE_EVENT_TYPES.draftUpdated:
      return reduceDraft(state, event, currentUserId);
    case CHAT_DURABLE_EVENT_TYPES.attachmentUpdated:
      return reduceAttachment(state, event);
    case CHAT_DURABLE_EVENT_TYPES.huddleUpdated:
      return reduceHuddle(state, event);
    default:
      fail(event, "unknown_event_type", "event_incompatible", "The durable event type is not supported by this client.");
  }
}

function reduceConversation(
  state: NormalizedChatCacheState,
  event: ChatEvent,
): NormalizedChatCacheState {
  const payload = record(event.payload);
  let conversation = parseConversation(payload.conversation, event.tenantId);
  if (event.streamId !== conversation.id) invalid(event);
  if (event.type === CHAT_DURABLE_EVENT_TYPES.threadCreated && conversation.type !== "thread") invalid(event);
  const existing = state.entities.conversations[conversation.id];
  if (existing !== undefined && timestamp(conversation.updatedAt) < timestamp(existing.updatedAt)) return state;
  if (conversation.type === "thread" && existing?.type === "thread") {
    // Creation replay may predate lifecycle support or a newer detail read.
    // Missing metadata does not revoke the canonical thread's name or state.
    const lifecycle = existing.threadLifecycle !== undefined &&
      (conversation.threadLifecycle === undefined || existing.threadLifecycle.revision >= conversation.threadLifecycle.revision)
      ? existing.threadLifecycle : conversation.threadLifecycle;
    const name = conversation.name ?? existing.name;
    conversation = Object.freeze({ ...conversation,
      ...(name === undefined ? {} : { name }),
      ...(lifecycle === undefined ? {} : { threadLifecycle: lifecycle }),
    });
  }
  const memberUserIds = parseStringArray(payload.memberUserIds ?? record(payload.conversation).memberUserIds);
  const next = freezeState({
    ...state,
    entities: Object.freeze({
      ...state.entities,
      conversations: freezeRecord({ ...state.entities.conversations, [conversation.id]: conversation }),
      ...(memberUserIds === undefined ? {} : {
        memberUserIdsByConversation: freezeRecord({
          ...state.entities.memberUserIdsByConversation,
          [conversation.id]: memberUserIds,
        }),
      }),
    }),
  });
  const clientRequestId = payload.clientRequestId;
  return typeof clientRequestId === "string"
    ? settlePending(next, (pending) =>
        pending.family === "creation" &&
        pending.clientRequestId === clientRequestId)
    : next;
}

function reduceConversationLifecycle(
  state: NormalizedChatCacheState,
  event: ChatEvent,
): NormalizedChatCacheState {
  const payload = record(event.payload);
  if (payload.conversation !== undefined) {
    const reduced = reduceConversation(state, event);
    return settlePending(reduced, (pending) =>
      pending.family === "archive" && pending.conversationId === event.streamId);
  }
  const conversationId = string(payload.conversationId) as ConversationId;
  if (conversationId !== event.streamId) invalid(event);
  const existing = state.entities.conversations[conversationId];
  if (existing === undefined) gap(event);
  const intent = payload.intent;
  const expectedIntent =
    event.type === CHAT_DURABLE_EVENT_TYPES.conversationArchived
      ? "archive"
      : "restore";
  if (
    intent !== expectedIntent ||
    payload.previousState !== (expectedIntent === "archive" ? "active" : "archived") ||
    payload.currentState !== (expectedIntent === "archive" ? "archived" : "active")
  ) invalid(event);
  const previousRevision = positiveInteger(payload.previousLifecycleRevision);
  const currentRevision = positiveInteger(payload.currentLifecycleRevision);
  if (currentRevision !== previousRevision + 1) invalid(event);
  const knownRevision = state.metadata.lifecycleRevisions[conversationId];
  if (knownRevision !== undefined && currentRevision < knownRevision) return state;
  // The transition event intentionally omits trusted archivedBy identity and a
  // full snapshot. Record only its canonical revision; the client runtime
  // follows it with a focused detail refresh instead of fabricating fields.
  const next = freezeState({
    ...state,
    metadata: Object.freeze({
      ...state.metadata,
      lifecycleRevisions: freezeRecord({
        ...state.metadata.lifecycleRevisions,
        [conversationId]: currentRevision,
      }),
    }),
  });
  return settlePending(next, (pending) =>
    pending.family === "archive" &&
    pending.conversationId === conversationId);
}

function reduceMembership(
  state: NormalizedChatCacheState,
  event: ChatEvent,
  currentUserId: UserId,
): NormalizedChatCacheState {
  const payload = record(event.payload);
  const input = parseConversationMembershipMutationInput(payload.input);
  const result = parseConversationMembershipMutationResult(payload.result, input);
  const onConversationStream = event.streamId === result.conversationId;
  const onAffectedPrivateStream =
    event.streamId === `user:${currentUserId}` &&
    result.memberUserId === currentUserId;
  if (
    (!onConversationStream && !onAffectedPrivateStream) ||
    state.entities.conversations[result.conversationId] === undefined
  ) invalid(event);
  const knownRevision =
    state.metadata.memberListRevisions[result.conversationId];
  if (
    knownRevision !== undefined &&
    result.memberListRevision < knownRevision
  ) {
    return settlePending(state, (pending) =>
      pending.family === "membership" &&
      pending.idempotencyKey === input.idempotencyKey);
  }
  const members = Object.fromEntries(result.members.map((member) => [
    member.userId,
    Object.freeze({ ...member, tenantId: event.tenantId, conversationId: result.conversationId }),
  ]));
  const activeIds = Object.freeze(result.members.filter((member) => member.state === "active").map((member) => member.userId));
  const current = members[currentUserId];
  const memberships = { ...state.currentUser.memberships };
  if (current === undefined) delete memberships[result.conversationId];
  else memberships[result.conversationId] = current;
  let next = freezeState({
    ...state,
    entities: Object.freeze({
      ...state.entities,
      memberUserIdsByConversation: freezeRecord({ ...state.entities.memberUserIdsByConversation, [result.conversationId]: activeIds }),
      membersByConversation: freezeRecord({ ...state.entities.membersByConversation, [result.conversationId]: freezeRecord(members) }),
    }),
    currentUser: Object.freeze({ ...state.currentUser, memberships: freezeRecord(memberships) }),
    metadata: Object.freeze({
      ...state.metadata,
      memberListRevisions: freezeRecord({
        ...state.metadata.memberListRevisions,
        [result.conversationId]: result.memberListRevision,
      }),
    }),
  });
  if (
    onAffectedPrivateStream &&
    current?.state !== "active" &&
    state.entities.conversations[result.conversationId]?.visibility === "private"
  ) {
    next = removeInaccessibleConversationContent(next, result.conversationId);
  }
  return settlePending(next, (pending) =>
    pending.family === "membership" &&
    pending.idempotencyKey === input.idempotencyKey);
}

function removeInaccessibleConversationContent(
  state: NormalizedChatCacheState,
  conversationId: ConversationId,
): NormalizedChatCacheState {
  let next = markConversationSavedMessagesUnavailable(state, conversationId);
  const messages = { ...next.entities.messages };
  const attachments = { ...next.entities.attachments };
  let changed = false;
  for (const message of Object.values(next.entities.messages)) {
    if (message.conversationId !== conversationId) continue;
    changed = true;
    delete messages[message.id];
    for (const attachment of message.attachmentMetadata) {
      delete attachments[attachment.attachmentId];
    }
  }
  if (!changed && next.timelines[conversationId] === undefined) return next;
  const timelines = { ...next.timelines };
  delete timelines[conversationId];
  next = freezeState({
    ...next,
    entities: Object.freeze({
      ...next.entities,
      messages: freezeRecord(messages),
      attachments: freezeRecord(attachments),
    }),
    timelines: freezeRecord(timelines),
  });
  return next;
}

function settlePending(
  state: NormalizedChatCacheState,
  matches: (
    pending: NormalizedChatCacheState["metadata"]["pendingConversationOperations"][string],
  ) => boolean,
): NormalizedChatCacheState {
  const pending = Object.entries(
    state.metadata.pendingConversationOperations,
  ).find(([, operation]) => matches(operation));
  if (pending === undefined) return state;
  const pendingConversationOperations = {
    ...state.metadata.pendingConversationOperations,
  };
  delete pendingConversationOperations[pending[0]];
  return freezeState({
    ...state,
    metadata: Object.freeze({
      ...state.metadata,
      pendingConversationOperations: freezeRecord(pendingConversationOperations),
    }),
  });
}

function reduceMessageCreated(
  state: NormalizedChatCacheState,
  event: ChatEvent,
): NormalizedChatCacheState {
  const payload = record(event.payload);
  const raw = record(payload.message);
  const result = parseSendMessageResult({
    operation: "send",
    reconciliationStatus: "applied",
    clientMessageId: typeof payload.clientMessageId === "string" ? payload.clientMessageId : event.eventId,
    message: raw,
    canonicalRevision: 1,
  });
  // Server send correlation is tenant/author scoped; reconciling a local
  // projection also requires agreement on its conversation.
  const optimistic = Object.values(state.entities.messages).find(
    (candidate) =>
      "delivery" in candidate &&
      candidate.delivery.clientMessageId === result.clientMessageId &&
      candidate.tenantId === result.message.tenantId &&
      candidate.author.userId === result.message.author.userId &&
      candidate.conversationId === result.message.conversationId,
  );
  if (optimistic !== undefined) {
    const messages = { ...state.entities.messages };
    delete messages[optimistic.id];
    const timeline = state.timelines[optimistic.conversationId];
    state = freezeState({
      ...state,
      entities: Object.freeze({
        ...state.entities,
        messages: freezeRecord(messages),
      }),
      ...(timeline === undefined
        ? {}
        : {
            timelines: freezeRecord({
              ...state.timelines,
              [optimistic.conversationId]: Object.freeze({
                ...timeline,
                messageIds: Object.freeze(
                  timeline.messageIds.filter((id) => id !== optimistic.id),
                ),
              }),
            }),
          }),
    });
  }
  const message = enrichMessage(result.message, state);
  if (event.streamId !== message.conversationId) invalid(event);
  const conversation = state.entities.conversations[message.conversationId];
  if (conversation === undefined) gap(event);
  const existing = state.entities.messages[message.id];
  if (existing !== undefined) {
    assertImmutableMessage(existing, message, event);
    return state;
  }
  const knownLatest = state.metadata.conversations[message.conversationId]?.latestSequence ?? 0;
  if (message.sequence > knownLatest + 1) gap(event);
  if (message.sequence <= knownLatest) return state;

  let messages: ChatCacheEntities["messages"] = freezeRecord({
    ...state.entities.messages,
    [message.id]: message,
  });
  let timelines = addMessageToTimeline(state, message, messages, event);
  let metadata = updateConversationSequence(state, message.conversationId, message.sequence, message.updatedAt);

  if (conversation.type === "thread") {
    const root = messages[conversation.rootMessageId];
    if (root === undefined || !root.isThreadRoot || root.threadSummary.threadId !== conversation.id) gap(event);
    const participants = root.threadSummary.participantIds.includes(message.author.userId)
      ? root.threadSummary.participantIds
      : Object.freeze([...root.threadSummary.participantIds, message.author.userId]);
    const summary: ThreadSummary = Object.freeze({
      ...root.threadSummary,
      replyCount: root.threadSummary.replyCount + 1,
      participantIds: participants,
      lastReplyAt: message.createdAt,
      unreadCount: root.threadSummary.unreadCount + (message.author.userId === state.identity?.userId ? 0 : 1),
    });
    messages = freezeRecord({ ...messages, [root.id]: Object.freeze({ ...root, threadSummary: summary }) });
  }
  return freezeState({ ...state, entities: Object.freeze({ ...state.entities, messages }), timelines, metadata });
}

/**
 * Reconciles an HTTP-authoritative created message through the same reducer as
 * its durable event, without advancing the durable replay cursor. The eventual
 * message.created event therefore observes the canonical entity and remains
 * duplicate-safe while still advancing its real cursor.
 */
export function reconcileAuthoritativeMessageCreated(
  state: NormalizedChatCacheState,
  message: Message,
  clientCorrelationId: string,
): NormalizedChatCacheState {
  if (
    state.identity === null ||
    message.tenantId !== state.identity.tenantId ||
    typeof clientCorrelationId !== "string" ||
    clientCorrelationId.trim().length === 0
  ) {
    throw new TypeError("authoritative created-message reconciliation is invalid");
  }
  const event: ChatEvent = Object.freeze({
    eventId: `http-forward:${clientCorrelationId}`,
    tenantId: message.tenantId,
    streamId: message.conversationId,
    type: CHAT_DURABLE_EVENT_TYPES.messageCreated,
    occurredAt: message.updatedAt,
    protocolVersion: CHAT_PROTOCOL_VERSION,
    payload: Object.freeze({
      message,
      clientMessageId: clientCorrelationId,
    }),
  });
  return reduceMessageCreated(state, event);
}

function reduceMessageRevision(
  state: NormalizedChatCacheState,
  event: ChatEvent,
  deleted: boolean,
): NormalizedChatCacheState {
  const raw = record(record(event.payload).message);
  const revision = positiveInteger(record(raw.revision).revision);
  const existing = state.entities.messages[string(raw.id) as MessageId];
  if (existing === undefined) gap(event);
  if (revision <= existing.revision.revision) return state;
  if (revision !== existing.revision.revision + 1) gap(event);
  const parsed = deleted
    ? parseSoftDeleteMessageResult({ operation: "soft_delete", reconciliationStatus: "applied", expectedRevision: revision - 1, message: raw, canonicalRevision: revision }).message
    : parseEditMessageResult({ operation: "edit", reconciliationStatus: "applied", expectedRevision: revision - 1, message: raw, canonicalRevision: revision }).message;
  const message = enrichMessage(parsed, state, existing);
  assertImmutableMessage(existing, message, event);
  if (event.streamId !== message.conversationId) invalid(event);
  const next = freezeState({
    ...state,
    entities: Object.freeze({ ...state.entities, messages: freezeRecord({ ...state.entities.messages, [message.id]: message }) }),
  });
  return deleted
    ? markSavedMessageUnavailable(next, message.id, "deleted")
    : next;
}

function reduceReaction(state: NormalizedChatCacheState, event: ChatEvent): NormalizedChatCacheState {
  const payload = record(event.payload);
  const { conversationId, ...resultPayload } = payload;
  const result = parseReactionMutationResult({
    ...resultPayload,
    reconciliationStatus: "applied",
  });
  const message = state.entities.messages[result.messageId];
  if (
    message === undefined ||
    (conversationId !== undefined && conversationId !== message.conversationId) ||
    event.streamId !== message.conversationId
  ) gap(event);
  const currentUserAggregate = message.reactions.find(
    (item) => item.reactionKey === result.reactionKey,
  );
  const aggregate: MessageReactionAggregate = Object.freeze({
    reactionKey: result.reactionKey,
    count: result.count,
    // Conversation events carry the command actor's projection. Preserve this
    // cache identity's projection while accepting the shared aggregate count.
    reactedByCurrentUser: currentUserAggregate?.reactedByCurrentUser ?? false,
  });
  const reactions = message.reactions.filter((item) => item.reactionKey !== result.reactionKey);
  if (aggregate.count > 0) reactions.push(aggregate);
  reactions.sort((left, right) => left.reactionKey.localeCompare(right.reactionKey));
  return replaceMessage(state, Object.freeze({ ...message, reactions: Object.freeze(reactions) }));
}

function reduceReadCursor(state: NormalizedChatCacheState, event: ChatEvent, currentUserId: UserId): NormalizedChatCacheState {
  const payload = record(event.payload);
  const { reconciliationStatus: _reconciliationStatus, ...readPayload } = payload;
  const parsed = parseReadCursorUpdatedEvent(
    { ...event, payload: readPayload },
    event.tenantId,
  );
  if (parsed.payload.actorUserId !== currentUserId || event.streamId !== `user:${currentUserId}`) privateMismatch(event);
  const incoming = parsed.payload.readState;
  const existing = state.currentUser.readStates[incoming.conversationId];
  const conversationMetadata = state.metadata.conversations[incoming.conversationId];
  if (
    state.entities.conversations[incoming.conversationId] === undefined ||
    conversationMetadata === undefined
  ) gap(event);
  if (
    existing !== undefined &&
    (incoming.lastReadSequence < existing.lastReadSequence ||
      (incoming.lastReadSequence === existing.lastReadSequence &&
        timestamp(incoming.updatedAt) <= timestamp(existing.updatedAt)))
  ) return state;
  const metadata =
    parsed.payload.latestSequence <= conversationMetadata.latestSequence
      ? state.metadata
      : Object.freeze({
          ...state.metadata,
          conversations: freezeRecord({
            ...state.metadata.conversations,
            [incoming.conversationId]: Object.freeze({
              ...conversationMetadata,
              latestSequence: parsed.payload.latestSequence,
            }),
          }),
        });
  return freezeState({
    ...state,
    currentUser: Object.freeze({ ...state.currentUser, readStates: freezeRecord({ ...state.currentUser.readStates, [incoming.conversationId]: incoming }) }),
    metadata,
  });
}

function reducePreference(state: NormalizedChatCacheState, event: ChatEvent, currentUserId: UserId): NormalizedChatCacheState {
  assertPrivate(event, currentUserId);
  const payload = record(event.payload);
  if (payload.actorUserId !== currentUserId) privateMismatch(event);
  const input = parseUpdateConversationPreferenceInput(payload.input);
  const result = parseUpdateConversationPreferenceResult(payload.result, input);
  if (state.entities.conversations[result.conversationId] === undefined) gap(event);
  return reconcileCurrentUserPreferenceMutation(state, input, result);
}

/** Shared HTTP/realtime convergence for one authenticated user's private state. */
export function reconcileCurrentUserPreferenceMutation(
  state: NormalizedChatCacheState,
  authoredInput: UpdateConversationPreferenceInput,
  authoredResult: UpdateConversationPreferenceResult,
): NormalizedChatCacheState {
  const identity = state.identity;
  if (identity === null) throw new TypeError("preference identity required");
  const input = parseUpdateConversationPreferenceInput(authoredInput);
  const result = parseUpdateConversationPreferenceResult(authoredResult, input);
  if (state.entities.conversations[result.conversationId] === undefined) {
    throw new TypeError("preference conversation required");
  }
  const knownRevision =
    state.currentUser.preferenceRevisions[result.conversationId] ?? 0;
  const pending =
    state.currentUser.pendingPreferenceUpdates[result.conversationId];
  if (result.preferenceRevision < knownRevision) {
    if (pending?.idempotencyKey !== result.idempotencyKey) return state;
    const mutablePending = {
      ...state.currentUser.pendingPreferenceUpdates,
    };
    delete mutablePending[result.conversationId];
    const authoritativePreference = pending.authoritativePreference;
    const preferences = authoritativePreference === undefined ||
        preferenceValueEqual(
          state.currentUser.preferences[result.conversationId],
          authoritativePreference,
        )
      ? state.currentUser.preferences
      : freezeRecord({
          ...state.currentUser.preferences,
          [result.conversationId]: authoritativePreference,
        });
    return freezeState({
      ...state,
      currentUser: Object.freeze({
        ...state.currentUser,
        preferences,
        pendingPreferenceUpdates: freezeRecord(mutablePending),
      }),
    });
  }

  const preference: ConversationMemberPreference = Object.freeze({
    ...result.preference,
    mute: Object.freeze({ ...result.preference.mute }),
    conversationId: result.conversationId,
    userId: identity.userId,
  });
  let preferences = state.currentUser.preferences;
  let pendingPreferenceUpdates = state.currentUser.pendingPreferenceUpdates;

  if (pending?.idempotencyKey === result.idempotencyKey) {
    const mutablePending = { ...pendingPreferenceUpdates };
    delete mutablePending[result.conversationId];
    pendingPreferenceUpdates = freezeRecord(mutablePending);
    if (!preferenceValueEqual(preferences[result.conversationId], preference)) {
      preferences = freezeRecord({
        ...preferences,
        [result.conversationId]: preference,
      });
    }
  } else if (pending !== undefined) {
    if (!preferenceValueEqual(pending.authoritativePreference, preference)) {
      pendingPreferenceUpdates = freezeRecord({
        ...pendingPreferenceUpdates,
        [result.conversationId]: Object.freeze({
          ...pending,
          authoritativePreference: preference,
        }),
      });
    }
  } else if (!preferenceValueEqual(preferences[result.conversationId], preference)) {
    preferences = freezeRecord({
      ...preferences,
      [result.conversationId]: preference,
    });
  }

  const preferenceRevisions =
    knownRevision === result.preferenceRevision
      ? state.currentUser.preferenceRevisions
      : freezeRecord({
          ...state.currentUser.preferenceRevisions,
          [result.conversationId]: result.preferenceRevision,
        });
  if (
    preferences === state.currentUser.preferences &&
    pendingPreferenceUpdates === state.currentUser.pendingPreferenceUpdates &&
    preferenceRevisions === state.currentUser.preferenceRevisions
  ) return state;
  return freezeState({
    ...state,
    currentUser: Object.freeze({
      ...state.currentUser,
      preferences,
      preferenceRevisions,
      pendingPreferenceUpdates,
    }),
  });
}

function parseThreadFollowEventPayload(
  event: ChatEvent,
): { readonly followRevision: number; readonly follow: CanonicalThreadFollowState } {
  const payload = record(event.payload);
  if (
    Object.keys(payload).length !== 4 ||
    !Object.hasOwn(payload, "operation") ||
    !Object.hasOwn(payload, "target") ||
    !Object.hasOwn(payload, "followRevision") ||
    !Object.hasOwn(payload, "follow") ||
    payload.operation !== "set_thread_follow"
  ) invalid(event);
  const target = record(payload.target);
  const follow = record(payload.follow);
  if (
    Object.keys(target).length !== 2 ||
    target.type !== "thread" ||
    typeof target.id !== "string" ||
    target.id.trim().length === 0 ||
    target.id !== target.id.trim() ||
    !Number.isSafeInteger(payload.followRevision) ||
    (payload.followRevision as number) < 1 ||
    Object.keys(follow).length !== 4 ||
    !Object.hasOwn(follow, "target") ||
    !Object.hasOwn(follow, "isFollowing") ||
    !Object.hasOwn(follow, "source") ||
    !Object.hasOwn(follow, "updatedAt")
  ) invalid(event);
  const followTarget = record(follow.target);
  if (
    Object.keys(followTarget).length !== 2 ||
    followTarget.type !== "thread" ||
    followTarget.id !== target.id ||
    typeof follow.isFollowing !== "boolean" ||
    (follow.source !== "manual" && follow.source !== "reply" && follow.source !== "mention") ||
    (!follow.isFollowing && follow.source !== "manual")
  ) invalid(event);
  const updatedAt = iso(follow.updatedAt);
  const canonical = Object.freeze({
    target: Object.freeze({ type: "thread" as const, id: target.id as ConversationId }),
    isFollowing: follow.isFollowing,
    source: follow.source,
    updatedAt,
  }) as CanonicalThreadFollowState;
  return Object.freeze({
    followRevision: payload.followRevision as number,
    follow: canonical,
  });
}

function assertKnownThreadFollowTarget(
  state: NormalizedChatCacheState,
  threadId: ConversationId,
  event?: ChatEvent,
): void {
  const thread = state.entities.conversations[threadId];
  const parent = thread?.type === "thread"
    ? state.entities.conversations[thread.parentConversationId]
    : undefined;
  const root = thread?.type === "thread"
    ? state.entities.messages[thread.rootMessageId]
    : undefined;
  if (
    thread?.type !== "thread" ||
    parent === undefined ||
    parent.type === "thread" ||
    root === undefined ||
    root.conversationId !== parent.id
  ) {
    if (event !== undefined) gap(event);
    throw new TypeError("thread follow target requires a known parent and root");
  }
}

function reduceThreadFollow(
  state: NormalizedChatCacheState,
  event: ChatEvent,
  currentUserId: UserId,
): NormalizedChatCacheState {
  assertPrivate(event, currentUserId);
  const incoming = parseThreadFollowEventPayload(event);
  assertKnownThreadFollowTarget(state, incoming.follow.target.id, event);
  return reconcileThreadFollowCanonical(
    state,
    incoming.follow.target.id,
    incoming.followRevision,
    incoming.follow,
  );
}

function reduceSavedMessage(
  state: NormalizedChatCacheState,
  event: ChatEvent,
  currentUserId: UserId,
): NormalizedChatCacheState {
  assertPrivate(event, currentUserId);
  return reconcileSavedMessageEvent(state, event.payload);
}

function reduceMessageReminder(
  state: NormalizedChatCacheState,
  event: ChatEvent,
  currentUserId: UserId,
): NormalizedChatCacheState {
  assertPrivate(event, currentUserId);
  return reconcileMessageReminderEvent(state, event.payload);
}

/** Shared HTTP/realtime convergence for one authenticated user's private state. */
export function reconcileCurrentUserThreadFollowMutation(
  state: NormalizedChatCacheState,
  authoredInput: SetThreadFollowInput,
  authoredResult: SetThreadFollowResult,
): NormalizedChatCacheState {
  if (state.identity === null) throw new TypeError("thread follow identity required");
  const input = parseSetThreadFollowInput(authoredInput);
  const result = parseSetThreadFollowResult(authoredResult, input);
  assertKnownThreadFollowTarget(state, result.target.id);
  return reconcileThreadFollowCanonical(
    state,
    result.target.id,
    result.followRevision,
    result.follow,
    result.idempotencyKey,
  );
}

export function reconcileThreadFollowCanonical(
  state: NormalizedChatCacheState,
  threadId: ConversationId,
  followRevision: number,
  follow: CanonicalThreadFollowState,
  settlingIdempotencyKey?: string,
): NormalizedChatCacheState {
  const knownRevision = state.currentUser.threadFollowRevisions[threadId] ?? 0;
  const pending = state.currentUser.pendingThreadFollowUpdates[threadId];
  const existing = pending?.authoritativeFollow ??
    state.currentUser.threadFollows[threadId];
  const matchingPending = settlingIdempotencyKey !== undefined &&
    pending?.idempotencyKey === settlingIdempotencyKey;

  if (followRevision < knownRevision) {
    if (!matchingPending) return state;
    const nextPending = { ...state.currentUser.pendingThreadFollowUpdates };
    delete nextPending[threadId];
    const projected = { ...state.currentUser.threadFollows };
    if (existing === undefined) delete projected[threadId];
    else projected[threadId] = existing;
    return freezeState({
      ...state,
      currentUser: Object.freeze({
        ...state.currentUser,
        threadFollows: freezeRecord(projected),
        pendingThreadFollowUpdates: freezeRecord(nextPending),
      }),
    });
  }

  if (
    followRevision === knownRevision &&
    existing !== undefined &&
    !preferenceValueEqual(existing, follow)
  ) {
    if (follow.source !== "manual" && !existing.isFollowing && existing.source === "manual") {
      return state;
    }
    throw new TypeError("one follow revision carried conflicting canonical states");
  }

  // Participation policy must never erase an explicit manual unfollow, whether
  // it is already canonical or remains the newest renderer intent.
  if (
    follow.source !== "manual" &&
    (pending?.intent === "unfollow" ||
      (pending === undefined && existing?.isFollowing === false && existing.source === "manual"))
  ) return state;

  let threadFollows = state.currentUser.threadFollows;
  let pendingThreadFollowUpdates =
    state.currentUser.pendingThreadFollowUpdates;
  if (matchingPending) {
    const nextPending = { ...pendingThreadFollowUpdates };
    delete nextPending[threadId];
    pendingThreadFollowUpdates = freezeRecord(nextPending);
    if (!preferenceValueEqual(threadFollows[threadId], follow)) {
      threadFollows = freezeRecord({ ...threadFollows, [threadId]: follow });
    }
  } else if (pending !== undefined) {
    if (!preferenceValueEqual(pending.authoritativeFollow, follow)) {
      pendingThreadFollowUpdates = freezeRecord({
        ...pendingThreadFollowUpdates,
        [threadId]: Object.freeze({ ...pending, authoritativeFollow: follow }),
      });
    }
  } else if (!preferenceValueEqual(threadFollows[threadId], follow)) {
    threadFollows = freezeRecord({ ...threadFollows, [threadId]: follow });
  }
  const threadFollowRevisions = knownRevision === followRevision
    ? state.currentUser.threadFollowRevisions
    : freezeRecord({
        ...state.currentUser.threadFollowRevisions,
        [threadId]: followRevision,
      });
  if (
    threadFollows === state.currentUser.threadFollows &&
    pendingThreadFollowUpdates === state.currentUser.pendingThreadFollowUpdates &&
    threadFollowRevisions === state.currentUser.threadFollowRevisions
  ) return state;
  return freezeState({
    ...state,
    currentUser: Object.freeze({
      ...state.currentUser,
      threadFollows,
      threadFollowRevisions,
      pendingThreadFollowUpdates,
    }),
  });
}

function reduceDraft(state: NormalizedChatCacheState, event: ChatEvent, currentUserId: UserId): NormalizedChatCacheState {
  assertPrivate(event, currentUserId);
  const payload = record(event.payload);
  if (payload.actorUserId !== currentUserId) privateMismatch(event);
  const input = parseSynchronizeDraftInput(payload.input);
  const result = parseSynchronizeDraftResult(payload.result, input);
  if (state.entities.conversations[result.conversationId] === undefined) gap(event);
  const knownRevision = state.currentUser.draftRevisions[result.conversationId] ?? 0;
  if (result.canonicalRevision < knownRevision) return state;
  const existing = state.currentUser.drafts[result.conversationId];
  if (
    result.canonicalRevision === knownRevision &&
    existing !== undefined &&
    JSON.stringify(existing) !== JSON.stringify(result.draft)
  ) {
    // The public draft runtime may be projecting a newer unsaved local edit at
    // this authoritative revision. Keep that private projection visible; the
    // runtime consumes the validated event correlation and surfaces a conflict
    // when the same revision is genuinely incompatible.
    return state;
  }
  if (
    result.canonicalRevision === knownRevision &&
    JSON.stringify(existing) === JSON.stringify(result.draft)
  ) return state;
  return freezeState({
    ...state,
    currentUser: Object.freeze({
      ...state.currentUser,
      drafts: freezeRecord({
        ...state.currentUser.drafts,
        [result.conversationId]: result.draft,
      }),
      draftRevisions: freezeRecord({
        ...state.currentUser.draftRevisions,
        [result.conversationId]: result.canonicalRevision,
      }),
    }),
  });
}

function reduceAttachment(state: NormalizedChatCacheState, event: ChatEvent): NormalizedChatCacheState {
  const payload = record(event.payload);
  const attachment = parseAttachment(payload.attachment);
  const messageId = typeof payload.messageId === "string" ? payload.messageId as MessageId : undefined;
  const attachments = freezeRecord({ ...state.entities.attachments, [attachment.attachmentId]: attachment });
  if (messageId === undefined) return freezeState({ ...state, entities: Object.freeze({ ...state.entities, attachments }) });
  const message = state.entities.messages[messageId];
  if (message === undefined) {
    const conversationId = string(payload.conversationId) as ConversationId;
    if (
      event.streamId !== conversationId ||
      state.entities.conversations[conversationId] === undefined
    ) gap(event);
    // Attachment metadata may lead its message on the same ordered stream.
    return freezeState({
      ...state,
      entities: Object.freeze({ ...state.entities, attachments }),
    });
  }
  if (event.streamId !== message.conversationId) gap(event);
  const refs = message.content?.attachments ?? [];
  if (!refs.some((reference) => reference.attachmentId === attachment.attachmentId)) invalid(event);
  const attachmentMetadata = refs.map((reference) => attachments[reference.attachmentId]);
  if (attachmentMetadata.some((item) => item === undefined)) invalid(event);
  return freezeState({
    ...state,
    entities: Object.freeze({ ...state.entities, attachments, messages: freezeRecord({ ...state.entities.messages, [message.id]: Object.freeze({ ...message, attachmentMetadata: Object.freeze(attachmentMetadata as MessageAttachmentMetadata[]) }) }) }),
  });
}

function reduceHuddle(state: NormalizedChatCacheState, event: ChatEvent): NormalizedChatCacheState {
  const huddle = parseHuddleSessionState(record(event.payload).state);
  if (event.streamId !== huddle.conversationId || state.entities.conversations[huddle.conversationId] === undefined) gap(event);
  const current = state.huddles[huddle.conversationId];
  if (current !== undefined && current.status !== "inactive") {
    // HTTP command snapshots can arrive before their queued durable events.
    // Do not let an older start/join event remove already-confirmed membership.
    const confirmedAt = Math.max(Date.parse(current.startedAt),
      current.status === "ended" ? Date.parse(current.endedAt) : 0,
      ...current.participants.map((participant) => Date.parse(
        participant.status === "left" ? participant.leftAt : participant.joinedAt,
      )));
    if (Date.parse(event.occurredAt) < confirmedAt) return state;
    // An ended session stays terminal even when a queued live event has a later envelope time.
    if (
      current.status === "ended" &&
      (huddle.status === "starting" || huddle.status === "active") &&
      huddle.huddleSessionId === current.huddleSessionId
    ) return state;
  }
  return freezeState({ ...state, huddles: freezeRecord({ ...state.huddles, [huddle.conversationId]: huddle }) });
}

function reduceThreadSummary(state: NormalizedChatCacheState, event: ChatEvent): NormalizedChatCacheState {
  const payload = record(event.payload);
  const parentConversationId = string(payload.parentConversationId) as ConversationId;
  const rootMessageId = string(payload.rootMessageId) as MessageId;
  const summary = parseThreadSummary(payload.rootThreadSummary);
  const root = state.entities.messages[rootMessageId];
  if (event.streamId !== parentConversationId || root === undefined || root.conversationId !== parentConversationId) gap(event);
  if (summary.threadId === parentConversationId) invalid(event);
  const thread = state.entities.conversations[summary.threadId];
  if (
    thread !== undefined &&
    (thread.type !== "thread" ||
      thread.parentConversationId !== parentConversationId ||
      thread.rootMessageId !== rootMessageId)
  ) invalid(event);
  // Creation/send summaries describe append-only reply progress: SQL counts all
  // reply rows, including soft-deleted replies. After identity validation, only
  // a greater per-root replyCount replaces accepted facts; an absent summary may
  // initialize at zero. Equal/lower progress preserves the entire accepted summary.
  // Neither unreadCount, root revision, event IDs nor envelope time orders these
  // summaries. No-ops still reach arrival-based cursor/recent-event bookkeeping
  // and the stream timestamp high-water update in reduceDurableChatEvent.
  if (root.threadSummary !== undefined && summary.replyCount <= root.threadSummary.replyCount) return state;
  const message = Object.freeze({ ...root, isThreadRoot: true as const, threadSummary: summary });
  return replaceMessage(state, message);
}

function enrichMessage(
  message: Message,
  state: NormalizedChatCacheState,
  existing?: MessageTimelineMessage,
): MessageTimelineMessage {
  const references = message.content?.attachments ?? [];
  const attachmentMetadata = references.map((reference) => state.entities.attachments[reference.attachmentId]);
  if (attachmentMetadata.some((item) => item === undefined)) throw new TypeError("attachment metadata is unavailable");
  const { threadSummary, ...messageWithoutSummary } = message;
  const base = {
    ...messageWithoutSummary,
    reactions: existing?.reactions ?? Object.freeze([]),
    attachmentMetadata: Object.freeze(attachmentMetadata as MessageAttachmentMetadata[]),
  };
  return threadSummary === undefined
    ? Object.freeze({ ...base, isThreadRoot: false as const })
    : Object.freeze({ ...base, isThreadRoot: true as const, threadSummary });
}

function addMessageToTimeline(
  state: NormalizedChatCacheState,
  message: MessageTimelineMessage,
  messages: ChatCacheEntities["messages"],
  event: ChatEvent,
): NormalizedChatCacheState["timelines"] {
  const existing = state.timelines[message.conversationId];
  const ids = [...(existing?.messageIds ?? []), message.id].sort((leftId, rightId) => {
    const left = messages[leftId];
    const right = messages[rightId];
    return (left?.sequence ?? 0) - (right?.sequence ?? 0);
  });
  // Pending sends have provisional sequences that can overlap canonical rows.
  const canonicalIds = ids.filter((id) => {
    const candidate = messages[id];
    return candidate === undefined || !("delivery" in candidate);
  });
  for (let index = 1; index < canonicalIds.length; index += 1) {
    const previous = messages[canonicalIds[index - 1] as MessageId];
    const current = messages[canonicalIds[index] as MessageId];
    if (previous?.sequence === current?.sequence && previous?.id !== current?.id) invalid(event);
  }
  const pagination = existing?.pagination ?? Object.freeze({
    older: Object.freeze({ available: false as const }),
    newer: Object.freeze({ available: false as const }),
  });
  return freezeRecord({
    ...state.timelines,
    [message.conversationId]: Object.freeze({
      messageIds: Object.freeze(ids),
      pagination,
      realtimeCursor: Object.freeze({ eventId: event.eventId }),
    }),
  });
}

function updateConversationSequence(
  state: NormalizedChatCacheState,
  conversationId: ConversationId,
  sequence: number,
  activityAt: IsoTimestamp,
): NormalizedChatCacheState["metadata"] {
  const existing = state.metadata.conversations[conversationId];
  return Object.freeze({
    ...state.metadata,
    conversations: freezeRecord({
      ...state.metadata.conversations,
      [conversationId]: Object.freeze({
        latestSequence: sequence,
        activityAt: existing !== undefined && timestamp(existing.activityAt) > timestamp(activityAt)
          ? existing.activityAt
          : activityAt,
      }),
    }),
  });
}

function replaceMessage(
  state: NormalizedChatCacheState,
  message: MessageTimelineMessage,
): NormalizedChatCacheState {
  return freezeState({
    ...state,
    entities: Object.freeze({
      ...state.entities,
      messages: freezeRecord({ ...state.entities.messages, [message.id]: message }),
    }),
  });
}

function assertImmutableMessage(
  existing: MessageTimelineMessage,
  incoming: MessageTimelineMessage,
  event: ChatEvent,
): void {
  if (
    existing.id !== incoming.id ||
    existing.tenantId !== incoming.tenantId ||
    existing.conversationId !== incoming.conversationId ||
    existing.sequence !== incoming.sequence ||
    existing.author.userId !== incoming.author.userId ||
    existing.createdAt !== incoming.createdAt
  ) invalid(event);
}

function parseConversation(value: unknown, tenantId: string): Conversation {
  const input = record(value);
  const id = string(input.id) as ConversationId;
  if (input.tenantId !== tenantId) throw new TypeError("tenant mismatch");
  const type = input.type;
  const visibility = input.visibility;
  if (!["channel", "direct", "group_direct", "thread"].includes(type as string)) throw new TypeError("type");
  if (visibility !== "public" && visibility !== "private") throw new TypeError("visibility");
  const common = {
    id,
    tenantId: tenantId as ChatCacheEntities["conversations"][ConversationId]["tenantId"],
    createdAt: iso(input.createdAt),
    updatedAt: iso(input.updatedAt),
    ...(input.archivedAt === undefined ? {} : {
      archivedAt: iso(input.archivedAt),
      archivedByUserId: string(input.archivedByUserId) as UserId,
    }),
  };
  if (type === "channel") {
    const entity = input.entity === undefined ? undefined : record(input.entity);
    return Object.freeze({
      ...common,
      type,
      visibility,
      name: string(input.name),
      ...(entity === undefined ? {} : { entity: Object.freeze({ type: string(entity.type), id: string(entity.id) }) }),
    }) as Conversation;
  }
  if (type === "thread") {
    return Object.freeze({
      ...common,
      type,
      visibility,
      ...(input.name === undefined ? {} : { name: validateThreadConversationName(input.name) }),
      ...(input.threadLifecycle === undefined ? {} : { threadLifecycle: Object.freeze(validateThreadLifecycle(input.threadLifecycle)) }),
      parentConversationId: string(input.parentConversationId) as ConversationId,
      rootMessageId: string(input.rootMessageId) as MessageId,
    }) as Conversation;
  }
  if (visibility !== "private") throw new TypeError("private visibility");
  return Object.freeze({ ...common, type, visibility }) as Conversation;
}

function parseThreadSummary(value: unknown): ThreadSummary {
  const input = record(value);
  const participants = parseStringArray(input.participantIds);
  if (participants === undefined) throw new TypeError("participants");
  return Object.freeze({
    threadId: string(input.threadId) as ConversationId,
    replyCount: nonNegativeInteger(input.replyCount),
    participantIds: participants,
    unreadCount: nonNegativeInteger(input.unreadCount),
    ...(input.lastReplyAt === undefined ? {} : { lastReplyAt: iso(input.lastReplyAt) }),
  });
}

function parseAttachment(value: unknown): MessageAttachmentMetadata {
  const input = record(value);
  return Object.freeze({
    attachmentId: string(input.attachmentId) as MessageAttachmentMetadata["attachmentId"],
    fileName: string(input.fileName),
    contentType: string(input.contentType),
    sizeBytes: nonNegativeInteger(input.sizeBytes),
    downloadUrl: string(input.downloadUrl),
    ...(input.previewUrl === undefined ? {} : { previewUrl: string(input.previewUrl) }),
    ...(input.width === undefined ? {} : { width: positiveInteger(input.width) }),
    ...(input.height === undefined ? {} : { height: positiveInteger(input.height) }),
    ...(input.altText === undefined ? {} : { altText: string(input.altText) }),
  });
}

function assertPrivate(event: ChatEvent, currentUserId: UserId): void {
  if (event.streamId !== `user:${currentUserId}`) privateMismatch(event);
}

function parseStringArray(value: unknown): readonly UserId[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim().length > 0)) throw new TypeError("string array");
  if (new Set(value).size !== value.length) throw new TypeError("duplicate string");
  return Object.freeze([...value]) as readonly UserId[];
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("object required");
  return value as Record<string, unknown>;
}

function string(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError("string required");
  return value;
}

function iso(value: unknown): IsoTimestamp {
  const parsed = string(value);
  if (!Number.isFinite(Date.parse(parsed))) throw new TypeError("timestamp required");
  return parsed as IsoTimestamp;
}

function nonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError("non-negative integer required");
  return value as number;
}

function positiveInteger(value: unknown): number {
  const parsed = nonNegativeInteger(value);
  if (parsed < 1) throw new TypeError("positive integer required");
  return parsed;
}

function timestamp(value: IsoTimestamp): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new TypeError("invalid timestamp");
  return parsed;
}

function preferenceValueEqual(left: unknown, right: unknown): boolean {
  return left === right || JSON.stringify(left) === JSON.stringify(right);
}

function freezeRecord<Value extends object>(value: Value): Readonly<Value> {
  return Object.freeze(value);
}

function freezeState(state: NormalizedChatCacheState): NormalizedChatCacheState {
  return Object.freeze(state);
}

function invalid(event: ChatEvent): never {
  return fail(event, "incoherent_payload", "event_invalid", "The durable event payload is incoherent with known cache state.");
}

function gap(event: ChatEvent): never {
  return fail(event, "ordering_gap", "event_gap", "The durable event cannot be safely reduced without a snapshot.");
}

function privateMismatch(event: ChatEvent): never {
  return fail(event, "private_stream_mismatch", "event_invalid", "The private durable event does not belong to the authenticated user stream.");
}

function fail(
  event: ChatEvent,
  code: DurableEventDiagnosticCode,
  reason: DurableEventRecoveryReason,
  message: string,
): never {
  throw new DurableEventReductionError(Object.freeze({
    code,
    reason,
    eventId: event.eventId,
    streamId: event.streamId,
    eventType: event.type,
    message,
  }));
}
