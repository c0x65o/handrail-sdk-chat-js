import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { WebSocket as NodeWebSocket } from "ws";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { ChatLabApp } from "../src/ChatLabApp";
// The executable Chat Lab harness intentionally remains plain Node ESM.
// @ts-expect-error No declaration file is emitted for this example-only script.
import { resolveChatLabActor, startChatLabBackend } from "../scripts/chat-lab-backend.mjs";

interface BrowserSocket {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: {
    readonly code: number;
    readonly reason: string;
    readonly wasClean: boolean;
  }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

interface ConversationDetail {
  readonly conversation: {
    readonly latestSequence: number;
    readonly currentReadState: {
      readonly userId: string;
      readonly lastReadSequence: number;
    };
  };
}

const nativeFetch = globalThis.fetch;
const nativeWebSocket = globalThis.WebSocket;
const hadNativeWebSocket = "WebSocket" in globalThis;
let lab: Awaited<ReturnType<typeof startChatLabBackend>>;
const incomingFrames: unknown[] = [];
let browserSocketSequence = 0;

const requireSuccess = <Value,>(
  operation: string,
  result: { readonly status: string; readonly value?: Value },
): Value => {
  expect(result.status, operation).toBe("success");
  expect(result.value, operation).toBeDefined();
  return result.value as Value;
};

const createBrowserSocket = (protocols: readonly string[]): BrowserSocket => {
  const socket = new NodeWebSocket(lab.harness.webSocketEndpoint, [...protocols]);
  const socketSequence = ++browserSocketSequence;
  const adapter: BrowserSocket = {
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
  socket.on("open", () => adapter.onopen?.({}));
  socket.on("message", (data) => {
    const text = data.toString();
    let frame: unknown = text;
    try {
      frame = JSON.parse(text) as unknown;
    } catch {
      // Preserve non-JSON frames for failure diagnostics.
    }
    incomingFrames.push(frame);
    adapter.onmessage?.({ data: text });
    if (
      typeof frame === "object" &&
      frame !== null &&
      "type" in frame &&
      frame.type === "chat.session.accepted"
    ) {
      // Keep the inactive direct conversation on the real server stream so
      // its navigation unread state can update while Grace views the group.
      socket.send(JSON.stringify({
        type: "chat.subscribe",
        requestId: `chat-lab-unread-${socketSequence}`,
        streamId: lab.conversationIds.direct,
      }));
    }
  });
  socket.on("error", (error) => adapter.onerror?.(error));
  socket.on("close", (code, reason) => adapter.onclose?.({
    code,
    reason: reason.toString(),
    wasClean: code === 1_000,
  }));
  return adapter;
};

const selectActor = async (displayName: string, optionName: string) => {
  fireEvent.click(screen.getByRole("button", {
    name: /Development fixture identity:/u,
  }));
  fireEvent.click(within(screen.getByRole("listbox", {
    name: "Development fixture identities",
  })).getByRole("option", { name: optionName }));
  await screen.findByText(`Current actor: ${displayName}`, {}, { timeout: 10_000 });
  await screen.findByText("Managed realtime connected", {}, { timeout: 10_000 });
  const activeSocketSequence = browserSocketSequence;
  await waitFor(() => {
    expect(incomingFrames.some((frame) =>
      typeof frame === "object" &&
      frame !== null &&
      "type" in frame &&
      frame.type === "chat.subscription.accepted" &&
      "requestId" in frame &&
      frame.requestId === `chat-lab-unread-${activeSocketSequence}`
    )).toBe(true);
  }, { timeout: 10_000 });
  return screen.findByRole("navigation", { name: "Conversations" });
};

const readConversation = async (credential: string) => {
  const client = lab.harness.createClient(credential);
  try {
    expect((await client.start()).state).toBe("ready");
    return requireSuccess<ConversationDetail>(
      `${credential} conversation detail`,
      await client.getConversation({ conversationId: lab.conversationIds.direct }),
    ).conversation;
  } finally {
    client.close();
  }
};

const readCursor = async (credential: string) =>
  (await readConversation(credential)).currentReadState;

const markDirectRead = async (credential: string, throughSequence: number) => {
  const client = lab.harness.createClient(credential);
  try {
    expect((await client.start()).state).toBe("ready");
    requireSuccess<ConversationDetail>(
      `${credential} direct conversation hydration`,
      await client.getConversation({ conversationId: lab.conversationIds.direct }),
    );
    requireSuccess(
      `${credential} direct read cursor`,
      await client.markRead({
        conversationId: lab.conversationIds.direct,
        throughSequence,
      }),
    );
  } finally {
    client.close();
  }
};

const directButton = (navigation: HTMLElement, unreadCount?: number) =>
  within(navigation).getByRole<HTMLButtonElement>("button", {
    name: unreadCount === undefined
      ? "Direct conversation"
      : `Direct conversation, ${unreadCount} unread ${
          unreadCount === 1 ? "message" : "messages"
        }`,
  });

beforeAll(async () => {
  lab = await startChatLabBackend();
  const harnessOrigin = new URL(lab.harness.endpoint).origin;
  globalThis.fetch = async (input, init) => {
    if (typeof input !== "string" && !(input instanceof URL)) {
      return nativeFetch(input, init);
    }
    const requested = new URL(input, "http://chat-lab.test");
    if (requested.origin === harnessOrigin) {
      return nativeFetch(input, init);
    }
    if (requested.pathname === "/__chat-lab/session") {
      const actor = resolveChatLabActor(requested.searchParams.get("actor") ?? "");
      return new Response(actor?.credential ?? "Unknown chat lab actor", {
        status: actor === undefined ? 404 : 200,
      });
    }
    if (!requested.pathname.startsWith("/api/chat")) {
      throw new Error(`Unexpected external Chat Lab request: ${requested.origin}`);
    }
    return nativeFetch(
      new URL(
        `${requested.pathname.replace(/^\/api\/chat/u, "")}${requested.search}`,
        lab.harness.endpoint,
      ),
      init,
    );
  };
  const RoutedWebSocket = function (
    _url: string | URL,
    protocols?: string | string[],
  ): BrowserSocket {
    return createBrowserSocket(
      protocols === undefined
        ? []
        : typeof protocols === "string"
          ? [protocols]
          : protocols,
    );
  };
  globalThis.WebSocket = RoutedWebSocket as unknown as typeof WebSocket;
}, 120_000);

afterEach(async () => {
  cleanup();
  localStorage.clear();
  await Promise.resolve();
});

afterAll(async () => {
  globalThis.fetch = nativeFetch;
  if (hadNativeWebSocket) globalThis.WebSocket = nativeWebSocket;
  else Reflect.deleteProperty(globalThis, "WebSocket");
  if (lab !== undefined) await lab.harness.teardown();
}, 120_000);

describe("ChatLabApp unread isolation", () => {
  it("keeps one realtime unread message scoped to Grace and persists its clear", async () => {
    const seededDirect = await readConversation("chat-lab-grace");
    await markDirectRead("chat-lab-ada", seededDirect.latestSequence);
    await markDirectRead("chat-lab-grace", seededDirect.latestSequence);
    await lab.harness.runtime.outboxPublisher.runOnce();

    render(<ChatLabApp />);

    await screen.findByText("Managed realtime connected", {}, { timeout: 10_000 });
    let navigation = await selectActor("Grace Hopper", "Grace Hopper Engineering");
    fireEvent.click(within(navigation).getByRole("button", { name: "Group conversation" }));
    await screen.findByRole("heading", { name: "Group conversation" }, { timeout: 10_000 });

    const messageText = "Unread isolation message from Ada to Grace.";
    const sender = lab.harness.createClient("chat-lab-ada");
    let sent: { readonly message: { readonly sequence: number } };
    try {
      expect((await sender.start()).state).toBe("ready");
      requireSuccess<ConversationDetail>(
        "Ada direct conversation hydration",
        await sender.getConversation({ conversationId: lab.conversationIds.direct }),
      );
      sent = requireSuccess(
        "Ada unread isolation message",
        await sender.sendMessage({
          conversationId: lab.conversationIds.direct,
          content: { format: "plain", text: messageText },
        }),
      );
      requireSuccess(
        "Ada read through authored message",
        await sender.markRead({
          conversationId: lab.conversationIds.direct,
          throughSequence: sent.message.sequence,
        }),
      );
    } finally {
      sender.close();
    }

    expect((await lab.harness.runtime.outboxPublisher.runOnce()).published)
      .toBeGreaterThan(0);
    await waitFor(() => {
      expect(incomingFrames.flatMap((frame) =>
        typeof frame === "object" && frame !== null && "type" in frame
          ? [(frame as { readonly type: unknown }).type]
          : []
      )).toContain("message.created");
    }, { timeout: 10_000 });

    const unreadButton = await within(navigation).findByRole(
      "button",
      { name: "Direct conversation, 1 unread message" },
      { timeout: 10_000 },
    );
    expect(within(navigation).getAllByRole("button", {
      name: "Direct conversation, 1 unread message",
    })).toHaveLength(1);
    const badge = unreadButton.querySelector<HTMLElement>("[data-unread-count]");
    expect(badge?.dataset["unreadCount"]).toBe("1");
    expect(badge?.textContent).toBe("1");
    expect((await readCursor("chat-lab-grace")).lastReadSequence)
      .toBe(sent.message.sequence - 1);

    navigation = await selectActor("Ada Lovelace", "Ada Lovelace Product");
    expect(directButton(navigation).querySelector("[data-unread-count]")).toBeNull();
    expect((await readCursor("chat-lab-ada")).lastReadSequence)
      .toBe(sent.message.sequence);
    fireEvent.click(directButton(navigation));
    await screen.findByText(messageText, {}, { timeout: 10_000 });
    expect(screen.queryByRole("separator", { name: "Unread messages" })).toBeNull();

    navigation = await selectActor("Grace Hopper", "Grace Hopper Engineering");
    expect(directButton(navigation, 1).querySelector("[data-unread-count]")?.textContent)
      .toBe("1");
    fireEvent.click(directButton(navigation, 1));
    await screen.findByText(messageText, {}, { timeout: 10_000 });
    expect(screen.getByRole("separator", { name: "Unread messages" })).not.toBeNull();

    await markDirectRead("chat-lab-grace", sent.message.sequence);
    await waitFor(() => {
      expect(directButton(navigation).querySelector("[data-unread-count]")).toBeNull();
      expect(screen.getByRole("separator", { name: "Unread messages" })).not.toBeNull();
    }, { timeout: 10_000 });

    navigation = await selectActor("Ada Lovelace", "Ada Lovelace Product");
    expect(directButton(navigation).querySelector("[data-unread-count]")).toBeNull();
    expect(screen.queryByRole("separator", { name: "Unread messages" })).toBeNull();
    expect((await readCursor("chat-lab-ada")).lastReadSequence)
      .toBe(sent.message.sequence);

    navigation = await selectActor("Grace Hopper", "Grace Hopper Engineering");
    expect(directButton(navigation).querySelector("[data-unread-count]")).toBeNull();
    expect(screen.queryByRole("separator", { name: "Unread messages" })).toBeNull();
    const persistedGraceCursor = await readCursor("chat-lab-grace");
    expect(persistedGraceCursor).toMatchObject({
      userId: "grace",
      lastReadSequence: sent.message.sequence,
    });
  }, 45_000);
});
