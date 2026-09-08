import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

export type ChatLabThemePreference = "system" | "light" | "dark";
export type ChatLabEffectiveTheme = Exclude<ChatLabThemePreference, "system">;

export const chatLabThemeStorageKey = "handrail-chat-lab:theme";
const systemThemeQuery = "(prefers-color-scheme: dark)";

export const isChatLabThemePreference = (
  value: string,
): value is ChatLabThemePreference =>
  value === "system" || value === "light" || value === "dark";

const readInitialThemePreference = (): ChatLabThemePreference => {
  try {
    const stored = globalThis.localStorage?.getItem(chatLabThemeStorageKey);
    return stored !== null && isChatLabThemePreference(stored) ? stored : "system";
  } catch {
    return "system";
  }
};

const readSystemTheme = (): ChatLabEffectiveTheme => {
  try {
    return globalThis.matchMedia?.(systemThemeQuery).matches === true ? "dark" : "light";
  } catch {
    return "light";
  }
};

export const useChatLabTheme = () => {
  const [themePreference, setThemePreference] = useState<ChatLabThemePreference>(
    readInitialThemePreference,
  );
  const [systemTheme, setSystemTheme] = useState<ChatLabEffectiveTheme>(readSystemTheme);

  useEffect(() => {
    if (themePreference !== "system") return;

    let mediaQuery: MediaQueryList;
    try {
      if (globalThis.matchMedia === undefined) return;
      mediaQuery = globalThis.matchMedia(systemThemeQuery);
    } catch {
      return;
    }

    const synchronizeSystemTheme = () => {
      setSystemTheme(mediaQuery.matches ? "dark" : "light");
    };
    synchronizeSystemTheme();

    try {
      mediaQuery.addEventListener("change", synchronizeSystemTheme);
      return () => {
        try {
          mediaQuery.removeEventListener("change", synchronizeSystemTheme);
        } catch {
          // Some embedded browser shims expose a partial MediaQueryList API.
        }
      };
    } catch {
      try {
        mediaQuery.addListener(synchronizeSystemTheme);
        return () => {
          try {
            mediaQuery.removeListener(synchronizeSystemTheme);
          } catch {
            // Legacy subscriptions are best-effort in partial browser shims.
          }
        };
      } catch {
        // The initial match still applies when the host cannot subscribe.
      }
    }
  }, [themePreference]);

  const selectTheme = useCallback((nextTheme: ChatLabThemePreference) => {
    if (!isChatLabThemePreference(nextTheme)) return;
    setThemePreference(nextTheme);
    try {
      globalThis.localStorage?.setItem(chatLabThemeStorageKey, nextTheme);
    } catch {
      // Storage is only a convenience; the selected theme still changes.
    }
  }, []);

  return {
    effectiveTheme: themePreference === "system" ? systemTheme : themePreference,
    selectTheme,
    themePreference,
  } as const;
};

export interface ChatLabThemeChooserProps {
  readonly id?: string;
  readonly onThemeChange: (theme: ChatLabThemePreference) => void;
  readonly themePreference: ChatLabThemePreference;
}

const themePreferences = Object.freeze([
  { label: "System", value: "system" },
  { label: "Light", value: "light" },
  { label: "Dark", value: "dark" },
] as const);

export function ChatLabThemeSettings({
  onThemeChange,
  themePreference,
}: Omit<ChatLabThemeChooserProps, "id">) {
  const selectedIndex = themePreferences.findIndex(({ value }) => value === themePreference);
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(selectedIndex);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef(new Map<ChatLabThemePreference, HTMLButtonElement>());

  const open = () => {
    setHighlightedIndex(selectedIndex);
    setIsOpen(true);
  };
  const close = (returnFocus = true) => {
    setIsOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  };
  const select = (theme: ChatLabThemePreference) => {
    onThemeChange(theme);
    close();
  };

  useEffect(() => {
    if (!isOpen) return;
    const preference = themePreferences[highlightedIndex]?.value;
    if (preference !== undefined) optionRefs.current.get(preference)?.focus();
  }, [highlightedIndex, isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleOutsideClick = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("click", handleOutsideClick);
    return () => document.removeEventListener("click", handleOutsideClick);
  }, [isOpen]);

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (isOpen) return;
    if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown") {
      event.preventDefault();
      open();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlightedIndex(themePreferences.length - 1);
      setIsOpen(true);
    }
  };

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setHighlightedIndex((index) => (index + 1) % themePreferences.length);
        break;
      case "ArrowUp":
        event.preventDefault();
        setHighlightedIndex((index) =>
          (index - 1 + themePreferences.length) % themePreferences.length);
        break;
      case "Home":
        event.preventDefault();
        setHighlightedIndex(0);
        break;
      case "End":
        event.preventDefault();
        setHighlightedIndex(themePreferences.length - 1);
        break;
      case "Enter":
      case " ": {
        event.preventDefault();
        const preference = themePreferences[highlightedIndex]?.value;
        if (preference !== undefined) select(preference);
        break;
      }
      case "Escape":
        event.preventDefault();
        close();
        break;
    }
  };

  return (
    <div className="chat-lab__theme-settings" ref={rootRef}>
      <button
        aria-controls="chat-lab-theme-settings-menu"
        aria-expanded={isOpen}
        aria-haspopup="menu"
        aria-label="Open theme settings"
        className="handrail-chat__workspace-settings-trigger chat-lab__theme-settings-trigger"
        onClick={() => isOpen ? close() : open()}
        onKeyDown={handleTriggerKeyDown}
        ref={triggerRef}
        title={`Theme: ${themePreferences[selectedIndex]?.label ?? "System"}`}
        type="button"
      >
        <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24">
          <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-1.42 1.42-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.02 1.55V20h-2v-.09a1.7 1.7 0 0 0-1.1-1.55 1.7 1.7 0 0 0-1.88.34l-.06.06-1.42-1.42.06-.06A1.7 1.7 0 0 0 9.36 15a1.7 1.7 0 0 0-1.55-1.02H7.7v-2h.11a1.7 1.7 0 0 0 1.55-1.1A1.7 1.7 0 0 0 9 9l-.06-.06 1.42-1.42.06.06a1.7 1.7 0 0 0 1.88.34A1.7 1.7 0 0 0 13.32 6.4V6h2v.4a1.7 1.7 0 0 0 1.02 1.52 1.7 1.7 0 0 0 1.88-.34l.06-.06 1.42 1.42-.06.06a1.7 1.7 0 0 0-.34 1.88 1.7 1.7 0 0 0 1.55 1.02H21v2h-.05A1.7 1.7 0 0 0 19.4 15Z" />
        </svg>
      </button>
      {isOpen ? (
        <div
          aria-label="Theme settings"
          className="chat-lab__theme-settings-menu"
          id="chat-lab-theme-settings-menu"
          onKeyDown={handleMenuKeyDown}
          role="menu"
        >
          <span className="chat-lab__theme-settings-label">Theme</span>
          {themePreferences.map(({ label, value }, index) => (
            <button
              aria-checked={value === themePreference}
              className="chat-lab__theme-settings-option"
              key={value}
              onClick={() => select(value)}
              ref={(element) => {
                if (element === null) optionRefs.current.delete(value);
                else optionRefs.current.set(value, element);
              }}
              role="menuitemradio"
              tabIndex={index === highlightedIndex ? 0 : -1}
              type="button"
            >
              <span>{label}</span>
              {value === themePreference ? (
                <svg
                  aria-hidden="true"
                  className="chat-lab__theme-settings-check"
                  focusable="false"
                  viewBox="0 0 24 24"
                >
                  <path d="m5 12.5 4.5 4.5L19 7.5" />
                </svg>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ChatLabThemeChooser({
  id = "chat-lab-theme",
  onThemeChange,
  themePreference,
}: ChatLabThemeChooserProps) {
  return (
    <div className="chat-lab__theme-control">
      <label htmlFor={id}>Theme</label>
      <select
        id={id}
        onChange={(event) => {
          const nextTheme = event.currentTarget.value;
          if (isChatLabThemePreference(nextTheme)) onThemeChange(nextTheme);
        }}
        value={themePreference}
      >
        {themePreferences.map(({ label, value }) => (
          <option key={value} value={value}>{label}</option>
        ))}
      </select>
    </div>
  );
}
