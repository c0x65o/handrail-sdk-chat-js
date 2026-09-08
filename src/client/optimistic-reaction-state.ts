import {
  parseReactionMutationInput,
  parseReactionMutationResult,
  type ReactionMutationInput,
  type ReactionMutationResult,
} from "../contracts/reaction-mutations.js";
import type {
  MessageReactionAggregate,
} from "../contracts/message-timeline.js";
import type { MessageId } from "../contracts/identifiers.js";
import type {
  ChatTimelineMessage,
  NormalizedChatCacheState,
} from "./normalized-cache.js";

interface ReactionIntent {
  readonly sequence: number;
  readonly idempotencyKey: string;
  readonly desired: boolean;
}

interface ReactionTarget {
  readonly messageId: MessageId;
  readonly reactionKey: string;
  canonical: MessageReactionAggregate | undefined;
  current: ReactionIntent | undefined;
  outstanding: ReactionIntent[];
  readonly completed: Set<string>;
  nextSequence: number;
}

const COMPLETED_KEY_LIMIT = 64;

const targetKey = (messageId: string, reactionKey: string): string =>
  JSON.stringify([messageId, reactionKey]);

const aggregateFromResult = (
  result: ReactionMutationResult,
): MessageReactionAggregate | undefined =>
  result.count === 0
    ? undefined
    : Object.freeze({
        reactionKey: result.reactionKey,
        count: result.count,
        reactedByCurrentUser: result.reactedByCurrentUser,
      });

const sameAggregate = (
  left: MessageReactionAggregate | undefined,
  right: MessageReactionAggregate | undefined,
): boolean =>
  left === right ||
  (left !== undefined &&
    right !== undefined &&
    left.reactionKey === right.reactionKey &&
    left.count === right.count &&
    left.reactedByCurrentUser === right.reactedByCurrentUser);

const rememberCompleted = (target: ReactionTarget, idempotencyKey: string): void => {
  target.completed.add(idempotencyKey);
  if (target.completed.size <= COMPLETED_KEY_LIMIT) return;
  const oldest = target.completed.values().next().value as string | undefined;
  if (oldest !== undefined) target.completed.delete(oldest);
};

const projectAggregate = (
  canonical: MessageReactionAggregate | undefined,
  reactionKey: string,
  desired: boolean | undefined,
): MessageReactionAggregate | undefined => {
  if (desired === undefined) return canonical;
  const canonicalCount = canonical?.count ?? 0;
  const canonicalReacted = canonical?.reactedByCurrentUser ?? false;
  const count = canonicalCount + (desired === canonicalReacted ? 0 : desired ? 1 : -1);
  return count === 0
    ? undefined
    : Object.freeze({ reactionKey, count, reactedByCurrentUser: desired });
};

const replaceProjectedAggregate = (
  state: NormalizedChatCacheState,
  target: ReactionTarget,
): NormalizedChatCacheState => {
  const message = state.entities.messages[target.messageId];
  if (message === undefined) return state;
  const aggregate = projectAggregate(
    target.canonical,
    target.reactionKey,
    target.current?.desired,
  );
  const existing = message.reactions.find(
    (reaction) => reaction.reactionKey === target.reactionKey,
  );
  if (sameAggregate(existing, aggregate)) return state;

  const reactions = message.reactions.filter(
    (reaction) => reaction.reactionKey !== target.reactionKey,
  );
  if (aggregate !== undefined) reactions.push(aggregate);
  reactions.sort((left, right) => left.reactionKey.localeCompare(right.reactionKey));
  const projected = Object.freeze({
    ...message,
    reactions: Object.freeze(reactions),
  }) as ChatTimelineMessage;
  return Object.freeze({
    ...state,
    entities: Object.freeze({
      ...state.entities,
      messages: Object.freeze({
        ...state.entities.messages,
        [message.id]: projected,
      }),
    }),
  });
};

/**
 * Keeps transport correlation out of renderer-facing message values while
 * retaining a canonical baseline beneath the latest optimistic desired state.
 */
export class OptimisticReactionStateMachine {
  readonly #targets = new Map<string, ReactionTarget>();

  clear(): void {
    this.#targets.clear();
  }

  begin(
    state: NormalizedChatCacheState,
    rawInput: ReactionMutationInput,
  ): NormalizedChatCacheState {
    const input = parseReactionMutationInput(rawInput);
    const identity = state.identity;
    const message = state.entities.messages[input.messageId];
    if (identity === null || message === undefined || message.tenantId !== identity.tenantId) {
      throw new TypeError("A canonical message in the current cache identity is required");
    }

    const key = targetKey(input.messageId, input.reactionKey);
    let target = this.#targets.get(key);
    if (target === undefined) {
      target = {
        messageId: input.messageId,
        reactionKey: input.reactionKey,
        canonical: message.reactions.find(
          (reaction) => reaction.reactionKey === input.reactionKey,
        ),
        current: undefined,
        outstanding: [],
        completed: new Set(),
        nextSequence: 1,
      };
      this.#targets.set(key, target);
    }

    const intent = Object.freeze({
      sequence: target.nextSequence++,
      idempotencyKey: input.idempotencyKey,
      desired: input.operation === "add_reaction",
    });
    target.outstanding.push(intent);
    target.current = intent;
    return replaceProjectedAggregate(state, target);
  }

  reconcile(
    state: NormalizedChatCacheState,
    idempotencyKey: string,
    rawResult: ReactionMutationResult,
  ): NormalizedChatCacheState {
    const result = parseReactionMutationResult(rawResult);
    const target = this.#targets.get(targetKey(result.messageId, result.reactionKey));
    if (target === undefined || target.completed.has(idempotencyKey)) return state;
    const intent = target.outstanding.find(
      (candidate) => candidate.idempotencyKey === idempotencyKey,
    );
    if (intent === undefined) return state;
    if (intent.desired !== result.reactedByCurrentUser) {
      throw new TypeError("The reaction result does not match its optimistic intent");
    }

    target.canonical = aggregateFromResult(result);
    target.outstanding = target.outstanding.filter(
      (candidate) => candidate.idempotencyKey !== idempotencyKey,
    );
    if (target.current?.idempotencyKey === idempotencyKey) target.current = undefined;
    rememberCompleted(target, idempotencyKey);
    return replaceProjectedAggregate(state, target);
  }

  rollback(
    state: NormalizedChatCacheState,
    messageId: MessageId,
    reactionKey: string,
    idempotencyKey: string,
  ): NormalizedChatCacheState {
    const target = this.#targets.get(targetKey(messageId, reactionKey));
    if (target === undefined || target.completed.has(idempotencyKey)) return state;
    if (!target.outstanding.some((intent) => intent.idempotencyKey === idempotencyKey)) {
      return state;
    }
    target.outstanding = target.outstanding.filter(
      (intent) => intent.idempotencyKey !== idempotencyKey,
    );
    if (target.current?.idempotencyKey === idempotencyKey) target.current = undefined;
    rememberCompleted(target, idempotencyKey);
    return replaceProjectedAggregate(state, target);
  }

  applyDurableEvent(
    state: NormalizedChatCacheState,
    event: { readonly type: string; readonly payload: unknown },
  ): NormalizedChatCacheState {
    if (event.type !== "reaction.updated") return state;
    const payload = event.payload;
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return state;
    }
    const { conversationId: _conversationId, ...resultPayload } = payload as Record<string, unknown>;
    const result = parseReactionMutationResult({
      ...resultPayload,
      reconciliationStatus: "applied",
    });
    const target = this.#targets.get(targetKey(result.messageId, result.reactionKey));
    if (target === undefined) return state;

    // Broadcasts lack actor/key correlation, so they cannot settle viewer intents.
    target.canonical = result.count === 0
      ? undefined
      : Object.freeze({
          reactionKey: result.reactionKey,
          count: result.count,
          reactedByCurrentUser: target.canonical?.reactedByCurrentUser ?? false,
        });
    return replaceProjectedAggregate(state, target);
  }
}
