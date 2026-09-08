import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const workspaceFixture = vi.hoisted(() => ({
  props: [] as Array<{
    readonly theme?: "light" | "dark";
    readonly workspaceMenuContent?: ReactNode;
    readonly workspaceSettingsContent?: ReactNode;
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
  const { createElement } = await import("react");
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
      readonly theme?: "light" | "dark";
      readonly workspaceMenuContent?: ReactNode;
      readonly workspaceSettingsContent?: ReactNode;
    }) => {
      workspaceFixture.props.push({
        ...(props.theme === undefined ? {} : { theme: props.theme }),
        workspaceMenuContent: props.workspaceMenuContent,
        workspaceSettingsContent: props.workspaceSettingsContent,
      });
      return createElement("div", {
        "aria-label": props.ariaLabel,
        "data-handrail-theme": props.theme,
        "data-workspace-theme-prop": props.theme ?? "omitted",
      }, createElement("div", {
        className: "handrail-chat__navigation-header",
      }, props.workspaceMenuContent, props.workspaceSettingsContent));
    },
  };
});

import { ChatLabApp, chatLabThemeStorageKey } from "../src/ChatLabApp";

interface MediaQueryController {
  readonly mediaQuery: MediaQueryList;
  readonly removeEventListener: ReturnType<typeof vi.fn>;
  setMatches(matches: boolean): void;
}

const installMatchMedia = (initialMatches: boolean): MediaQueryController => {
  let matches = initialMatches;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const addEventListener = vi.fn((type: string, listener: (event: MediaQueryListEvent) => void) => {
    if (type === "change") listeners.add(listener);
  });
  const removeEventListener = vi.fn(
    (type: string, listener: (event: MediaQueryListEvent) => void) => {
      if (type === "change") listeners.delete(listener);
    },
  );
  const mediaQuery = {
    get matches() {
      return matches;
    },
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addEventListener,
    removeEventListener,
    addListener: (listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
    removeListener: (listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
    dispatchEvent: () => true,
  } as MediaQueryList;

  vi.stubGlobal("matchMedia", vi.fn(() => mediaQuery));
  return {
    mediaQuery,
    removeEventListener,
    setMatches(nextMatches) {
      matches = nextMatches;
      const event = { matches, media: mediaQuery.media } as MediaQueryListEvent;
      act(() => {
        for (const listener of listeners) listener(event);
      });
    },
  };
};

const shell = () => document.querySelector<HTMLElement>(".chat-lab");
const workspace = () => screen.getByLabelText("Handrail Chat Lab workspace");
const settingsTrigger = () => screen.getByRole<HTMLButtonElement>("button", {
  name: "Open theme settings",
});
const openThemeSettings = () => {
  fireEvent.click(settingsTrigger());
  return screen.getByRole("menu", { name: "Theme settings" });
};
const selectTheme = (theme: "System" | "Light" | "Dark") => {
  const menu = openThemeSettings();
  fireEvent.click(screen.getByRole("menuitemradio", { name: theme }));
  expect(menu.isConnected).toBe(false);
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  workspaceFixture.props.length = 0;
});

describe("ChatLabApp theme preference", () => {
  it("defaults to system, applies the current OS theme to the shell, and omits a workspace override", () => {
    const media = installMatchMedia(true);
    render(<ChatLabApp />);

    expect(screen.getAllByRole("button", { name: "Open theme settings" })).toHaveLength(1);
    expect(settingsTrigger().closest(".handrail-chat__navigation-header")).toBeTruthy();
    expect(document.querySelector(".chat-lab__toolbar .chat-lab__theme-settings"))
      .toBeNull();
    expect(screen.queryByRole("combobox", { name: "Theme" })).toBeNull();
    const menu = openThemeSettings();
    expect(screen.getAllByRole("menuitemradio").map((option) => option.textContent?.trim()))
      .toEqual(["System", "Light", "Dark"]);
    const systemOption = screen.getByRole("menuitemradio", { name: "System" });
    expect(systemOption.getAttribute("aria-checked")).toBe("true");
    const check = systemOption.querySelector("svg.chat-lab__theme-settings-check");
    expect(check?.getAttribute("aria-hidden")).toBe("true");
    expect(check?.getAttribute("focusable")).toBe("false");
    expect(check?.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(menu.querySelectorAll("svg.chat-lab__theme-settings-check")).toHaveLength(1);
    expect(menu.textContent).not.toContain("✓");
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Theme settings" })).toBeNull();
    expect(document.activeElement).toBe(settingsTrigger());
    expect(shell()?.getAttribute("data-chat-lab-theme")).toBe("system");
    expect(shell()?.getAttribute("data-chat-lab-effective-theme")).toBe("dark");
    expect(shell()?.hasAttribute("data-handrail-theme")).toBe(false);
    expect(workspace().hasAttribute("data-handrail-theme")).toBe(false);
    expect(workspace().getAttribute("data-workspace-theme-prop")).toBe("omitted");
    expect(workspaceFixture.props.at(-1)?.theme).toBeUndefined();

    cleanup();
    expect(media.removeEventListener).toHaveBeenCalledOnce();
  });

  it.each(["light", "dark"] as const)(
    "restores a stored %s preference on both the shell and workspace",
    (storedTheme) => {
      localStorage.setItem(chatLabThemeStorageKey, storedTheme);
      installMatchMedia(storedTheme === "light");
      render(<ChatLabApp />);

      expect(settingsTrigger().title).toBe(`Theme: ${storedTheme === "light" ? "Light" : "Dark"}`);
      expect(shell()?.getAttribute("data-chat-lab-theme")).toBe(storedTheme);
      expect(shell()?.getAttribute("data-chat-lab-effective-theme")).toBe(storedTheme);
      expect(shell()?.getAttribute("data-handrail-theme")).toBe(storedTheme);
      expect(workspace().getAttribute("data-handrail-theme")).toBe(storedTheme);
      expect(workspaceFixture.props.at(-1)?.theme).toBe(storedTheme);
    },
  );

  it("persists explicit selections and ignores later OS changes", () => {
    const media = installMatchMedia(false);
    render(<ChatLabApp />);

    selectTheme("Dark");
    expect(localStorage.getItem(chatLabThemeStorageKey)).toBe("dark");
    expect(shell()?.getAttribute("data-chat-lab-effective-theme")).toBe("dark");
    expect(shell()?.getAttribute("data-handrail-theme")).toBe("dark");
    expect(workspace().getAttribute("data-handrail-theme")).toBe("dark");
    expect(media.removeEventListener).toHaveBeenCalledOnce();

    media.setMatches(true);
    media.setMatches(false);
    expect(settingsTrigger().title).toBe("Theme: Dark");
    expect(shell()?.getAttribute("data-chat-lab-effective-theme")).toBe("dark");
    expect(workspaceFixture.props.at(-1)?.theme).toBe("dark");

    selectTheme("Light");
    expect(localStorage.getItem(chatLabThemeStorageKey)).toBe("light");
    expect(shell()?.getAttribute("data-chat-lab-effective-theme")).toBe("light");
    expect(workspace().getAttribute("data-handrail-theme")).toBe("light");

    cleanup();
    render(<ChatLabApp />);
    expect(settingsTrigger().title).toBe("Theme: Light");
    expect(shell()?.getAttribute("data-chat-lab-effective-theme")).toBe("light");
  });

  it("tracks OS changes only while the system preference is selected", () => {
    const media = installMatchMedia(false);
    render(<ChatLabApp />);

    expect(shell()?.getAttribute("data-chat-lab-effective-theme")).toBe("light");
    media.setMatches(true);
    expect(shell()?.getAttribute("data-chat-lab-effective-theme")).toBe("dark");
    expect(workspace().hasAttribute("data-handrail-theme")).toBe(false);

    media.setMatches(false);
    expect(shell()?.getAttribute("data-chat-lab-effective-theme")).toBe("light");

    selectTheme("Dark");
    selectTheme("System");
    expect(localStorage.getItem(chatLabThemeStorageKey)).toBe("system");
    expect(shell()?.getAttribute("data-chat-lab-effective-theme")).toBe("light");
    media.setMatches(true);
    expect(shell()?.getAttribute("data-chat-lab-effective-theme")).toBe("dark");
  });

  it("falls back to system for invalid storage", () => {
    localStorage.setItem(chatLabThemeStorageKey, "sepia");
    installMatchMedia(true);
    render(<ChatLabApp />);

    expect(settingsTrigger().title).toBe("Theme: System");
    expect(shell()?.getAttribute("data-chat-lab-effective-theme")).toBe("dark");
    expect(workspace().getAttribute("data-workspace-theme-prop")).toBe("omitted");
  });

  it("falls back safely when storage and matchMedia are inaccessible", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("Storage unavailable", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage unavailable", "SecurityError");
    });
    vi.stubGlobal("matchMedia", undefined);
    render(<ChatLabApp />);

    expect(settingsTrigger().title).toBe("Theme: System");
    expect(shell()?.getAttribute("data-chat-lab-effective-theme")).toBe("light");
    expect(workspace().getAttribute("data-workspace-theme-prop")).toBe("omitted");

    expect(() => selectTheme("Dark")).not.toThrow();
    expect(shell()?.getAttribute("data-chat-lab-effective-theme")).toBe("dark");
  });

  it("supports keyboard navigation, outside-click closing, and trigger focus return", () => {
    installMatchMedia(false);
    render(<ChatLabApp />);

    const trigger = settingsTrigger();
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });
    const menu = screen.getByRole("menu", { name: "Theme settings" });
    const system = screen.getByRole("menuitemradio", { name: "System" });
    const light = screen.getByRole("menuitemradio", { name: "Light" });
    const dark = screen.getByRole("menuitemradio", { name: "Dark" });
    expect(document.activeElement).toBe(system);

    fireEvent.keyDown(system, { key: "End" });
    expect(document.activeElement).toBe(dark);
    fireEvent.keyDown(dark, { key: "Home" });
    expect(document.activeElement).toBe(system);
    fireEvent.keyDown(system, { key: "ArrowDown" });
    expect(document.activeElement).toBe(light);
    fireEvent.keyDown(light, { key: "Enter" });
    expect(screen.queryByRole("menu", { name: "Theme settings" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(localStorage.getItem(chatLabThemeStorageKey)).toBe("light");

    fireEvent.click(trigger);
    expect(screen.getByRole("menu", { name: "Theme settings" })).toBeTruthy();
    fireEvent.click(document.body);
    expect(screen.queryByRole("menu", { name: "Theme settings" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(menu.isConnected).toBe(false);
  });
});
