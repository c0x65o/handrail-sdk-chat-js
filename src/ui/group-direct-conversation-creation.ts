import {
  createElement,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
} from "react";

import type {
  ConversationId,
  HostDirectoryUserSummary,
  UserId,
} from "../contracts/index.js";
import {
  useDirectorySearch,
  type ChatActions,
} from "../react/index.js";

const DIRECTORY_QUERY_DEBOUNCE_MS = 300;

const directoryUserLabel = (user: HostDirectoryUserSummary): string => {
  if (user.kind === "active") return user.displayName;
  if (user.kind === "redacted") return "Hidden user";
  return "Unavailable user";
};

const statusRegion = (message: string): ReactElement => createElement(
  "div",
  {
    className: "handrail-chat__status",
    role: "status",
    "aria-live": "polite",
  },
  message,
);

const errorRegion = (message: string): ReactElement => createElement(
  "div",
  { className: "handrail-chat__error", role: "alert" },
  message,
);

export interface GroupDirectConversationCreationProps {
  readonly actions: ChatActions;
  readonly currentUserId?: UserId;
  readonly onOpenChange?: (open: boolean) => void;
  readonly onConversationSelected: (conversationId: ConversationId) => void;
  readonly open?: boolean;
  readonly renderTrigger?: boolean;
  readonly restoreFocus?: () => void;
}

/** Default, host-authorized multi-participant group-direct workflow. */
export function GroupDirectConversationCreation(
  props: GroupDirectConversationCreationProps,
): ReactElement | null {
  const [internalDialogOpen, setInternalDialogOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [selectedUsers, setSelectedUsers] = useState<
    readonly HostDirectoryUserSummary[]
  >([]);
  const [creationPending, setCreationPending] = useState(false);
  const [creationError, setCreationError] = useState<string>();
  const creationPendingRef = useRef(false);
  const restoreFocusPendingRef = useRef(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const queryInputRef = useRef<HTMLInputElement | null>(null);
  const dialogId = useId();
  const dialogTitleId = useId();
  const queryId = useId();
  const selectedTitleId = useId();
  const dialogOpen = props.open ?? internalDialogOpen;
  const setDialogOpen = useCallback((open: boolean) => {
    if (props.open === undefined) setInternalDialogOpen(open);
    props.onOpenChange?.(open);
  }, [props.onOpenChange, props.open]);
  const restoreFocus = useCallback(() => {
    if (props.restoreFocus !== undefined) props.restoreFocus();
    else triggerRef.current?.focus();
  }, [props.restoreFocus]);

  const normalizedQuery = query.trim().normalize("NFC");
  useEffect(() => {
    if (!dialogOpen || normalizedQuery.length === 0) {
      setDebouncedQuery("");
      return;
    }
    const timer = setTimeout(() => {
      setDebouncedQuery(normalizedQuery);
    }, DIRECTORY_QUERY_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [dialogOpen, normalizedQuery]);

  const searchResult = useDirectorySearch(debouncedQuery, {
    enabled: dialogOpen,
    limit: 25,
  });
  const isDebouncing = normalizedQuery.length > 0 &&
    normalizedQuery !== debouncedQuery;
  const eligibleSearchUsers = useMemo(() => {
    const seen = new Set<UserId>();
    return (searchResult.data?.users ?? []).filter((user) => {
      if (user.userId === props.currentUserId || seen.has(user.userId)) {
        return false;
      }
      seen.add(user.userId);
      return true;
    });
  }, [props.currentUserId, searchResult.data?.users]);
  const selectedUserIds = useMemo(
    () => new Set(selectedUsers.map(({ userId }) => userId)),
    [selectedUsers],
  );

  const reset = useCallback(() => {
    creationPendingRef.current = false;
    setQuery("");
    setDebouncedQuery("");
    setSelectedUsers([]);
    setCreationPending(false);
    setCreationError(undefined);
  }, []);
  const closeDialog = useCallback(() => {
    if (creationPendingRef.current) return;
    restoreFocusPendingRef.current = true;
    setDialogOpen(false);
    reset();
  }, [reset, setDialogOpen]);
  const containDialogFocus = useCallback((
    event: KeyboardEvent<HTMLDivElement>,
  ) => {
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (dialog === null) return;
    const focusable = [...dialog.querySelectorAll<HTMLElement>(
      "button, input, select, textarea, [href], [tabindex]",
    )].filter((element) =>
      (element as HTMLButtonElement | HTMLInputElement).disabled !== true &&
      element.closest("fieldset[disabled]") === null &&
      element.getAttribute("aria-hidden") !== "true" &&
      !element.hasAttribute("hidden") &&
      element.tabIndex >= 0
    );
    event.preventDefault();
    if (focusable.length === 0) {
      dialog.focus();
      return;
    }
    const activeIndex = focusable.indexOf(
      dialog.ownerDocument.activeElement as HTMLElement,
    );
    const nextIndex = event.shiftKey
      ? activeIndex <= 0 ? focusable.length - 1 : activeIndex - 1
      : activeIndex < 0 || activeIndex === focusable.length - 1
        ? 0
        : activeIndex + 1;
    focusable[nextIndex]?.focus();
  }, []);
  useEffect(() => {
    if (!dialogOpen) return;
    queryInputRef.current?.focus();
  }, [dialogOpen]);
  useEffect(() => {
    if (dialogOpen || !restoreFocusPendingRef.current) return;
    restoreFocusPendingRef.current = false;
    restoreFocus();
  }, [dialogOpen, restoreFocus]);
  const removeSelectedUser = useCallback((userId: UserId) => {
    setSelectedUsers((current) =>
      current.filter((user) => user.userId !== userId)
    );
    setCreationError(undefined);
  }, []);
  const submit = useCallback(async (
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();
    if (creationPendingRef.current) return;

    const canonicalParticipantIds = [...new Set(
      selectedUsers
        .map(({ userId }) => userId)
        .filter((userId) => userId !== props.currentUserId),
    )].sort();
    if (canonicalParticipantIds.length < 2) {
      setCreationError("Select at least two people and try again.");
      return;
    }

    creationPendingRef.current = true;
    setCreationPending(true);
    setCreationError(undefined);
    try {
      const intendedMemberUserIds = canonicalParticipantIds as [
        UserId,
        UserId,
        ...UserId[],
      ];
      const result = await props.actions.createGroupDirect({
        intendedMemberUserIds,
      });
      if (result.status !== "success") {
        setCreationError(
          `${result.message} Review the selected people and try again.`,
        );
        return;
      }

      props.onConversationSelected(
        result.value.conversation.conversation.id,
      );
      restoreFocusPendingRef.current = true;
      setDialogOpen(false);
      reset();
    } catch {
      setCreationError(
        "The group conversation could not be created. Check your connection and try again.",
      );
    } finally {
      creationPendingRef.current = false;
      setCreationPending(false);
    }
  }, [props, reset, selectedUsers, setDialogOpen]);

  const searchContent = normalizedQuery.length === 0
    ? statusRegion("Search for people to start a group conversation.")
    : isDebouncing || searchResult.status === "loading"
      ? statusRegion("Searching directory…")
      : searchResult.status === "error"
        ? errorRegion(searchResult.error.message)
        : searchResult.status === "empty" || eligibleSearchUsers.length === 0
          ? statusRegion("No eligible people found.")
          : createElement(
              "fieldset",
              {
                className: "handrail-chat__group-direct-creation-results",
                disabled: creationPending,
              },
              createElement("legend", null, "Add people"),
              createElement(
                "ul",
                { className: "handrail-chat__group-direct-creation-list" },
                ...eligibleSearchUsers.map((user) => createElement(
                  "li",
                  {
                    className: "handrail-chat__group-direct-creation-item",
                    key: user.userId,
                  },
                  createElement(
                    "label",
                    { className: "handrail-chat__group-direct-creation-choice" },
                    createElement("input", {
                      checked: selectedUserIds.has(user.userId),
                      name: "groupDirectParticipant",
                      onChange: (event: FormEvent<HTMLInputElement>) => {
                        if (event.currentTarget.checked) {
                          setSelectedUsers((current) =>
                            current.some(({ userId }) => userId === user.userId)
                              ? current
                              : [...current, user]
                          );
                        } else {
                          removeSelectedUser(user.userId);
                        }
                        setCreationError(undefined);
                      },
                      type: "checkbox",
                      value: user.userId,
                    }),
                    createElement("span", null, directoryUserLabel(user)),
                  ),
                )),
              ),
            );

  if (props.renderTrigger === false && !dialogOpen) return null;

  return createElement(
    "div",
    {
      className: props.renderTrigger === false
        ? "handrail-chat__group-direct-creation handrail-chat__group-direct-creation--modal"
        : "handrail-chat__group-direct-creation",
      onClick: props.renderTrigger === false
        ? (event: ReactMouseEvent<HTMLDivElement>) => {
            if (event.target !== event.currentTarget || creationPendingRef.current) return;
            closeDialog();
          }
        : undefined,
    },
    props.renderTrigger === false
      ? null
      : createElement(
          "button",
          {
            "aria-controls": dialogId,
            "aria-expanded": dialogOpen,
            "aria-haspopup": "dialog",
            className: "handrail-chat__group-direct-creation-trigger",
            onClick: () => {
              setDialogOpen(true);
              setCreationError(undefined);
            },
            ref: triggerRef,
            type: "button",
          },
          "Create group conversation",
        ),
    !dialogOpen
      ? null
      : createElement(
          "div",
          {
            "aria-labelledby": dialogTitleId,
            "aria-modal": true,
            className: "handrail-chat__group-direct-creation-dialog",
            id: dialogId,
            onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
              if (event.key === "Tab") {
                containDialogFocus(event);
                return;
              }
              if (event.key !== "Escape" || creationPendingRef.current) return;
              event.preventDefault();
              closeDialog();
            },
            ref: dialogRef,
            role: "dialog",
            tabIndex: -1,
          },
          createElement(
            "form",
            {
              className: "handrail-chat__group-direct-creation-form",
              onSubmit: (event: FormEvent<HTMLFormElement>) => {
                void submit(event);
              },
            },
            createElement(
              "h3",
              {
                className: "handrail-chat__group-direct-creation-title",
                id: dialogTitleId,
              },
              "Create group conversation",
            ),
            createElement(
              "label",
              {
                className: "handrail-chat__group-direct-creation-label",
                htmlFor: queryId,
              },
              "Find people",
            ),
            createElement("input", {
              autoComplete: "off",
              autoFocus: true,
              className: "handrail-chat__group-direct-creation-input",
              disabled: creationPending,
              id: queryId,
              name: "groupDirectoryQuery",
              onInput: (event: FormEvent<HTMLInputElement>) => {
                setQuery(event.currentTarget.value);
                setCreationError(undefined);
              },
              ref: queryInputRef,
              type: "search",
              value: query,
            }),
            selectedUsers.length === 0
              ? statusRegion("Select at least two people.")
              : createElement(
                  "section",
                  {
                    "aria-labelledby": selectedTitleId,
                    className: "handrail-chat__group-direct-creation-selected",
                  },
                  createElement(
                    "h4",
                    {
                      className: "handrail-chat__group-direct-creation-selected-title",
                      id: selectedTitleId,
                    },
                    `Selected people (${selectedUsers.length})`,
                  ),
                  createElement(
                    "ul",
                    { className: "handrail-chat__group-direct-creation-selected-list" },
                    ...selectedUsers.map((user) => {
                      const label = directoryUserLabel(user);
                      return createElement(
                        "li",
                        {
                          className: "handrail-chat__group-direct-creation-selected-item",
                          key: user.userId,
                        },
                        createElement("span", null, label),
                        createElement(
                          "button",
                          {
                            "aria-label": `Remove ${label} from group conversation`,
                            className: "handrail-chat__group-direct-creation-remove",
                            disabled: creationPending,
                            onClick: () => removeSelectedUser(user.userId),
                            type: "button",
                          },
                          "Remove",
                        ),
                      );
                    }),
                  ),
                ),
            searchContent,
            creationPending
              ? statusRegion("Creating group conversation…")
              : null,
            creationError === undefined
              ? null
              : errorRegion(creationError),
            createElement(
              "div",
              { className: "handrail-chat__group-direct-creation-actions" },
              createElement(
                "button",
                {
                  className: "handrail-chat__group-direct-creation-cancel",
                  disabled: creationPending,
                  onClick: closeDialog,
                  type: "button",
                },
                "Cancel",
              ),
              createElement(
                "button",
                {
                  "aria-busy": creationPending ? true : undefined,
                  className: "handrail-chat__group-direct-creation-submit",
                  disabled: creationPending || selectedUsers.length < 2,
                  type: "submit",
                },
                creationPending ? "Creating…" : "Create",
              ),
            ),
          ),
        ),
  );
}
