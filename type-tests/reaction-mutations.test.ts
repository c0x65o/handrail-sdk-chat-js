import {
  parseReactionMutationInput,
  parseReactionMutationResult,
  type AddReactionInput,
  type AddReactionResult,
  type ReactionMutationInput,
  type ReactionMutationResult,
  type RemoveReactionInput,
  type RemoveReactionResult,
} from "../src/contracts/reaction-mutations.js";
import type { MessageId } from "../src/contracts/identifiers.js";

const messageId = "message-1" as MessageId;

const add: AddReactionInput = {
  operation: "add_reaction",
  messageId,
  reactionKey: "👍",
  idempotencyKey: "reaction-attempt-1",
};
const remove: RemoveReactionInput = {
  operation: "remove_reaction",
  messageId,
  reactionKey: "👍",
  idempotencyKey: "reaction-attempt-2",
};

// @ts-expect-error Every reaction intent requires an idempotency key.
const addWithoutIdempotency: AddReactionInput = {
  operation: "add_reaction",
  messageId,
  reactionKey: "👍",
};

const tenantSpoof: AddReactionInput = {
  ...add,
  // @ts-expect-error Tenant identity is attached from the trusted server session.
  tenantId: "tenant-spoof",
};
const userSpoof: RemoveReactionInput = {
  ...remove,
  // @ts-expect-error User identity is attached from the trusted server session.
  userId: "user-spoof",
};
const actorSpoof: AddReactionInput = {
  ...add,
  // @ts-expect-error Actor identity is attached from the trusted server session.
  actor: { userId: "user-spoof" },
};
const actorIdSpoof: RemoveReactionInput = {
  ...remove,
  // @ts-expect-error Actor identity is attached from the trusted server session.
  actorId: "user-spoof",
};
const rolesSpoof: AddReactionInput = {
  ...add,
  // @ts-expect-error Roles are attached from the trusted server session.
  roles: ["admin"],
};

const toggle: ReactionMutationInput = {
  // @ts-expect-error Toggle is intentionally absent because retry could reverse intent.
  operation: "toggle_reaction",
  messageId,
  reactionKey: "👍",
  idempotencyKey: "reaction-attempt-3",
};

const addResult: AddReactionResult = {
  operation: "add_reaction",
  reconciliationStatus: "applied",
  messageId,
  reactionKey: "👍",
  count: 3,
  reactedByCurrentUser: true,
};
const addReplay: AddReactionResult = {
  ...addResult,
  reconciliationStatus: "replayed",
};
const removeResult: RemoveReactionResult = {
  operation: "remove_reaction",
  reconciliationStatus: "applied",
  messageId,
  reactionKey: "👍",
  count: 2,
  reactedByCurrentUser: false,
};

const incoherentAdd: AddReactionResult = {
  ...addResult,
  // @ts-expect-error An add result always reports the current user reacted.
  reactedByCurrentUser: false,
};
const incoherentRemove: RemoveReactionResult = {
  ...removeResult,
  // @ts-expect-error A remove result always reports the current user did not react.
  reactedByCurrentUser: true,
};

function reconcile(result: ReactionMutationResult): boolean {
  if (result.operation === "add_reaction") {
    const reacted: true = result.reactedByCurrentUser;
    return reacted;
  }
  const reacted: false = result.reactedByCurrentUser;
  return reacted;
}

parseReactionMutationInput(add);
parseReactionMutationInput(remove);
parseReactionMutationResult(addResult);
parseReactionMutationResult(removeResult);

void [
  addWithoutIdempotency,
  tenantSpoof,
  userSpoof,
  actorSpoof,
  actorIdSpoof,
  rolesSpoof,
  toggle,
  addReplay,
  incoherentAdd,
  incoherentRemove,
  reconcile(addResult),
];
