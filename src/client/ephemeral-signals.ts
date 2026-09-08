import type {
  EphemeralSignalEvent,
  PresenceSignalEvent,
  TypingSignalEvent,
} from "../contracts/ephemeral-signals.js";

export interface EphemeralSignalState {
  readonly typing: Readonly<Record<string, TypingSignalEvent>>;
  readonly presence: Readonly<Record<string, PresenceSignalEvent>>;
}

export const EMPTY_EPHEMERAL_SIGNAL_STATE: EphemeralSignalState = Object.freeze({
  typing: Object.freeze({}),
  presence: Object.freeze({}),
});

/** Removes entries whose expiresAt is at or before the injected timestamp. */
export function expireEphemeralSignals(
  state: EphemeralSignalState,
  now: number,
): EphemeralSignalState {
  assertFiniteNow(now);
  const typing = retainLive(state.typing, now);
  const presence = retainLive(state.presence, now);
  if (typing === state.typing && presence === state.presence) {
    return state;
  }
  return { typing, presence };
}

/**
 * Accepts only a live signal newer than the current actor/device/session entry.
 * Equal timestamps are also ignored so replayed duplicates remain idempotent.
 */
export function reduceEphemeralSignal(
  state: EphemeralSignalState,
  event: EphemeralSignalEvent,
  now: number,
): EphemeralSignalState {
  const liveState = expireEphemeralSignals(state, now);
  if (Date.parse(event.payload.expiresAt) <= now) {
    return liveState;
  }

  if (event.type === "typing.signal") {
    const key = typingSignalKey(event);
    const accepted = liveState.typing[key];
    if (accepted !== undefined && compareSentAt(event, accepted) <= 0) {
      return liveState;
    }
    return {
      typing: { ...liveState.typing, [key]: event },
      presence: liveState.presence,
    };
  }

  const key = presenceSignalKey(event);
  const accepted = liveState.presence[key];
  if (accepted !== undefined && compareSentAt(event, accepted) <= 0) {
    return liveState;
  }
  return {
    typing: liveState.typing,
    presence: { ...liveState.presence, [key]: event },
  };
}

export function typingSignalKey(event: TypingSignalEvent): string {
  const { payload, tenantId } = event;
  return JSON.stringify([
    tenantId,
    payload.scope.conversationId,
    payload.actorUserId,
    payload.deviceId,
    payload.sessionId,
  ]);
}

export function presenceSignalKey(event: PresenceSignalEvent): string {
  const { payload, tenantId } = event;
  return JSON.stringify([
    tenantId,
    payload.scope.userId,
    payload.actorUserId,
    payload.deviceId,
    payload.sessionId,
  ]);
}

function retainLive<Event extends EphemeralSignalEvent>(
  entries: Readonly<Record<string, Event>>,
  now: number,
): Readonly<Record<string, Event>> {
  const liveEntries = Object.entries(entries).filter(
    ([, event]) => Date.parse(event.payload.expiresAt) > now,
  );
  if (liveEntries.length === Object.keys(entries).length) {
    return entries;
  }
  return Object.fromEntries(liveEntries) as Readonly<Record<string, Event>>;
}

function compareSentAt(
  incoming: EphemeralSignalEvent,
  accepted: EphemeralSignalEvent,
): number {
  return (
    Date.parse(incoming.payload.sentAt) - Date.parse(accepted.payload.sentAt)
  );
}

function assertFiniteNow(now: number): void {
  if (!Number.isFinite(now)) {
    throw new TypeError("now must be a finite millisecond timestamp");
  }
}
