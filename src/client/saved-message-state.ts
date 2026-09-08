import {
  parseSetSavedMessageInput,
  parseSetSavedMessageResult,
  type CanonicalActorPrivateSavedMessageState,
  type SavedMessageMutationIntent,
  type SetSavedMessageInput,
  type SetSavedMessageResult,
} from "../contracts/saved-message-mutation.js";
import type { MessageId } from "../contracts/identifiers.js";
import type { NormalizedChatCacheState } from "./normalized-cache.js";

export type SavedMessageMutationFailure =
  | "malformed_response"
  | "transport"
  | "aborted";

export interface PendingSavedMessageUpdate {
  /** Conflicts retain the exact durable request without replaying it. */
  readonly state: "pending" | "failed" | "conflict";
  readonly messageId: MessageId;
  readonly idempotencyKey: string;
  readonly expectedSavedMessageRevision: number;
  readonly intent: SavedMessageMutationIntent;
  readonly desiredSavedMessage: CanonicalActorPrivateSavedMessageState;
  readonly authoritativeSavedMessage?: CanonicalActorPrivateSavedMessageState;
  readonly attempt: number;
  readonly retryable: boolean;
  readonly failure?: SavedMessageMutationFailure;
}

export type SavedMessageUnavailableReason = "deleted" | "inaccessible";

const freezeRecord = <Value>(
  value: Record<string, Value>,
): Readonly<Record<string, Value>> => Object.freeze(value);

const valueEqual = (left: unknown, right: unknown): boolean =>
  left === right || JSON.stringify(left) === JSON.stringify(right);

const canonicalFromInput = (
  input: SetSavedMessageInput,
): CanonicalActorPrivateSavedMessageState => Object.freeze({
  messageId: input.messageId,
  isSaved: input.intent === "save",
  ...(input.intent === "save" && input.privateNote !== undefined
    ? { privateNote: input.privateNote }
    : {}),
});

const sanitizeUnavailable = (
  state: NormalizedChatCacheState,
  savedMessage: CanonicalActorPrivateSavedMessageState,
): CanonicalActorPrivateSavedMessageState =>
  state.currentUser.savedMessageUnavailableReasons[savedMessage.messageId] ===
  undefined
    ? Object.freeze({ ...savedMessage })
    : Object.freeze({
        messageId: savedMessage.messageId,
        isSaved: savedMessage.isSaved,
      });

const isKnownAccessibleMessage = (
  state: NormalizedChatCacheState,
  messageId: MessageId,
): boolean => {
  const message = state.entities.messages[messageId];
  if (message?.content == null) return false;
  const conversation = state.entities.conversations[message.conversationId];
  if (conversation === undefined || conversation.archivedAt !== undefined) {
    return false;
  }
  if (conversation.visibility === "public") return true;
  return state.currentUser.memberships[conversation.id]?.state === "active";
};

export function beginOptimisticSavedMessage(
  state: NormalizedChatCacheState,
  authoredInput: SetSavedMessageInput,
): NormalizedChatCacheState {
  if (state.identity === null) throw new TypeError("saved-message identity required");
  const input = parseSetSavedMessageInput(authoredInput);
  const knownRevision =
    state.currentUser.savedMessageRevisions[input.messageId] ?? 0;
  if (input.expectedSavedMessageRevision !== knownRevision) {
    throw new TypeError("saved-message input does not use the authoritative revision");
  }
  const existingPending =
    state.currentUser.pendingSavedMessageUpdates[input.messageId];
  const authoritativeSavedMessage =
    existingPending === undefined
      ? state.currentUser.savedMessages[input.messageId]
      : existingPending.authoritativeSavedMessage;
  if (
    input.intent === "save" &&
    !isKnownAccessibleMessage(state, input.messageId)
  ) {
    throw new TypeError("saved-message input requires an accessible message");
  }
  const desiredSavedMessage = canonicalFromInput(input);
  const pending: PendingSavedMessageUpdate = Object.freeze({
    state: "pending",
    messageId: input.messageId,
    idempotencyKey: input.idempotencyKey,
    expectedSavedMessageRevision: input.expectedSavedMessageRevision,
    intent: input.intent,
    desiredSavedMessage,
    ...(authoritativeSavedMessage === undefined
      ? {}
      : { authoritativeSavedMessage }),
    attempt: 1,
    retryable: false,
  });
  const unavailableReasons = {
    ...state.currentUser.savedMessageUnavailableReasons,
  };
  delete unavailableReasons[input.messageId];
  return Object.freeze({
    ...state,
    currentUser: Object.freeze({
      ...state.currentUser,
      savedMessages: freezeRecord<CanonicalActorPrivateSavedMessageState>({
        ...state.currentUser.savedMessages,
        [input.messageId]: desiredSavedMessage,
      }),
      pendingSavedMessageUpdates: freezeRecord<PendingSavedMessageUpdate>({
        ...state.currentUser.pendingSavedMessageUpdates,
        [input.messageId]: pending,
      }),
      savedMessageUnavailableReasons:
        freezeRecord<SavedMessageUnavailableReason>(unavailableReasons),
    }),
  });
}

export function retryOptimisticSavedMessage(
  state: NormalizedChatCacheState,
  messageId: MessageId,
  idempotencyKey: string,
): NormalizedChatCacheState {
  if (state.identity === null) throw new TypeError("saved-message identity required");
  const pending = state.currentUser.pendingSavedMessageUpdates[messageId];
  if (
    pending?.idempotencyKey !== idempotencyKey ||
    pending.state !== "failed" ||
    !pending.retryable
  ) {
    throw new TypeError("saved-message update is not retryable");
  }
  const { failure: _failure, ...pendingWithoutFailure } = pending;
  const retried: PendingSavedMessageUpdate = Object.freeze({
    ...pendingWithoutFailure,
    state: "pending",
    attempt: pending.attempt + 1,
    retryable: false,
  });
  return Object.freeze({
    ...state,
    currentUser: Object.freeze({
      ...state.currentUser,
      pendingSavedMessageUpdates: freezeRecord<PendingSavedMessageUpdate>({
        ...state.currentUser.pendingSavedMessageUpdates,
        [messageId]: retried,
      }),
    }),
  });
}

export function failOptimisticSavedMessage(
  state: NormalizedChatCacheState,
  messageId: MessageId,
  idempotencyKey: string,
  failure: SavedMessageMutationFailure,
): NormalizedChatCacheState {
  const pending = state.currentUser.pendingSavedMessageUpdates[messageId];
  if (pending?.idempotencyKey !== idempotencyKey) return state;
  return Object.freeze({
    ...state,
    currentUser: Object.freeze({
      ...state.currentUser,
      pendingSavedMessageUpdates: freezeRecord<PendingSavedMessageUpdate>({
        ...state.currentUser.pendingSavedMessageUpdates,
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

export function markSavedMessageConflict(
  state: NormalizedChatCacheState,
  authoredInput: SetSavedMessageInput,
): NormalizedChatCacheState {
  if (state.identity === null) throw new TypeError("saved-message identity required");
  const input = parseSetSavedMessageInput(authoredInput);
  const knownRevision = state.currentUser.savedMessageRevisions[input.messageId] ?? 0;
  const existing = state.currentUser.pendingSavedMessageUpdates[input.messageId];
  const authoritativeSavedMessage = existing?.authoritativeSavedMessage ??
    state.currentUser.savedMessages[input.messageId];
  if (
    knownRevision <= input.expectedSavedMessageRevision ||
    authoritativeSavedMessage === undefined
  ) {
    throw new TypeError(
      "saved-message conflict requires a newer authoritative state",
    );
  }
  const conflict: PendingSavedMessageUpdate = Object.freeze({
    state: "conflict",
    messageId: input.messageId,
    idempotencyKey: input.idempotencyKey,
    expectedSavedMessageRevision: input.expectedSavedMessageRevision,
    intent: input.intent,
    desiredSavedMessage: canonicalFromInput(input),
    authoritativeSavedMessage,
    attempt: existing?.attempt ?? 1,
    retryable: false,
  });
  return Object.freeze({
    ...state,
    currentUser: Object.freeze({
      ...state.currentUser,
      savedMessages: freezeRecord<CanonicalActorPrivateSavedMessageState>({
        ...state.currentUser.savedMessages,
        [input.messageId]: authoritativeSavedMessage,
      }),
      pendingSavedMessageUpdates: freezeRecord<PendingSavedMessageUpdate>({
        ...state.currentUser.pendingSavedMessageUpdates,
        [input.messageId]: conflict,
      }),
    }),
  });
}

/** Records a trusted actor-private authority observation without settling by key. */
export function reconcileSavedMessageAuthority(
  state: NormalizedChatCacheState,
  messageId: MessageId,
  savedMessageRevision: number,
  savedMessage: CanonicalActorPrivateSavedMessageState,
): NormalizedChatCacheState {
  if (state.identity === null) throw new TypeError("saved-message identity required");
  if (
    !Number.isSafeInteger(savedMessageRevision) ||
    savedMessageRevision < 0 ||
    savedMessage.messageId !== messageId
  ) throw new TypeError("invalid saved-message authority");
  return reconcileSavedMessageCanonical(
    state,
    messageId,
    savedMessageRevision,
    savedMessage,
  );
}

export function rollbackOptimisticSavedMessage(
  state: NormalizedChatCacheState,
  messageId: MessageId,
  idempotencyKey: string,
): NormalizedChatCacheState {
  const pending = state.currentUser.pendingSavedMessageUpdates[messageId];
  if (pending?.idempotencyKey !== idempotencyKey) return state;
  const pendingUpdates = { ...state.currentUser.pendingSavedMessageUpdates };
  delete pendingUpdates[messageId];
  const savedMessages = { ...state.currentUser.savedMessages };
  if (pending.authoritativeSavedMessage === undefined) delete savedMessages[messageId];
  else savedMessages[messageId] = pending.authoritativeSavedMessage;
  return Object.freeze({
    ...state,
    currentUser: Object.freeze({
      ...state.currentUser,
      savedMessages:
        freezeRecord<CanonicalActorPrivateSavedMessageState>(savedMessages),
      pendingSavedMessageUpdates:
        freezeRecord<PendingSavedMessageUpdate>(pendingUpdates),
    }),
  });
}

export function reconcileCurrentUserSavedMessageMutation(
  state: NormalizedChatCacheState,
  authoredInput: SetSavedMessageInput,
  authoredResult: SetSavedMessageResult,
): NormalizedChatCacheState {
  if (state.identity === null) throw new TypeError("saved-message identity required");
  const input = parseSetSavedMessageInput(authoredInput);
  const result = parseSetSavedMessageResult(authoredResult, input);
  return reconcileSavedMessageCanonical(
    state,
    result.messageId,
    result.savedMessageRevision,
    result.savedMessage,
    result.idempotencyKey,
  );
}

export function reconcileSavedMessageEvent(
  state: NormalizedChatCacheState,
  payload: unknown,
): NormalizedChatCacheState {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new TypeError("saved-message event payload required");
  }
  const record = payload as Record<string, unknown>;
  if (
    Object.keys(record).length !== 4 ||
    record.operation !== "set_saved_message" ||
    typeof record.messageId !== "string" ||
    !Number.isSafeInteger(record.savedMessageRevision) ||
    (record.savedMessageRevision as number) < 1 ||
    typeof record.savedMessage !== "object" ||
    record.savedMessage === null ||
    Array.isArray(record.savedMessage)
  ) {
    throw new TypeError("invalid saved-message event payload");
  }
  const savedMessage = record.savedMessage as Record<string, unknown>;
  const intent = savedMessage.isSaved === true ? "save" : "unsave";
  const revision = record.savedMessageRevision as number;
  const input = parseSetSavedMessageInput({
    operation: "set_saved_message",
    intent,
    messageId: record.messageId,
    expectedSavedMessageRevision: revision - 1,
    idempotencyKey: "durable-saved-message-event",
    ...(intent === "save" && savedMessage.privateNote !== undefined
      ? { privateNote: savedMessage.privateNote }
      : {}),
  });
  const result = parseSetSavedMessageResult(
    {
      operation: "set_saved_message",
      intent,
      reconciliationStatus: "applied",
      messageId: record.messageId,
      expectedSavedMessageRevision: revision - 1,
      idempotencyKey: input.idempotencyKey,
      savedMessageRevision: revision,
      savedMessage: record.savedMessage,
    },
    input,
  );
  return reconcileSavedMessageCanonical(
    state,
    result.messageId,
    result.savedMessageRevision,
    result.savedMessage,
  );
}

function reconcileSavedMessageCanonical(
  state: NormalizedChatCacheState,
  messageId: MessageId,
  savedMessageRevision: number,
  authoredSavedMessage: CanonicalActorPrivateSavedMessageState,
  settlingIdempotencyKey?: string,
): NormalizedChatCacheState {
  const savedMessage = sanitizeUnavailable(state, authoredSavedMessage);
  const knownRevision = state.currentUser.savedMessageRevisions[messageId] ?? 0;
  const pending = state.currentUser.pendingSavedMessageUpdates[messageId];
  const existing = pending?.authoritativeSavedMessage ??
    state.currentUser.savedMessages[messageId];
  const matchingPending = settlingIdempotencyKey !== undefined &&
    pending?.idempotencyKey === settlingIdempotencyKey;

  if (savedMessageRevision < knownRevision) {
    return matchingPending
      ? settlePendingWithCanonical(state, messageId, existing)
      : state;
  }
  if (
    savedMessageRevision === knownRevision &&
    existing !== undefined &&
    !valueEqual(sanitizeUnavailable(state, existing), savedMessage)
  ) {
    throw new TypeError("one saved-message revision carried conflicting state");
  }

  let savedMessages = state.currentUser.savedMessages;
  let pendingUpdates = state.currentUser.pendingSavedMessageUpdates;
  if (matchingPending) {
    const nextPending = { ...pendingUpdates };
    delete nextPending[messageId];
    pendingUpdates = freezeRecord<PendingSavedMessageUpdate>(nextPending);
    if (!valueEqual(savedMessages[messageId], savedMessage)) {
      savedMessages = freezeRecord<CanonicalActorPrivateSavedMessageState>({
        ...savedMessages,
        [messageId]: savedMessage,
      });
    }
  } else if (pending !== undefined) {
    if (!valueEqual(pending.authoritativeSavedMessage, savedMessage)) {
      pendingUpdates = freezeRecord<PendingSavedMessageUpdate>({
        ...pendingUpdates,
        [messageId]: Object.freeze({
          ...pending,
          authoritativeSavedMessage: savedMessage,
        }),
      });
    }
  } else if (!valueEqual(savedMessages[messageId], savedMessage)) {
    savedMessages = freezeRecord<CanonicalActorPrivateSavedMessageState>({
      ...savedMessages,
      [messageId]: savedMessage,
    });
  }
  const revisions = knownRevision === savedMessageRevision
    ? state.currentUser.savedMessageRevisions
    : freezeRecord<number>({
        ...state.currentUser.savedMessageRevisions,
        [messageId]: savedMessageRevision,
      });
  if (
    savedMessages === state.currentUser.savedMessages &&
    pendingUpdates === state.currentUser.pendingSavedMessageUpdates &&
    revisions === state.currentUser.savedMessageRevisions
  ) return state;
  return Object.freeze({
    ...state,
    currentUser: Object.freeze({
      ...state.currentUser,
      savedMessages,
      savedMessageRevisions: revisions,
      pendingSavedMessageUpdates: pendingUpdates,
    }),
  });
}

const settlePendingWithCanonical = (
  state: NormalizedChatCacheState,
  messageId: MessageId,
  canonical: CanonicalActorPrivateSavedMessageState | undefined,
): NormalizedChatCacheState => {
  const pendingUpdates = { ...state.currentUser.pendingSavedMessageUpdates };
  delete pendingUpdates[messageId];
  const savedMessages = { ...state.currentUser.savedMessages };
  if (canonical === undefined) delete savedMessages[messageId];
  else savedMessages[messageId] = sanitizeUnavailable(state, canonical);
  return Object.freeze({
    ...state,
    currentUser: Object.freeze({
      ...state.currentUser,
      savedMessages:
        freezeRecord<CanonicalActorPrivateSavedMessageState>(savedMessages),
      pendingSavedMessageUpdates:
        freezeRecord<PendingSavedMessageUpdate>(pendingUpdates),
    }),
  });
};

export function markSavedMessageUnavailable(
  state: NormalizedChatCacheState,
  messageId: MessageId,
  reason: SavedMessageUnavailableReason,
): NormalizedChatCacheState {
  const current = state.currentUser.savedMessages[messageId];
  const pending = state.currentUser.pendingSavedMessageUpdates[messageId];
  if (
    current === undefined &&
    pending === undefined &&
    state.currentUser.savedMessageRevisions[messageId] === undefined
  ) return state;
  const pendingUpdates = { ...state.currentUser.pendingSavedMessageUpdates };
  delete pendingUpdates[messageId];
  const savedMessages = { ...state.currentUser.savedMessages };
  const canonical = pending?.authoritativeSavedMessage ?? current;
  if (canonical === undefined) delete savedMessages[messageId];
  else savedMessages[messageId] = Object.freeze({
    messageId,
    isSaved: canonical.isSaved,
  });
  return Object.freeze({
    ...state,
    currentUser: Object.freeze({
      ...state.currentUser,
      savedMessages:
        freezeRecord<CanonicalActorPrivateSavedMessageState>(savedMessages),
      pendingSavedMessageUpdates:
        freezeRecord<PendingSavedMessageUpdate>(pendingUpdates),
      savedMessageUnavailableReasons: freezeRecord<SavedMessageUnavailableReason>({
        ...state.currentUser.savedMessageUnavailableReasons,
        [messageId]: reason,
      }),
    }),
  });
}

export function markConversationSavedMessagesUnavailable(
  state: NormalizedChatCacheState,
  conversationId: string,
): NormalizedChatCacheState {
  let next = state;
  for (const message of Object.values(state.entities.messages)) {
    if (message.conversationId === conversationId) {
      next = markSavedMessageUnavailable(next, message.id, "inaccessible");
    }
  }
  return next;
}
