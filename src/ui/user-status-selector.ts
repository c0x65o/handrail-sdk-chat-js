import {
  createElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
} from "react";

import type {
  HostDirectoryAvailability,
  HostDirectoryUserStatus,
  IsoTimestamp,
} from "../contracts/index.js";

type StatusTimerChoice = "never" | "thirty-minutes" | "one-hour" | "four-hours" |
  "today" | "this-week" | "custom";

export interface UserStatusSelectorProps {
  /** Controlled status. Include the prop with `undefined` to control the cleared state. */
  readonly status?: HostDirectoryUserStatus | undefined;
  /** Initial status for an uncontrolled selector. */
  readonly defaultStatus?: HostDirectoryUserStatus | undefined;
  /** Persists a saved or automatically cleared status. Rejections remain editable. */
  readonly onStatusChange?: (
    status: HostDirectoryUserStatus | undefined,
  ) => void | Promise<void>;
  readonly className?: string;
  readonly disabled?: boolean;
  readonly triggerLabel?: string;
}

const AVAILABILITY_OPTIONS = Object.freeze([
  ["online", "Online", "Available for messages"],
  ["away", "Away", "May respond later"],
  ["busy", "Busy", "Please do not disturb"],
  ["offline", "Offline", "Appears unavailable"],
] as const);

const TIMER_OPTIONS = Object.freeze([
  ["thirty-minutes", "30 minutes"],
  ["one-hour", "1 hour"],
  ["four-hours", "4 hours"],
  ["today", "Today"],
  ["this-week", "This week"],
  ["custom", "Custom date and time"],
  ["never", "Don't clear"],
] as const);

const STATUS_PRESETS = Object.freeze([
  { emoji: "📅", text: "In a meeting", timer: "one-hour", availability: "busy" },
  { emoji: "🚙", text: "Commuting", timer: "thirty-minutes", availability: "away" },
  { emoji: "🤒", text: "Out sick", timer: "today", availability: "offline" },
  { emoji: "🏝️", text: "Vacationing", timer: "this-week", availability: "offline" },
  { emoji: "🏡", text: "Working remotely", timer: "today", availability: "online" },
] as const satisfies readonly {
  readonly emoji: string;
  readonly text: string;
  readonly timer: StatusTimerChoice;
  readonly availability: HostDirectoryAvailability;
}[]);

const pad = (value: number): string => String(value).padStart(2, "0");

const toLocalDateTime = (timestamp: string | undefined): string => {
  if (timestamp === undefined) return "";
  const date = new Date(timestamp);
  if (!Number.isFinite(date.valueOf())) return "";
  return [
    date.getFullYear(),
    "-",
    pad(date.getMonth() + 1),
    "-",
    pad(date.getDate()),
    "T",
    pad(date.getHours()),
    ":",
    pad(date.getMinutes()),
  ].join("");
};

const expiryForChoice = (
  choice: StatusTimerChoice,
  customValue: string,
  now: number,
): IsoTimestamp | undefined => {
  if (choice === "never") return undefined;
  let expiresAt: Date;
  switch (choice) {
    case "thirty-minutes":
      expiresAt = new Date(now + 30 * 60_000);
      break;
    case "one-hour":
      expiresAt = new Date(now + 60 * 60_000);
      break;
    case "four-hours":
      expiresAt = new Date(now + 4 * 60 * 60_000);
      break;
    case "today": {
      expiresAt = new Date(now);
      expiresAt.setHours(24, 0, 0, 0);
      break;
    }
    case "this-week": {
      expiresAt = new Date(now);
      const daysUntilMonday = (8 - expiresAt.getDay()) % 7 || 7;
      expiresAt.setDate(expiresAt.getDate() + daysUntilMonday);
      expiresAt.setHours(0, 0, 0, 0);
      break;
    }
    case "custom":
      expiresAt = new Date(customValue);
      break;
  }
  return Number.isFinite(expiresAt.valueOf())
    ? expiresAt.toISOString() as IsoTimestamp
    : undefined;
};

const timerChoiceForStatus = (
  status: HostDirectoryUserStatus | undefined,
): StatusTimerChoice => status?.expiresAt === undefined ? "never" : "custom";

const availabilityLabel = (
  availability: HostDirectoryAvailability | undefined,
): string => AVAILABILITY_OPTIONS.find(([value]) => value === availability)?.[1] ??
  "Online";

const statusSummary = (status: HostDirectoryUserStatus | undefined): string => {
  const availability = availabilityLabel(status?.availability);
  const custom = [status?.emoji, status?.text].filter(Boolean).join(" ");
  return custom.length === 0 ? availability : `${availability} · ${custom}`;
};

const statusIcon = (
  availability: HostDirectoryAvailability,
  className: string,
): ReactElement => createElement(
  "span",
  {
    "aria-hidden": true,
    className,
    "data-availability": availability,
  },
  createElement(
    "svg",
    { focusable: "false", viewBox: "0 0 24 24" },
    availability === "away"
      ? createElement("path", { d: "M12 7v5l3 2" })
      : availability === "busy"
        ? createElement("path", { d: "M8 12h8" })
        : availability === "online"
          ? createElement("path", { d: "m8.5 12 2.25 2.25L15.5 9.5" })
          : null,
    createElement("circle", { cx: 12, cy: 12, r: 8 }),
  ),
);

const focusableSelector = [
  "button:not(:disabled)",
  "input:not(:disabled)",
  "select:not(:disabled)",
].join(",");

export function UserStatusSelector(props: UserStatusSelectorProps): ReactElement {
  const controlled = Object.prototype.hasOwnProperty.call(props, "status");
  const [uncontrolledStatus, setUncontrolledStatus] =
    useState<HostDirectoryUserStatus | undefined>(props.defaultStatus);
  const status = controlled ? props.status : uncontrolledStatus;
  const [open, setOpen] = useState(false);
  const [availability, setAvailability] = useState<HostDirectoryAvailability>(
    status?.availability ?? "online",
  );
  const [text, setText] = useState(status?.text ?? "");
  const [emoji, setEmoji] = useState(status?.emoji ?? "");
  const [timerChoice, setTimerChoice] = useState<StatusTimerChoice>(() =>
    timerChoiceForStatus(status)
  );
  const [customExpiry, setCustomExpiry] = useState(() =>
    toLocalDateTime(status?.expiresAt)
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const textInputRef = useRef<HTMLInputElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const mountedRef = useRef(true);
  const dialogId = useId();
  const titleId = useId();
  const customExpiryId = useId();

  const loadDraft = useCallback((next: HostDirectoryUserStatus | undefined) => {
    setAvailability(next?.availability ?? "online");
    setText(next?.text ?? "");
    setEmoji(next?.emoji ?? "");
    setTimerChoice(timerChoiceForStatus(next));
    setCustomExpiry(toLocalDateTime(next?.expiresAt));
    setError(undefined);
  }, []);

  const close = useCallback((restoreFocus = true) => {
    if (pending) return;
    setOpen(false);
    loadDraft(status);
    if (restoreFocus) triggerRef.current?.focus();
  }, [loadDraft, pending, status]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!open) loadDraft(status);
  }, [loadDraft, open, status]);

  useEffect(() => {
    const expiresAt = status?.expiresAt;
    if (expiresAt === undefined) return;
    let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
    let active = true;
    const clearExpiredStatus = (): void => {
      if (!active) return;
      const remaining = Date.parse(expiresAt) - Date.now();
      if (remaining > 0) {
        timeout = globalThis.setTimeout(
          clearExpiredStatus,
          Math.min(remaining, 2_147_483_647),
        );
        return;
      }
      if (!controlled) setUncontrolledStatus(undefined);
      void Promise.resolve(props.onStatusChange?.(undefined)).catch(() => undefined);
    };
    clearExpiredStatus();
    return () => {
      active = false;
      if (timeout !== undefined) globalThis.clearTimeout(timeout);
    };
  }, [controlled, props.onStatusChange, status?.expiresAt]);

  useEffect(() => {
    if (!open) return;
    textInputRef.current?.focus();
    const handleKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
        focusableSelector,
      ) ?? [])];
      if (controls.length === 0) return;
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [close, open]);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (pending || props.disabled === true) return;
    const now = Date.now();
    const expiresAt = expiryForChoice(timerChoice, customExpiry, now);
    if (
      timerChoice === "custom" &&
      (expiresAt === undefined || Date.parse(expiresAt) <= now)
    ) {
      setError("Choose a future date and time for this status.");
      return;
    }
    const trimmedText = text.trim();
    const trimmedEmoji = emoji.trim();
    const next: HostDirectoryUserStatus = Object.freeze({
      availability,
      ...(trimmedText.length === 0 ? {} : { text: trimmedText }),
      ...(trimmedEmoji.length === 0 ? {} : { emoji: trimmedEmoji }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
    });
    setPending(true);
    setError(undefined);
    try {
      await props.onStatusChange?.(next);
      if (!mountedRef.current) return;
      if (!controlled) setUncontrolledStatus(next);
      setOpen(false);
      triggerRef.current?.focus();
    } catch {
      if (mountedRef.current) {
        setError("Your status could not be saved. Check your connection and try again.");
      }
    } finally {
      if (mountedRef.current) setPending(false);
    }
  };

  const clearStatus = async (): Promise<void> => {
    if (pending || props.disabled === true) return;
    setPending(true);
    setError(undefined);
    try {
      await props.onStatusChange?.(undefined);
      if (!mountedRef.current) return;
      if (!controlled) setUncontrolledStatus(undefined);
      setOpen(false);
      triggerRef.current?.focus();
    } catch {
      if (mountedRef.current) {
        setError("Your status could not be cleared. Check your connection and try again.");
      }
    } finally {
      if (mountedRef.current) setPending(false);
    }
  };

  const summary = statusSummary(status);
  const triggerLabel = `${props.triggerLabel ?? "Set your status"}: ${summary}`;
  const currentAvailability = status?.availability ?? "online";

  return createElement(
    "div",
    {
      className: ["handrail-chat__user-status-selector", props.className]
        .filter(Boolean)
        .join(" "),
      "data-availability": currentAvailability,
    },
    createElement(
      "button",
      {
        "aria-controls": dialogId,
        "aria-expanded": open,
        "aria-haspopup": "dialog",
        "aria-label": triggerLabel,
        className: "handrail-chat__user-status-trigger",
        disabled: props.disabled,
        onClick: () => {
          if (open) close();
          else {
            loadDraft(status);
            setOpen(true);
          }
        },
        ref: triggerRef,
        title: triggerLabel,
        type: "button",
      },
      status?.emoji === undefined
        ? statusIcon(currentAvailability, "handrail-chat__user-status-trigger-icon")
        : createElement(
            "span",
            { "aria-hidden": true, className: "handrail-chat__user-status-trigger-emoji" },
            status.emoji,
          ),
      createElement(
        "span",
        { className: "handrail-chat__user-status-trigger-copy" },
        status?.text ?? availabilityLabel(currentAvailability),
      ),
    ),
    !open
      ? null
      : createElement(
          "div",
          {
            className: "handrail-chat__user-status-backdrop",
            onMouseDown: (event: ReactMouseEvent<HTMLDivElement>) => {
              if (event.target === event.currentTarget) close();
            },
          },
          createElement(
            "div",
            {
              "aria-labelledby": titleId,
              "aria-modal": true,
              className: "handrail-chat__user-status-dialog",
              id: dialogId,
              ref: dialogRef,
              role: "dialog",
            },
            createElement(
              "form",
              {
                className: "handrail-chat__user-status-form",
                onSubmit: (event: FormEvent<HTMLFormElement>) => void submit(event),
              },
              createElement(
                "header",
                { className: "handrail-chat__user-status-header" },
                createElement("h2", { id: titleId }, "Set a status"),
                createElement(
                  "button",
                  {
                    "aria-label": "Close status selector",
                    className: "handrail-chat__user-status-close",
                    disabled: pending,
                    onClick: () => close(),
                    type: "button",
                  },
                  "×",
                ),
              ),
              createElement(
                "div",
                { className: "handrail-chat__user-status-custom" },
                createElement(
                  "label",
                  { className: "handrail-chat__user-status-emoji-label" },
                  createElement("span", { className: "handrail-chat__sr-only" }, "Status icon"),
                  createElement("input", {
                    "aria-label": "Status icon",
                    autoComplete: "off",
                    className: "handrail-chat__user-status-emoji-input",
                    disabled: pending,
                    maxLength: 32,
                    onInput: (event: FormEvent<HTMLInputElement>) => {
                      setEmoji(event.currentTarget.value);
                      setError(undefined);
                    },
                    placeholder: "🙂",
                    value: emoji,
                  }),
                ),
                createElement(
                  "label",
                  { className: "handrail-chat__user-status-text-label" },
                  createElement("span", { className: "handrail-chat__sr-only" }, "Custom status"),
                  createElement("input", {
                    "aria-label": "Custom status",
                    autoComplete: "off",
                    className: "handrail-chat__user-status-text-input",
                    disabled: pending,
                    maxLength: 160,
                    onInput: (event: FormEvent<HTMLInputElement>) => {
                      setText(event.currentTarget.value);
                      setError(undefined);
                    },
                    placeholder: "What's your status?",
                    ref: textInputRef,
                    value: text,
                  }),
                ),
              ),
              createElement(
                "fieldset",
                { className: "handrail-chat__user-status-availability", disabled: pending },
                createElement("legend", null, "Availability"),
                ...AVAILABILITY_OPTIONS.map(([value, label, description]) =>
                  createElement(
                    "label",
                    {
                      className: "handrail-chat__user-status-availability-option",
                      key: value,
                    },
                    createElement("input", {
                      checked: availability === value,
                      name: "availability",
                      onChange: () => {
                        setAvailability(value);
                        setError(undefined);
                      },
                      type: "radio",
                      value,
                    }),
                    statusIcon(value, "handrail-chat__user-status-availability-icon"),
                    createElement(
                      "span",
                      { className: "handrail-chat__user-status-availability-copy" },
                      createElement("strong", null, label),
                      createElement("small", null, description),
                    ),
                  )
                ),
              ),
              createElement(
                "section",
                { className: "handrail-chat__user-status-presets" },
                createElement("h3", null, "Suggestions"),
                ...STATUS_PRESETS.map((preset) =>
                  createElement(
                    "button",
                    {
                      className: "handrail-chat__user-status-preset",
                      disabled: pending,
                      key: preset.text,
                      onClick: () => {
                        setEmoji(preset.emoji);
                        setText(preset.text);
                        setAvailability(preset.availability);
                        setTimerChoice(preset.timer);
                        setError(undefined);
                        textInputRef.current?.focus();
                      },
                      type: "button",
                    },
                    createElement("span", { "aria-hidden": true }, preset.emoji),
                    createElement("strong", null, preset.text),
                    createElement(
                      "span",
                      null,
                      `— ${TIMER_OPTIONS.find(([value]) => value === preset.timer)?.[1]}`,
                    ),
                  )
                ),
              ),
              createElement(
                "label",
                { className: "handrail-chat__user-status-timer-label" },
                "Clear status after",
                createElement(
                  "select",
                  {
                    className: "handrail-chat__user-status-timer",
                    disabled: pending,
                    name: "statusTimer",
                    onChange: (event: ChangeEvent<HTMLSelectElement>) => {
                      setTimerChoice(event.currentTarget.value as StatusTimerChoice);
                      setError(undefined);
                    },
                    value: timerChoice,
                  },
                  ...TIMER_OPTIONS.map(([value, label]) =>
                    createElement("option", { key: value, value }, label)
                  ),
                ),
              ),
              timerChoice !== "custom"
                ? null
                : createElement(
                    "label",
                    {
                      className: "handrail-chat__user-status-expiry-label",
                      htmlFor: customExpiryId,
                    },
                    "Clear on",
                    createElement("input", {
                      className: "handrail-chat__user-status-expiry",
                      disabled: pending,
                      id: customExpiryId,
                      min: toLocalDateTime(new Date(Date.now() + 60_000).toISOString()),
                      onInput: (event: FormEvent<HTMLInputElement>) => {
                        setCustomExpiry(event.currentTarget.value);
                        setError(undefined);
                      },
                      type: "datetime-local",
                      value: customExpiry,
                    }),
                  ),
              error === undefined
                ? null
                : createElement(
                    "div",
                    { className: "handrail-chat__user-status-error", role: "alert" },
                    error,
                  ),
              createElement(
                "footer",
                { className: "handrail-chat__user-status-actions" },
                status === undefined
                  ? createElement("span", null)
                  : createElement(
                      "button",
                      {
                        className: "handrail-chat__user-status-clear",
                        disabled: pending,
                        onClick: () => void clearStatus(),
                        type: "button",
                      },
                      "Clear status",
                    ),
                createElement(
                  "div",
                  null,
                  createElement(
                    "button",
                    {
                      className: "handrail-chat__user-status-cancel",
                      disabled: pending,
                      onClick: () => close(),
                      type: "button",
                    },
                    "Cancel",
                  ),
                  createElement(
                    "button",
                    {
                      "aria-busy": pending ? true : undefined,
                      className: "handrail-chat__user-status-save",
                      disabled: pending,
                      type: "submit",
                    },
                    pending ? "Saving…" : "Save",
                  ),
                ),
              ),
            ),
          ),
        ),
  );
}
