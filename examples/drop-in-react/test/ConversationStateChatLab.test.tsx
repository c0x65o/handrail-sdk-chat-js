import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  ConversationStateChatLab,
  createConversationStateFixtureClient,
  resolveConversationStateFixture,
  type ConversationStateFixtureKind,
} from "../src/ConversationStateChatLab";
import { chatLabThemeStorageKey } from "../src/chat-lab-theme";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

interface MediaQueryController {
  setMatches(matches: boolean): void;
}

const installMatchMedia = (initialMatches: boolean): MediaQueryController => {
  let matches = initialMatches;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const mediaQuery = {
    get matches() {
      return matches;
    },
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addEventListener: (type: string, listener: (event: MediaQueryListEvent) => void) => {
      if (type === "change") listeners.add(listener);
    },
    removeEventListener: (type: string, listener: (event: MediaQueryListEvent) => void) => {
      if (type === "change") listeners.delete(listener);
    },
    addListener: (listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
    removeListener: (listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
    dispatchEvent: () => true,
  } as MediaQueryList;

  vi.stubGlobal("matchMedia", vi.fn(() => mediaQuery));
  return {
    setMatches(nextMatches) {
      matches = nextMatches;
      const event = { matches, media: mediaQuery.media } as MediaQueryListEvent;
      act(() => {
        for (const listener of listeners) listener(event);
      });
    },
  };
};

const expectedPanels: ReadonlyArray<readonly [
  ConversationStateFixtureKind,
  string,
  "alert" | "status",
  "assertive" | "polite",
  string | null,
  RegExp,
]> = [
  ["loading", "conversation-loading", "status", "polite", "true", /Loading conversation/u],
  ["unavailable", "conversation-unavailable", "status", "polite", null, /Conversation unavailable/u],
  ["error", "conversation-error", "alert", "assertive", null, /Unable to load conversation/u],
  ["no-selection", "conversation-selecting", "status", "polite", "true", /Selecting a conversation/u],
  ["empty", "no-conversation", "status", "polite", null, /No conversations/u],
];

const themedPanels = expectedPanels.flatMap((panel) =>
  (["light", "dark"] as const).map((theme) => [...panel, theme] as const)
);

const shell = () => document.querySelector<HTMLElement>(".chat-lab");

describe("development conversation-state Chat Lab", () => {
  it.each(themedPanels)(
    "renders the directly selected %s fixture with an explicit workspace theme",
    async (state, stateKind, role, live, busy, title, theme) => {
      localStorage.setItem(chatLabThemeStorageKey, theme);
      render(<ConversationStateChatLab state={state} />);

      const fixtureLabel = state === "no-selection"
        ? "No selection"
        : `${state[0]?.toUpperCase()}${state.slice(1)}`;
      const workspace = screen.getByLabelText(
        `${fixtureLabel} conversation state`,
      );
      const panel = await waitFor(() => {
        const match = workspace.querySelector(`[data-state-kind="${stateKind}"]`);
        expect(match).toBeTruthy();
        return match as HTMLElement;
      });

      expect(panel.getAttribute("role")).toBe(role);
      expect(panel.getAttribute("aria-live")).toBe(live);
      expect(panel.getAttribute("aria-busy")).toBe(busy);
      expect(panel.textContent).toMatch(title);
      expect(within(workspace).getByRole("navigation", { name: "Conversations" }))
        .toBeTruthy();
      expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Theme" }).value)
        .toBe(theme);
      expect(shell()?.getAttribute("data-chat-lab-theme")).toBe(theme);
      expect(shell()?.getAttribute("data-chat-lab-effective-theme")).toBe(theme);
      expect(shell()?.getAttribute("data-handrail-theme")).toBe(theme);
      expect(workspace.getAttribute("data-handrail-theme")).toBe(theme);

      const fixtureNavigation = screen.getByRole("navigation", {
        name: "Conversation fixture state",
      });
      const currentLinks = within(fixtureNavigation).getAllByRole("link")
        .filter((link) => link.getAttribute("aria-current") === "page");
      expect(currentLinks).toHaveLength(1);
      expect(currentLinks[0]?.getAttribute("href")).toBe(`?state=${state}`);
    },
  );

  it("renders the no-selection URL without timeline or composer access in system mode", async () => {
    const media = installMatchMedia(false);
    window.history.replaceState({}, "", "?state=no-selection");
    render(<ConversationStateChatLab />);

    const workspace = screen.getByLabelText("No selection conversation state");
    const panel = await waitFor(() => {
      const match = workspace.querySelector(
        '[data-state-kind="conversation-selecting"]',
      );
      expect(match).toBeTruthy();
      return match as HTMLElement;
    });
    expect(panel.textContent).toMatch(/Selecting a conversation/u);

    const conversationNavigation = within(workspace).getByRole("navigation", {
      name: "Conversations",
    });
    const conversationRows = conversationNavigation.querySelectorAll(
      ".handrail-chat__conversation-button",
    );
    expect(conversationRows.length).toBeGreaterThan(0);
    expect(conversationNavigation.querySelectorAll('[aria-current="page"]'))
      .toHaveLength(0);
    expect(within(workspace).queryByLabelText("Message timeline")).toBeNull();
    expect(within(workspace).queryByLabelText("Conversation composer")).toBeNull();

    const fixtureNavigation = screen.getByRole("navigation", {
      name: "Conversation fixture state",
    });
    const currentLinks = within(fixtureNavigation).getAllByRole("link")
      .filter((link) => link.getAttribute("aria-current") === "page");
    expect(currentLinks).toHaveLength(1);
    expect(currentLinks[0]?.getAttribute("href")).toBe("?state=no-selection");

    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Theme" }).value)
      .toBe("system");
    expect(shell()?.getAttribute("data-chat-lab-theme")).toBe("system");
    expect(shell()?.getAttribute("data-chat-lab-effective-theme")).toBe("light");
    expect(shell()?.hasAttribute("data-handrail-theme")).toBe(false);
    expect(workspace.hasAttribute("data-handrail-theme")).toBe(false);

    media.setMatches(true);
    expect(shell()?.getAttribute("data-chat-lab-effective-theme")).toBe("dark");
    expect(workspace.hasAttribute("data-handrail-theme")).toBe(false);
  });

  it("renders the empty URL as a stable workspace with no conversation controls", async () => {
    const media = installMatchMedia(false);
    window.history.replaceState({}, "", "?state=empty");
    render(<ConversationStateChatLab />);

    const workspace = screen.getByLabelText("Empty conversation state");
    const panel = await waitFor(() => {
      const match = workspace.querySelector('[data-state-kind="no-conversation"]');
      expect(match).toBeTruthy();
      return match as HTMLElement;
    });
    expect(panel.getAttribute("role")).toBe("status");
    expect(panel.getAttribute("aria-live")).toBe("polite");

    const conversationNavigation = within(workspace).getByRole("navigation", {
      name: "Conversations",
    });
    expect(conversationNavigation.querySelectorAll(
      ".handrail-chat__conversation-button",
    )).toHaveLength(0);
    expect(within(workspace).queryByLabelText("Message timeline")).toBeNull();
    expect(within(workspace).queryByLabelText("Conversation composer")).toBeNull();

    const fixtureNavigation = screen.getByRole("navigation", {
      name: "Conversation fixture state",
    });
    const currentLinks = within(fixtureNavigation).getAllByRole("link")
      .filter((link) => link.getAttribute("aria-current") === "page");
    expect(currentLinks).toHaveLength(1);
    expect(currentLinks[0]?.getAttribute("href")).toBe("?state=empty");

    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Theme" }).value)
      .toBe("system");
    expect(shell()?.getAttribute("data-chat-lab-theme")).toBe("system");
    expect(shell()?.getAttribute("data-chat-lab-effective-theme")).toBe("light");
    expect(shell()?.hasAttribute("data-handrail-theme")).toBe(false);
    expect(workspace.hasAttribute("data-handrail-theme")).toBe(false);

    media.setMatches(true);
    expect(shell()?.getAttribute("data-chat-lab-effective-theme")).toBe("dark");
    expect(workspace.hasAttribute("data-handrail-theme")).toBe(false);
  });

  it("keeps unavailable distinct from the generic conversation error panel", async () => {
    render(<ConversationStateChatLab state="unavailable" />);
    const workspace = screen.getByLabelText("Unavailable conversation state");

    await waitFor(() => {
      expect(workspace.querySelector('[data-state-kind="conversation-unavailable"]'))
        .toBeTruthy();
    });
    expect(workspace.querySelector('[data-state-kind="conversation-error"]')).toBeNull();
    expect(within(workspace).queryByRole("alert")).toBeNull();
  });

  it("resolves stable query targets and defaults invalid or missing selectors to unavailable", () => {
    expect(resolveConversationStateFixture("?state=loading")).toBe("loading");
    expect(resolveConversationStateFixture("?state=unavailable")).toBe("unavailable");
    expect(resolveConversationStateFixture("?state=error")).toBe("error");
    expect(resolveConversationStateFixture("?state=no-selection")).toBe("no-selection");
    expect(resolveConversationStateFixture("?state=empty")).toBe("empty");
    expect(resolveConversationStateFixture("?state=unknown")).toBe("unavailable");
    expect(resolveConversationStateFixture("")).toBe("unavailable");
  });

  it("uses a read-only in-memory client with no HTTP or mutation surface", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const fixtureClient = createConversationStateFixtureClient("empty");
    const client = fixtureClient as unknown as Record<string, unknown>;
    const mutationMethods = [
      "sendMessage",
      "editMessage",
      "deleteMessage",
      "setReaction",
      "createChannel",
      "createDirect",
      "createGroupDirect",
      "updateConversationPreference",
      "markRead",
      "markUnread",
    ];

    expect(client.endpoint).toBe("fixture://conversation-state");
    expect(fixtureClient.state.state).toBe("ready");
    expect(fixtureClient.cache.getState().metadata.conversationLists.organization
      ?.conversationIds).toEqual([]);
    await expect(fixtureClient.listConversations({ scope: { type: "organization" } }))
      .resolves.toMatchObject({ status: "success" });
    for (const method of mutationMethods) expect(client).not.toHaveProperty(method);

    render(<ConversationStateChatLab state="empty" />);
    await waitFor(() => {
      expect(screen.getByLabelText("Empty conversation state").querySelector(
        '[data-state-kind="no-conversation"]',
      )).toBeTruthy();
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps the canonical fixture conversation non-archived", () => {
    const state = createConversationStateFixtureClient("loading").cache.getState();
    const fixtureConversationId = state.metadata.conversationLists.organization
      ?.conversationIds[0];
    const fixtureConversation = fixtureConversationId === undefined
      ? undefined
      : state.entities.conversations[fixtureConversationId];

    expect(fixtureConversation).toBeDefined();
    expect(fixtureConversation).not.toHaveProperty("archivedAt");
    expect(fixtureConversation).not.toHaveProperty("archivedByUserId");
  });

  it("owns a dedicated development entry that is omitted from production inputs", () => {
    const html = readFileSync(
      resolve(process.cwd(), "conversation-state-chat-lab.html"),
      "utf8",
    );
    const bootstrap = readFileSync(
      resolve(process.cwd(), "src/conversation-state-chat-lab-main.tsx"),
      "utf8",
    );
    const viteConfig = readFileSync(resolve(process.cwd(), "vite.config.ts"), "utf8");

    expect(html).toMatch(/src="\/src\/conversation-state-chat-lab-main\.tsx"/u);
    expect(bootstrap).toMatch(/!import\.meta\.env\.DEV/u);
    expect(viteConfig).not.toMatch(
      /new URL\("\.\/conversation-state-chat-lab\.html"/u,
    );
  });
});
