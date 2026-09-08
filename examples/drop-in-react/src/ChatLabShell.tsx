import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { ChatRealtimeSessionState } from "@handrail/chat/client";
import type {
  ChatLabEffectiveTheme,
  ChatLabThemePreference,
} from "./chat-lab-theme";

export type { ChatLabEffectiveTheme, ChatLabThemePreference } from "./chat-lab-theme";

export interface ChatLabActorSummary {
  readonly id: string;
  readonly displayName: string;
  readonly role: string;
}

export interface ChatLabActorChooserProps {
  readonly actors: readonly ChatLabActorSummary[];
  readonly activeActorId: string;
  readonly onActorChange: (actorId: string) => void;
}

export interface ChatLabShellProps {
  readonly activeActorName: string;
  readonly effectiveTheme: ChatLabEffectiveTheme;
  readonly huddleMediaConfigured: boolean;
  readonly realtimeState: ChatRealtimeSessionState;
  readonly themePreference: ChatLabThemePreference;
  readonly workspace: ReactNode;
}

const realtimeStatusText = (state: ChatRealtimeSessionState): string => {
  switch (state.state) {
    case "idle":
      return "Managed realtime idle";
    case "connecting":
      return "Managed realtime connecting";
    case "connected":
      return "Managed realtime connected";
    case "reconnecting":
      return `Managed realtime reconnecting (attempt ${state.attempt})`;
    case "offline":
      return "Managed realtime offline";
    case "hydrating_snapshot":
      return `Managed realtime recovering snapshot (${state.reason.replaceAll("_", " ")})`;
    case "refresh_required":
      return "Managed realtime refresh required";
  }
};

const realtimeStatusLabel = (state: ChatRealtimeSessionState): string => {
  switch (state.state) {
    case "idle":
      return "Idle";
    case "connecting":
      return "Connecting";
    case "connected":
      return "Connected";
    case "reconnecting":
      return `Reconnecting · attempt ${state.attempt}`;
    case "offline":
      return "Offline";
    case "hydrating_snapshot":
      return `Recovering · ${state.reason.replaceAll("_", " ")}`;
    case "refresh_required":
      return "Refresh required";
  }
};

const actorInitials = (displayName: string): string =>
  displayName
    .trim()
    .split(/\s+/u)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();

export function ChatLabActorChooser({
  actors,
  activeActorId,
  onActorChange,
}: ChatLabActorChooserProps) {
  const activeActorIndex = Math.max(0, actors.findIndex(({ id }) => id === activeActorId));
  const activeActor = actors[activeActorIndex];
  const [isIdentityMenuOpen, setIsIdentityMenuOpen] = useState(false);
  const [highlightedActorIndex, setHighlightedActorIndex] = useState(activeActorIndex);
  const identityControlRef = useRef<HTMLDivElement>(null);
  const identityTriggerRef = useRef<HTMLButtonElement>(null);
  const actorOptionRefs = useRef(new Map<string, HTMLDivElement>());

  const openIdentityMenu = (actorIndex = activeActorIndex) => {
    if (actors.length === 0) return;
    setHighlightedActorIndex(actorIndex);
    setIsIdentityMenuOpen(true);
  };

  const closeIdentityMenu = (returnFocus = true) => {
    setIsIdentityMenuOpen(false);
    if (returnFocus) identityTriggerRef.current?.focus();
  };

  const selectActor = (actor: ChatLabActorSummary) => {
    closeIdentityMenu();
    onActorChange(actor.id);
  };

  useEffect(() => {
    if (!isIdentityMenuOpen) return;
    const actor = actors[highlightedActorIndex];
    if (actor !== undefined) actorOptionRefs.current.get(actor.id)?.focus();
  }, [actors, highlightedActorIndex, isIdentityMenuOpen]);

  useEffect(() => {
    if (!isIdentityMenuOpen) return;

    const handleOutsideClick = (event: MouseEvent) => {
      if (!identityControlRef.current?.contains(event.target as Node)) {
        closeIdentityMenu();
      }
    };

    document.addEventListener("click", handleOutsideClick);
    return () => document.removeEventListener("click", handleOutsideClick);
  }, [isIdentityMenuOpen]);

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (isIdentityMenuOpen) return;

    switch (event.key) {
      case "ArrowDown":
      case "Enter":
      case " ":
        event.preventDefault();
        openIdentityMenu();
        break;
      case "ArrowUp":
      case "End":
        event.preventDefault();
        openIdentityMenu(actors.length - 1);
        break;
      case "Home":
        event.preventDefault();
        openIdentityMenu(0);
        break;
    }
  };

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setHighlightedActorIndex((index) => (index + 1) % actors.length);
        break;
      case "ArrowUp":
        event.preventDefault();
        setHighlightedActorIndex((index) => (index - 1 + actors.length) % actors.length);
        break;
      case "Home":
        event.preventDefault();
        setHighlightedActorIndex(0);
        break;
      case "End":
        event.preventDefault();
        setHighlightedActorIndex(actors.length - 1);
        break;
      case "Enter":
      case " ": {
        event.preventDefault();
        const actor = actors[highlightedActorIndex];
        if (actor !== undefined) selectActor(actor);
        break;
      }
      case "Escape":
        event.preventDefault();
        closeIdentityMenu();
        break;
    }
  };

  return (
    <div className="chat-lab__identity" ref={identityControlRef}>
      <button
        aria-controls="chat-lab-identity-menu"
        aria-expanded={isIdentityMenuOpen}
        aria-haspopup="listbox"
        aria-label={`Development fixture identity: ${activeActor?.displayName ?? "unknown actor"}`}
        className="chat-lab__identity-trigger"
        disabled={activeActor === undefined}
        onClick={() => {
          if (isIdentityMenuOpen) closeIdentityMenu();
          else openIdentityMenu();
        }}
        onKeyDown={handleTriggerKeyDown}
        ref={identityTriggerRef}
        title={`Development fixture: ${activeActor?.displayName ?? "unknown actor"}`}
        type="button"
      >
        <span className="chat-lab__identity-avatar" aria-hidden="true">
          {activeActor === undefined ? "?" : actorInitials(activeActor.displayName)}
        </span>
        <span className="chat-lab__identity-copy" aria-hidden="true">
          <span className="chat-lab__identity-cue">Dev fixture</span>
          <span className="chat-lab__identity-name">
            {activeActor?.displayName ?? "Unknown actor"}
          </span>
        </span>
        <svg
          aria-hidden="true"
          className="chat-lab__identity-chevron"
          focusable="false"
          viewBox="0 0 24 24"
        >
          <path d="m7 9.5 5 5 5-5" />
        </svg>
      </button>
      {isIdentityMenuOpen ? (
        <div
          aria-label="Development fixture identities"
          className="chat-lab__identity-menu"
          id="chat-lab-identity-menu"
          onKeyDown={handleMenuKeyDown}
          role="listbox"
        >
          {actors.map((actor, index) => (
            <div
              aria-selected={actor.id === activeActor?.id}
              className="chat-lab__identity-option"
              data-actor-id={actor.id}
              key={actor.id}
              onClick={() => selectActor(actor)}
              ref={(element) => {
                if (element === null) actorOptionRefs.current.delete(actor.id);
                else actorOptionRefs.current.set(actor.id, element);
              }}
              role="option"
              tabIndex={index === highlightedActorIndex ? 0 : -1}
            >
              <span className="chat-lab__identity-option-copy">
                <span className="chat-lab__identity-option-name">{actor.displayName}</span>
                <span className="chat-lab__identity-role">{actor.role}</span>
              </span>
              {actor.id === activeActor?.id ? (
                <svg
                  aria-hidden="true"
                  className="chat-lab__identity-check"
                  focusable="false"
                  viewBox="0 0 24 24"
                >
                  <path d="m5 12.5 4.5 4.5L19 7.5" />
                </svg>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ChatLabShell({
  activeActorName,
  effectiveTheme,
  huddleMediaConfigured,
  realtimeState,
  themePreference,
  workspace,
}: ChatLabShellProps) {
  return (
    <main
      className="chat-lab handrail-chat"
      data-chat-lab-effective-theme={effectiveTheme}
      data-chat-lab-theme={themePreference}
      {...(themePreference === "system"
        ? {}
        : { "data-handrail-theme": themePreference })}
    >
      <header className="chat-lab__toolbar">
        <div className="chat-lab__brand">
          <span className="chat-lab__brand-mark" aria-hidden="true">H</span>
          <div>
            <h1>Handrail Chat Lab</h1>
            <span className="chat-lab__workspace-label">Development workspace</span>
          </div>
        </div>
        <div className="chat-lab__toolbar-controls">
          <span
            className="chat-lab__realtime-announcement chat-lab__sr-only"
            data-realtime-state={realtimeState.state}
            role="status"
          >
            {realtimeStatusText(realtimeState)}
          </span>
          {realtimeState.state === "connected" ? null : (
            <span
              aria-hidden="true"
              className="chat-lab__realtime-status"
              data-realtime-state={realtimeState.state}
            >
              <span className="chat-lab__status-dot" />
              <span>{realtimeStatusLabel(realtimeState)}</span>
            </span>
          )}
          <details className="chat-lab__details">
            <summary aria-label="About this lab and local media">About</summary>
            <p>{huddleMediaConfigured
              ? "Huddle media is configured for this Chat Lab session. Availability depends on the supplied adapter."
              : "Huddle media not configured. Start and Join actions are unavailable."}
            </p>
          </details>
        </div>
        <span className="chat-lab__sr-only">
          Current actor: {activeActorName}
        </span>
      </header>
      <section className="chat-lab__stage" aria-label="Interactive chat lab">
        <div className="chat-lab__workspace">{workspace}</div>
      </section>
    </main>
  );
}
