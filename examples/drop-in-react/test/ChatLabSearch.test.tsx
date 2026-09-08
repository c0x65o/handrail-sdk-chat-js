import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ChatLabApp } from "../src/ChatLabApp";
// The executable Chat Lab harness intentionally remains plain Node ESM.
// @ts-expect-error No declaration file is emitted for this example-only script.
import { resolveChatLabActor, startChatLabBackend } from "../scripts/chat-lab-backend.mjs";

const nativeFetch = globalThis.fetch;
let lab: Awaited<ReturnType<typeof startChatLabBackend>>;
let scrollIntoView: ReturnType<typeof vi.fn>;

const enterText = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
    input,
    value,
  );
  input.dispatchEvent(new InputEvent("input", { bubbles: true }));
};

const searchAllConversations = () => {
  const filters = document.querySelector<HTMLDetailsElement>(
    ".handrail-chat__message-search-filters",
  );
  if (filters === null) throw new Error("Message search filters were not rendered");
  if (!filters.open) {
    fireEvent.click(filters.querySelector("summary") as HTMLElement);
  }
  fireEvent.change(screen.getByRole("combobox", { name: "Conversation" }), {
    target: { value: "" },
  });
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
  scrollIntoView = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scrollIntoView,
  });
}, 120_000);

afterEach(() => {
  cleanup();
  localStorage.clear();
  scrollIntoView.mockClear();
});

afterAll(async () => {
  globalThis.fetch = nativeFetch;
  await lab.harness.teardown();
}, 120_000);

describe("ChatLabApp message search", () => {
  it("opens Ada's exact private-channel hit and hides it from non-member Margaret", async () => {
    render(<ChatLabApp />);

    await screen.findByRole("button", { name: "Chat Lab Private" });
    fireEvent.click(await screen.findByRole("button", { name: "Search messages" }));
    const search = await screen.findByRole<HTMLInputElement>(
      "searchbox",
      { name: "Search messages" },
    );
    searchAllConversations();
    enterText(search, lab.privateSearchText);

    const result = await screen.findByRole(
      "option",
      { name: /Quarantined orbital telemetry/u },
      { timeout: 10_000 },
    );
    expect(result.textContent).toContain("Quarantined orbital telemetry");
    fireEvent.click(result);

    await waitFor(() => {
      const target = document.querySelector<HTMLElement>(
        `[data-message-id="${lab.privateSearchMessageId}"]`,
      );
      expect(target).not.toBeNull();
      expect(document.activeElement).toBe(target);
      expect(target?.closest("[data-conversation-id]")?.getAttribute("data-conversation-id"))
        .toBe(lab.conversationIds.privateChannel);
      expect(scrollIntoView).toHaveBeenCalledWith({
        block: "center",
        inline: "nearest",
      });
    }, { timeout: 10_000 });
    expect(screen.getByText("Search result opened.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Margaret Hamilton/u }));
    fireEvent.click(await screen.findByRole("button", { name: "Search messages" }));
    const margaretSearch = await screen.findByRole<HTMLInputElement>("searchbox", {
      name: "Search messages",
    });
    searchAllConversations();
    enterText(margaretSearch, lab.privateSearchText);

    await waitFor(() => {
      expect(screen.getByText("No messages found.")).toBeTruthy();
      expect(document.querySelector(".handrail-chat__message-search-result")).toBeNull();
    }, { timeout: 10_000 });
  }, 30_000);
});
