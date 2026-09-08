import {
  createElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  type ReactElement,
} from "react";

export const REACTION_PICKER_CATEGORIES = Object.freeze([
  { key: "all", label: "All", icon: "🕘" },
  { key: "smileys", label: "Smileys", icon: "😀" },
  { key: "gestures", label: "Gestures", icon: "👋" },
  { key: "hearts", label: "Hearts", icon: "❤️" },
  { key: "celebration", label: "Celebration", icon: "🎉" },
  { key: "symbols", label: "Symbols", icon: "✅" },
  { key: "nature_food", label: "Nature and food", icon: "☕" },
] as const);

export type ReactionPickerCategoryKey =
  (typeof REACTION_PICKER_CATEGORIES)[number]["key"];
export type ReactionPickerCatalogCategoryKey = Exclude<
  ReactionPickerCategoryKey,
  "all"
>;

export interface ReactionPickerCatalogEntry {
  /** Canonical value reported to the caller and persisted as the reaction key. */
  readonly reactionKey: string;
  /** Human-readable emoji name used by assistive technology and search. */
  readonly name: string;
  readonly category: ReactionPickerCatalogCategoryKey;
  readonly searchTerms: readonly string[];
}

/** Network-independent catalog used by the default picker. */
export const REACTION_PICKER_CATALOG = Object.freeze([
  { reactionKey: "😀", name: "Grinning face", category: "smileys", searchTerms: ["happy", "smile"] },
  { reactionKey: "😄", name: "Smiling face with open mouth", category: "smileys", searchTerms: ["happy", "joy"] },
  { reactionKey: "😂", name: "Face with tears of joy", category: "smileys", searchTerms: ["laugh", "funny"] },
  { reactionKey: "🤣", name: "Rolling on the floor laughing", category: "smileys", searchTerms: ["laugh", "rofl"] },
  { reactionKey: "😊", name: "Smiling face with smiling eyes", category: "smileys", searchTerms: ["blush", "pleased"] },
  { reactionKey: "😍", name: "Smiling face with heart eyes", category: "smileys", searchTerms: ["love", "adore"] },
  { reactionKey: "😎", name: "Smiling face with sunglasses", category: "smileys", searchTerms: ["cool", "sunny"] },
  { reactionKey: "🤔", name: "Thinking face", category: "smileys", searchTerms: ["hmm", "consider"] },
  { reactionKey: "👍", name: "Thumbs up", category: "gestures", searchTerms: ["yes", "approve", "like"] },
  { reactionKey: "👎", name: "Thumbs down", category: "gestures", searchTerms: ["no", "disapprove", "dislike"] },
  { reactionKey: "👏", name: "Clapping hands", category: "gestures", searchTerms: ["applause", "bravo"] },
  { reactionKey: "🙌", name: "Raising hands", category: "gestures", searchTerms: ["hooray", "praise"] },
  { reactionKey: "👋", name: "Waving hand", category: "gestures", searchTerms: ["hello", "goodbye"] },
  { reactionKey: "🤝", name: "Handshake", category: "gestures", searchTerms: ["deal", "agreement"] },
  { reactionKey: "💪", name: "Flexed biceps", category: "gestures", searchTerms: ["strong", "strength"] },
  { reactionKey: "🙏", name: "Folded hands", category: "gestures", searchTerms: ["please", "thanks", "pray"] },
  { reactionKey: "❤️", name: "Red heart", category: "hearts", searchTerms: ["love", "favorite"] },
  { reactionKey: "🧡", name: "Orange heart", category: "hearts", searchTerms: ["love", "orange"] },
  { reactionKey: "💛", name: "Yellow heart", category: "hearts", searchTerms: ["love", "yellow"] },
  { reactionKey: "💚", name: "Green heart", category: "hearts", searchTerms: ["love", "green"] },
  { reactionKey: "💙", name: "Blue heart", category: "hearts", searchTerms: ["love", "blue"] },
  { reactionKey: "💜", name: "Purple heart", category: "hearts", searchTerms: ["love", "purple"] },
  { reactionKey: "🖤", name: "Black heart", category: "hearts", searchTerms: ["love", "black"] },
  { reactionKey: "💔", name: "Broken heart", category: "hearts", searchTerms: ["sad", "heartbreak"] },
  { reactionKey: "🎉", name: "Party popper", category: "celebration", searchTerms: ["celebrate", "congratulations"] },
  { reactionKey: "🎊", name: "Confetti ball", category: "celebration", searchTerms: ["party", "celebrate"] },
  { reactionKey: "🥳", name: "Partying face", category: "celebration", searchTerms: ["party", "birthday"] },
  { reactionKey: "✨", name: "Sparkles", category: "celebration", searchTerms: ["shiny", "magic"] },
  { reactionKey: "🔥", name: "Fire", category: "celebration", searchTerms: ["hot", "lit"] },
  { reactionKey: "💯", name: "Hundred points", category: "celebration", searchTerms: ["perfect", "score"] },
  { reactionKey: "🚀", name: "Rocket", category: "celebration", searchTerms: ["launch", "ship"] },
  { reactionKey: "🏆", name: "Trophy", category: "celebration", searchTerms: ["winner", "achievement"] },
  { reactionKey: "👀", name: "Eyes", category: "symbols", searchTerms: ["looking", "watching"] },
  { reactionKey: "✅", name: "Check mark button", category: "symbols", searchTerms: ["done", "complete", "yes"] },
  { reactionKey: "❌", name: "Cross mark", category: "symbols", searchTerms: ["no", "wrong", "cancel"] },
  { reactionKey: "⚠️", name: "Warning", category: "symbols", searchTerms: ["alert", "caution"] },
  { reactionKey: "❓", name: "Question mark", category: "symbols", searchTerms: ["question", "help"] },
  { reactionKey: "❗", name: "Exclamation mark", category: "symbols", searchTerms: ["important", "alert"] },
  { reactionKey: "💡", name: "Light bulb", category: "symbols", searchTerms: ["idea", "tip"] },
  { reactionKey: "📌", name: "Pushpin", category: "symbols", searchTerms: ["pin", "save"] },
  { reactionKey: "🐶", name: "Dog face", category: "nature_food", searchTerms: ["dog", "pet"] },
  { reactionKey: "🐱", name: "Cat face", category: "nature_food", searchTerms: ["cat", "pet"] },
  { reactionKey: "🌸", name: "Cherry blossom", category: "nature_food", searchTerms: ["flower", "spring"] },
  { reactionKey: "🌞", name: "Sun with face", category: "nature_food", searchTerms: ["sunny", "weather"] },
  { reactionKey: "☕", name: "Hot beverage", category: "nature_food", searchTerms: ["coffee", "tea"] },
  { reactionKey: "🍕", name: "Pizza", category: "nature_food", searchTerms: ["food", "lunch"] },
  { reactionKey: "🍰", name: "Shortcake", category: "nature_food", searchTerms: ["cake", "dessert", "birthday"] },
  { reactionKey: "🍿", name: "Popcorn", category: "nature_food", searchTerms: ["movie", "snack"] },
] as const satisfies readonly ReactionPickerCatalogEntry[]);

export type ReactionPickerReactionKey =
  (typeof REACTION_PICKER_CATALOG)[number]["reactionKey"];

const reactionKeys = new Set<string>(
  REACTION_PICKER_CATALOG.map((entry) => entry.reactionKey),
);

export const isReactionPickerReactionKey = (
  value: string,
): value is ReactionPickerReactionKey => reactionKeys.has(value);

export type ReactionPickerDismissReason =
  | "close_button"
  | "escape"
  | "outside_pointer"
  | "selection";

export interface ReactionPickerProps {
  readonly onSelect: (reactionKey: ReactionPickerReactionKey) => void;
  readonly onDismiss: (reason: ReactionPickerDismissReason) => void;
  /** Restores focus to the host-owned control that opened this popover. */
  readonly restoreFocus: () => void;
  readonly ariaLabel?: string;
  readonly className?: string;
  readonly initialCategory?: ReactionPickerCategoryKey;
  /** Optional host positioning for overlays rendered near a trigger. */
  readonly style?: CSSProperties;
  /** Promotes the picker above ancestor clipping and stacking contexts. */
  readonly topLayer?: boolean;
  /** Optional host-specific copy. Omitted values retain reaction picker defaults. */
  readonly labels?: Partial<ReactionPickerLabels>;
}

export interface ReactionPickerLabelContext {
  readonly categoryLabel: string;
  readonly query: string;
}

export interface ReactionPickerLabels {
  readonly title: string;
  readonly search: string;
  readonly searchPlaceholder: string;
  readonly categories: string;
  readonly category: (categoryLabel: string) => string;
  readonly grid: (context: ReactionPickerLabelContext) => string;
  readonly empty: (query: string) => string;
  readonly close: string;
}

const DEFAULT_REACTION_PICKER_LABELS: ReactionPickerLabels = Object.freeze({
  title: "Add reaction",
  search: "Search reactions",
  searchPlaceholder: "Search reactions",
  categories: "Reaction categories",
  category: (categoryLabel: string) => `${categoryLabel} reactions`,
  grid: ({ categoryLabel, query }: ReactionPickerLabelContext) => query.length > 0
    ? `Reaction search results for ${query}`
    : `${categoryLabel} reactions`,
  empty: (query: string) => `No reactions found for “${query}”.`,
  close: "Close reaction picker",
});

const GRID_COLUMNS = 6;

const reactionPickerCloseIcon = (): ReactElement => createElement(
  "svg",
  {
    "aria-hidden": true,
    className: "handrail-chat__reaction-picker-close-icon",
    fill: "none",
    focusable: "false",
    stroke: "currentColor",
    strokeLinecap: "round",
    strokeWidth: 1.8,
    viewBox: "0 0 20 20",
  },
  createElement("path", { d: "m5 5 10 10M15 5 5 15" }),
);

const normalizeSearchText = (value: string): string =>
  value.trim().normalize("NFKC").toLocaleLowerCase();

const chunkEntries = <T,>(entries: readonly T[], size: number): T[][] => {
  const rows: T[][] = [];
  for (let index = 0; index < entries.length; index += size) {
    rows.push(entries.slice(index, index + size));
  }
  return rows;
};

/**
 * Standalone, host-positioned reaction popover. Mutation and optimistic state
 * remain caller-owned; this component reports only catalog-backed keys.
 */
export function ReactionPicker({
  onSelect,
  onDismiss,
  restoreFocus,
  ariaLabel = "Choose a reaction",
  className,
  initialCategory = "all",
  style,
  topLayer = false,
  labels: customLabels,
}: ReactionPickerProps): ReactElement {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<ReactionPickerCategoryKey>(
    initialCategory,
  );
  const [activeIndex, setActiveIndex] = useState(0);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const dismissedRef = useRef(false);
  const searchId = useId();
  const labels = { ...DEFAULT_REACTION_PICKER_LABELS, ...customLabels };

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!topLayer || panel === null || typeof panel.showPopover !== "function") return;
    try {
      panel.showPopover();
    } catch {
      return;
    }
    return () => {
      try {
        panel.hidePopover();
      } catch {
        // The browser may already have removed the panel from the top layer.
      }
    };
  }, [topLayer]);

  const normalizedQuery = normalizeSearchText(query);
  const filteredEntries = useMemo(() => {
    if (normalizedQuery.length > 0) {
      return REACTION_PICKER_CATALOG.filter((entry) => {
        const searchable = [
          entry.reactionKey,
          entry.name,
          ...entry.searchTerms,
        ].join(" ").normalize("NFKC").toLocaleLowerCase();
        return searchable.includes(normalizedQuery);
      });
    }
    if (category === "all") return [...REACTION_PICKER_CATALOG];
    return REACTION_PICKER_CATALOG.filter(
      (entry) => entry.category === category,
    );
  }, [category, normalizedQuery]);

  const dismiss = useCallback((reason: ReactionPickerDismissReason) => {
    if (dismissedRef.current) return;
    dismissedRef.current = true;
    onDismiss(reason);
    if (reason === "outside_pointer") {
      // Microtasks queued by the pointerdown listener can run before the
      // browser's native focus default action. Restore in the next task so the
      // outside target cannot overwrite the trigger focus afterward.
      setTimeout(restoreFocus, 0);
      return;
    }
    queueMicrotask(restoreFocus);
  }, [onDismiss, restoreFocus]);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  useEffect(() => {
    setActiveIndex((current) => filteredEntries.length === 0
      ? 0
      : Math.min(current, filteredEntries.length - 1));
  }, [filteredEntries.length]);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const panel = panelRef.current;
      if (panel === null || event.target === null) return;
      if (!panel.contains(event.target as Node)) dismiss("outside_pointer");
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      dismiss("escape");
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [dismiss]);

  const moveFocus = useCallback((
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    if (filteredEntries.length === 0) return;
    let nextIndex: number | undefined;
    switch (event.key) {
      case "ArrowRight":
        nextIndex = Math.min(index + 1, filteredEntries.length - 1);
        break;
      case "ArrowLeft":
        nextIndex = Math.max(index - 1, 0);
        break;
      case "ArrowDown":
        nextIndex = Math.min(index + GRID_COLUMNS, filteredEntries.length - 1);
        break;
      case "ArrowUp":
        nextIndex = Math.max(index - GRID_COLUMNS, 0);
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = filteredEntries.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    setActiveIndex(nextIndex);
    itemRefs.current[nextIndex]?.focus();
  }, [filteredEntries.length]);

  const focusSearchResult = useCallback((
    event: KeyboardEvent<HTMLInputElement>,
  ) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    event.stopPropagation();
    if (filteredEntries.length === 0) return;
    const nextIndex = event.key === "ArrowDown"
      ? 0
      : filteredEntries.length - 1;
    setActiveIndex(nextIndex);
    itemRefs.current[nextIndex]?.focus();
  }, [filteredEntries.length]);

  const selectReaction = useCallback((reactionKey: string) => {
    if (!isReactionPickerReactionKey(reactionKey)) return;
    onSelect(reactionKey);
    dismiss("selection");
  }, [dismiss, onSelect]);

  const selectedCategoryLabel = REACTION_PICKER_CATEGORIES.find(
    (item) => item.key === category,
  )?.label ?? "All";
  const trimmedQuery = query.trim();
  const gridLabel = labels.grid({
    categoryLabel: selectedCategoryLabel,
    query: normalizedQuery.length > 0 ? trimmedQuery : "",
  });
  const classes = ["handrail-chat__reaction-picker", className]
    .filter((value): value is string => value !== undefined && value.length > 0)
    .join(" ");

  return createElement(
    "div",
    {
      "aria-label": ariaLabel,
      className: classes,
      ...(topLayer ? { popover: "manual" as const } : {}),
      ref: panelRef,
      role: "dialog",
      style,
    },
    createElement(
      "div",
      { className: "handrail-chat__reaction-picker-header" },
      createElement("h2", null, labels.title),
      createElement(
        "button",
        {
          "aria-label": labels.close,
          className: "handrail-chat__reaction-picker-close",
          onClick: () => dismiss("close_button"),
          type: "button",
        },
        reactionPickerCloseIcon(),
      ),
    ),
    createElement(
      "label",
      {
        className: "handrail-chat__sr-only",
        htmlFor: searchId,
      },
      labels.search,
    ),
    createElement("input", {
      "aria-label": labels.search,
      autoComplete: "off",
      className: "handrail-chat__reaction-picker-search",
      id: searchId,
      onInput: (event: FormEvent<HTMLInputElement>) => {
        setQuery(event.currentTarget.value);
        setCategory("all");
        setActiveIndex(0);
      },
      onKeyDown: focusSearchResult,
      placeholder: labels.searchPlaceholder,
      ref: searchRef,
      type: "search",
      value: query,
    }),
    createElement(
      "nav",
      {
        "aria-label": labels.categories,
        className: "handrail-chat__reaction-picker-categories",
      },
      ...REACTION_PICKER_CATEGORIES.map((item) => createElement(
        "button",
        {
          "aria-label": labels.category(item.label),
          "aria-pressed": category === item.key && normalizedQuery.length === 0,
          className: "handrail-chat__reaction-picker-category",
          key: item.key,
          onClick: () => {
            setCategory(item.key);
            setQuery("");
            setActiveIndex(0);
          },
          title: item.label,
          type: "button",
        },
        createElement("span", { "aria-hidden": true }, item.icon),
        createElement("span", null, item.label),
      )),
    ),
    filteredEntries.length === 0
      ? createElement(
          "p",
          {
            className: "handrail-chat__reaction-picker-empty",
            role: "status",
          },
          labels.empty(trimmedQuery),
        )
      : createElement(
          "div",
          {
            "aria-colcount": GRID_COLUMNS,
            "aria-label": gridLabel,
            "aria-rowcount": Math.ceil(filteredEntries.length / GRID_COLUMNS),
            className: "handrail-chat__reaction-picker-grid",
            role: "grid",
          },
          ...chunkEntries(filteredEntries, GRID_COLUMNS).map((row, rowIndex) =>
            createElement(
              "div",
              { key: `row-${rowIndex}`, role: "row" },
              ...row.map((entry, columnIndex) => {
                const index = rowIndex * GRID_COLUMNS + columnIndex;
                return createElement(
                  "div",
                  { key: entry.reactionKey, role: "gridcell" },
                  createElement(
                    "button",
                    {
                      "aria-label": entry.name,
                      className: "handrail-chat__reaction-picker-emoji",
                      "data-reaction-key": entry.reactionKey,
                      onClick: () => selectReaction(entry.reactionKey),
                      onFocus: () => setActiveIndex(index),
                      onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) =>
                        moveFocus(event, index),
                      ref: (element: HTMLButtonElement | null) => {
                        itemRefs.current[index] = element;
                      },
                      tabIndex: activeIndex === index ? 0 : -1,
                      title: entry.name,
                      type: "button",
                    },
                    createElement("span", { "aria-hidden": true }, entry.reactionKey),
                  ),
                );
              }),
            )
          ),
        ),
  );
}
