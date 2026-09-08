import type {
  ConversationId,
  IsoTimestamp,
  TenantScopedId,
  UserId,
} from "./identifiers.js";

const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Matches the persisted idempotency-key UTF-8 bound used by chat commands. */
export const MAX_HUDDLE_IDEMPOTENCY_KEY_UTF8_BYTES = 255;
/** Keeps the public descriptor opaque while preventing unbounded payloads. */
export const MAX_HUDDLE_MEDIA_JOIN_DESCRIPTOR_UTF8_BYTES = 4_096;
/** Public join material must expire shortly after it is issued. */
export const MAX_HUDDLE_MEDIA_JOIN_DESCRIPTOR_TTL_MS = 5 * 60_000;

export type HuddleSessionId = TenantScopedId<"huddle_session">;

export interface HuddleJoinedParticipant {
  readonly userId: UserId;
  readonly status: "joined";
  readonly joinedAt: IsoTimestamp;
  readonly leftAt?: never;
}

export interface HuddleLeftParticipant {
  readonly userId: UserId;
  readonly status: "left";
  readonly joinedAt: IsoTimestamp;
  readonly leftAt: IsoTimestamp;
}

export type HuddleParticipant =
  | HuddleJoinedParticipant
  | HuddleLeftParticipant;

export interface InactiveHuddleState {
  readonly status: "inactive";
  readonly conversationId: ConversationId;
}

interface LiveHuddleStateBase {
  readonly conversationId: ConversationId;
  readonly huddleSessionId: HuddleSessionId;
  readonly startedAt: IsoTimestamp;
  readonly participants: readonly HuddleParticipant[];
  /** A single canonical owner makes concurrent screen sharing unrepresentable. */
  readonly screenShareOwnerUserId: UserId | null;
  readonly endedAt?: never;
  readonly endedByUserId?: never;
}

export interface StartingHuddleState extends LiveHuddleStateBase {
  readonly status: "starting";
}

export interface ActiveHuddleState extends LiveHuddleStateBase {
  readonly status: "active";
}

export interface EndedHuddleState {
  readonly status: "ended";
  readonly conversationId: ConversationId;
  readonly huddleSessionId: HuddleSessionId;
  readonly startedAt: IsoTimestamp;
  readonly endedAt: IsoTimestamp;
  readonly endedByUserId: UserId;
  readonly participants: readonly HuddleLeftParticipant[];
  readonly screenShareOwnerUserId: null;
}

export type HuddleSessionState =
  | InactiveHuddleState
  | StartingHuddleState
  | ActiveHuddleState
  | EndedHuddleState;

/** Provider-neutral, opaque material handed directly to a media client. */
export interface HuddleMediaJoinDescriptor {
  readonly kind: "opaque_media_join";
  readonly descriptor: string;
  readonly expiresAt: IsoTimestamp;
}

/** Compile-time guard for all identity, authorization, and provider data. */
export interface NoTrustedHuddleCommandContext {
  readonly tenant?: never;
  readonly tenantId?: never;
  readonly organization?: never;
  readonly organizationId?: never;
  readonly actor?: never;
  readonly actorId?: never;
  readonly actorUserId?: never;
  readonly currentUser?: never;
  readonly currentUserId?: never;
  readonly user?: never;
  readonly userId?: never;
  readonly roles?: never;
  readonly role?: never;
  readonly capabilities?: never;
  readonly capability?: never;
  readonly permissions?: never;
  readonly permission?: never;
  readonly auth?: never;
  readonly authorization?: never;
  readonly mediaProvider?: never;
  readonly mediaProviderId?: never;
  readonly provider?: never;
  readonly providerId?: never;
  readonly credentials?: never;
  readonly credential?: never;
  readonly apiKey?: never;
  readonly secret?: never;
  readonly clientSecret?: never;
  readonly roomId?: never;
  readonly roomToken?: never;
  readonly token?: never;
  readonly accessToken?: never;
  readonly refreshToken?: never;
  readonly endpoint?: never;
  readonly providerConfiguration?: never;
  readonly mediaConfiguration?: never;
}

interface HuddleCommandInputBase<Operation extends string>
  extends NoTrustedHuddleCommandContext {
  readonly operation: Operation;
  readonly idempotencyKey: string;
}

export interface StartHuddleInput
  extends HuddleCommandInputBase<"start_huddle"> {
  readonly conversationId: ConversationId;
}

export interface JoinHuddleInput
  extends HuddleCommandInputBase<"join_huddle"> {
  readonly huddleSessionId: HuddleSessionId;
}

export interface LeaveHuddleInput
  extends HuddleCommandInputBase<"leave_huddle"> {
  readonly huddleSessionId: HuddleSessionId;
}

export type HuddleScreenShareIntent = "set" | "clear";

export interface SetHuddleScreenShareInput
  extends HuddleCommandInputBase<"set_huddle_screen_share"> {
  readonly huddleSessionId: HuddleSessionId;
  readonly intent: HuddleScreenShareIntent;
}

export interface EndHuddleInput
  extends HuddleCommandInputBase<"end_huddle"> {
  readonly huddleSessionId: HuddleSessionId;
}

export type HuddleCommandInput =
  | StartHuddleInput
  | JoinHuddleInput
  | LeaveHuddleInput
  | SetHuddleScreenShareInput
  | EndHuddleInput;
export type HuddleCommandOperation = HuddleCommandInput["operation"];
export type HuddleReconciliationStatus = "applied" | "replayed";

interface HuddleCommandResultBase<
  Operation extends HuddleCommandOperation,
  State extends HuddleSessionState,
> {
  readonly operation: Operation;
  readonly outcome: "ok";
  readonly reconciliationStatus: HuddleReconciliationStatus;
  readonly state: State;
}

export interface StartHuddleResult
  extends HuddleCommandResultBase<"start_huddle", StartingHuddleState> {
  readonly mediaJoin: HuddleMediaJoinDescriptor;
}

export interface JoinHuddleResult
  extends HuddleCommandResultBase<"join_huddle", ActiveHuddleState> {
  readonly mediaJoin: HuddleMediaJoinDescriptor;
}

export type LeaveHuddleResult = HuddleCommandResultBase<
  "leave_huddle",
  ActiveHuddleState
>;

export type SetHuddleScreenShareResult = HuddleCommandResultBase<
  "set_huddle_screen_share",
  ActiveHuddleState
>;

export type EndHuddleResult = HuddleCommandResultBase<
  "end_huddle",
  EndedHuddleState
>;

export interface HuddleFeatureDisabledResult {
  readonly operation: "start_huddle" | "join_huddle";
  readonly outcome: "feature_disabled";
  readonly reconciliationStatus: HuddleReconciliationStatus;
  readonly feature: "huddles";
  readonly reason: "media_unavailable";
  readonly state: HuddleSessionState;
}

export type HuddleCommandResult =
  | StartHuddleResult
  | JoinHuddleResult
  | LeaveHuddleResult
  | SetHuddleScreenShareResult
  | EndHuddleResult
  | HuddleFeatureDisabledResult;

export interface HuddleParseOptions {
  /** Deterministic clock used for validating short-lived join material. */
  readonly now?: number | Date | IsoTimestamp;
  /** Trusted state immediately before an applied command. */
  readonly previousState?: HuddleSessionState;
  /** Original accepted result when validating an idempotent replay. */
  readonly replayOf?: HuddleCommandResult;
}

export type HuddleContractErrorCode =
  | "malformed_input"
  | "trusted_context_field"
  | "provider_field"
  | "malformed_state"
  | "incoherent_state"
  | "invalid_transition"
  | "malformed_descriptor"
  | "expired_descriptor"
  | "malformed_result"
  | "incoherent_result"
  | "replay_mismatch";

export class HuddleContractError extends Error {
  readonly code: HuddleContractErrorCode;

  constructor(code: HuddleContractErrorCode, message: string) {
    super(message);
    this.name = "HuddleContractError";
    this.code = code;
  }
}

const TRUSTED_CONTEXT_FIELDS = new Set([
  "tenant", "tenantid", "organization", "organizationid", "actor",
  "actorid", "actorcontext", "actoruserid", "currentactor",
  "currentactorid", "currentuser", "currentuserid", "user", "userid",
  "principal", "principalid", "subject", "subjectid", "identity", "session",
  "auth", "authorization", "role", "roles", "capability", "capabilities",
  "permission", "permissions",
]);

const PROVIDER_FIELDS = new Set([
  "provider", "providerid", "providername", "mediaprovider",
  "mediaproviderid", "mediaprovidername", "credential", "credentials",
  "apikey", "secret", "clientsecret", "roomid", "roomtoken", "token",
  "accesstoken", "refreshtoken", "endpoint", "providerconfiguration",
  "mediaconfiguration", "rawproviderconfiguration",
]);

const OPERATION_KEYS = {
  start_huddle: ["operation", "conversationId", "idempotencyKey"],
  join_huddle: ["operation", "huddleSessionId", "idempotencyKey"],
  leave_huddle: ["operation", "huddleSessionId", "idempotencyKey"],
  set_huddle_screen_share: [
    "operation", "huddleSessionId", "intent", "idempotencyKey",
  ],
  end_huddle: ["operation", "huddleSessionId", "idempotencyKey"],
} as const;

export function parseHuddleCommandInput(value: unknown): HuddleCommandInput {
  rejectServerDerivedFields(value);
  const input = requireRecord(value, "input", "malformed_input");
  const operation = readOperation(input.operation, "malformed_input");
  assertExactKeys(input, OPERATION_KEYS[operation], "input", "malformed_input");
  const idempotencyKey = readBoundedNonblankString(
    input.idempotencyKey,
    "input.idempotencyKey",
    MAX_HUDDLE_IDEMPOTENCY_KEY_UTF8_BYTES,
    "malformed_input",
  );

  if (operation === "start_huddle") {
    return {
      operation,
      conversationId: readId(input.conversationId, "input.conversationId") as ConversationId,
      idempotencyKey,
    };
  }
  const huddleSessionId = readId(
    input.huddleSessionId,
    "input.huddleSessionId",
  ) as HuddleSessionId;
  if (operation === "set_huddle_screen_share") {
    if (input.intent !== "set" && input.intent !== "clear") {
      throw contractError(
        "malformed_input",
        "input.intent must be set or clear",
      );
    }
    return { operation, huddleSessionId, intent: input.intent, idempotencyKey };
  }
  return { operation, huddleSessionId, idempotencyKey } as HuddleCommandInput;
}

export function parseStartHuddleInput(value: unknown): StartHuddleInput {
  return requireInputOperation(parseHuddleCommandInput(value), "start_huddle");
}

export function parseJoinHuddleInput(value: unknown): JoinHuddleInput {
  return requireInputOperation(parseHuddleCommandInput(value), "join_huddle");
}

export function parseLeaveHuddleInput(value: unknown): LeaveHuddleInput {
  return requireInputOperation(parseHuddleCommandInput(value), "leave_huddle");
}

export function parseSetHuddleScreenShareInput(
  value: unknown,
): SetHuddleScreenShareInput {
  return requireInputOperation(
    parseHuddleCommandInput(value),
    "set_huddle_screen_share",
  );
}

export function parseEndHuddleInput(value: unknown): EndHuddleInput {
  return requireInputOperation(parseHuddleCommandInput(value), "end_huddle");
}

export function parseHuddleSessionState(value: unknown): HuddleSessionState {
  const state = requireRecord(value, "state", "malformed_state");
  const conversationId = readId(
    state.conversationId,
    "state.conversationId",
    "malformed_state",
  ) as ConversationId;

  if (state.status === "inactive") {
    assertExactKeys(state, ["status", "conversationId"], "state", "malformed_state");
    return { status: "inactive", conversationId };
  }
  if (state.status !== "starting" && state.status !== "active" && state.status !== "ended") {
    throw contractError(
      "malformed_state",
      "state.status must be inactive, starting, active, or ended",
    );
  }

  assertExactKeys(
    state,
    state.status === "ended"
      ? [
          "status", "conversationId", "huddleSessionId", "startedAt",
          "endedAt", "endedByUserId", "participants", "screenShareOwnerUserId",
        ]
      : [
          "status", "conversationId", "huddleSessionId", "startedAt",
          "participants", "screenShareOwnerUserId",
        ],
    "state",
    "malformed_state",
  );

  const huddleSessionId = readId(
    state.huddleSessionId,
    "state.huddleSessionId",
    "malformed_state",
  ) as HuddleSessionId;
  const startedAt = readIsoTimestamp(state.startedAt, "state.startedAt", "malformed_state");
  const participants = parseParticipants(state.participants);
  for (const participant of participants) {
    if (timestamp(participant.joinedAt) < timestamp(startedAt)) {
      throw contractError("incoherent_state", "a participant cannot join before the huddle started");
    }
  }

  if (state.status === "ended") {
    const endedAt = readIsoTimestamp(state.endedAt, "state.endedAt", "malformed_state");
    const endedByUserId = readId(
      state.endedByUserId,
      "state.endedByUserId",
      "malformed_state",
    ) as UserId;
    if (timestamp(endedAt) < timestamp(startedAt)) {
      throw contractError("incoherent_state", "state.endedAt cannot precede state.startedAt");
    }
    if (state.screenShareOwnerUserId !== null) {
      throw contractError("incoherent_state", "an ended huddle cannot have a screen-share owner");
    }
    for (const participant of participants) {
      if (participant.status !== "left") {
        throw contractError("incoherent_state", "an ended huddle cannot have joined participants");
      }
      if (timestamp(participant.leftAt) > timestamp(endedAt)) {
        throw contractError("incoherent_state", "a participant cannot leave after the huddle ended");
      }
    }
    return {
      status: "ended",
      conversationId,
      huddleSessionId,
      startedAt,
      endedAt,
      endedByUserId,
      participants: participants as HuddleLeftParticipant[],
      screenShareOwnerUserId: null,
    };
  }

  const screenShareOwnerUserId = state.screenShareOwnerUserId === null
    ? null
    : readId(
        state.screenShareOwnerUserId,
        "state.screenShareOwnerUserId",
        "malformed_state",
      ) as UserId;
  if (
    screenShareOwnerUserId !== null &&
    !participants.some(
      (participant) =>
        participant.userId === screenShareOwnerUserId && participant.status === "joined",
    )
  ) {
    throw contractError(
      "incoherent_state",
      "the screen-share owner must be an actively joined participant",
    );
  }
  return {
    status: state.status,
    conversationId,
    huddleSessionId,
    startedAt,
    participants,
    screenShareOwnerUserId,
  };
}

export function parseHuddleMediaJoinDescriptor(
  value: unknown,
  options: Pick<HuddleParseOptions, "now"> = {},
): HuddleMediaJoinDescriptor {
  const descriptor = requireRecord(value, "mediaJoin", "malformed_descriptor");
  assertExactKeys(
    descriptor,
    ["kind", "descriptor", "expiresAt"],
    "mediaJoin",
    "malformed_descriptor",
  );
  if (descriptor.kind !== "opaque_media_join") {
    throw contractError(
      "malformed_descriptor",
      "mediaJoin.kind must be opaque_media_join",
    );
  }
  const opaqueValue = readBoundedNonblankString(
    descriptor.descriptor,
    "mediaJoin.descriptor",
    MAX_HUDDLE_MEDIA_JOIN_DESCRIPTOR_UTF8_BYTES,
    "malformed_descriptor",
  );
  const expiresAt = readIsoTimestamp(
    descriptor.expiresAt,
    "mediaJoin.expiresAt",
    "malformed_descriptor",
  );
  const now = readNow(options.now);
  const ttl = timestamp(expiresAt) - now;
  if (ttl <= 0) {
    throw contractError("expired_descriptor", "mediaJoin.expiresAt must be in the future");
  }
  if (ttl > MAX_HUDDLE_MEDIA_JOIN_DESCRIPTOR_TTL_MS) {
    throw contractError(
      "malformed_descriptor",
      `mediaJoin.expiresAt cannot exceed ${MAX_HUDDLE_MEDIA_JOIN_DESCRIPTOR_TTL_MS}ms from now`,
    );
  }
  return { kind: "opaque_media_join", descriptor: opaqueValue, expiresAt };
}

export function isAllowedHuddleLifecycleTransition(
  from: HuddleSessionState["status"],
  to: HuddleSessionState["status"],
): boolean {
  return (
    (from === "inactive" && (to === "inactive" || to === "starting")) ||
    (from === "starting" && (to === "starting" || to === "active" || to === "ended")) ||
    (from === "active" && (to === "active" || to === "ended")) ||
    (from === "ended" && to === "ended")
  );
}

/** Validates both the lifecycle edge and the operation-specific state delta. */
export function validateHuddleStateTransition(
  previousValue: unknown,
  nextValue: unknown,
  inputValue: unknown,
  reconciliationStatus: HuddleReconciliationStatus = "applied",
): HuddleSessionState {
  const previous = parseHuddleSessionState(previousValue);
  const next = parseHuddleSessionState(nextValue);
  const input = parseHuddleCommandInput(inputValue);

  if (reconciliationStatus === "replayed") {
    if (!sameCanonicalValue(previous, next)) {
      throw contractError(
        "replay_mismatch",
        "a replayed command must preserve the same canonical huddle state",
      );
    }
    return next;
  }
  if (!isAllowedHuddleLifecycleTransition(previous.status, next.status)) {
    throw contractError(
      "invalid_transition",
      `huddle lifecycle cannot transition from ${previous.status} to ${next.status}`,
    );
  }

  if (input.operation === "start_huddle") {
    if (
      previous.status !== "inactive" ||
      next.status !== "starting" ||
      previous.conversationId !== input.conversationId ||
      next.conversationId !== input.conversationId ||
      next.participants.length !== 0 ||
      next.screenShareOwnerUserId !== null
    ) {
      throw contractError("invalid_transition", "start_huddle must create an empty starting session");
    }
    return next;
  }

  assertSameSession(previous, next, input.huddleSessionId);
  if (input.operation === "join_huddle") {
    if (
      (previous.status !== "starting" && previous.status !== "active") ||
      next.status !== "active" ||
      countParticipantChanges(previous.participants, next.participants, "join") !== 1 ||
      previous.screenShareOwnerUserId !== next.screenShareOwnerUserId
    ) {
      throw contractError("invalid_transition", "join_huddle must join exactly one participant into an active session");
    }
  } else if (input.operation === "leave_huddle") {
    if (
      previous.status !== "active" ||
      next.status !== "active" ||
      countParticipantChanges(previous.participants, next.participants, "leave") !== 1
    ) {
      throw contractError("invalid_transition", "leave_huddle must leave exactly one joined participant");
    }
    const ownerRemainsJoined = previous.screenShareOwnerUserId !== null &&
      next.participants.some(
        (participant) =>
          participant.userId === previous.screenShareOwnerUserId &&
          participant.status === "joined",
      );
    const expectedOwner = ownerRemainsJoined
      ? previous.screenShareOwnerUserId
      : null;
    if (next.screenShareOwnerUserId !== expectedOwner) {
      throw contractError("invalid_transition", "leave_huddle cannot transfer screen-share ownership");
    }
  } else if (input.operation === "set_huddle_screen_share") {
    if (
      previous.status !== "active" ||
      next.status !== "active" ||
      !sameCanonicalValue(previous.participants, next.participants) ||
      (input.intent === "set" && next.screenShareOwnerUserId === null) ||
      (input.intent === "clear" && next.screenShareOwnerUserId !== null)
    ) {
      throw contractError("invalid_transition", "screen-share commands may only change exclusive ownership on an active session");
    }
  } else if (
    (previous.status !== "starting" && previous.status !== "active") ||
    next.status !== "ended" ||
    !participantsEndCoherently(previous.participants, next)
  ) {
    throw contractError(
      "invalid_transition",
      "end_huddle must preserve participants and leave every joined participant",
    );
  }
  return next;
}

export function parseHuddleCommandResult(
  value: unknown,
  expectedInput: HuddleCommandInput,
  options: HuddleParseOptions = {},
): HuddleCommandResult {
  const input = parseHuddleCommandInput(expectedInput);
  const result = requireRecord(value, "result", "malformed_result");
  if (result.operation !== input.operation) {
    throw contractError(
      "incoherent_result",
      "result.operation must match the command operation",
    );
  }
  const reconciliationStatus = readReconciliationStatus(result.reconciliationStatus);

  let parsed: HuddleCommandResult;
  if (result.outcome === "feature_disabled") {
    if (input.operation !== "start_huddle" && input.operation !== "join_huddle") {
      throw contractError("incoherent_result", "only start and join can report unavailable media");
    }
    assertExactKeys(
      result,
      ["operation", "outcome", "reconciliationStatus", "feature", "reason", "state"],
      "result",
      "malformed_result",
    );
    if (result.feature !== "huddles" || result.reason !== "media_unavailable") {
      throw contractError(
        "malformed_result",
        "feature-disabled results must identify unavailable huddle media",
      );
    }
    const state = parseHuddleSessionState(result.state);
    assertResultTargetsInput(state, input);
    if (input.operation === "start_huddle" && state.status !== "inactive") {
      throw contractError(
        "incoherent_result",
        "a feature-disabled start must preserve inactive state",
      );
    }
    parsed = {
      operation: input.operation,
      outcome: "feature_disabled",
      reconciliationStatus,
      feature: "huddles",
      reason: "media_unavailable",
      state,
    };
  } else {
    if (result.outcome !== "ok") {
      throw contractError("malformed_result", "result.outcome must be ok or feature_disabled");
    }
    const needsMedia = input.operation === "start_huddle" || input.operation === "join_huddle";
    assertExactKeys(
      result,
      needsMedia
        ? ["operation", "outcome", "reconciliationStatus", "state", "mediaJoin"]
        : ["operation", "outcome", "reconciliationStatus", "state"],
      "result",
      "malformed_result",
    );
    const state = parseHuddleSessionState(result.state);
    assertResultTargetsInput(state, input);
    assertSuccessfulResultState(input.operation, state);
    parsed = needsMedia
      ? {
          operation: input.operation,
          outcome: "ok",
          reconciliationStatus,
          state,
          mediaJoin: parseHuddleMediaJoinDescriptor(result.mediaJoin, options),
        } as StartHuddleResult | JoinHuddleResult
      : {
          operation: input.operation,
          outcome: "ok",
          reconciliationStatus,
          state,
        } as LeaveHuddleResult | SetHuddleScreenShareResult | EndHuddleResult;
  }

  if (options.previousState !== undefined) {
    if (parsed.outcome === "feature_disabled") {
      const previous = parseHuddleSessionState(options.previousState);
      if (!sameCanonicalValue(previous, parsed.state)) {
        throw contractError("invalid_transition", "feature-disabled results cannot mutate huddle state");
      }
    } else {
      validateHuddleStateTransition(
        options.previousState,
        parsed.state,
        input,
        parsed.reconciliationStatus,
      );
    }
  }
  if (parsed.reconciliationStatus === "replayed" && options.replayOf !== undefined) {
    const original = parseHuddleCommandResult(options.replayOf, input, {
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    if (
      original.operation !== parsed.operation ||
      original.outcome !== parsed.outcome ||
      !sameCanonicalValue(original.state, parsed.state)
    ) {
      throw contractError(
        "replay_mismatch",
        "a replay must preserve the original operation, outcome, and canonical state",
      );
    }
  }
  return parsed;
}

function parseParticipants(value: unknown): HuddleParticipant[] {
  if (!Array.isArray(value)) {
    throw contractError("malformed_state", "state.participants must be an array");
  }
  const participants: HuddleParticipant[] = [];
  const userIds = new Set<string>();
  for (const [index, raw] of value.entries()) {
    const path = `state.participants[${index}]`;
    const participant = requireRecord(raw, path, "malformed_state");
    const userId = readId(participant.userId, `${path}.userId`, "malformed_state") as UserId;
    if (userIds.has(userId)) {
      throw contractError("incoherent_state", "state.participants must contain each user at most once");
    }
    userIds.add(userId);
    const joinedAt = readIsoTimestamp(participant.joinedAt, `${path}.joinedAt`, "malformed_state");
    if (participant.status === "joined") {
      assertExactKeys(participant, ["userId", "status", "joinedAt"], path, "malformed_state");
      participants.push({ userId, status: "joined", joinedAt });
    } else if (participant.status === "left") {
      assertExactKeys(participant, ["userId", "status", "joinedAt", "leftAt"], path, "malformed_state");
      const leftAt = readIsoTimestamp(participant.leftAt, `${path}.leftAt`, "malformed_state");
      if (timestamp(leftAt) < timestamp(joinedAt)) {
        throw contractError("incoherent_state", "a participant cannot leave before joining");
      }
      participants.push({ userId, status: "left", joinedAt, leftAt });
    } else {
      throw contractError("malformed_state", `${path}.status must be joined or left`);
    }
  }
  return participants;
}

function countParticipantChanges(
  previous: readonly HuddleParticipant[],
  next: readonly HuddleParticipant[],
  kind: "join" | "leave",
): number {
  const previousByUser = new Map(previous.map((participant) => [participant.userId, participant]));
  const nextByUser = new Map(next.map((participant) => [participant.userId, participant]));
  let changes = 0;
  for (const [userId, participant] of nextByUser) {
    const before = previousByUser.get(userId);
    if (sameCanonicalValue(before, participant)) continue;
    const valid = kind === "join"
      ? participant.status === "joined" && (before === undefined || before.status === "left")
      : before?.status === "joined" && participant.status === "left" && participant.joinedAt === before.joinedAt;
    if (!valid) return Number.POSITIVE_INFINITY;
    changes += 1;
  }
  for (const userId of previousByUser.keys()) {
    if (!nextByUser.has(userId)) return Number.POSITIVE_INFINITY;
  }
  return changes;
}

function participantsEndCoherently(
  previous: readonly HuddleParticipant[],
  ended: EndedHuddleState,
): boolean {
  if (previous.length !== ended.participants.length) return false;
  const endedByUser = new Map(
    ended.participants.map((participant) => [participant.userId, participant]),
  );
  return previous.every((participant) => {
    const after = endedByUser.get(participant.userId);
    if (after === undefined || after.joinedAt !== participant.joinedAt) return false;
    return participant.status === "left"
      ? sameCanonicalValue(participant, after)
      : after.leftAt === ended.endedAt;
  });
}

function assertSameSession(
  previous: HuddleSessionState,
  next: HuddleSessionState,
  expectedId: HuddleSessionId,
): void {
  if (
    previous.status === "inactive" ||
    next.status === "inactive" ||
    previous.huddleSessionId !== expectedId ||
    next.huddleSessionId !== expectedId ||
    previous.conversationId !== next.conversationId ||
    previous.startedAt !== next.startedAt
  ) {
    throw contractError("invalid_transition", "command states must identify the same huddle session");
  }
}

function assertResultTargetsInput(
  state: HuddleSessionState,
  input: HuddleCommandInput,
): void {
  if (input.operation === "start_huddle") {
    if (state.conversationId !== input.conversationId) {
      throw contractError("incoherent_result", "result conversationId must match the start command");
    }
  } else if (state.status === "inactive" || state.huddleSessionId !== input.huddleSessionId) {
    throw contractError("incoherent_result", "result must identify the command's huddle session");
  }
}

function assertSuccessfulResultState(
  operation: HuddleCommandOperation,
  state: HuddleSessionState,
): void {
  const expected = operation === "start_huddle"
    ? "starting"
    : operation === "end_huddle"
      ? "ended"
      : "active";
  if (state.status !== expected) {
    throw contractError(
      "incoherent_result",
      `${operation} success must carry ${expected} state`,
    );
  }
}

function requireInputOperation<Operation extends HuddleCommandOperation>(
  input: HuddleCommandInput,
  operation: Operation,
): Extract<HuddleCommandInput, { readonly operation: Operation }> {
  if (input.operation !== operation) {
    throw contractError("malformed_input", `input.operation must be ${operation}`);
  }
  return input as Extract<HuddleCommandInput, { readonly operation: Operation }>;
}

function readOperation(
  value: unknown,
  code: "malformed_input" | "malformed_result",
): HuddleCommandOperation {
  if (
    value !== "start_huddle" && value !== "join_huddle" &&
    value !== "leave_huddle" && value !== "set_huddle_screen_share" &&
    value !== "end_huddle"
  ) {
    throw contractError(code, "unsupported huddle command operation");
  }
  return value;
}

function readReconciliationStatus(value: unknown): HuddleReconciliationStatus {
  if (value !== "applied" && value !== "replayed") {
    throw contractError(
      "malformed_result",
      "result.reconciliationStatus must be applied or replayed",
    );
  }
  return value;
}

function rejectServerDerivedFields(value: unknown, path = "input"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectServerDerivedFields(entry, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    const normalized = key.replaceAll(/[^a-zA-Z0-9]/g, "").toLowerCase();
    if (TRUSTED_CONTEXT_FIELDS.has(normalized)) {
      throw contractError(
        "trusted_context_field",
        `${path}.${key} is server-derived and cannot be supplied by a client`,
      );
    }
    if (PROVIDER_FIELDS.has(normalized)) {
      throw contractError(
        "provider_field",
        `${path}.${key} is provider-derived and cannot be supplied by a client`,
      );
    }
    rejectServerDerivedFields(nested, `${path}.${key}`);
  }
}

function requireRecord(
  value: unknown,
  path: string,
  code: HuddleContractErrorCode,
): Record<string, unknown> {
  if (!isRecord(value)) throw contractError(code, `${path} must be an object`);
  return value;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
  code: HuddleContractErrorCode,
): void {
  const keys = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) throw contractError(code, `${path}.${key} is not supported`);
  }
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) throw contractError(code, `${path}.${key} is required`);
  }
}

function readId(
  value: unknown,
  path: string,
  code: HuddleContractErrorCode = "malformed_input",
): string {
  return readBoundedNonblankString(value, path, 255, code);
}

function readBoundedNonblankString(
  value: unknown,
  path: string,
  maxBytes: number,
  code: HuddleContractErrorCode,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw contractError(code, `${path} must be a nonblank string`);
  }
  if (new TextEncoder().encode(value).byteLength > maxBytes) {
    throw contractError(code, `${path} cannot exceed ${maxBytes} UTF-8 bytes`);
  }
  return value;
}

function readIsoTimestamp(
  value: unknown,
  path: string,
  code: HuddleContractErrorCode,
): IsoTimestamp {
  if (
    typeof value !== "string" ||
    !ISO_TIMESTAMP_PATTERN.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw contractError(code, `${path} must be an ISO-8601 timestamp`);
  }
  return value;
}

function readNow(value: HuddleParseOptions["now"]): number {
  if (value === undefined) return Date.now();
  const parsed = value instanceof Date
    ? value.getTime()
    : typeof value === "number"
      ? value
      : Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw contractError("malformed_descriptor", "options.now must be a valid time");
  }
  return parsed;
}

function timestamp(value: IsoTimestamp): number {
  return Date.parse(value);
}

function sameCanonicalValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contractError(
  code: HuddleContractErrorCode,
  message: string,
): HuddleContractError {
  return new HuddleContractError(code, message);
}
