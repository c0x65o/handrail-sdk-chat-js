export { CHAT_REPLY_THREAD_FEATURES, type ChatReplyThreadFeature } from "./generated/realtime-handshake.js";
import type {
  EnabledFeatures,
  ServerHandshakeMetadata,
  ServerHandshakeMetadataInput,
  SupportedProtocolRange,
} from "./generated/realtime-handshake.js";
import { CHAT_REFRESH_REQUIRED_MESSAGE } from "./generated/realtime-session.js";
import type {
  ClientHandshakeInput,
  RealtimeHandshakeOutput,
  ReplayCursorStatus,
  SnapshotRequiredReason,
} from "./generated/realtime-session.js";

export type {
  EnabledFeatures,
  ServerHandshakeMetadata,
  ServerHandshakeMetadataInput,
  SupportedProtocolRange,
} from "./generated/realtime-handshake.js";
export * from "./generated/realtime-session.js";

/** Current wire protocol spoken by this package release. */
export const CHAT_PROTOCOL_VERSION = 4;

/**
 * Builds the rolling compatibility window: the current protocol and, when one
 * exists, its immediately previous version.
 */
export function createSupportedProtocolRange(
  currentProtocolVersion: number,
): SupportedProtocolRange {
  assertPositiveSafeInteger(currentProtocolVersion, "currentProtocolVersion");

  return {
    minimumVersion: Math.max(1, currentProtocolVersion - 1),
    maximumVersion: currentProtocolVersion,
  };
}

/** Creates server metadata with the required current-plus-previous window. */
export function createServerHandshakeMetadata<Feature extends string = string>(
  input: ServerHandshakeMetadataInput<Feature>,
): ServerHandshakeMetadata<Feature> {
  assertNonEmptyString(input.packageVersion, "packageVersion");
  assertPositiveSafeInteger(input.protocolVersion, "protocolVersion");
  assertNonNegativeSafeInteger(input.schemaVersion, "schemaVersion");

  return {
    packageVersion: input.packageVersion,
    protocolVersion: input.protocolVersion,
    schemaVersion: input.schemaVersion,
    enabledFeatures: input.enabledFeatures,
    supportedProtocolRange: createSupportedProtocolRange(
      input.protocolVersion,
    ),
  };
}

/** Checks the advertised inclusive protocol range. */
export function isProtocolSupported(
  protocolVersion: number,
  supportedRange: SupportedProtocolRange,
): boolean {
  return (
    Number.isSafeInteger(protocolVersion) &&
    protocolVersion >= supportedRange.minimumVersion &&
    protocolVersion <= supportedRange.maximumVersion
  );
}

/**
 * Resolves protocol compatibility before replay availability. An incompatible
 * client therefore never proceeds into replay, even if its cursor is expired.
 */
export function decideRealtimeHandshake<Feature extends string = string>(
  handshake: ClientHandshakeInput,
  metadata: ServerHandshakeMetadata<Feature>,
  replayCursorStatus: ReplayCursorStatus = "available",
): RealtimeHandshakeOutput<Feature> {
  if (
    !isProtocolSupported(
      handshake.protocolVersion,
      metadata.supportedProtocolRange,
    )
  ) {
    return {
      state: "refresh_required",
      reason: "unsupported_protocol",
      message: CHAT_REFRESH_REQUIRED_MESSAGE,
      requestedProtocolVersion: handshake.protocolVersion,
      metadata,
    };
  }

  if (replayCursorStatus !== "available") {
    const reason: SnapshotRequiredReason =
      replayCursorStatus === "expired"
        ? "replay_expired"
        : replayCursorStatus === "incompatible"
          ? "replay_incompatible"
          : replayCursorStatus === "overflow"
            ? "replay_overflow"
            : "replay_unavailable";
    return handshake.resumeFrom === undefined
      ? {
          state: "snapshot_required",
          reason,
          metadata,
        }
      : {
          state: "snapshot_required",
          reason,
          metadata,
          expiredCursor: handshake.resumeFrom,
        };
  }

  return handshake.resumeFrom === undefined
    ? { state: "accepted", metadata }
    : { state: "accepted", metadata, resumeFrom: handshake.resumeFrom };
}

function assertNonEmptyString(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
}

function assertPositiveSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${field} must be a positive safe integer`);
  }
}

function assertNonNegativeSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer`);
  }
}
