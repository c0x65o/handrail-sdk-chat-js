import { WebSocket as NodeWebSocket } from "ws";

const normalizeProtocols = (protocols) =>
  protocols === undefined
    ? []
    : typeof protocols === "string"
      ? [protocols]
      : [...protocols];

const normalizeText = (data) =>
  Array.isArray(data)
    ? Buffer.concat(data.map((part) => Buffer.from(part))).toString("utf8")
    : Buffer.from(data).toString("utf8");

const parseIncomingFrame = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const isSessionAccepted = (frame) =>
  typeof frame === "object" &&
  frame !== null &&
  frame.type === "chat.session.accepted";

/**
 * Installs the Node-only socket bridge used by the in-process Chat Lab tests.
 * The returned function restores the exact global property state that existed
 * before installation and is safe to call more than once.
 *
 * Hooks receive parsed JSON frames when possible and raw text otherwise.
 * `onSessionAccepted` may use `send` to write a string or JSON-serializable
 * frame without exposing the underlying Node connection to typed tests.
 *
 * @param {{
 *   endpoint: string | URL,
 *   onIncomingFrame?: (frame: unknown, context: {
 *     connectionId: number,
 *     text: string,
 *   }) => void,
 *   onSessionAccepted?: (context: {
 *     connectionId: number,
 *     frame: unknown,
 *     text: string,
 *     send: (frame: unknown) => void,
 *   }) => void,
 * }} options
 * @returns {() => void}
 */
export const installChatLabBrowserSocket = ({
  endpoint,
  onIncomingFrame,
  onSessionAccepted,
}) => {
  const previousDescriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  let connectionSequence = 0;
  let restored = false;

  const RoutedWebSocket = function (_url, protocols) {
    const connectionId = ++connectionSequence;
    const socket = new NodeWebSocket(endpoint, normalizeProtocols(protocols));
    const adapter = {
      get readyState() {
        return socket.readyState;
      },
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      send(data) {
        socket.send(data);
      },
      close(code, reason) {
        if (socket.readyState === NodeWebSocket.CONNECTING) {
          socket.once("error", () => undefined);
          socket.terminate();
          return;
        }
        socket.close(code, reason);
      },
    };
    const send = (frame) => {
      socket.send(typeof frame === "string" ? frame : JSON.stringify(frame));
    };

    socket.on("open", () => adapter.onopen?.({}));
    socket.on("message", (data) => {
      const text = normalizeText(data);
      const frame = parseIncomingFrame(text);
      onIncomingFrame?.(frame, { connectionId, text });
      adapter.onmessage?.({ data: text });
      if (isSessionAccepted(frame)) {
        onSessionAccepted?.({ connectionId, frame, text, send });
      }
    });
    socket.on("error", (error) => adapter.onerror?.(error));
    socket.on("close", (code, reason) => adapter.onclose?.({
      code,
      reason: normalizeText(reason),
      wasClean: code === 1_000,
    }));
    return adapter;
  };

  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    enumerable: previousDescriptor?.enumerable ?? false,
    value: RoutedWebSocket,
    writable: true,
  });

  return () => {
    if (restored) return;
    restored = true;
    if (previousDescriptor === undefined) {
      Reflect.deleteProperty(globalThis, "WebSocket");
      return;
    }
    Object.defineProperty(globalThis, "WebSocket", previousDescriptor);
  };
};
