import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ChatLabApp } from "../src/ChatLabApp";
// The executable Chat Lab harness intentionally remains plain Node ESM.
// @ts-expect-error No declaration file is emitted for this example-only script.
import { resolveChatLabActor, startChatLabBackend } from "../scripts/chat-lab-backend.mjs";
// @ts-expect-error No declaration file is emitted for this example-only script.
import { installChatLabBrowserSocket } from "../scripts/chat-lab-browser-socket-harness.mjs";

const nativeFetch = globalThis.fetch;
let lab: Awaited<ReturnType<typeof startChatLabBackend>>;
let restoreBrowserSocket: (() => void) | undefined;
let scrollIntoView: ReturnType<typeof vi.fn>;
const incomingFrames: unknown[] = [];

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const enterText = (input: HTMLTextAreaElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
    input,
    value,
  );
  input.dispatchEvent(new InputEvent("input", { bubbles: true }));
};

beforeAll(async () => {
  lab = await startChatLabBackend();
  globalThis.fetch = (input, init) => {
    if (typeof input !== "string" && !(input instanceof URL)) {
      return nativeFetch(input, init);
    }
    const requested = new URL(input, "http://chat-lab.test");
    if (requested.pathname === "/__chat-lab/session") {
      const actor = resolveChatLabActor(requested.searchParams.get("actor") ?? "");
      return Promise.resolve(new Response(actor?.credential ?? "Unknown chat lab actor", {
        status: actor === undefined ? 404 : 200,
      }));
    }
    const resolved = new URL(
      `${requested.pathname.replace(/^\/api\/chat/u, "")}${requested.search}`,
      lab.harness.endpoint,
    );
    return nativeFetch(resolved, init);
  };
  restoreBrowserSocket = installChatLabBrowserSocket({
    endpoint: lab.harness.webSocketEndpoint,
    onIncomingFrame: (frame: unknown) => incomingFrames.push(frame),
  });
  scrollIntoView = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scrollIntoView,
  });
}, 120_000);

afterEach(() => {
  cleanup();
  localStorage.clear();
  incomingFrames.length = 0;
  scrollIntoView.mockClear();
});

afterAll(async () => {
  globalThis.fetch = nativeFetch;
  restoreBrowserSocket?.();
  await lab.harness.teardown();
}, 120_000);

describe("ChatLabApp reactions and threads", () => {
  it("switches actors, toggles both reactions, and receives a new reply count over realtime", async () => {
    render(<ChatLabApp />);

    await screen.findByText("Managed realtime connected", {}, { timeout: 10_000 });
    fireEvent.click(screen.getByRole("button", { name: /Grace Hopper Engineering/u }));
    await screen.findByText(
      "Viewing the real persisted conversation as Grace Hopper",
      {},
      { timeout: 10_000 },
    );
    await screen.findByText("Managed realtime connected", {}, { timeout: 10_000 });

    const navigation = await screen.findByRole("navigation", { name: "Conversations" });
    fireEvent.click(within(navigation).getByRole("button", { name: "Direct conversation" }));
    const messageText = await screen.findByText(
      "Switch personas above to verify live delivery and read state.",
      {},
      { timeout: 10_000 },
    );
    const message = messageText.closest<HTMLElement>("[data-message-id]");
    expect(message).not.toBeNull();
    const row = within(message!);

    for (const [reactionKey, pickerName] of [["👍", "Thumbs up"], ["👀", "Eyes"]] as const) {
      fireEvent.click(row.getByRole("button", { name: "Add reaction" }));
      const picker = row.getByRole("dialog", { name: /Choose a reaction/u });
      fireEvent.click(within(picker).getByRole("button", { name: pickerName }));
      await row.findByRole("button", { name: `Remove ${reactionKey} reaction` });
      fireEvent.click(row.getByRole("button", { name: `Remove ${reactionKey} reaction` }));
      await waitFor(() => {
        expect(row.queryByRole("button", { name: `Remove ${reactionKey} reaction` })).toBeNull();
      });
    }

    expect(row.queryByRole("button", { name: /^Open thread/u })).toBeNull();
    fireEvent.click(row.getByRole("button", { name: "Reply" }));
    const thread = await screen.findByRole("complementary", { name: "Thread" });
    await within(thread).findByText("0 replies", {}, { timeout: 10_000 });
    const threadId = thread.querySelector<HTMLElement>("[data-thread-conversation-id]")
      ?.dataset["threadConversationId"];
    expect(threadId).toBeTruthy();

    const reply = within(thread).getByRole<HTMLTextAreaElement>("textbox", {
      name: "Reply to thread",
    });
    const replyText = "A new reply delivered through the managed Chat Lab session.";
    enterText(reply, replyText);
    fireEvent.click(within(thread).getByRole("button", { name: "Send message" }));

    await waitFor(() => {
      expect(incomingFrames.some((frame) =>
        isRecord(frame) &&
        frame["type"] === "message.created" &&
        isRecord(frame["payload"]) &&
        isRecord(frame["payload"]["message"]) &&
        frame["payload"]["message"]["conversationId"] === threadId &&
        isRecord(frame["payload"]["message"]["content"]) &&
        frame["payload"]["message"]["content"]["text"] === replyText
      )).toBe(true);
    }, { timeout: 10_000 });
    await within(thread).findByText("1 reply", {}, { timeout: 10_000 });
    const replyMessage = within(thread).getByText(replyText).closest<HTMLElement>("[data-message-id]");
    expect(replyMessage).not.toBeNull();
    const replyRow = within(replyMessage!);
    fireEvent.click(replyRow.getByRole("button", { name: "Add reaction" }));
    fireEvent.click(within(replyRow.getByRole("dialog", { name: /Choose a reaction/u }))
      .getByRole("button", { name: "Fire" }));
    await replyRow.findByRole("button", { name: "Remove 🔥 reaction" }, { timeout: 10_000 });
    await row.findByRole(
      "button",
      { name: "Open thread with 1 reply" },
      { timeout: 10_000 },
    );
  }, 30_000);
});
