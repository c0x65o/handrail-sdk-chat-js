import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import type { ChatClient } from "@handrail/chat/client";
import { ChatProvider } from "@handrail/chat/react";

import { DropInChatExample } from "../src/DropInChatExample";
import "../src/styles.css";
import { createDropInFixture } from "./chat-fixture";

const renderExample = (client: ChatClient = createDropInFixture()) => render(
  <ChatProvider client={client}>
    <DropInChatExample />
  </ChatProvider>,
);

afterEach(cleanup);

describe("drop-in ChatWorkspace example", () => {
  it("renders a complete organization-scoped full-screen workspace", () => {
    renderExample();

    const workspace = screen.getByLabelText("Organization chat workspace");
    expect(workspace.getAttribute("data-handrail-chat-mode")).toBe("full-screen");
    expect(workspace.getAttribute("data-handrail-chat-scope")).toBe("organization");
    expect(workspace.classList.contains("company-chat-theme")).toBe(true);
    expect(getComputedStyle(workspace).getPropertyValue("--hr-chat-color-accent").trim()).toBe("#4f46e5");
    expect(within(workspace).getAllByText("Organization operations").length).toBeGreaterThan(0);
    expect(within(workspace).getByText("The full-screen workspace is ready.")).toBeTruthy();
    expect(within(workspace).getByLabelText("Conversation composer")).toBeTruthy();
  });

  it("submits non-empty composer text once and blocks empty submissions", async () => {
    const onSendMessage = vi.fn();
    renderExample(createDropInFixture({ onSendMessage }));

    const workspace = screen.getByLabelText("Organization chat workspace");
    const form = workspace.querySelector('[data-example-slot="Composer"]');
    if (!(form instanceof HTMLFormElement)) throw new Error("Composer form was not rendered.");
    const composer = within(form).getByRole("textbox") as HTMLTextAreaElement;
    const send = within(form).getByRole("button", { name: "Send" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);

    fireEvent.change(composer, { target: { value: "Ready for production." } });
    expect(send.disabled).toBe(false);

    let submitEvent: Event | undefined;
    form.addEventListener("submit", (event) => {
      submitEvent = event;
    }, { once: true });
    fireEvent.click(send);

    expect(submitEvent?.defaultPrevented).toBe(true);
    await waitFor(() => expect(onSendMessage).toHaveBeenCalledOnce());
    expect(onSendMessage.mock.calls[0]?.[0]).toMatchObject({
      conversationId: "conversation-organization",
      content: { format: "plain", text: "Ready for production." },
    });
    await waitFor(() => {
      expect(composer.value).toBe("");
      expect(send.disabled).toBe(true);
    });

    const emptySubmit = new Event("submit", { bubbles: true, cancelable: true });
    fireEvent(form, emptySubmit);
    expect(emptySubmit.defaultPrevented).toBe(true);
    expect(onSendMessage).toHaveBeenCalledOnce();
  });

  it("embeds an entity-scoped workspace as a record side panel", () => {
    renderExample();

    const panel = screen.getByLabelText("Sales order chat panel");
    const workspace = within(panel).getByLabelText("Sales order SO-1042 chat");
    expect(workspace.getAttribute("data-handrail-chat-mode")).toBe("side-panel");
    expect(workspace.getAttribute("data-handrail-chat-scope")).toBe("entity");
    expect(workspace.getAttribute("data-handrail-theme")).toBe("dark");
    expect(workspace.classList.contains("company-chat-theme--record")).toBe(true);
    expect(getComputedStyle(workspace).getPropertyValue("--hr-chat-color-accent").trim()).toBe("#a5b4fc");
    expect(within(workspace).queryByText("Organization operations")).toBeNull();
    expect(within(workspace).getByText("Approval notes are attached to this record.")).toBeTruthy();
  });

  it("renders each public slot override exercised by the populated fixture", () => {
    renderExample();

    for (const name of [
      "WorkspaceHeader",
      "Avatar",
      "Message",
      "ChannelHeader",
      "Composer",
      "Attachment",
      "SystemEvent",
      "User",
      "EntityReference",
    ]) {
      expect(document.querySelector(`[data-example-slot="${name}"]`)).toBeTruthy();
    }
    expect(screen.getAllByText("approval-notes.txt").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Sales order SO-1042").length).toBeGreaterThan(0);
  });
});
