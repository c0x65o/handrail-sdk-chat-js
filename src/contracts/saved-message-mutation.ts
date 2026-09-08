import type { MessageId } from "./identifiers.js";

/** Matches the persisted chat identifier UTF-8 bound. */
export const MAX_SAVED_MESSAGE_IDENTIFIER_UTF8_BYTES = 255;

/** Matches `chat_idempotency_keys.client_key`. */
export const MAX_SAVED_MESSAGE_IDEMPOTENCY_KEY_UTF8_BYTES = 255;

/** Private actor-only note bound shared by the wire contract and PostgreSQL. */
export const MAX_SAVED_MESSAGE_PRIVATE_NOTE_UTF8_BYTES = 4_096;

const TRUSTED_CONTEXT_FIELDS = new Set([
  "tenant",
  "tenantid",
  "organization",
  "organizationid",
  "actor",
  "actorid",
  "actorcontext",
  "actorrole",
  "actorroles",
  "actoruserid",
  "currentactor",
  "currentactorid",
  "currentuser",
  "currentuserid",
  "user",
  "userid",
  "principal",
  "principalid",
  "subject",
  "subjectid",
  "authenticateduser",
  "authenticateduserid",
  "identity",
  "session",
  "sessionid",
  "auth",
  "authentication",
  "authorization",
  "role",
  "roles",
  "capability",
  "capabilities",
  "permission",
  "permissions",
]);

const UNSUPPORTED_NOTE_FIELDS = new Set([
  "note",
  "notes",
  "privatenotes",
  "savednote",
  "savednotes",
  "savedmessagenote",
  "savedmessagenotes",
  "memo",
  "annotation",
  "annotations",
]);

/** Compile-time guard for identity and authorization resolved by the server. */
export interface NoTrustedSavedMessageMutationContext {
  readonly tenant?: never;
  readonly tenantId?: never;
  readonly organization?: never;
  readonly organizationId?: never;
  readonly actor?: never;
  readonly actorId?: never;
  readonly actorContext?: never;
  readonly actorRole?: never;
  readonly actorRoles?: never;
  readonly actorUserId?: never;
  readonly currentActor?: never;
  readonly currentActorId?: never;
  readonly currentUser?: never;
  readonly currentUserId?: never;
  readonly user?: never;
  readonly userId?: never;
  readonly principal?: never;
  readonly principalId?: never;
  readonly subject?: never;
  readonly subjectId?: never;
  readonly authenticatedUser?: never;
  readonly authenticatedUserId?: never;
  readonly identity?: never;
  readonly session?: never;
  readonly sessionId?: never;
  readonly auth?: never;
  readonly authentication?: never;
  readonly authorization?: never;
  readonly role?: never;
  readonly roles?: never;
  readonly capability?: never;
  readonly capabilities?: never;
  readonly permission?: never;
  readonly permissions?: never;
}

/** Compile-time guard for non-canonical note aliases. */
export interface NoSavedMessageNoteAliases {
  readonly note?: never;
  readonly notes?: never;
  readonly privateNotes?: never;
  readonly savedNote?: never;
  readonly savedNotes?: never;
  readonly savedMessageNote?: never;
  readonly savedMessageNotes?: never;
  readonly memo?: never;
  readonly annotation?: never;
  readonly annotations?: never;
}

/**
 * Saved-message results are delivered only on the trusted actor's private
 * stream. They never carry a caller-selectable conversation or public target.
 */
export interface NoSavedMessagePublicDeliveryTarget {
  readonly conversationId?: never;
  readonly channelId?: never;
  readonly stream?: never;
  readonly streamId?: never;
  readonly deliveryTarget?: never;
  readonly audience?: never;
  readonly publicStream?: never;
  readonly publicStreamId?: never;
}

export type SavedMessageMutationIntent = "save" | "unsave";

interface SavedMessageMutationInputBase<
  Intent extends SavedMessageMutationIntent,
> extends NoTrustedSavedMessageMutationContext,
    NoSavedMessageNoteAliases {
  readonly operation: "set_saved_message";
  readonly intent: Intent;
  readonly messageId: MessageId;
  /** Zero means the caller has not observed a persisted saved state yet. */
  readonly expectedSavedMessageRevision: number;
  readonly idempotencyKey: string;
  /** Boolean and toggle-style desired-state shapes are deliberately absent. */
  readonly isSaved?: never;
  readonly saved?: never;
  readonly shouldSave?: never;
  readonly desiredSavedState?: never;
  readonly toggle?: never;
  readonly toggleSaved?: never;
  readonly toggleSavedMessage?: never;
}

export interface SaveMessageInput
  extends SavedMessageMutationInputBase<"save"> {
  /** Omission explicitly requests a saved item without a private note. */
  readonly privateNote?: string;
}

export interface UnsaveMessageInput
  extends SavedMessageMutationInputBase<"unsave"> {
  readonly privateNote?: never;
}

/** Explicit desired state; ambiguous toggle semantics are unsupported. */
export type SetSavedMessageInput = SaveMessageInput | UnsaveMessageInput;

/** Authoritative saved state for the trusted current actor. */
export interface CanonicalActorPrivateSavedMessageState {
  readonly messageId: MessageId;
  readonly isSaved: boolean;
  /** Present only for a saved item with an actor-private note. */
  readonly privateNote?: string;
}

export type SavedMessageMutationReconciliationStatus =
  | "applied"
  | "replayed"
  | "already_requested_state"
  | "saved_message_revision_conflict";

interface SavedMessageMutationResultBase<
  Intent extends SavedMessageMutationIntent,
  Status extends SavedMessageMutationReconciliationStatus,
> extends NoTrustedSavedMessageMutationContext,
    NoSavedMessagePublicDeliveryTarget {
  readonly operation: "set_saved_message";
  readonly intent: Intent;
  readonly reconciliationStatus: Status;
  readonly messageId: MessageId;
  readonly expectedSavedMessageRevision: number;
  /** Exact request identity used to reconcile retries. */
  readonly idempotencyKey: string;
  readonly savedMessageRevision: number;
  /** Authoritative state intended only for the trusted actor's private stream. */
  readonly savedMessage: CanonicalActorPrivateSavedMessageState;
}

export type SettledSavedMessageMutationResult<
  Intent extends SavedMessageMutationIntent = SavedMessageMutationIntent,
> = SavedMessageMutationResultBase<
  Intent,
  "applied" | "replayed" | "already_requested_state"
>;

export type ConflictingSavedMessageMutationResult<
  Intent extends SavedMessageMutationIntent = SavedMessageMutationIntent,
> = SavedMessageMutationResultBase<Intent, "saved_message_revision_conflict">;

/** Canonical mutation result suitable only for the trusted actor's private stream. */
export type ActorPrivateSetSavedMessageResult =
  | SettledSavedMessageMutationResult<"save">
  | SettledSavedMessageMutationResult<"unsave">
  | ConflictingSavedMessageMutationResult<"save">
  | ConflictingSavedMessageMutationResult<"unsave">;

export type SetSavedMessageResult = ActorPrivateSetSavedMessageResult;

export type SavedMessageMutationParseErrorCode =
  | "malformed_input"
  | "trusted_identity_field"
  | "unsupported_note_field"
  | "malformed_private_note"
  | "malformed_identifier"
  | "malformed_revision"
  | "malformed_result"
  | "incoherent_result";

export class SavedMessageMutationParseError extends Error {
  readonly code: SavedMessageMutationParseErrorCode;

  constructor(code: SavedMessageMutationParseErrorCode, message: string) {
    super(message);
    this.name = "SavedMessageMutationParseError";
    this.code = code;
  }
}

const INPUT_KEYS = [
  "operation",
  "intent",
  "messageId",
  "expectedSavedMessageRevision",
  "idempotencyKey",
] as const;

const OPTIONAL_INPUT_KEYS = ["privateNote"] as const;

const RESULT_KEYS = [
  "operation",
  "intent",
  "reconciliationStatus",
  "messageId",
  "expectedSavedMessageRevision",
  "idempotencyKey",
  "savedMessageRevision",
  "savedMessage",
] as const;

export function parseSaveMessageInput(value: unknown): SaveMessageInput {
  const input = parseSetSavedMessageInput(value);
  if (input.intent !== "save") {
    throw savedMessageError("malformed_input", "input.intent must be save");
  }
  return input;
}

export function parseUnsaveMessageInput(value: unknown): UnsaveMessageInput {
  const input = parseSetSavedMessageInput(value);
  if (input.intent !== "unsave") {
    throw savedMessageError("malformed_input", "input.intent must be unsave");
  }
  return input;
}

/** Parses explicit save-or-unsave intent for the trusted current actor. */
export function parseSetSavedMessageInput(
  value: unknown,
): SetSavedMessageInput {
  rejectForbiddenCallerFields(value);
  const input = requireRecord(value, "input", "malformed_input");
  assertInputKeys(input);

  if (input.operation !== "set_saved_message") {
    throw savedMessageError(
      "malformed_input",
      "input.operation must be set_saved_message; toggle semantics are not supported",
    );
  }

  const intent = readIntent(input.intent, "malformed_input");
  const privateNote =
    input.privateNote === undefined
      ? undefined
      : readPrivateNote(input.privateNote, "input.privateNote", "malformed_private_note");
  if (intent === "unsave" && privateNote !== undefined) {
    throw savedMessageError(
      "malformed_private_note",
      "input.privateNote is supported only when input.intent is save",
    );
  }

  return {
    operation: "set_saved_message",
    intent,
    messageId: readIdentifier(
      input.messageId,
      "input.messageId",
      "malformed_input",
    ),
    expectedSavedMessageRevision: readExpectedRevision(
      input.expectedSavedMessageRevision,
      "input.expectedSavedMessageRevision",
    ),
    idempotencyKey: readIdempotencyKey(
      input.idempotencyKey,
      "input.idempotencyKey",
      "malformed_input",
    ),
    ...(privateNote === undefined ? {} : { privateNote }),
  } as SetSavedMessageInput;
}

/** Parses an actor-private result and proves coherence with its exact request. */
export function parseSetSavedMessageResult(
  value: unknown,
  expectedInput: SetSavedMessageInput,
): SetSavedMessageResult {
  const request = parseSetSavedMessageInput(expectedInput);
  rejectTrustedContextFields(value, "result");
  const result = requireRecord(value, "result", "malformed_result");
  assertExactKeys(result, RESULT_KEYS, "result", "malformed_result");

  if (result.operation !== "set_saved_message") {
    throw savedMessageError(
      "malformed_result",
      "result.operation must be set_saved_message",
    );
  }

  const intent = readIntent(result.intent, "malformed_result");
  const reconciliationStatus = readReconciliationStatus(
    result.reconciliationStatus,
  );
  const messageId = readIdentifier(
    result.messageId,
    "result.messageId",
    "malformed_result",
  );
  const expectedSavedMessageRevision = readExpectedRevision(
    result.expectedSavedMessageRevision,
    "result.expectedSavedMessageRevision",
  );
  const idempotencyKey = readIdempotencyKey(
    result.idempotencyKey,
    "result.idempotencyKey",
    "malformed_result",
  );
  const savedMessageRevision = readCanonicalRevision(
    result.savedMessageRevision,
  );
  const savedMessage = parseCanonicalSavedMessage(result.savedMessage);

  if (
    intent !== request.intent ||
    messageId !== request.messageId ||
    expectedSavedMessageRevision !== request.expectedSavedMessageRevision ||
    idempotencyKey !== request.idempotencyKey
  ) {
    throw savedMessageError(
      "incoherent_result",
      "result intent, messageId, expectedSavedMessageRevision, and idempotencyKey must exactly match the request",
    );
  }
  if (savedMessage.messageId !== request.messageId) {
    throw savedMessageError(
      "incoherent_result",
      "result.savedMessage.messageId must exactly match the requested messageId",
    );
  }

  const requestedPrivateNote =
    request.intent === "save" ? request.privateNote : undefined;
  const canonicalMatchesIntent =
    savedMessage.isSaved === (request.intent === "save") &&
    savedMessage.privateNote === requestedPrivateNote;
  if (reconciliationStatus === "applied" || reconciliationStatus === "replayed") {
    if (savedMessageRevision !== expectedSavedMessageRevision + 1) {
      throw savedMessageError(
        "incoherent_result",
        `${reconciliationStatus} results must advance expectedSavedMessageRevision by one`,
      );
    }
    if (!canonicalMatchesIntent) {
      throw savedMessageError(
        "incoherent_result",
        "applied and replayed results must carry the exact requested saved state",
      );
    }
  } else if (reconciliationStatus === "already_requested_state") {
    if (savedMessageRevision !== expectedSavedMessageRevision) {
      throw savedMessageError(
        "incoherent_result",
        "already-requested-state results must preserve expectedSavedMessageRevision",
      );
    }
    if (!canonicalMatchesIntent) {
      throw savedMessageError(
        "incoherent_result",
        "an already-requested-state result must carry the exact requested saved state",
      );
    }
  } else {
    if (savedMessageRevision === expectedSavedMessageRevision) {
      throw savedMessageError(
        "incoherent_result",
        "a saved-message revision conflict must carry a different authoritative revision",
      );
    }
  }

  return {
    operation: "set_saved_message",
    intent,
    reconciliationStatus,
    messageId,
    expectedSavedMessageRevision,
    idempotencyKey,
    savedMessageRevision,
    savedMessage,
  } as SetSavedMessageResult;
}

function parseCanonicalSavedMessage(
  value: unknown,
): CanonicalActorPrivateSavedMessageState {
  const savedMessage = requireRecord(
    value,
    "result.savedMessage",
    "malformed_result",
  );
  assertExactKeys(
    savedMessage,
    savedMessage.privateNote === undefined
      ? ["messageId", "isSaved"]
      : ["messageId", "isSaved", "privateNote"],
    "result.savedMessage",
    "malformed_result",
  );
  if (typeof savedMessage.isSaved !== "boolean") {
    throw savedMessageError(
      "malformed_result",
      "result.savedMessage.isSaved must be boolean",
    );
  }
  const privateNote =
    savedMessage.privateNote === undefined
      ? undefined
      : readPrivateNote(
          savedMessage.privateNote,
          "result.savedMessage.privateNote",
          "malformed_result",
        );
  if (!savedMessage.isSaved && privateNote !== undefined) {
    throw savedMessageError(
      "incoherent_result",
      "an unsaved canonical state cannot retain a private note",
    );
  }
  return {
    messageId: readIdentifier(
      savedMessage.messageId,
      "result.savedMessage.messageId",
      "malformed_result",
    ),
    isSaved: savedMessage.isSaved,
    ...(privateNote === undefined ? {} : { privateNote }),
  };
}

function readIntent(
  value: unknown,
  code: "malformed_input" | "malformed_result",
): SavedMessageMutationIntent {
  if (value !== "save" && value !== "unsave") {
    throw savedMessageError(
      code,
      "intent must be save or unsave; toggle semantics are not supported",
    );
  }
  return value;
}

function readReconciliationStatus(
  value: unknown,
): SavedMessageMutationReconciliationStatus {
  if (
    value !== "applied" &&
    value !== "replayed" &&
    value !== "already_requested_state" &&
    value !== "saved_message_revision_conflict"
  ) {
    throw savedMessageError(
      "malformed_result",
      "result.reconciliationStatus is not supported",
    );
  }
  return value;
}

function readExpectedRevision(value: unknown, path: string): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) >= Number.MAX_SAFE_INTEGER
  ) {
    throw savedMessageError(
      "malformed_revision",
      `${path} must be a nonnegative safe integer that can advance by one`,
    );
  }
  return value as number;
}

function readCanonicalRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw savedMessageError(
      "malformed_revision",
      "result.savedMessageRevision must be a nonnegative safe integer",
    );
  }
  return value as number;
}

function readIdentifier(
  value: unknown,
  path: string,
  code: "malformed_input" | "malformed_result",
): MessageId {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    value !== value.normalize("NFC") ||
    containsUnsafeUnicode(value) ||
    utf8ByteLength(value) > MAX_SAVED_MESSAGE_IDENTIFIER_UTF8_BYTES
  ) {
    throw savedMessageError(
      "malformed_identifier",
      `${path} must be a safe, NFC-normalized identifier of at most ${MAX_SAVED_MESSAGE_IDENTIFIER_UTF8_BYTES} UTF-8 bytes`,
    );
  }
  return value as MessageId;
}

function readIdempotencyKey(
  value: unknown,
  path: string,
  code: "malformed_input" | "malformed_result",
): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.trim() !== value ||
    value !== value.normalize("NFC") ||
    containsUnsafeUnicode(value) ||
    utf8ByteLength(value) > MAX_SAVED_MESSAGE_IDEMPOTENCY_KEY_UTF8_BYTES
  ) {
    throw savedMessageError(
      code,
      `${path} must be a safe, NFC-normalized nonblank string of at most ${MAX_SAVED_MESSAGE_IDEMPOTENCY_KEY_UTF8_BYTES} UTF-8 bytes`,
    );
  }
  return value;
}

function readPrivateNote(
  value: unknown,
  path: string,
  code: "malformed_private_note" | "malformed_result",
): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value !== value.normalize("NFC") ||
    containsUnsafePrivateNoteUnicode(value) ||
    utf8ByteLength(value) > MAX_SAVED_MESSAGE_PRIVATE_NOTE_UTF8_BYTES
  ) {
    throw savedMessageError(
      code,
      `${path} must be a nonblank, NFC-normalized string of at most ${MAX_SAVED_MESSAGE_PRIVATE_NOTE_UTF8_BYTES} UTF-8 bytes without unsafe controls`,
    );
  }
  return value;
}

function rejectForbiddenCallerFields(value: unknown, path = "input"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      rejectForbiddenCallerFields(entry, `${path}[${index}]`),
    );
    return;
  }
  if (!isRecord(value)) return;

  for (const [key, nested] of Object.entries(value)) {
    const normalizedKey = normalizeFieldName(key);
    if (TRUSTED_CONTEXT_FIELDS.has(normalizedKey)) {
      throw savedMessageError(
        "trusted_identity_field",
        `${path}.${key} is server-derived and cannot be supplied by a client`,
      );
    }
    if (UNSUPPORTED_NOTE_FIELDS.has(normalizedKey)) {
      throw savedMessageError(
        "unsupported_note_field",
        `${path}.${key} is unsupported because saved messages have no persisted note field`,
      );
    }
    if (normalizedKey === "privatenote" && key !== "privateNote") {
      throw savedMessageError(
        "unsupported_note_field",
        `${path}.${key} is not the canonical privateNote field`,
      );
    }
    rejectForbiddenCallerFields(nested, `${path}.${key}`);
  }
}

function rejectTrustedContextFields(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      rejectTrustedContextFields(entry, `${path}[${index}]`),
    );
    return;
  }
  if (!isRecord(value)) return;

  for (const [key, nested] of Object.entries(value)) {
    if (TRUSTED_CONTEXT_FIELDS.has(normalizeFieldName(key))) {
      throw savedMessageError(
        "trusted_identity_field",
        `${path}.${key} is server-derived and cannot appear in an actor-private result`,
      );
    }
    rejectTrustedContextFields(nested, `${path}.${key}`);
  }
}

function normalizeFieldName(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
  code: "malformed_input" | "malformed_result",
): void {
  const actual = Object.keys(value).sort();
  const expectedKeys = expected.slice().sort();
  if (
    actual.length !== expectedKeys.length ||
    actual.some((key, index) => key !== expectedKeys[index])
  ) {
    throw savedMessageError(
      code,
      `${path} must contain exactly: ${expectedKeys.join(", ")}`,
    );
  }
}

function assertInputKeys(value: Record<string, unknown>): void {
  const required = new Set<string>(INPUT_KEYS);
  const allowed = new Set<string>([...INPUT_KEYS, ...OPTIONAL_INPUT_KEYS]);
  const actual = Object.keys(value);
  if (
    actual.some((key) => !allowed.has(key)) ||
    [...required].some((key) => !Object.hasOwn(value, key))
  ) {
    throw savedMessageError(
      "malformed_input",
      `input must contain ${INPUT_KEYS.join(", ")} and may contain only ${OPTIONAL_INPUT_KEYS.join(", ")}`,
    );
  }
}

function requireRecord(
  value: unknown,
  path: string,
  code: "malformed_input" | "malformed_result",
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw savedMessageError(code, `${path} must be an object`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function containsUnsafeUnicode(value: string): boolean {
  return /[\u0000-\u001F\u007F-\u009F\uD800-\uDFFF]/u.test(value);
}

function containsUnsafePrivateNoteUnicode(value: string): boolean {
  return /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uD800-\uDFFF]/u.test(
    value,
  );
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function savedMessageError(
  code: SavedMessageMutationParseErrorCode,
  message: string,
): SavedMessageMutationParseError {
  return new SavedMessageMutationParseError(code, message);
}
