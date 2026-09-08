import {
  parseCancelMessageReminderInput,
  parseMessageReminderResult,
  parseSetMessageReminderInput,
  type CanonicalMessageReminder,
  type MessageReminderInput,
  type MessageReminderIntent,
  type MessageReminderResult,
} from "../contracts/generated/message-reminder.js";
import type { ConversationId, MessageId } from "../contracts/identifiers.js";
import type { NormalizedChatCacheState } from "./normalized-cache.js";

export type MessageReminderMutationFailure =
  | "malformed_response"
  | "transport"
  | "aborted";

export interface PendingMessageReminderUpdate {
  /** Conflicts retain the desired request without continuing automatic replay. */
  readonly state: "pending" | "failed" | "conflict";
  readonly conversationId: ConversationId;
  readonly messageId: MessageId;
  readonly idempotencyKey: string;
  readonly expectedReminderRevision: number;
  readonly intent: MessageReminderIntent;
  readonly desiredReminder: CanonicalMessageReminder;
  readonly authoritativeReminder?: CanonicalMessageReminder;
  readonly attempt: number;
  readonly retryable: boolean;
  readonly failure?: MessageReminderMutationFailure;
}

export function markMessageReminderConflict(
  state: NormalizedChatCacheState,
  authoredInput: MessageReminderInput,
): NormalizedChatCacheState {
  const input = parseInput(authoredInput);
  const pending = state.currentUser.pendingMessageReminderUpdates[input.messageId];
  const authoritativeReminder = pending?.authoritativeReminder ??
    state.currentUser.messageReminders[input.messageId];
  const authoritativeRevision =
    state.currentUser.messageReminderRevisions[input.messageId] ?? 0;
  if (
    authoritativeReminder === undefined ||
    authoritativeRevision <= input.expectedReminderRevision
  ) {
    throw new TypeError("message-reminder conflict requires newer authoritative state");
  }
  const conflict: PendingMessageReminderUpdate = Object.freeze({
    state: "conflict",
    conversationId: input.conversationId,
    messageId: input.messageId,
    idempotencyKey: input.idempotencyKey,
    expectedReminderRevision: input.expectedReminderRevision,
    intent: input.intent,
    desiredReminder: desiredFromInput(input),
    authoritativeReminder,
    attempt: pending?.idempotencyKey === input.idempotencyKey ? pending.attempt : 1,
    retryable: false,
  });
  const updates = {
    ...state.currentUser.pendingMessageReminderUpdates,
    [input.messageId]: conflict,
  };
  return Object.freeze({
    ...state,
    currentUser: Object.freeze({
      ...state.currentUser,
      messageReminders: freezeRecord<CanonicalMessageReminder>({
        ...state.currentUser.messageReminders,
        [input.messageId]: authoritativeReminder,
      }),
      pendingMessageReminderUpdates: freezeRecord<PendingMessageReminderUpdate>(updates),
    }),
  });
}

const freezeRecord = <Value>(value: Record<string, Value>): Readonly<Record<string, Value>> =>
  Object.freeze(value);

const equal = (left: unknown, right: unknown): boolean =>
  left === right || JSON.stringify(left) === JSON.stringify(right);

const parseInput = (input: MessageReminderInput): MessageReminderInput =>
  input.intent === "set"
    ? parseSetMessageReminderInput(input, { referenceTime: new Date(0) })
    : parseCancelMessageReminderInput(input);

const desiredFromInput = (input: MessageReminderInput): CanonicalMessageReminder =>
  input.intent === "set"
    ? Object.freeze({
        privacy: "affected_authenticated_actor" as const,
        state: "scheduled" as const,
        dueAt: input.dueAt,
      })
    : Object.freeze({
        privacy: "affected_authenticated_actor" as const,
        state: "cancelled" as const,
      });

export function beginOptimisticMessageReminder(
  state: NormalizedChatCacheState,
  authoredInput: MessageReminderInput,
): NormalizedChatCacheState {
  if (state.identity === null) throw new TypeError("message-reminder identity required");
  const input = parseInput(authoredInput);
  const knownRevision = state.currentUser.messageReminderRevisions[input.messageId] ?? 0;
  const knownConversationId =
    state.currentUser.messageReminderConversationIds[input.messageId];
  if (knownConversationId !== undefined && knownConversationId !== input.conversationId) {
    throw new TypeError("message-reminder conversation is immutable");
  }
  if (input.expectedReminderRevision !== knownRevision) {
    throw new TypeError("message-reminder input does not use the authoritative revision");
  }
  const existingPending = state.currentUser.pendingMessageReminderUpdates[input.messageId];
  const authoritativeReminder = existingPending === undefined
    ? state.currentUser.messageReminders[input.messageId]
    : existingPending.authoritativeReminder;
  const desiredReminder = desiredFromInput(input);
  const pending: PendingMessageReminderUpdate = Object.freeze({
    state: "pending",
    conversationId: input.conversationId,
    messageId: input.messageId,
    idempotencyKey: input.idempotencyKey,
    expectedReminderRevision: input.expectedReminderRevision,
    intent: input.intent,
    desiredReminder,
    ...(authoritativeReminder === undefined ? {} : { authoritativeReminder }),
    attempt: 1,
    retryable: false,
  });
  return Object.freeze({
    ...state,
    currentUser: Object.freeze({
      ...state.currentUser,
      messageReminders: freezeRecord<CanonicalMessageReminder>({
        ...state.currentUser.messageReminders,
        [input.messageId]: desiredReminder,
      }),
      messageReminderConversationIds: freezeRecord<ConversationId>({
        ...state.currentUser.messageReminderConversationIds,
        [input.messageId]: input.conversationId,
      }),
      pendingMessageReminderUpdates: freezeRecord<PendingMessageReminderUpdate>({
        ...state.currentUser.pendingMessageReminderUpdates,
        [input.messageId]: pending,
      }),
    }),
  });
}

export function retryOptimisticMessageReminder(
  state: NormalizedChatCacheState,
  messageId: MessageId,
  idempotencyKey: string,
): NormalizedChatCacheState {
  const pending = state.currentUser.pendingMessageReminderUpdates[messageId];
  if (state.identity === null || pending?.idempotencyKey !== idempotencyKey ||
      pending.state !== "failed" || !pending.retryable) {
    throw new TypeError("message-reminder update is not retryable");
  }
  const { failure: _failure, ...rest } = pending;
  return Object.freeze({
    ...state,
    currentUser: Object.freeze({
      ...state.currentUser,
      pendingMessageReminderUpdates: freezeRecord<PendingMessageReminderUpdate>({
        ...state.currentUser.pendingMessageReminderUpdates,
        [messageId]: Object.freeze({
          ...rest,
          state: "pending" as const,
          attempt: pending.attempt + 1,
          retryable: false,
        }),
      }),
    }),
  });
}

export function failOptimisticMessageReminder(
  state: NormalizedChatCacheState,
  messageId: MessageId,
  idempotencyKey: string,
  failure: MessageReminderMutationFailure,
): NormalizedChatCacheState {
  const pending = state.currentUser.pendingMessageReminderUpdates[messageId];
  if (pending?.idempotencyKey !== idempotencyKey) return state;
  return Object.freeze({
    ...state,
    currentUser: Object.freeze({
      ...state.currentUser,
      pendingMessageReminderUpdates: freezeRecord<PendingMessageReminderUpdate>({
        ...state.currentUser.pendingMessageReminderUpdates,
        [messageId]: Object.freeze({
          ...pending,
          state: "failed" as const,
          retryable: true,
          failure,
        }),
      }),
    }),
  });
}

export function rollbackOptimisticMessageReminder(
  state: NormalizedChatCacheState,
  messageId: MessageId,
  idempotencyKey: string,
): NormalizedChatCacheState {
  const pending = state.currentUser.pendingMessageReminderUpdates[messageId];
  if (pending?.idempotencyKey !== idempotencyKey) return state;
  const updates = { ...state.currentUser.pendingMessageReminderUpdates };
  const reminders = { ...state.currentUser.messageReminders };
  const conversations = { ...state.currentUser.messageReminderConversationIds };
  delete updates[messageId];
  if (pending.authoritativeReminder === undefined) {
    delete reminders[messageId];
    delete conversations[messageId];
  } else {
    reminders[messageId] = pending.authoritativeReminder;
  }
  return Object.freeze({
    ...state,
    currentUser: Object.freeze({
      ...state.currentUser,
      messageReminders: freezeRecord(reminders),
      messageReminderConversationIds: freezeRecord(conversations),
      pendingMessageReminderUpdates: freezeRecord(updates),
    }),
  });
}

export function reconcileCurrentUserMessageReminderMutation(
  state: NormalizedChatCacheState,
  authoredInput: MessageReminderInput,
  authoredResult: MessageReminderResult,
): NormalizedChatCacheState {
  const input = parseInput(authoredInput);
  const result = parseMessageReminderResult(authoredResult, input);
  if (result.reconciliationStatus === "unavailable-source") {
    return rollbackOptimisticMessageReminder(
      state,
      result.messageId,
      result.idempotencyKey,
    );
  }
  return reconcileMessageReminderCanonical(
    state,
    result.conversationId,
    result.messageId,
    result.reminderRevision,
    result.reminder,
    result.idempotencyKey,
  );
}

export function reconcileMessageReminderEvent(
  state: NormalizedChatCacheState,
  payload: unknown,
): NormalizedChatCacheState {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new TypeError("message-reminder event payload required");
  }
  const value = payload as Record<string, unknown>;
  if (Object.keys(value).length !== 5 || value.operation !== "message_reminder.v1" ||
      typeof value.conversationId !== "string" || typeof value.messageId !== "string" ||
      !Number.isSafeInteger(value.reminderRevision) || (value.reminderRevision as number) < 1 ||
      typeof value.reminder !== "object" || value.reminder === null || Array.isArray(value.reminder)) {
    throw new TypeError("invalid message-reminder event payload");
  }
  const reminder = value.reminder as Record<string, unknown>;
  const revision = value.reminderRevision as number;
  const intent = reminder.state === "scheduled" ? "set" : "cancel";
  const candidate = {
    operation: "message_reminder.v1" as const,
    intent,
    conversationId: value.conversationId,
    messageId: value.messageId,
    expectedReminderRevision: revision - 1,
    idempotencyKey: "durable-message-reminder-event",
    ...(intent === "set" ? { dueAt: reminder.dueAt } : {}),
  };
  const input = intent === "set"
    ? parseSetMessageReminderInput(candidate, { referenceTime: new Date(0) })
    : parseCancelMessageReminderInput(candidate);
  const result = parseMessageReminderResult({
    operation: input.operation,
    intent: input.intent,
    reconciliationStatus: "applied",
    conversationId: input.conversationId,
    messageId: input.messageId,
    expectedReminderRevision: input.expectedReminderRevision,
    idempotencyKey: input.idempotencyKey,
    reminderRevision: revision,
    reminder: value.reminder,
  }, input);
  if (result.reconciliationStatus === "unavailable-source") {
    throw new TypeError("durable reminder event cannot be unavailable");
  }
  return reconcileMessageReminderCanonical(
    state,
    result.conversationId,
    result.messageId,
    result.reminderRevision,
    result.reminder,
  );
}

export function reconcileMessageReminderCanonical(
  state: NormalizedChatCacheState,
  conversationId: ConversationId,
  messageId: MessageId,
  reminderRevision: number,
  reminder: CanonicalMessageReminder,
  settlingIdempotencyKey?: string,
): NormalizedChatCacheState {
  const knownConversationId = state.currentUser.messageReminderConversationIds[messageId];
  if (knownConversationId !== undefined && knownConversationId !== conversationId) {
    throw new TypeError("message-reminder conversation is immutable");
  }
  const knownRevision = state.currentUser.messageReminderRevisions[messageId] ?? 0;
  const pending = state.currentUser.pendingMessageReminderUpdates[messageId];
  const existing = pending?.authoritativeReminder ?? state.currentUser.messageReminders[messageId];
  const matchingCorrelation = settlingIdempotencyKey !== undefined &&
    pending?.idempotencyKey === settlingIdempotencyKey;
  const matchingRealtimeIntent = settlingIdempotencyKey === undefined && pending !== undefined &&
    reminderRevision > pending.expectedReminderRevision && equal(pending.desiredReminder, reminder);

  if (reminderRevision < knownRevision) {
    return matchingCorrelation ? settlePending(state, messageId, existing) : state;
  }
  if (reminderRevision === knownRevision && existing !== undefined && !equal(existing, reminder)) {
    throw new TypeError("one message-reminder revision carried conflicting state");
  }

  let reminders = state.currentUser.messageReminders;
  let updates = state.currentUser.pendingMessageReminderUpdates;
  if (matchingCorrelation || matchingRealtimeIntent) {
    const next = { ...updates };
    delete next[messageId];
    updates = freezeRecord<PendingMessageReminderUpdate>(next);
    reminders = freezeRecord<CanonicalMessageReminder>({ ...reminders, [messageId]: reminder });
  } else if (pending !== undefined) {
    updates = freezeRecord<PendingMessageReminderUpdate>({
      ...updates,
      [messageId]: Object.freeze({ ...pending, authoritativeReminder: reminder }),
    });
  } else if (!equal(reminders[messageId], reminder)) {
    reminders = freezeRecord<CanonicalMessageReminder>({ ...reminders, [messageId]: reminder });
  }
  const revisions = reminderRevision === knownRevision
    ? state.currentUser.messageReminderRevisions
    : freezeRecord<number>({
        ...state.currentUser.messageReminderRevisions,
        [messageId]: reminderRevision,
      });
  const conversations = state.currentUser.messageReminderConversationIds[messageId] === conversationId
    ? state.currentUser.messageReminderConversationIds
    : freezeRecord<ConversationId>({
        ...state.currentUser.messageReminderConversationIds,
        [messageId]: conversationId,
      });
  if (reminders === state.currentUser.messageReminders &&
      updates === state.currentUser.pendingMessageReminderUpdates &&
      revisions === state.currentUser.messageReminderRevisions &&
      conversations === state.currentUser.messageReminderConversationIds) return state;
  return Object.freeze({
    ...state,
    currentUser: Object.freeze({
      ...state.currentUser,
      messageReminders: reminders,
      messageReminderRevisions: revisions,
      messageReminderConversationIds: conversations,
      pendingMessageReminderUpdates: updates,
    }),
  });
}

const settlePending = (
  state: NormalizedChatCacheState,
  messageId: MessageId,
  canonical: CanonicalMessageReminder | undefined,
): NormalizedChatCacheState => {
  const updates = { ...state.currentUser.pendingMessageReminderUpdates };
  const reminders = { ...state.currentUser.messageReminders };
  const conversations = { ...state.currentUser.messageReminderConversationIds };
  delete updates[messageId];
  if (canonical === undefined) {
    delete reminders[messageId];
    delete conversations[messageId];
  } else reminders[messageId] = canonical;
  return Object.freeze({
    ...state,
    currentUser: Object.freeze({
      ...state.currentUser,
      messageReminders: freezeRecord(reminders),
      messageReminderConversationIds: freezeRecord(conversations),
      pendingMessageReminderUpdates: freezeRecord(updates),
    }),
  });
};
