import type { ReadCursorMutationInput } from "../../../dist/index.js";
declare const rawHttpBody: unknown;
declare const request: ReadCursorMutationInput;
declare const actorUserId: string;
declare const eventMetadata: Omit<Parameters<typeof createReadCursorUpdatedEvent>[0], "result">;
import {
  parseReadCursorMutationOutcome,
  parseReadCursorMutationResult,
  createReadCursorUpdatedEvent,
} from "../../../dist/index.js";

// rawHttpBody, request, actorUserId and eventMetadata come from the host.
const outcome = parseReadCursorMutationOutcome(rawHttpBody, request);
if (outcome.readState.userId !== actorUserId) {
  throw new Error("Read acknowledgement user does not match the actor");
}
const result = parseReadCursorMutationResult({
  operation: outcome.operation,
  conversationId: outcome.conversationId,
  readState: outcome.readState,
  latestSequence: outcome.latestSequence,
  unreadCount: outcome.unreadCount,
});
// eventMetadata contains eventId, protocolVersion, tenantId and occurredAt.
const event = createReadCursorUpdatedEvent({ ...eventMetadata, result });
