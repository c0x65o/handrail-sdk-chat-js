import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { ChatLabActorChooser, ChatLabShell } from "../src/ChatLabShell";
import { chatLabActors, createChatLabConfig } from "../src/chat-lab-config";

afterEach(cleanup);

const shellThemeProps = {
  effectiveTheme: "light",
  huddleMediaConfigured: false,
  themePreference: "system",
} as const;

describe("Chat Lab shell", () => {
  it("keeps the viewport grid and compact host sizing shrinkable", () => {
    const styles = readFileSync(resolve(process.cwd(), "src/chat-lab.css"), "utf8");

    expect(styles).toMatch(
      /\.chat-lab\s*{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\);[^}]*block-size:\s*100dvh;[^}]*min-block-size:\s*0;/s,
    );
    expect(styles).toMatch(
      /\.chat-lab__stage\s*{[^}]*inline-size:\s*100%;[^}]*max-inline-size:\s*92rem;[^}]*min-block-size:\s*0;[^}]*min-inline-size:\s*0;/s,
    );
    expect(styles).not.toMatch(/\.chat-lab__stage\s*{[^}]*block-size:\s*100%;/s);
    expect(styles).toMatch(
      /\.chat-lab__workspace,[^{}]*\.chat-lab__chat\s*{[^}]*min-inline-size:\s*0;[^}]*inline-size:\s*100%;[^}]*max-inline-size:\s*100%;/s,
    );
    expect(styles).toMatch(/\.chat-lab__identity-menu\s*{[^}]*inline-size:\s*min\(18rem, calc\(100vw - 1\.5rem\)\);/s);
    expect(styles).toMatch(
      /\.chat-lab__chat \.handrail-chat__navigation-header \.chat-lab__identity-menu\s*{[^}]*inline-size:\s*min\(18rem, calc\(100% - \(2 \* var\(--hr-chat-space-1\)\)\)\);/s,
    );
    expect(styles).not.toMatch(/\.chat-lab__actors\b/u);
  });

  it("keeps the light desktop navigation roomy, dense, and visibly grouped", () => {
    const styles = readFileSync(resolve(process.cwd(), "src/chat-lab.css"), "utf8");

    expect(styles).toMatch(
      /\.chat-lab\[data-chat-lab-effective-theme="light"\][\s\S]*?\.chat-lab__chat:not\(\[data-handrail-compact-layout="true"\]\)\s*{[^}]*grid-template-columns:\s*17rem minmax\(0, 1fr\);/s,
    );
    expect(styles).toMatch(
      /\.handrail-chat__conversation-section\[data-conversation-section="starred"\]\s*{[^}]*margin-block-end:\s*0\.5rem;/s,
    );
    expect(styles).toMatch(
      /\.handrail-chat__conversation-section-disclosure\s*{[^}]*min-block-size:\s*1\.5rem;[^}]*padding-inline:\s*0\.375rem 0\.1875rem;/s,
    );
    expect(styles).toMatch(
      /\.handrail-chat__conversation-list\s*{[^}]*gap:\s*0;/s,
    );
    expect(styles).toMatch(
      /\.handrail-chat__conversation-button\s*{[^}]*padding:\s*0\.125rem 0\.4375rem;[^}]*padding-inline-start:\s*1\.375rem;/s,
    );
    expect(styles).not.toMatch(/handrail-chat__conversation-section-(?:header|title)/u);
  });

  it("initializes the real client cache with the selected test-harness identity", () => {
    const onStateChange = vi.fn();
    const config = createChatLabConfig("margaret", onStateChange);
    expect(config.cache?.getState().identity).toEqual({
      tenantId: "chat-lab",
      userId: "margaret",
      sessionId: "test-session:chat-lab:margaret",
    });
    expect(config.messageSearch).toEqual({ debounceMs: 100 });
    expect(config.crossTab).toEqual({
      sessionFingerprint: "chat-lab:actor:margaret",
    });
    expect(createChatLabConfig("margaret").crossTab).toEqual(config.crossTab);
    expect(createChatLabConfig("ada").crossTab).toEqual({
      sessionFingerprint: "chat-lab:actor:ada",
    });
    const restartedConfig = createChatLabConfig(
      "ada",
      undefined,
      "0123456789abcdef0123456789abcdef",
    );
    expect(restartedConfig.cache?.getState().identity?.sessionId).toBe(
      "test-session:chat-lab:ada:0123456789abcdef0123456789abcdef",
    );
    expect(restartedConfig.crossTab).toEqual({
      sessionFingerprint:
        "chat-lab:actor:ada:0123456789abcdef0123456789abcdef",
    });
    expect(config.realtime).toEqual({ onStateChange });
    expect(createChatLabConfig("ada").realtime).toEqual({});
    expect(chatLabActors.map(({ id, creationAvailability }) => ({
      id,
      creationAvailability,
    }))).toEqual([
      {
        id: "ada",
        creationAvailability: {
          channel: { canCreate: true },
          direct: { canCreate: true },
          groupDirect: { canCreate: true },
        },
      },
      {
        id: "grace",
        creationAvailability: {
          channel: { canCreate: true },
          direct: { canCreate: true },
          groupDirect: { canCreate: true },
        },
      },
      {
        id: "margaret",
        creationAvailability: {
          channel: { canCreate: true },
          direct: { canCreate: true },
          groupDirect: { canCreate: true },
        },
      },
    ]);
  });

  it("renders one fixture identity trigger and preserves the live status and About affordance", () => {
    const onActorChange = vi.fn();
    render(
      <ChatLabShell
        {...shellThemeProps}
        activeActorName="Ada Lovelace"
        huddleMediaConfigured
        realtimeState={{ state: "connected", metadata: {
          packageVersion: "0.0.0",
          protocolVersion: 1,
          schemaVersion: 1,
          enabledFeatures: {},
          supportedProtocolRange: { minimumVersion: 1, maximumVersion: 1 },
        } }}
        workspace={(
          <div
            className="handrail-chat__navigation-header"
            data-testid="real-workspace-boundary"
          >
            <ChatLabActorChooser
              actors={chatLabActors}
              activeActorId="ada"
              onActorChange={onActorChange}
            />
          </div>
        )}
      />,
    );

    expect(screen.getByRole("heading", { name: "Handrail Chat Lab" })).toBeTruthy();
    expect(screen.getByText("Development workspace")).toBeTruthy();
    expect(screen.getByText("Current actor: Ada Lovelace")).toBeTruthy();
    const liveRegion = screen.getByRole("status");
    expect(liveRegion.textContent).toBe("Managed realtime connected");
    expect(liveRegion.getAttribute("data-realtime-state")).toBe("connected");
    expect(liveRegion.classList.contains("chat-lab__sr-only")).toBe(true);
    expect(document.querySelector(".chat-lab__realtime-status")).toBeNull();
    expect(screen.queryByText("Connected")).toBeNull();
    expect(screen.getByTestId("real-workspace-boundary")).toBeTruthy();
    const identityTrigger = screen.getByRole("button", {
      name: "Development fixture identity: Ada Lovelace",
    });
    expect(screen.getAllByRole("button", {
      name: /Development fixture identity:/u,
    })).toHaveLength(1);
    expect(identityTrigger.closest(".handrail-chat__navigation-header")).toBeTruthy();
    expect(document.querySelector(".chat-lab__toolbar .chat-lab__identity")).toBeNull();
    expect(identityTrigger.getAttribute("aria-expanded")).toBe("false");
    expect(identityTrigger.querySelector("svg.chat-lab__identity-chevron")).toBeTruthy();
    expect(identityTrigger.textContent).not.toContain("▾");
    expect(screen.getAllByText("Dev fixture")).toHaveLength(1);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.queryByText("Grace Hopper")).toBeNull();

    const detailsSummary = screen.getByText("About");
    expect(detailsSummary.getAttribute("aria-label")).toBe("About this lab and local media");
    fireEvent.click(detailsSummary);
    expect(detailsSummary.closest("details")?.hasAttribute("open")).toBe(true);
    expect(screen.getByText(/Huddle media is configured for this Chat Lab session/u))
      .toBeTruthy();

    fireEvent.click(identityTrigger);
    const menu = screen.getByRole("listbox", { name: "Development fixture identities" });
    const options = within(menu).getAllByRole("option");
    expect(options).toHaveLength(chatLabActors.length);
    expect(options.filter((option) => option.getAttribute("aria-selected") === "true"))
      .toEqual([within(menu).getByRole("option", { name: "Ada Lovelace Product" })]);
    expect(within(menu).getByRole("option", { name: "Ada Lovelace Product" })
      .querySelector("svg.chat-lab__identity-check")).toBeTruthy();
    expect(menu.textContent).not.toContain("✓");

    fireEvent.click(within(menu).getByRole("option", { name: "Grace Hopper Engineering" }));
    expect(onActorChange).toHaveBeenCalledOnce();
    expect(onActorChange).toHaveBeenCalledWith("grace");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(identityTrigger);
  });

  it("leaves theme selection out of the outer toolbar and preserves shell attributes", () => {
    render(
      <ChatLabShell
        activeActorName="Ada Lovelace"
        effectiveTheme="dark"
        huddleMediaConfigured={false}
        realtimeState={{ state: "idle" }}
        themePreference="dark"
        workspace={null}
      />,
    );

    expect(screen.queryByRole("combobox", { name: "Theme" })).toBeNull();
    expect(document.querySelector(".chat-lab__toolbar .chat-lab__theme-control"))
      .toBeNull();

    const shell = document.querySelector(".chat-lab");
    expect(shell?.getAttribute("data-chat-lab-theme")).toBe("dark");
    expect(shell?.getAttribute("data-chat-lab-effective-theme")).toBe("dark");
    expect(shell?.getAttribute("data-handrail-theme")).toBe("dark");
    expect(screen.getByText(
      "Huddle media not configured. Start and Join actions are unavailable.",
    )).toBeTruthy();
  });

  it("uses shared semantic theme tokens for shell surfaces, controls, overlays, and status states", () => {
    const styles = readFileSync(resolve(process.cwd(), "src/chat-lab.css"), "utf8");

    expect(styles).toMatch(
      /\.chat-lab\s*{[^}]*color:\s*var\(--hr-chat-color-text\);[^}]*background:\s*var\(--hr-chat-color-canvas\);/s,
    );
    expect(styles).toMatch(
      /\.chat-lab__identity-trigger\s*{[^}]*border:[^;]*transparent;[^}]*color:\s*var\(--hr-chat-color-navigation-text-muted\);[^}]*background:\s*transparent;/s,
    );
    expect(styles).toMatch(
      /\.chat-lab__identity-chevron,\s*\.chat-lab__identity-check,\s*\.chat-lab__theme-settings-check\s*{[^}]*fill:\s*none;[^}]*stroke:\s*currentColor;[^}]*stroke-linecap:\s*round;[^}]*stroke-linejoin:\s*round;[^}]*stroke-width:\s*1\.8;/s,
    );
    expect(styles).toMatch(
      /\.chat-lab__identity-check,\s*\.chat-lab__theme-settings-check\s*{[^}]*inline-size:\s*1rem;[^}]*block-size:\s*1rem;[^}]*color:\s*var\(--hr-chat-color-accent\);/s,
    );
    expect(styles).toMatch(
      /\.chat-lab__theme-control select\s*{[^}]*border:[^;]*var\(--hr-chat-color-border\);[^}]*background:\s*var\(--hr-chat-color-surface\);/s,
    );
    expect(styles).toMatch(
      /\.chat-lab__theme-settings-menu\s*{[^}]*inline-size:\s*min\(14rem, calc\(100% - \(2 \* var\(--hr-chat-space-1\)\)\)\);[^}]*background:\s*var\(--hr-chat-color-surface-raised\);[^}]*box-shadow:\s*var\(--hr-chat-elevation-menu\);/s,
    );
    expect(styles).toMatch(
      /\.chat-lab__identity-menu\s*{[^}]*background:\s*var\(--hr-chat-color-surface-raised\);[^}]*box-shadow:\s*var\(--hr-chat-elevation-menu\);/s,
    );
    expect(styles).toMatch(
      /\.chat-lab__details p\s*{[^}]*background:\s*var\(--hr-chat-color-surface-raised\);[^}]*box-shadow:\s*var\(--hr-chat-elevation-menu\);/s,
    );
    expect(styles).toMatch(
      /\.chat-lab__stage\s*{[^}]*background:\s*var\(--hr-chat-color-surface\);[^}]*box-shadow:\s*var\(--hr-chat-shadow-lg\);/s,
    );
    expect(styles).toMatch(
      /\.chat-lab__realtime-status\s*{[^}]*border:[^;]*var\(--hr-chat-color-warning\);[^}]*color:\s*var\(--hr-chat-color-warning\);[^}]*background:\s*var\(--hr-chat-color-warning-background\);/s,
    );
    expect(styles).toMatch(/\.chat-lab__status-dot\s*{[^}]*var\(--hr-chat-color-warning\)/s);
    expect(styles).toMatch(/data-realtime-state="idle"[^}]*var\(--hr-chat-color-surface-muted\)/s);
    expect(styles).toMatch(/data-realtime-state="offline"[^}]*var\(--hr-chat-color-danger\)/s);
    expect(styles).toMatch(/data-realtime-state="refresh_required"[^}]*var\(--hr-chat-color-danger\)/s);
    expect(styles).toMatch(/\.chat-lab\[data-chat-lab-theme="light"\][^{]*{[^}]*color-scheme:\s*light;/s);
    expect(styles).toMatch(/\.chat-lab\[data-chat-lab-theme="dark"\][^{]*{[^}]*color-scheme:\s*dark;/s);
    expect(styles).toMatch(
      /@media\s*\(prefers-color-scheme:\s*dark\)[^{]*{\s*\.chat-lab\[data-chat-lab-theme="system"\][^{]*{[^}]*color-scheme:\s*dark;/s,
    );
  });

  it.each(["Enter", " "])(
    "supports keyboard opening, navigation, and %s selection without duplicate changes",
    (selectionKey) => {
      const onActorChange = vi.fn();
      render(
        <ChatLabActorChooser
          actors={chatLabActors}
          activeActorId="ada"
          onActorChange={onActorChange}
        />,
      );

      const identityTrigger = screen.getByRole("button", {
        name: "Development fixture identity: Ada Lovelace",
      });
      identityTrigger.focus();
      fireEvent.keyDown(identityTrigger, { key: "Enter" });

      const menu = screen.getByRole("listbox", { name: "Development fixture identities" });
      const adaOption = within(menu).getByRole("option", { name: "Ada Lovelace Product" });
      const graceOption = within(menu).getByRole("option", { name: "Grace Hopper Engineering" });
      const margaretOption = within(menu).getByRole("option", {
        name: "Margaret Hamilton Flight software",
      });
      expect(document.activeElement).toBe(adaOption);

      fireEvent.keyDown(adaOption, { key: "End" });
      expect(document.activeElement).toBe(margaretOption);
      fireEvent.keyDown(margaretOption, { key: "Home" });
      expect(document.activeElement).toBe(adaOption);
      fireEvent.keyDown(adaOption, { key: "ArrowDown" });
      expect(document.activeElement).toBe(graceOption);
      fireEvent.keyDown(graceOption, { key: "ArrowUp" });
      expect(document.activeElement).toBe(adaOption);
      fireEvent.keyDown(adaOption, { key: "ArrowDown" });
      fireEvent.keyDown(graceOption, { key: selectionKey });

      expect(onActorChange).toHaveBeenCalledOnce();
      expect(onActorChange).toHaveBeenCalledWith("grace");
      expect(screen.queryByRole("listbox")).toBeNull();
      expect(document.activeElement).toBe(identityTrigger);
    },
  );

  it("dismisses the identity menu with Escape and an outside click and returns focus", () => {
    render(
      <>
        <ChatLabActorChooser
          actors={chatLabActors}
          activeActorId="grace"
          onActorChange={() => undefined}
        />
        <button type="button">Outside control</button>
      </>,
    );

    const identityTrigger = screen.getByRole("button", {
      name: "Development fixture identity: Grace Hopper",
    });
    identityTrigger.focus();
    fireEvent.keyDown(identityTrigger, { key: "ArrowUp" });
    expect(document.activeElement).toBe(screen.getByRole("option", {
      name: "Margaret Hamilton Flight software",
    }));
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(identityTrigger);

    fireEvent.click(identityTrigger);
    expect(screen.getByRole("listbox")).toBeTruthy();
    const outsideControl = screen.getByRole("button", { name: "Outside control" });
    fireEvent.mouseDown(outsideControl);
    outsideControl.focus();
    fireEvent.click(outsideControl);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(identityTrigger);
  });

  it.each([
    [{ state: "idle" } as const, "Managed realtime idle", "Idle"],
    [{ state: "connecting" } as const, "Managed realtime connecting", "Connecting"],
    [{
      state: "reconnecting",
      attempt: 2,
      delayMs: 500,
      diagnostic: { code: "connection_lost", message: "Connection interrupted." },
    } as const, "Managed realtime reconnecting (attempt 2)", "Reconnecting · attempt 2"],
    [{ state: "offline" } as const, "Managed realtime offline", "Offline"],
    [{
      state: "hydrating_snapshot",
      reason: "replay_expired",
    } as const, "Managed realtime recovering snapshot (replay expired)", "Recovering · replay expired"],
    [{
      state: "refresh_required",
      reason: "unsupported_protocol",
      message: "Chat was updated; refresh to continue.",
      requestedProtocolVersion: 1,
      metadata: {
        packageVersion: "2.0.0",
        protocolVersion: 2,
        schemaVersion: 1,
        enabledFeatures: {},
        supportedProtocolRange: { minimumVersion: 2, maximumVersion: 2 },
      },
    } as const, "Managed realtime refresh required", "Refresh required"],
  ])("renders degraded managed realtime state %# without raw socket events", (realtimeState, text, label) => {
    render(
      <ChatLabShell
        {...shellThemeProps}
        activeActorName="Grace Hopper"
        realtimeState={realtimeState}
        workspace={null}
      />,
    );

    const liveRegion = screen.getByRole("status");
    expect(liveRegion.textContent).toBe(text);
    expect(liveRegion.getAttribute("data-realtime-state")).toBe(realtimeState.state);

    const notice = document.querySelector(".chat-lab__realtime-status");
    expect(notice?.textContent).toBe(label);
    expect(notice?.getAttribute("aria-hidden")).toBe("true");
    expect(notice?.getAttribute("data-realtime-state")).toBe(realtimeState.state);
  });
});
