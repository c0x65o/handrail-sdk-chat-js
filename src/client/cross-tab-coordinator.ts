import type { ChatCommandResult } from "./command-dispatcher.js";

const CROSS_TAB_PROTOCOL = "@handrail/chat/cross-tab";
const CROSS_TAB_VERSION = 1;
const DEFAULT_ELECTION_DELAY_MS = 25;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 1_000;
const DEFAULT_LEASE_DURATION_MS = 3_000;
const DEFAULT_COMMAND_CLAIM_DELAY_MS = 15;
const DEFAULT_COMMAND_CLAIM_LEASE_MS = 3_000;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const PERSISTED_COMMANDS = new Set([
  "message.send",
  "message.edit",
  "message.delete",
  "reaction.set",
  "message.forward",
  "conversation.draft.synchronize",
  "conversation.mark_read",
  "conversation.mark_unread",
  "conversation.membership.mutate",
  "conversation.create",
  "conversation.preference.update",
  "conversation.archive.set",
  "thread.follow.set",
  "saved_message.set",
  "message.reminder.set",
  "huddle.command",
]);

export interface ChatCrossTabMessageEvent {
  readonly data: unknown;
}

export interface ChatCrossTabChannel {
  postMessage(message: unknown): void;
  addEventListener(
    type: "message",
    listener: (event: ChatCrossTabMessageEvent) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: ChatCrossTabMessageEvent) => void,
  ): void;
  close(): void;
}

export type ChatCrossTabChannelFactory = (
  name: string,
) => ChatCrossTabChannel;

export interface ChatCrossTabClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type ChatCrossTabRole =
  | "idle"
  | "electing"
  | "leader"
  | "follower"
  | "fallback"
  | "closed";

export interface ChatCrossTabStatus {
  readonly role: ChatCrossTabRole;
  readonly tabId: string;
  readonly leaderId?: string;
  readonly term: number;
  /** True only while this tab owns identity-scoped persisted queue draining. */
  readonly ownsPersistedSendIntents: boolean;
}

export interface ChatCrossTabTimingOptions {
  readonly electionDelayMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly leaseDurationMs?: number;
  readonly commandClaimDelayMs?: number;
  readonly commandClaimLeaseMs?: number;
}

export interface CreateChatCrossTabCoordinatorOptions {
  readonly endpoint: string;
  /** Stable, trusted, non-secret identity supplied by the host application. */
  readonly sessionFingerprint: string;
  readonly channelFactory?: ChatCrossTabChannelFactory;
  readonly clock?: ChatCrossTabClock;
  readonly tabId?: string;
  readonly timing?: ChatCrossTabTimingOptions;
  readonly onStatusChange?: (status: ChatCrossTabStatus) => void;
  readonly onHydrationRequest?: () => void;
  /** Must validate before applying the unknown canonical state payload. */
  readonly onCanonicalState?: (value: unknown) => void;
  /** Must validate before applying the unknown canonical event payload. */
  readonly onCanonicalEvent?: (value: unknown) => void;
  /** Reloads durable state; the channel carries correlation only, never content. */
  readonly onPersistedCommandAvailable?: (
    command: string,
    idempotencyKey: string,
  ) => void;
  /** Must validate the relayed result before settling local durable state. */
  readonly onCoordinatedCommandResult?: (
    command: string,
    idempotencyKey: string,
    result: unknown,
  ) => void;
}

export interface ChatCrossTabCommandOptions<Result> {
  readonly command: string;
  readonly idempotencyKey: string;
  readonly execute: () => Promise<ChatCommandResult<Result>>;
  /** Re-validates a relayed result with the local command descriptor. */
  readonly parseResult: (value: unknown) => ChatCommandResult<Result> | undefined;
  /** Projects a parsed result to a bounded, non-sensitive channel envelope. */
  readonly projectResultForRelay?: (
    result: ChatCommandResult<Result>,
  ) => ChatCommandResult<unknown> | undefined;
}

export interface ChatCrossTabCoordinator {
  readonly channelName: string;
  readonly status: ChatCrossTabStatus;
  start(): void;
  requestHydration(): void;
  publishCanonicalState(value: unknown): boolean;
  publishCanonicalEvent(value: unknown): boolean;
  announcePersistedCommand(command: string, idempotencyKey: string): boolean;
  coordinateCommand<Result>(
    options: ChatCrossTabCommandOptions<Result>,
  ): Promise<ChatCommandResult<Result>>;
  close(): void;
}

type MessageKind =
  | "hello"
  | "candidate"
  | "heartbeat"
  | "leader-close"
  | "hydrate-request"
  | "canonical-state"
  | "canonical-event"
  | "persisted-command-available"
  | "command-claim"
  | "command-result";

interface Envelope {
  readonly protocol: typeof CROSS_TAB_PROTOCOL;
  readonly version: typeof CROSS_TAB_VERSION;
  readonly namespace: string;
  readonly senderId: string;
  readonly leaderId: string | null;
  readonly term: number;
  readonly kind: MessageKind;
  readonly payload: Record<string, unknown>;
}

interface PendingCommand {
  readonly command: string;
  readonly idempotencyKey: string;
  readonly execute: () => Promise<ChatCommandResult<unknown>>;
  readonly parseResult: (
    value: unknown,
  ) => ChatCommandResult<unknown> | undefined;
  readonly projectResultForRelay?: (
    result: ChatCommandResult<unknown>,
  ) => ChatCommandResult<unknown> | undefined;
  readonly contenders: Map<string, number>;
  readonly promise: Promise<ChatCommandResult<unknown>>;
  resolve(value: ChatCommandResult<unknown>): void;
  timer?: unknown;
  settled: boolean;
  executing: boolean;
}

const defaultClock: ChatCrossTabClock = {
  now: Date.now,
  setTimeout(callback, delayMs) {
    return globalThis.setTimeout(callback, delayMs);
  },
  clearTimeout(handle) {
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
};

const isFiniteNonNegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const isPositive = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

const isPersistedCommand = (value: unknown): value is string =>
  typeof value === "string" && PERSISTED_COMMANDS.has(value);

const isCommandResultEnvelope = (value: unknown): value is Record<string, unknown> => {
  if (!isRecord(value) || typeof value.status !== "string") return false;
  if (value.status === "success") return hasExactKeys(value, ["status", "value"]);
  const definitions = {
    validation: ["The command input is invalid.", false],
    conflict: ["The command conflicts with current server state.", true],
    authentication: ["Chat authentication failed.", "optional"],
    feature_disabled: ["The requested chat feature is disabled.", true],
    unsupported: ["The requested chat command is unsupported.", true],
    rejected: ["The chat server rejected the command.", true],
    malformed_response: ["The chat server returned an invalid command response.", "optional"],
    transport: ["The chat command could not be completed.", "optional"],
    aborted: ["The chat command was aborted.", false],
    closed: ["The chat client was closed.", false],
  } as const;
  const definition = definitions[value.status as keyof typeof definitions];
  if (definition === undefined || value.message !== definition[0]) return false;
  const http = definition[1];
  const expectedKeys =
    http === true || (http === "optional" && value.httpStatus !== undefined)
      ? ["status", "message", "httpStatus"]
      : ["status", "message"];
  return hasExactKeys(value, expectedKeys) &&
    (expectedKeys.length !== 3 ||
      (Number.isInteger(value.httpStatus) &&
        (value.httpStatus as number) >= 100 &&
        (value.httpStatus as number) <= 599));
};

const isRelayableCommandResult = (value: ChatCommandResult<unknown>): boolean =>
  value.status !== "transport" &&
  value.status !== "malformed_response" &&
  value.status !== "aborted" &&
  value.status !== "closed";

const stableHash = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
};

/** The returned namespace contains hashes only; endpoint and identity are never sent. */
export const createChatCrossTabChannelName = (
  endpoint: string,
  sessionFingerprint: string,
): string =>
  `@handrail/chat:cross-tab:v${CROSS_TAB_VERSION}:${stableHash(endpoint)}:${stableHash(
    sessionFingerprint,
  )}`;

const generateTabId = (): string => {
  const browserCrypto = globalThis.crypto;
  if (typeof browserCrypto?.randomUUID === "function") {
    return browserCrypto.randomUUID();
  }
  if (typeof browserCrypto?.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    browserCrypto.getRandomValues(bytes);
    return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  }
  throw new TypeError("A cross-tab identity boundary is required");
};

const defaultChannelFactory: ChatCrossTabChannelFactory = (name) => {
  const Constructor = (
    globalThis as unknown as {
      BroadcastChannel?: new (channelName: string) => ChatCrossTabChannel;
    }
  ).BroadcastChannel;
  if (Constructor === undefined) throw new Error("BroadcastChannel unavailable");
  return new Constructor(name);
};

const parseEnvelope = (value: unknown, namespace: string): Envelope | undefined => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "protocol",
      "version",
      "namespace",
      "senderId",
      "leaderId",
      "term",
      "kind",
      "payload",
    ]) ||
    value.protocol !== CROSS_TAB_PROTOCOL ||
    value.version !== CROSS_TAB_VERSION ||
    value.namespace !== namespace ||
    typeof value.senderId !== "string" ||
    !ID_PATTERN.test(value.senderId) ||
    (value.leaderId !== null &&
      (typeof value.leaderId !== "string" || !ID_PATTERN.test(value.leaderId))) ||
    !Number.isSafeInteger(value.term) ||
    (value.term as number) < 0 ||
    typeof value.kind !== "string" ||
    !isRecord(value.payload)
  ) {
    return undefined;
  }

  const payload = value.payload;
  switch (value.kind) {
    case "hello":
    case "candidate":
    case "leader-close":
    case "hydrate-request":
      if (!hasExactKeys(payload, [])) return undefined;
      break;
    case "heartbeat":
      if (
        !hasExactKeys(payload, ["leaseUntil"]) ||
        !isFiniteNonNegative(payload.leaseUntil)
      ) return undefined;
      break;
    case "canonical-state":
    case "canonical-event":
      if (!hasExactKeys(payload, ["value"]) || !isRecord(payload.value)) {
        return undefined;
      }
      break;
    case "persisted-command-available":
      if (
        !hasExactKeys(payload, ["command", "idempotencyKey"]) ||
        !isPersistedCommand(payload.command) ||
        typeof payload.idempotencyKey !== "string" ||
        !ID_PATTERN.test(payload.idempotencyKey)
      ) return undefined;
      break;
    case "command-claim":
      if (
        !hasExactKeys(payload, ["command", "idempotencyKey", "expiresAt"]) ||
        !isPersistedCommand(payload.command) ||
        typeof payload.idempotencyKey !== "string" ||
        !ID_PATTERN.test(payload.idempotencyKey) ||
        !isFiniteNonNegative(payload.expiresAt)
      ) return undefined;
      break;
    case "command-result":
      if (
        !hasExactKeys(payload, ["command", "idempotencyKey", "result"]) ||
        !isPersistedCommand(payload.command) ||
        typeof payload.idempotencyKey !== "string" ||
        !ID_PATTERN.test(payload.idempotencyKey) ||
        !isCommandResultEnvelope(payload.result)
      ) return undefined;
      break;
    default:
      return undefined;
  }

  return value as unknown as Envelope;
};

const freezeStatus = (
  role: ChatCrossTabRole,
  tabId: string,
  leaderId: string | undefined,
  term: number,
): ChatCrossTabStatus => Object.freeze({
  role,
  tabId,
  ...(leaderId ? { leaderId } : {}),
  term,
  ownsPersistedSendIntents: role === "leader" || role === "fallback",
});

export function createChatCrossTabCoordinator(
  options: CreateChatCrossTabCoordinatorOptions,
): ChatCrossTabCoordinator {
  if (
    !isRecord(options) ||
    typeof options.endpoint !== "string" ||
    options.endpoint.length === 0 ||
    typeof options.sessionFingerprint !== "string" ||
    options.sessionFingerprint.trim().length === 0
  ) {
    throw new TypeError("Cross-tab endpoint and trusted session fingerprint are required");
  }
  const tabId = options.tabId ?? generateTabId();
  if (!ID_PATTERN.test(tabId)) throw new TypeError("Cross-tab tabId is invalid");
  const clock = options.clock ?? defaultClock;
  const timing = {
    electionDelayMs: options.timing?.electionDelayMs ?? DEFAULT_ELECTION_DELAY_MS,
    heartbeatIntervalMs:
      options.timing?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
    leaseDurationMs: options.timing?.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS,
    commandClaimDelayMs:
      options.timing?.commandClaimDelayMs ?? DEFAULT_COMMAND_CLAIM_DELAY_MS,
    commandClaimLeaseMs:
      options.timing?.commandClaimLeaseMs ?? DEFAULT_COMMAND_CLAIM_LEASE_MS,
  };
  if (
    !isFiniteNonNegative(timing.electionDelayMs) ||
    !isPositive(timing.heartbeatIntervalMs) ||
    !isPositive(timing.leaseDurationMs) ||
    timing.leaseDurationMs <= timing.heartbeatIntervalMs ||
    !isFiniteNonNegative(timing.commandClaimDelayMs) ||
    !isPositive(timing.commandClaimLeaseMs)
  ) {
    throw new TypeError("Cross-tab timing options are invalid");
  }

  const namespace = createChatCrossTabChannelName(
    options.endpoint,
    options.sessionFingerprint,
  );
  const candidates = new Map<string, number>();
  const observedClaims = new Map<string, Map<string, number>>();
  const pendingCommands = new Map<string, PendingCommand>();
  let role: ChatCrossTabRole = "idle";
  let leaderId: string | undefined;
  let term = 0;
  let leaseUntil = 0;
  let channel: ChatCrossTabChannel | undefined;
  let electionTimer: unknown;
  let heartbeatTimer: unknown;
  let leaseTimer: unknown;
  let listenerAttached = false;

  const status = (): ChatCrossTabStatus =>
    freezeStatus(role, tabId, leaderId, term);

  const notifyStatus = (): void => {
    try {
      options.onStatusChange?.(status());
    } catch {
      // Cross-tab observers are isolated from coordination reliability.
    }
  };

  const clearTimer = (handle: unknown): void => {
    if (handle !== undefined) clock.clearTimeout(handle);
  };

  const settlePendingLocally = (): void => {
    for (const pending of pendingCommands.values()) {
      if (!pending.settled && !pending.executing) {
        pending.executing = true;
        void pending.execute().then(pending.resolve, () => {
          pending.resolve(Object.freeze({
            status: "transport",
            message: "The chat command could not be completed.",
          }));
        });
      }
    }
  };

  const enterFallback = (): void => {
    if (role === "fallback" || role === "closed") return;
    clearTimer(electionTimer);
    clearTimer(heartbeatTimer);
    clearTimer(leaseTimer);
    electionTimer = undefined;
    heartbeatTimer = undefined;
    leaseTimer = undefined;
    if (listenerAttached && channel !== undefined) {
      try {
        channel.removeEventListener("message", onMessage);
      } catch {
        // A broken listener boundary is already being abandoned.
      }
    }
    listenerAttached = false;
    try {
      channel?.close();
    } catch {
      // Fallback is deliberately independent of the channel implementation.
    }
    channel = undefined;
    leaderId = tabId;
    role = "fallback";
    notifyStatus();
    settlePendingLocally();
  };

  const post = (kind: MessageKind, payload: Record<string, unknown>): boolean => {
    if (channel === undefined || role === "fallback" || role === "closed") return false;
    const envelope: Envelope = Object.freeze({
      protocol: CROSS_TAB_PROTOCOL,
      version: CROSS_TAB_VERSION,
      namespace,
      senderId: tabId,
      leaderId: leaderId ?? null,
      term,
      kind,
      payload: Object.freeze(payload),
    });
    try {
      channel.postMessage(envelope);
      return true;
    } catch {
      enterFallback();
      return false;
    }
  };

  const scheduleHeartbeat = (): void => {
    clearTimer(heartbeatTimer);
    if (role !== "leader") return;
    leaseUntil = clock.now() + timing.leaseDurationMs;
    post("heartbeat", { leaseUntil });
    if (role === "leader") {
      heartbeatTimer = clock.setTimeout(scheduleHeartbeat, timing.heartbeatIntervalMs);
    }
  };

  const beginElection = (): void => {
    if (role === "fallback" || role === "closed") return;
    clearTimer(heartbeatTimer);
    clearTimer(leaseTimer);
    heartbeatTimer = undefined;
    leaseTimer = undefined;
    role = "electing";
    leaderId = undefined;
    term += 1;
    candidates.clear();
    candidates.set(tabId, term);
    notifyStatus();
    post("candidate", {});
    clearTimer(electionTimer);
    electionTimer = clock.setTimeout(() => {
      electionTimer = undefined;
      if (role !== "electing") return;
      const nextTerm = Math.max(term, ...candidates.values());
      const eligible = [...candidates.entries()]
        .filter(([, candidateTerm]) => candidateTerm === nextTerm)
        .map(([candidateId]) => candidateId)
        .sort();
      term = nextTerm;
      leaderId = eligible[0] ?? tabId;
      role = leaderId === tabId ? "leader" : "follower";
      notifyStatus();
      if (role === "leader") {
        scheduleHeartbeat();
      } else {
        leaseUntil = clock.now() + timing.leaseDurationMs;
        scheduleLeaseCheck();
        post("hydrate-request", {});
      }
    }, timing.electionDelayMs);
  };

  const scheduleLeaseCheck = (): void => {
    clearTimer(leaseTimer);
    if (role !== "follower") return;
    const delay = Math.max(0, leaseUntil - clock.now());
    leaseTimer = clock.setTimeout(() => {
      leaseTimer = undefined;
      if (role === "follower" && clock.now() >= leaseUntil) beginElection();
    }, delay);
  };

  const acceptHeartbeat = (envelope: Envelope): void => {
    const announcedLeader = envelope.leaderId;
    const announcedLease = envelope.payload.leaseUntil as number;
    if (
      announcedLeader === null ||
      announcedLeader !== envelope.senderId ||
      envelope.term < term ||
      announcedLease <= clock.now() ||
      announcedLease > clock.now() + timing.leaseDurationMs * 2
    ) return;
    if (
      envelope.term === term &&
      leaderId !== undefined &&
      leaderId.localeCompare(announcedLeader) < 0
    ) return;
    const shouldRequestHydration =
      role !== "follower" || leaderId !== announcedLeader || term !== envelope.term;
    const wasLeader = role === "leader";
    term = envelope.term;
    leaderId = announcedLeader;
    leaseUntil = announcedLease;
    if (leaderId === tabId) return;
    clearTimer(electionTimer);
    clearTimer(heartbeatTimer);
    electionTimer = undefined;
    heartbeatTimer = undefined;
    role = "follower";
    if (wasLeader || status().leaderId !== announcedLeader) notifyStatus();
    else notifyStatus();
    scheduleLeaseCheck();
    if (shouldRequestHydration) post("hydrate-request", {});
  };

  const commandKey = (command: string, idempotencyKey: string): string =>
    `${command}\u0000${idempotencyKey}`;

  const parsePendingResult = (
    pending: PendingCommand,
    value: unknown,
  ): ChatCommandResult<unknown> | undefined => {
    try {
      return pending.parseResult(value);
    } catch {
      return undefined;
    }
  };

  const scheduleCommandDecision = (pending: PendingCommand, delayMs: number): void => {
    clearTimer(pending.timer);
    pending.timer = clock.setTimeout(() => {
      pending.timer = undefined;
      if (pending.settled || pending.executing) return;
      const currentNow = clock.now();
      const contenders = [...pending.contenders.entries()]
        .filter(([, expiresAt]) => expiresAt > currentNow)
        .map(([candidateId]) => candidateId)
        .sort();
      if (contenders[0] === tabId) {
        pending.executing = true;
        const renewClaim = (): void => {
          if (pending.settled || !pending.executing) return;
          const expiresAt = clock.now() + timing.commandClaimLeaseMs;
          pending.contenders.set(tabId, expiresAt);
          post("command-claim", {
            command: pending.command,
            idempotencyKey: pending.idempotencyKey,
            expiresAt,
          });
          pending.timer = clock.setTimeout(
            renewClaim,
            Math.max(1, Math.floor(timing.commandClaimLeaseMs / 2)),
          );
        };
        renewClaim();
        void pending.execute().then(
          (result) => {
            if (pending.settled) return;
            const parsed = parsePendingResult(pending, result);
            if (parsed === undefined) {
              pending.resolve(Object.freeze({
                status: "malformed_response",
                message: "The chat server returned an invalid command response.",
              }));
              return;
            }
            let relayed: ChatCommandResult<unknown> | undefined;
            try {
              relayed = pending.projectResultForRelay === undefined
                ? parsed
                : pending.projectResultForRelay(parsed);
            } catch {
              relayed = undefined;
            }
            if (
              relayed !== undefined &&
              isRelayableCommandResult(relayed) &&
              isCommandResultEnvelope(relayed)
            ) {
              post("command-result", {
                command: pending.command,
                idempotencyKey: pending.idempotencyKey,
                result: relayed,
              });
            }
            pending.resolve(parsed);
          },
          () => pending.resolve(Object.freeze({
            status: "transport",
            message: "The chat command could not be completed.",
          })),
        );
        return;
      }
      if (contenders.length > 0) {
        const winnerExpiry = pending.contenders.get(contenders[0] as string) ?? currentNow;
        scheduleCommandDecision(
          pending,
          Math.max(1, winnerExpiry - currentNow),
        );
        return;
      }
      pending.contenders.clear();
      const expiresAt = currentNow + timing.commandClaimLeaseMs;
      pending.contenders.set(tabId, expiresAt);
      post("command-claim", {
        command: pending.command,
        idempotencyKey: pending.idempotencyKey,
        expiresAt,
      });
      scheduleCommandDecision(pending, timing.commandClaimDelayMs);
    }, delayMs);
  };

  function onMessage(event: ChatCrossTabMessageEvent): void {
    const envelope = parseEnvelope(event.data, namespace);
    if (envelope === undefined || envelope.senderId === tabId) return;

    switch (envelope.kind) {
      case "hello":
        if (role === "leader") scheduleHeartbeat();
        else if (role === "electing") post("candidate", {});
        return;
      case "candidate":
        if (role === "leader") {
          scheduleHeartbeat();
          return;
        }
        if (role === "follower" && clock.now() < leaseUntil) return;
        if (role !== "electing") beginElection();
        candidates.set(envelope.senderId, envelope.term);
        return;
      case "heartbeat":
        acceptHeartbeat(envelope);
        return;
      case "leader-close":
        if (
          role === "follower" &&
          envelope.senderId === leaderId &&
          envelope.leaderId === leaderId &&
          envelope.term === term
        ) beginElection();
        return;
      case "hydrate-request":
        if (
          role === "leader" &&
          envelope.leaderId === tabId &&
          envelope.term === term
        ) {
          try {
            options.onHydrationRequest?.();
          } catch {
            // Hydration production failures do not affect leadership.
          }
        }
        return;
      case "canonical-state":
      case "canonical-event":
        if (
          role !== "follower" ||
          envelope.senderId !== leaderId ||
          envelope.leaderId !== leaderId ||
          envelope.term !== term
        ) return;
        try {
          if (envelope.kind === "canonical-state") {
            options.onCanonicalState?.(envelope.payload.value);
          } else {
            options.onCanonicalEvent?.(envelope.payload.value);
          }
        } catch {
          // Payload consumers are validators and malformed data is ignored.
        }
        return;
      case "persisted-command-available":
        if (
          role !== "leader" ||
          envelope.leaderId !== tabId ||
          envelope.term !== term
        ) return;
        try {
          options.onPersistedCommandAvailable?.(
            envelope.payload.command as string,
            envelope.payload.idempotencyKey as string,
          );
        } catch {
          // Durable-state reload failures do not affect leadership.
        }
        return;
      case "command-claim": {
        const command = envelope.payload.command as string;
        const idempotencyKey = envelope.payload.idempotencyKey as string;
        const key = commandKey(command, idempotencyKey);
        const expiresAt = envelope.payload.expiresAt as number;
        if (
          envelope.term !== term ||
          (role === "electing"
            ? envelope.leaderId !== null
            : (role !== "leader" && role !== "follower") ||
              envelope.leaderId !== leaderId) ||
          expiresAt <= clock.now() ||
          expiresAt > clock.now() + timing.commandClaimLeaseMs * 2
        ) return;
        const claims = observedClaims.get(key) ?? new Map<string, number>();
        claims.set(envelope.senderId, expiresAt);
        observedClaims.set(key, claims);
        const pending = pendingCommands.get(key);
        if (pending !== undefined && !pending.settled) {
          pending.contenders.set(
            envelope.senderId,
            expiresAt,
          );
        }
        return;
      }
      case "command-result": {
        const command = envelope.payload.command as string;
        const idempotencyKey = envelope.payload.idempotencyKey as string;
        const fromCurrentLeader =
          role === "follower" &&
          envelope.senderId === leaderId &&
          envelope.leaderId === leaderId &&
          envelope.term === term;
        if (fromCurrentLeader) {
          try {
            options.onCoordinatedCommandResult?.(
              command,
              idempotencyKey,
              envelope.payload.result,
            );
          } catch {
            // Result consumers validate independently from coordination.
          }
        }
        const fromCurrentTerm = envelope.term === term && (
          fromCurrentLeader ||
          (role === "leader" && envelope.leaderId === leaderId) ||
          (role === "electing" && envelope.leaderId === null)
        );
        if (!fromCurrentTerm) return;
        const pending = pendingCommands.get(commandKey(command, idempotencyKey));
        if (pending === undefined || pending.settled) return;
        const parsed = parsePendingResult(pending, envelope.payload.result);
        if (parsed !== undefined) pending.resolve(parsed);
      }
    }
  }

  const coordinator: ChatCrossTabCoordinator = {
    channelName: namespace,
    get status() {
      return status();
    },
    start() {
      if (role !== "idle") return;
      try {
        channel = (options.channelFactory ?? defaultChannelFactory)(namespace);
        channel.addEventListener("message", onMessage);
        listenerAttached = true;
      } catch {
        enterFallback();
        return;
      }
      role = "electing";
      notifyStatus();
      post("hello", {});
      if (role === "electing") beginElection();
    },
    requestHydration() {
      if (role === "follower") post("hydrate-request", {});
    },
    publishCanonicalState(value) {
      return role === "leader" && isRecord(value)
        ? post("canonical-state", { value })
        : false;
    },
    publishCanonicalEvent(value) {
      return role === "leader" && isRecord(value)
        ? post("canonical-event", { value })
        : false;
    },
    announcePersistedCommand(command, idempotencyKey) {
      if (
        (role !== "follower" && role !== "electing") ||
        !isPersistedCommand(command) ||
        !ID_PATTERN.test(idempotencyKey)
      ) return false;
      return post("persisted-command-available", { command, idempotencyKey });
    },
    coordinateCommand<Result>(commandOptions: ChatCrossTabCommandOptions<Result>) {
      if (
        role === "fallback" ||
        role === "idle" ||
        role === "closed"
      ) return commandOptions.execute();
      if (
        !isPersistedCommand(commandOptions.command) ||
        !ID_PATTERN.test(commandOptions.idempotencyKey) ||
        typeof commandOptions.execute !== "function" ||
        typeof commandOptions.parseResult !== "function" ||
        (commandOptions.projectResultForRelay !== undefined &&
          typeof commandOptions.projectResultForRelay !== "function")
      ) return commandOptions.execute();
      const key = commandKey(commandOptions.command, commandOptions.idempotencyKey);
      const existing = pendingCommands.get(key);
      if (existing !== undefined) {
        return existing.promise as Promise<ChatCommandResult<Result>>;
      }
      let resolvePromise!: (value: ChatCommandResult<unknown>) => void;
      const promise = new Promise<ChatCommandResult<unknown>>((resolve) => {
        resolvePromise = resolve;
      });
      const pending: PendingCommand = {
        command: commandOptions.command,
        idempotencyKey: commandOptions.idempotencyKey,
        execute: commandOptions.execute as () => Promise<ChatCommandResult<unknown>>,
        parseResult: commandOptions.parseResult as PendingCommand["parseResult"],
        ...(commandOptions.projectResultForRelay === undefined
          ? {}
          : {
              projectResultForRelay:
                commandOptions.projectResultForRelay as NonNullable<
                  PendingCommand["projectResultForRelay"]
                >,
            }),
        contenders: new Map(observedClaims.get(key) ?? []),
        promise,
        settled: false,
        executing: false,
        resolve(value) {
          if (pending.settled) return;
          pending.settled = true;
          clearTimer(pending.timer);
          pending.timer = undefined;
          pendingCommands.delete(key);
          observedClaims.delete(key);
          resolvePromise(value);
        },
      };
      pendingCommands.set(key, pending);
      const expiresAt = clock.now() + timing.commandClaimLeaseMs;
      pending.contenders.set(tabId, expiresAt);
      post("command-claim", {
        command: pending.command,
        idempotencyKey: pending.idempotencyKey,
        expiresAt,
      });
      if (channel === undefined) settlePendingLocally();
      else scheduleCommandDecision(pending, timing.commandClaimDelayMs);
      return promise as Promise<ChatCommandResult<Result>>;
    },
    close() {
      if (role === "closed") return;
      if (role === "leader") post("leader-close", {});
      clearTimer(electionTimer);
      clearTimer(heartbeatTimer);
      clearTimer(leaseTimer);
      for (const pending of pendingCommands.values()) {
        clearTimer(pending.timer);
        pending.resolve(Object.freeze({
          status: "closed",
          message: "The chat client was closed.",
        }));
      }
      if (listenerAttached && channel !== undefined) {
        try {
          channel.removeEventListener("message", onMessage);
        } catch {
          // Closing remains idempotent for a failing channel.
        }
      }
      try {
        channel?.close();
      } catch {
        // Closing remains idempotent for a failing channel.
      }
      channel = undefined;
      listenerAttached = false;
      role = "closed";
      leaderId = undefined;
      notifyStatus();
    },
  };

  return Object.freeze(coordinator);
}
