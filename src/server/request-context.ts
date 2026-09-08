import type { IncomingMessage } from "node:http";

import type { TenantId, UserId } from "../contracts/identifiers.js";
import type {
  ChatAuthAdapter,
  ChatPermissionAdapter,
  TrustedChatActorContext,
} from "./contracts.js";

export const CHAT_AUTHENTICATION_ERROR_CODE =
  "CHAT_AUTHENTICATION_FAILED" as const;
export const CHAT_AUTHORIZATION_ERROR_CODE =
  "CHAT_AUTHORIZATION_FAILED" as const;

/** Stable, sanitized failure raised when no valid trusted host actor exists. */
export class ChatAuthenticationError extends Error {
  public readonly code = CHAT_AUTHENTICATION_ERROR_CODE;
  public readonly statusCode = 401;

  public constructor() {
    super("Chat authentication failed");
    this.name = "ChatAuthenticationError";
  }
}

/** Stable, sanitized failure raised when host capabilities cannot be resolved. */
export class ChatAuthorizationError extends Error {
  public readonly code = CHAT_AUTHORIZATION_ERROR_CODE;
  public readonly statusCode = 403;

  public constructor() {
    super("Chat authorization failed");
    this.name = "ChatAuthorizationError";
  }
}

export interface TrustedChatRequestContext<Capability extends string = string> {
  readonly actor: TrustedChatActorContext;
  readonly capabilities: readonly Capability[];
}

/** Per-request attachment point populated only by trusted host adapters. */
export const CHAT_REQUEST_CONTEXT: unique symbol = Symbol(
  "@handrail/chat/request-context",
);

const CHAT_REQUEST_CONTEXT_RESOLUTION: unique symbol = Symbol(
  "@handrail/chat/request-context-resolution",
);

export type ChatRequestWithContext<Capability extends string = string> =
  IncomingMessage & {
    readonly [CHAT_REQUEST_CONTEXT]: TrustedChatRequestContext<Capability>;
  };

type ContextCarrier<Capability extends string> = object & {
  readonly [CHAT_REQUEST_CONTEXT]?: TrustedChatRequestContext<Capability>;
  readonly [CHAT_REQUEST_CONTEXT_RESOLUTION]?: Promise<
    TrustedChatRequestContext<Capability>
  >;
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const validateStringList = <Value extends string>(
  value: unknown,
  ErrorType: new () => Error,
): readonly Value[] => {
  try {
    if (!Array.isArray(value)) {
      throw new ErrorType();
    }
    const entries = [...value] as unknown[];
    if (!entries.every(isNonEmptyString)) {
      throw new ErrorType();
    }
    return Object.freeze(entries) as readonly Value[];
  } catch {
    throw new ErrorType();
  }
};

export const validateTrustedChatActorContext = (
  value: unknown,
): TrustedChatActorContext => {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new ChatAuthenticationError();
    }

    const candidate = value as Record<string, unknown>;
    if (
      !isNonEmptyString(candidate.tenantId) ||
      !isNonEmptyString(candidate.userId)
    ) {
      throw new ChatAuthenticationError();
    }

    return Object.freeze({
      tenantId: candidate.tenantId as TenantId,
      userId: candidate.userId as UserId,
      roles: validateStringList<string>(
        candidate.roles,
        ChatAuthenticationError,
      ),
    });
  } catch {
    throw new ChatAuthenticationError();
  }
};

/** Validates and freezes capabilities returned by the trusted host adapter. */
export const validateChatCapabilities = <Capability extends string>(
  value: unknown,
): readonly Capability[] =>
  validateStringList<Capability>(value, ChatAuthorizationError);

/** Returns the immutable trusted context previously attached to this request. */
export function getChatRequestContext<Capability extends string = string>(
  request: object,
): TrustedChatRequestContext<Capability> {
  const context = (request as ContextCarrier<Capability>)[CHAT_REQUEST_CONTEXT];
  if (context === undefined) {
    throw new ChatAuthenticationError();
  }
  return context;
}

/** Type guard for downstream middleware that receives a plain Node request. */
export function hasChatRequestContext<Capability extends string = string>(
  request: IncomingMessage,
): request is ChatRequestWithContext<Capability> {
  return (
    (request as ContextCarrier<Capability>)[CHAT_REQUEST_CONTEXT] !== undefined
  );
}

/**
 * Resolves and attaches trusted identity exactly once for a request object.
 * Identity and capabilities are sourced exclusively from the supplied adapters.
 */
export function resolveChatRequestContext<
  Request extends object,
  Capability extends string = string,
  EntityAction extends string = string,
>(
  request: Request,
  auth: ChatAuthAdapter<Request>,
  permissions: ChatPermissionAdapter<Capability, EntityAction>,
): Promise<TrustedChatRequestContext<Capability>> {
  const carrier = request as ContextCarrier<Capability>;
  const existingContext = carrier[CHAT_REQUEST_CONTEXT];
  if (existingContext !== undefined) {
    return Promise.resolve(existingContext);
  }

  const existingResolution = carrier[CHAT_REQUEST_CONTEXT_RESOLUTION];
  if (existingResolution !== undefined) {
    return existingResolution;
  }

  const resolution = (async () => {
    let unsafeActor: unknown;
    try {
      unsafeActor = await auth.resolveActor(request);
    } catch {
      throw new ChatAuthenticationError();
    }

    const actor = validateTrustedChatActorContext(unsafeActor);
    let unsafeCapabilities: unknown;
    try {
      unsafeCapabilities = await permissions.getCapabilities({ actor });
    } catch {
      throw new ChatAuthorizationError();
    }

    const capabilities = validateChatCapabilities<Capability>(
      unsafeCapabilities,
    );
    const context = Object.freeze({ actor, capabilities });
    Object.defineProperty(carrier, CHAT_REQUEST_CONTEXT, {
      configurable: false,
      enumerable: false,
      value: context,
      writable: false,
    });
    return context;
  })();

  Object.defineProperty(carrier, CHAT_REQUEST_CONTEXT_RESOLUTION, {
    configurable: false,
    enumerable: false,
    value: resolution,
    writable: false,
  });
  return resolution;
}
