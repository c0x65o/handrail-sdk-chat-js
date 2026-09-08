import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const workspaceFixture = vi.hoisted(() => ({
  graceConversationIds: ["grace-b", "shared"],
  mounts: [] as Array<{
    readonly actorId: string | undefined;
    readonly conversationIds: readonly string[];
    readonly defaultConversationId: string | undefined;
  }>,
}));

vi.mock("@handrail/chat/react", async () => {
  const { Fragment, createElement } = await import("react");
  return {
    useChat: () => null,
    ChatProvider: ({ children }: { readonly children?: ReactNode }) =>
      createElement(Fragment, null, children),
  };
});

vi.mock("@handrail/chat/ui", async () => {
  const { createElement, useState } = await import("react");
  const labels: Readonly<Record<string, string>> = {
    "ada-a": "Conversation A",
    "grace-b": "Conversation B",
    shared: "Shared fallback",
  };

  return {
    UserStatusSelector: ({ onStatusChange }: {
      readonly onStatusChange?: (status: undefined) => void;
    }) => createElement("button", {
      "aria-label": "Set your status: Online",
      onClick: () => onStatusChange?.(undefined),
      type: "button",
    }, "Online"),
    ChatWorkspace: (props: {
      readonly ariaLabel?: string;
      readonly conversationId?: string;
      readonly currentUserId?: string;
      readonly defaultConversationId?: string;
      readonly onConversationChange?: (conversationId: string) => void;
      readonly workspaceIdentity?: { readonly name: string };
      readonly workspaceMenuContent?: ReactNode;
    }) => {
      const conversationIds = props.currentUserId === "ada"
        ? ["shared", "ada-a"]
        : props.currentUserId === "grace"
          ? workspaceFixture.graceConversationIds
          : ["shared"];
      const [internalConversationId, setInternalConversationId] = useState(() => {
        workspaceFixture.mounts.push({
          actorId: props.currentUserId,
          conversationIds: [...conversationIds],
          defaultConversationId: props.defaultConversationId,
        });
        return props.defaultConversationId !== undefined &&
            conversationIds.includes(props.defaultConversationId)
          ? props.defaultConversationId
          : conversationIds[0];
      });
      const selectedConversationId = props.conversationId ?? internalConversationId;

      return createElement(
        "div",
        {
          "aria-label": props.ariaLabel,
          "data-selected-conversation-id": selectedConversationId,
        },
        createElement(
          "header",
          { className: "handrail-chat__navigation-header" },
          createElement("h2", null, props.workspaceIdentity?.name ?? "Conversations"),
          createElement(
            "div",
            { className: "handrail-chat__navigation-actions" },
            props.workspaceMenuContent,
          ),
        ),
        createElement(
          "button",
          {
            onClick: () => setInternalConversationId(conversationIds[0]),
            type: "button",
          },
          "Simulate realtime recovery",
        ),
        createElement(
          "nav",
          { "aria-label": "Conversations" },
          conversationIds.map((conversationId) => createElement(
            "button",
            {
              "aria-current": selectedConversationId === conversationId ? "page" : undefined,
              key: conversationId,
              onClick: () => {
                setInternalConversationId(conversationId);
                props.onConversationChange?.(conversationId);
              },
              type: "button",
            },
            labels[conversationId],
          )),
        ),
      );
    },
  };
});

import { ChatLabApp } from "../src/ChatLabApp";

const selectedConversationId = () =>
  document.querySelector<HTMLElement>("[data-selected-conversation-id]")
    ?.dataset["selectedConversationId"];

const activeNavigationItems = (navigation: HTMLElement) =>
  navigation.querySelectorAll('[aria-current="page"]');

const selectActor = async (displayName: string, optionName: string) => {
  fireEvent.click(screen.getByRole("button", {
    name: /Development fixture identity:/u,
  }));
  fireEvent.click(within(screen.getByRole("listbox", {
    name: "Development fixture identities",
  })).getByRole("option", { name: optionName }));
  await screen.findByText(`Current actor: ${displayName}`);
  return screen.findByRole("navigation", { name: "Conversations" });
};

afterEach(() => {
  cleanup();
  localStorage.clear();
  workspaceFixture.graceConversationIds.splice(
    0,
    workspaceFixture.graceConversationIds.length,
    "grace-b",
    "shared",
  );
  workspaceFixture.mounts.length = 0;
});

describe("ChatLabApp actor conversation selection", () => {
  it("supplies exactly one fixture chooser through the workspace-header menu slot", () => {
    render(<ChatLabApp />);

    const trigger = screen.getByRole("button", {
      name: "Development fixture identity: Ada Lovelace",
    });
    expect(screen.getAllByRole("button", {
      name: /Development fixture identity:/u,
    })).toHaveLength(1);
    expect(trigger.closest(".handrail-chat__navigation-header")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Development workspace" })).toBeTruthy();
    expect(document.querySelector(".chat-lab__toolbar .chat-lab__identity")).toBeNull();
    const chevron = trigger.querySelector("svg.chat-lab__identity-chevron");
    expect(chevron?.getAttribute("aria-hidden")).toBe("true");
    expect(chevron?.getAttribute("focusable")).toBe("false");
    expect(chevron?.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(trigger.textContent).not.toContain("▾");

    fireEvent.click(trigger);
    const menu = screen.getByRole("listbox", {
      name: "Development fixture identities",
    });
    const selectedOption = within(menu).getByRole("option", {
      name: "Ada Lovelace Product",
    });
    const check = selectedOption.querySelector("svg.chat-lab__identity-check");
    expect(check?.getAttribute("aria-hidden")).toBe("true");
    expect(check?.getAttribute("focusable")).toBe("false");
    expect(check?.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(menu.textContent).not.toContain("✓");
  });

  it("keeps an explicit selection when realtime recovery reconciles workspace state", async () => {
    render(<ChatLabApp />);

    const navigation = await screen.findByRole("navigation", { name: "Conversations" });
    fireEvent.click(within(navigation).getByRole("button", { name: "Conversation A" }));
    expect(selectedConversationId()).toBe("ada-a");

    fireEvent.click(screen.getByRole("button", { name: "Simulate realtime recovery" }));
    await waitFor(() => {
      expect(selectedConversationId()).toBe("ada-a");
      expect(activeNavigationItems(navigation)).toHaveLength(1);
    });
  });

  it("restores each actor's selection and safely falls back when a saved conversation is unavailable", async () => {
    render(<ChatLabApp />);

    let navigation = await screen.findByRole("navigation", { name: "Conversations" });
    fireEvent.click(within(navigation).getByRole("button", { name: "Conversation A" }));
    expect(selectedConversationId()).toBe("ada-a");

    navigation = await selectActor("Grace Hopper", "Grace Hopper Engineering");
    expect(localStorage.getItem("handrail-chat-lab:actor")).toBe("grace");
    expect(workspaceFixture.mounts.at(-1)?.actorId).toBe("grace");
    fireEvent.click(within(navigation).getByRole("button", { name: "Conversation B" }));
    expect(selectedConversationId()).toBe("grace-b");

    navigation = await selectActor("Ada Lovelace", "Ada Lovelace Product");
    await waitFor(() => {
      expect(selectedConversationId()).toBe("ada-a");
      expect(activeNavigationItems(navigation)).toHaveLength(1);
    });

    navigation = await selectActor("Grace Hopper", "Grace Hopper Engineering");
    await waitFor(() => {
      expect(selectedConversationId()).toBe("grace-b");
      expect(activeNavigationItems(navigation)).toHaveLength(1);
    });

    navigation = await selectActor("Ada Lovelace", "Ada Lovelace Product");
    workspaceFixture.graceConversationIds.splice(
      0,
      workspaceFixture.graceConversationIds.length,
      "shared",
    );
    navigation = await selectActor("Grace Hopper", "Grace Hopper Engineering");
    await waitFor(() => {
      expect(workspaceFixture.mounts.at(-1)).toEqual({
        actorId: "grace",
        conversationIds: ["shared"],
        defaultConversationId: "grace-b",
      });
      expect(selectedConversationId()).toBe("shared");
      expect(selectedConversationId()).not.toBe("grace-b");
      expect(selectedConversationId()).not.toBe("ada-a");
      expect(within(navigation).queryByRole("button", { name: "Conversation A" })).toBeNull();
      expect(activeNavigationItems(navigation)).toHaveLength(1);
    });
  });
});
