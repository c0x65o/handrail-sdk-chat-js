import type { ChatRequestAdmissionOutcome } from "./contracts.js";

export const MIN_CHAT_REQUEST_ADMISSION_RETRY_AFTER_SECONDS = 1 as const;
export const MAX_CHAT_REQUEST_ADMISSION_RETRY_AFTER_SECONDS = 3_600 as const;
export const DEFAULT_CHAT_REQUEST_ADMISSION_RETRY_AFTER_SECONDS = 60 as const;
export const CHAT_REQUEST_ADMISSION_DENIED_CODE =
  "chat_request_not_admitted" as const;
export const CHAT_REQUEST_ADMISSION_DENIED_MESSAGE =
  "Chat request temporarily unavailable" as const;

export type NormalizedChatRequestAdmission =
  | Readonly<{ admitted: true }>
  | Readonly<{ admitted: false; retryAfterSeconds: number }>;

export const ADMITTED_CHAT_REQUEST: NormalizedChatRequestAdmission =
  Object.freeze({ admitted: true });

export const failedClosedChatRequestAdmission =
  (): NormalizedChatRequestAdmission =>
    Object.freeze({
      admitted: false,
      retryAfterSeconds: DEFAULT_CHAT_REQUEST_ADMISSION_RETRY_AFTER_SECONDS,
    });

const hasExactlyOwnKeys = (
  value: object,
  expected: readonly string[],
): boolean => {
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
};

/** Runtime validation for the adapter's closed allow-or-deny outcome union. */
export const normalizeChatRequestAdmissionOutcome = (
  outcome: ChatRequestAdmissionOutcome,
): NormalizedChatRequestAdmission => {
  if (
    typeof outcome !== "object" ||
    outcome === null ||
    Array.isArray(outcome)
  ) {
    return failedClosedChatRequestAdmission();
  }
  if (
    outcome.decision === "allow" &&
    hasExactlyOwnKeys(outcome, ["decision"])
  ) {
    return ADMITTED_CHAT_REQUEST;
  }
  if (
    outcome.decision === "deny" &&
    hasExactlyOwnKeys(outcome, ["decision", "retryAfterSeconds"]) &&
    typeof outcome.retryAfterSeconds === "number" &&
    Number.isFinite(outcome.retryAfterSeconds) &&
    outcome.retryAfterSeconds >=
      MIN_CHAT_REQUEST_ADMISSION_RETRY_AFTER_SECONDS &&
    outcome.retryAfterSeconds <= MAX_CHAT_REQUEST_ADMISSION_RETRY_AFTER_SECONDS
  ) {
    return Object.freeze({
      admitted: false,
      retryAfterSeconds: Math.ceil(outcome.retryAfterSeconds),
    });
  }
  return failedClosedChatRequestAdmission();
};
