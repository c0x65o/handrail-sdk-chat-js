import {
  createElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactElement,
} from "react";

import type {
  ConversationMemberPreference,
  ConversationMuteState,
  ConversationNotificationPreference,
  IsoTimestamp,
} from "../contracts/index.js";
import type { ChatActions } from "../react/index.js";

type NotificationPreferenceActions = Pick<
  ChatActions,
  "updateConversationPreference"
>;
type AuthoritativePreference = Pick<
  ConversationMemberPreference,
  "notificationPreference" | "isStarred" | "mute"
>;
type MuteChoice = "unmuted" | "indefinite" | "until";
type Feedback = Readonly<{ kind: "status" | "error"; message: string }>;

interface NotificationPreferencesProps {
  readonly actions: NotificationPreferenceActions;
  readonly className?: string;
  readonly preference: AuthoritativePreference;
  readonly readOnly: boolean;
  readonly externalPending?: boolean;
  readonly triggerLabelPrefix?: string;
}

const NOTIFICATION_OPTIONS = Object.freeze([
  ["all", "All messages"],
  ["mentions", "Mentions only"],
  ["none", "No notifications"],
] as const);

const MUTE_OPTIONS = Object.freeze([
  ["unmuted", "Unmuted"],
  ["indefinite", "Muted indefinitely"],
  ["until", "Muted until a specific time"],
] as const);

const notificationLabel = (
  preference: ConversationNotificationPreference,
): string => NOTIFICATION_OPTIONS.find(([value]) => value === preference)?.[1] ??
  "Notifications";

const muteChoice = (mute: ConversationMuteState): MuteChoice =>
  mute.muted === false
    ? "unmuted"
    : mute.mutedUntil === undefined
      ? "indefinite"
      : "until";

const pad = (value: number): string => String(value).padStart(2, "0");

const toLocalDateTime = (mute: ConversationMuteState): string => {
  if (mute.muted === false || mute.mutedUntil === undefined) return "";
  const date = new Date(mute.mutedUntil);
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

const toCanonicalTimestamp = (value: string): IsoTimestamp | undefined => {
  if (value.length === 0) return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds)
    ? new Date(milliseconds).toISOString() as IsoTimestamp
    : undefined;
};

const preferenceSummary = (
  preference: AuthoritativePreference,
): string => {
  const notification = notificationLabel(preference.notificationPreference);
  if (preference.mute.muted === false) return `${notification}; Unmuted`;
  if (preference.mute.mutedUntil === undefined) {
    return `${notification}; Muted indefinitely`;
  }
  return `${notification}; Muted until ${preference.mute.mutedUntil}`;
};

const failureMessage = (
  result: Exclude<
    Awaited<ReturnType<NotificationPreferenceActions["updateConversationPreference"]>>,
    { readonly status: "success" }
  >,
): string => {
  switch (result.status) {
    case "authentication":
      return "Notification preferences were not saved. Sign in again, then retry.";
    case "transport":
      return "Notification preferences were not saved. Check your connection, then retry.";
    case "validation":
      return "Notification preferences were not saved. Review each choice, then retry.";
    case "feature_disabled":
    case "unsupported":
      return "Notification preferences are unavailable for this conversation. Contact your workspace administrator.";
    case "rejected":
    case "conflict":
      return "Notification preferences were not saved. Check your access and retry, or contact your workspace administrator.";
    case "malformed_response":
      return "Notification preferences were not saved because the server response was invalid. Retry, or contact support.";
    case "aborted":
    case "closed":
      return "Notification preferences were not saved. Reopen the chat and retry.";
  }
};

export function NotificationPreferences({
  actions,
  className,
  preference,
  readOnly,
  externalPending = false,
  triggerLabelPrefix = "Notification preferences",
}: NotificationPreferencesProps): ReactElement {
  const [open, setOpen] = useState(false);
  const [authoritativePreference, setAuthoritativePreference] =
    useState<AuthoritativePreference>(() => ({
      notificationPreference: preference.notificationPreference,
      isStarred: preference.isStarred,
      mute: preference.mute,
    }));
  const [notificationPreference, setNotificationPreference] = useState(
    preference.notificationPreference,
  );
  const [selectedMute, setSelectedMute] = useState<MuteChoice>(() =>
    muteChoice(preference.mute)
  );
  const [mutedUntil, setMutedUntil] = useState(() =>
    toLocalDateTime(preference.mute)
  );
  const [saving, setPending] = useState(false);
  const pending = saving || externalPending;
  const [feedback, setFeedback] = useState<Feedback>();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const firstControlRef = useRef<HTMLSelectElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const mountedRef = useRef(true);
  const pendingRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelId = useId();
  const titleId = useId();
  const untilId = useId();

  const applyCanonicalPreference = useCallback((
    canonical: AuthoritativePreference,
  ) => {
    setAuthoritativePreference({
      notificationPreference: canonical.notificationPreference,
      isStarred: canonical.isStarred,
      mute: canonical.mute,
    });
    setNotificationPreference(canonical.notificationPreference);
    setSelectedMute(muteChoice(canonical.mute));
    setMutedUntil(toLocalDateTime(canonical.mute));
  }, []);

  const resetDraft = useCallback(() => {
    setNotificationPreference(authoritativePreference.notificationPreference);
    setSelectedMute(muteChoice(authoritativePreference.mute));
    setMutedUntil(toLocalDateTime(authoritativePreference.mute));
  }, [authoritativePreference]);

  useEffect(() => {
    applyCanonicalPreference(preference);
  }, [applyCanonicalPreference, preference]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const close = useCallback((): boolean => {
    if (pendingRef.current || externalPending) return false;
    setOpen(false);
    setFeedback(undefined);
    resetDraft();
    const trigger = triggerRef.current;
    if (trigger?.isConnected === true) trigger.focus();
    return true;
  }, [resetDraft, externalPending]);

  useEffect(() => {
    if (!open) return;
    (readOnly ? closeRef.current : firstControlRef.current)?.focus();
  }, [open, readOnly]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // Escape belongs to this dialog even while saving; do not dismiss its host.
      event.preventDefault();
      close();
    };
    const handlePointerDown = (event: PointerEvent): void => {
      const root = rootRef.current;
      if (
        root === null ||
        !(event.target instanceof Node) ||
        root.contains(event.target)
      ) return;
      close();
    };

    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("pointerdown", handlePointerDown, true);
    };
  }, [close, open]);

  const submit = useCallback(async (
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();
    if (readOnly || pendingRef.current || externalPending) return;

    let mute: ConversationMuteState;
    if (selectedMute === "unmuted") {
      mute = { muted: false };
    } else if (selectedMute === "indefinite") {
      mute = { muted: true };
    } else {
      const canonicalMutedUntil = toCanonicalTimestamp(mutedUntil);
      if (canonicalMutedUntil === undefined) {
        setFeedback({
          kind: "error",
          message: "Choose a valid mute end time, then retry.",
        });
        return;
      }
      mute = { muted: true, mutedUntil: canonicalMutedUntil };
    }

    pendingRef.current = true;
    setPending(true);
    setFeedback(undefined);
    try {
      const result = await actions.updateConversationPreference({
        notificationPreference,
        isStarred: authoritativePreference.isStarred,
        mute,
      });
      if (!mountedRef.current) return;
      if (result.status !== "success") {
        setFeedback({ kind: "error", message: failureMessage(result) });
        return;
      }

      applyCanonicalPreference({
        notificationPreference: result.value.preference.notificationPreference,
        isStarred: result.value.preference.isStarred,
        mute: result.value.preference.mute,
      });
      const canonicalSummary = preferenceSummary(result.value.preference);
      if (result.value.reconciliationStatus === "preference_revision_conflict") {
        setFeedback({
          kind: "error",
          message: `Preferences changed elsewhere. Authoritative preference loaded: ${canonicalSummary}. Review it before saving another explicit choice.`,
        });
      } else {
        setFeedback({
          kind: "status",
          message: `Notification preferences saved: ${canonicalSummary}.`,
        });
      }
    } catch {
      if (!mountedRef.current) return;
      setFeedback({
        kind: "error",
        message: "Notification preferences were not saved. Check your connection, then retry.",
      });
    } finally {
      pendingRef.current = false;
      if (mountedRef.current) setPending(false);
    }
  }, [
    actions,
    applyCanonicalPreference,
    authoritativePreference.isStarred,
    mutedUntil,
    notificationPreference,
    readOnly,
    externalPending,
    selectedMute,
  ]);

  const authoritativeMuteChoice = muteChoice(authoritativePreference.mute);
  const triggerLabel = `${triggerLabelPrefix}: ${
    preferenceSummary(authoritativePreference)
  }${readOnly ? "; Read-only" : ""}`;
  const showMutedMark = authoritativePreference.mute.muted ||
    authoritativePreference.notificationPreference === "none";

  return createElement(
    "div",
    {
      className: ["handrail-chat__notification-preferences", className]
        .filter(Boolean)
        .join(" "),
      "data-expanded": open ? "true" : "false",
      ref: rootRef,
    },
    createElement(
      "button",
      {
        "aria-controls": panelId,
        "aria-busy": pending ? true : undefined,
        "aria-disabled": pending ? true : undefined,
        "aria-expanded": open,
        "aria-haspopup": "dialog",
        "aria-label": triggerLabel,
        className: "handrail-chat__notification-preferences-trigger",
        "data-mute-state": authoritativeMuteChoice,
        "data-muted": authoritativePreference.mute.muted ? "true" : "false",
        "data-notification-level": authoritativePreference.notificationPreference,
        "data-read-only": readOnly ? "true" : "false",
        onClick: () => {
          if (open) {
            close();
            return;
          }
          setOpen(true);
          setFeedback(undefined);
        },
        ref: triggerRef,
        title: triggerLabel,
        type: "button",
      },
      createElement(
        "svg",
        {
          "aria-hidden": true,
          className: "handrail-chat__notification-preferences-icon",
          fill: "none",
          focusable: "false",
          stroke: "currentColor",
          strokeLinecap: "round",
          strokeLinejoin: "round",
          strokeWidth: 2,
          viewBox: "0 0 24 24",
        },
        createElement("path", {
          d: "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9",
        }),
        createElement("path", { d: "M13.73 21a2 2 0 0 1-3.46 0" }),
        showMutedMark
          ? createElement("path", {
              className: "handrail-chat__notification-preferences-muted-mark",
              d: "M4 4l16 16",
            })
          : null,
      ),
    ),
    !open
      ? null
      : createElement(
          "div",
          {
            "aria-labelledby": titleId,
            className: "handrail-chat__notification-preferences-panel",
            id: panelId,
            role: "dialog",
          },
          createElement(
            "form",
            {
              className: "handrail-chat__notification-preferences-form",
              onSubmit: (event: FormEvent<HTMLFormElement>) => {
                void submit(event);
              },
            },
            createElement(
              "h3",
              {
                className: "handrail-chat__notification-preferences-title",
                id: titleId,
              },
              "Notification preferences",
            ),
            createElement(
              "p",
              { className: "handrail-chat__notification-preferences-summary" },
              `Current preference: ${preferenceSummary(authoritativePreference)}.`,
            ),
            createElement(
              "label",
              { className: "handrail-chat__notification-preferences-label" },
              "Notify me about",
              createElement(
                "select",
                {
                  className: "handrail-chat__notification-preferences-select",
                  disabled: pending || readOnly,
                  name: "notificationPreference",
                  onChange: (event: ChangeEvent<HTMLSelectElement>) => {
                    setNotificationPreference(
                      event.currentTarget.value as ConversationNotificationPreference,
                    );
                    setFeedback(undefined);
                  },
                  ref: firstControlRef,
                  value: notificationPreference,
                },
                ...NOTIFICATION_OPTIONS.map(([value, label]) =>
                  createElement("option", { key: value, value }, label)
                ),
              ),
            ),
            createElement(
              "fieldset",
              {
                className: "handrail-chat__notification-preferences-mute",
                disabled: pending || readOnly,
              },
              createElement("legend", null, "Mute"),
              ...MUTE_OPTIONS.map(([value, label]) =>
                createElement(
                  "label",
                  {
                    className: "handrail-chat__notification-preferences-choice",
                    key: value,
                  },
                  createElement("input", {
                    checked: selectedMute === value,
                    name: "conversationMute",
                    onChange: () => {
                      setSelectedMute(value);
                      setFeedback(undefined);
                    },
                    type: "radio",
                    value,
                  }),
                  label,
                )
              ),
              selectedMute !== "until"
                ? null
                : createElement(
                    "label",
                    {
                      className: "handrail-chat__notification-preferences-label",
                      htmlFor: untilId,
                    },
                    "Mute until",
                    createElement("input", {
                      className: "handrail-chat__notification-preferences-until",
                      disabled: pending || readOnly,
                      id: untilId,
                      name: "mutedUntil",
                      onInput: (event: FormEvent<HTMLInputElement>) => {
                        setMutedUntil(event.currentTarget.value);
                        setFeedback(undefined);
                      },
                      required: true,
                      type: "datetime-local",
                      value: mutedUntil,
                    }),
                  ),
            ),
            pending
              ? createElement(
                  "div",
                  {
                    className: "handrail-chat__status",
                    role: "status",
                    "aria-live": "polite",
                  },
                  "Saving notification preferences…",
                )
              : null,
            feedback === undefined
              ? null
              : createElement(
                  "div",
                  feedback.kind === "error"
                    ? { className: "handrail-chat__error", role: "alert" }
                    : {
                        className: "handrail-chat__status",
                        role: "status",
                        "aria-live": "polite",
                      },
                  feedback.message,
                ),
            readOnly
              ? createElement(
                  "p",
                  { className: "handrail-chat__notification-preferences-read-only" },
                  "Notification preferences are read-only.",
                )
              : null,
            createElement(
              "div",
              { className: "handrail-chat__notification-preferences-actions" },
              createElement(
                "button",
                {
                  className: "handrail-chat__notification-preferences-close",
                  disabled: pending,
                  onClick: close,
                  ref: closeRef,
                  type: "button",
                },
                "Close",
              ),
              readOnly
                ? null
                : createElement(
                    "button",
                    {
                      "aria-busy": pending ? true : undefined,
                      className: "handrail-chat__notification-preferences-submit",
                      disabled: pending ||
                        (selectedMute === "until" && mutedUntil.length === 0),
                      type: "submit",
                    },
                    pending ? "Saving…" : feedback?.kind === "error" ? "Retry save" : "Save preferences",
                  ),
            ),
          ),
        ),
  );
}
