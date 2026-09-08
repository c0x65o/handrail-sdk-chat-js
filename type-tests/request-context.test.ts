import type { IncomingMessage } from "node:http";

import {
  CHAT_AUTHENTICATION_ERROR_CODE,
  CHAT_AUTHORIZATION_ERROR_CODE,
  CHAT_REQUEST_CONTEXT,
  ChatAuthenticationError,
  ChatAuthorizationError,
  getChatRequestContext,
  hasChatRequestContext,
  type ChatRequestWithContext,
  type TrustedChatActorContext,
  type TrustedChatRequestContext,
} from "../src/server/index.js";

declare const request: ChatRequestWithContext<"message.read" | "message.send">;
declare let incomingRequest: IncomingMessage;
declare const replacementActor: TrustedChatActorContext;

const context = getChatRequestContext<"message.read" | "message.send">(request);
const typedContext: TrustedChatRequestContext<"message.read" | "message.send"> =
  request[CHAT_REQUEST_CONTEXT];
const capability: "message.read" | "message.send" | undefined =
  context.capabilities[0];

if (hasChatRequestContext<"message.read" | "message.send">(incomingRequest)) {
  const narrowed: TrustedChatRequestContext<"message.read" | "message.send"> =
    incomingRequest[CHAT_REQUEST_CONTEXT];
  void narrowed;
}

// @ts-expect-error The enclosing request context is immutable.
context.actor = replacementActor;
// @ts-expect-error The actor is immutable.
context.actor.userId = "another-user";
// @ts-expect-error Roles expose no mutable array operations.
context.actor.roles.push("owner");
// @ts-expect-error Capabilities expose no mutable array operations.
context.capabilities.push("message.send");
// @ts-expect-error The attached context cannot be replaced downstream.
request[CHAT_REQUEST_CONTEXT] = typedContext;

const authenticationError = new ChatAuthenticationError();
const authenticationCode: typeof CHAT_AUTHENTICATION_ERROR_CODE =
  authenticationError.code;
const authenticationStatus: 401 = authenticationError.statusCode;
const authorizationError = new ChatAuthorizationError();
const authorizationCode: typeof CHAT_AUTHORIZATION_ERROR_CODE =
  authorizationError.code;
const authorizationStatus: 403 = authorizationError.statusCode;

void [
  capability,
  authenticationCode,
  authenticationStatus,
  authorizationCode,
  authorizationStatus,
];
