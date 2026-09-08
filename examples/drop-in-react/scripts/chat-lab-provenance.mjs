import { createHash } from "node:crypto";
import { createChatServer } from "@handrail/chat/server";
import { createChatTestHarness } from "@handrail/chat/testing";

// Resolve from the same installed SDK as the harness, so Node returns the
// controller module used by createChatServer, including when it is cached.
const { createChatEphemeralSignalController } = await import(
  new URL("./websocket-ephemeral-signals.js", import.meta.resolve("@handrail/chat/server"))
);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const functions = Object.freeze(Object.fromEntries(Object.entries({
  createChatTestHarness,
  createChatServer,
  createChatEphemeralSignalController,
}).map(([name, implementation]) => [
  name, sha256(Function.prototype.toString.call(implementation)),
])));

// Hash loaded functions, never current disk files on an HTTP request. This is
// scoped code evidence (including the shared wireTimestamp allocator), not a
// claim to fingerprint every dependency or closed-over module constant.
export const chatLabBackendProvenance = Object.freeze({
  scheme: "sha256-loaded-functions-v1",
  capturedAt: new Date().toISOString(),
  fingerprint: sha256(JSON.stringify(functions)),
  functions,
});
