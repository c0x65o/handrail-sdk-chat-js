import { createElement, useEffect, useId, useRef, type ChangeEvent, type KeyboardEvent, type ReactElement } from "react";
import { useReplyStyle, useReplyStyleActions } from "../react/reply-style-hooks.js";
import type { ChatReplyStyleState } from "../client/reply-style-runtime.js";

const label = (style: string) => style === "current" ? "Current" : style === "discord" ? "Discord-style" : "Unsupported choice";
const origins = { override: "enforced by this app", saved: "saved preference", host_default: "app default", fallback: "SDK default" };
const disabledReasons: Record<NonNullable<ChatReplyStyleState["disabledReason"]>, string> = {
  identity_required: "Sign in to load and save your reply style.",
  unsupported: "Saving reply style is unavailable on this server.",
  capability_unknown: "Checking whether this server supports saving reply style…",
  enforced_override: "This app enforces the reply style. It cannot be changed here.",
  loading: "Loading your saved reply style…",
  not_hydrated: "Waiting to confirm your saved reply style. If you are offline, reconnect to continue.",
  offline: "You are offline. Reconnect to save your reply style.",
  saving: "Waiting for confirmation before applying your choice.",
};

export interface ReplyStyleSettingsProps {
  readonly className?: string;
}

/** Embed in host settings under the existing ChatProvider; never changes composition or navigation. */
export function ReplyStyleSettings(props: ReplyStyleSettingsProps): ReactElement {
  const state = useReplyStyle();
  const actions = useReplyStyleActions();
  const id = useId();
  const preference = state.confirmedPreference;
  const failedSave = state.saveStatus === "error" || state.saveStatus === "conflict";
  const retryAvailable = !state.loading && state.saveStatus !== "saving" &&
    state.capability === "available" && !["identity_required", "offline"].includes(state.disabledReason ?? "") &&
    !(state.disabledReason === "enforced_override" && state.requestedStyle !== undefined) &&
    state.loadError !== "offline";
  return createElement("section", { className: props.className ?? "handrail-chat__reply-style-settings", "aria-label": "Reply and thread style" },
    createElement("label", { htmlFor: id }, "Reply and thread style"),
    createElement("p", { id: `${id}-description` },
      "Current: Reply opens a separate thread. Discord-style: Reply stays in the current conversation with a reference."),
    createElement("select", {
      id, "aria-describedby": `${id}-description ${id}-status`,
      disabled: !state.editingAvailable || state.pendingInput !== undefined,
      value: state.requestedStyle ?? state.effectiveStyle,
      onChange: (event: ChangeEvent<HTMLSelectElement>) => {
        const choice = event.currentTarget.value;
        if (choice === "current" || choice === "discord") void actions.update(choice);
      },
    }, createElement("option", { value: "current" }, "Current"), createElement("option", { value: "discord" }, "Discord-style")),
    createElement("div", { id: `${id}-status`, role: "status", "aria-live": "polite", "aria-atomic": true },
      createElement("p", null, `Effective style: ${label(state.effectiveStyle)} — ${origins[state.origin]}.`,
        preference === undefined ? " Saved preference is not yet confirmed." : null),
      preference?.state === "absent" ? createElement("p", null, "No saved choice.") : null,
      preference?.state === "saved" && (state.origin === "override" || preference.style !== state.effectiveStyle)
        ? createElement("p", null, `Saved choice: ${label(preference.style)}.`) : null,
      state.resolutionReason === "unsupported_value" ? createElement("p", null, "An unsupported style value is using Current.") : null,
      state.disabledReason === undefined ? null : createElement("p", null, disabledReasons[state.disabledReason]),
      state.loading && state.disabledReason !== "loading" ? createElement("p", null, disabledReasons.loading) : null,
      state.requestedStyle === undefined ? null : createElement("p", null,
        `${state.saveStatus === "saving" ? "Saving" : "Requested choice (unconfirmed)"}: ${label(state.requestedStyle)}${state.saveStatus === "saving" ? "…" : "."}`),
      state.saveStatus === "saved" ? createElement("p", null, "Reply style save confirmed.") : null),
    state.loadStatus === "error" ? createElement("p", { role: "alert" }, state.loadError === "offline"
      ? "You are offline. Reconnect to load your saved reply style."
      : "Could not load your saved reply style. The displayed style is provisional.") : null,
    failedSave ? createElement("p", { role: "alert" }, state.saveStatus === "conflict"
      ? "Your preference changed elsewhere. Review the effective style and retry your choice."
      : "Could not confirm your choice. The effective style still follows the confirmed preference and app policy.") : null,
    state.loadStatus === "error" || failedSave ? createElement("button", {
      type: "button", disabled: !retryAvailable, onClick: () => { void actions.retry(); },
    }, failedSave && state.requestedStyle !== undefined ? "Retry saving reply style" : "Retry loading reply style") : null);
}

/** Workspace-owned shell; host settings can embed ReplyStyleSettings directly. */
export function ReplyStyleSettingsDialog({ onClose }: { readonly onClose: () => void }): ReactElement {
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const focusGeneration = useRef(0);
  useEffect(() => {
    const generation = ++focusGeneration.current;
    if (document.activeElement instanceof HTMLElement && !dialog.current?.contains(document.activeElement)) {
      returnFocus.current = document.activeElement;
    }
    dialog.current?.focus();
    return () => {
      queueMicrotask(() => {
        if (generation === focusGeneration.current && returnFocus.current?.isConnected) returnFocus.current.focus();
      });
    };
  }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
    if (event.key !== "Tab") return;
    event.stopPropagation();
    const controls = [...(dialog.current?.querySelectorAll<HTMLElement>("select:not(:disabled), button:not(:disabled)") ?? [])];
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) {
      event.preventDefault(); last?.focus();
    } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) {
      event.preventDefault(); first?.focus();
    }
  };
  return createElement("div", { className: "handrail-chat__channel-creation", onClick: event => { if (event.target === event.currentTarget) onClose(); } },
    createElement("div", { role: "dialog", "aria-modal": true, "aria-labelledby": titleId,
      className: "handrail-chat__channel-creation-dialog", ref: dialog, tabIndex: -1, onKeyDown },
    createElement("h3", { id: titleId }, "Workspace settings"),
    createElement(ReplyStyleSettings, {}),
    createElement("button", { type: "button", onClick: onClose }, "Close settings")));
}
