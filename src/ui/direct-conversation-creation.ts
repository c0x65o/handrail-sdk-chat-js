import {
  createElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
} from "react";

import type {
  ConversationId,
  DirectConversationSnapshotSummary,
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

export interface DirectConversationCreationProps {
  readonly actions: ChatActions;
  readonly onOpenChange?: (open: boolean) => void;
  readonly onConversationResolved?: (
    conversation: DirectConversationSnapshotSummary,
  ) => void;
  readonly onConversationSelected: (conversationId: ConversationId) => void;
  readonly open?: boolean;
  readonly renderTrigger?: boolean;
  readonly restoreFocus?: () => void;
}

/** Default, host-authorized single-participant direct-conversation workflow. */
export function DirectConversationCreation(
  props: DirectConversationCreationProps,
): ReactElement | null {
  const [internalDialogOpen, setInternalDialogOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [selectedUserId, setSelectedUserId] = useState<UserId>();
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

  const reset = useCallback(() => {
    creationPendingRef.current = false;
    setQuery("");
    setDebouncedQuery("");
    setSelectedUserId(undefined);
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
  const submit = useCallback(async (
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    event.preventDefault();
    if (creationPendingRef.current) return;
    if (selectedUserId === undefined) {
      setCreationError("Select one person and try again.");
      return;
    }

    creationPendingRef.current = true;
    setCreationPending(true);
    setCreationError(undefined);
    try {
      const result = await props.actions.createDirect({
        intendedMemberUserIds: [selectedUserId],
      });
      if (result.status !== "success") {
        setCreationError(
          `${result.message} Check the selected person and try again.`,
        );
        return;
      }

      const conversation = result.value.conversation.conversation;
      props.onConversationResolved?.(conversation);
      props.onConversationSelected(conversation.id);
      restoreFocusPendingRef.current = true;
      setDialogOpen(false);
      reset();
    } catch {
      setCreationError(
        "The direct conversation could not be created. Check your connection and try again.",
      );
    } finally {
      creationPendingRef.current = false;
      setCreationPending(false);
    }
  }, [props, reset, selectedUserId, setDialogOpen]);

  const searchContent = normalizedQuery.length === 0
    ? statusRegion("Search for a person to start a direct conversation.")
    : isDebouncing || searchResult.status === "loading"
      ? statusRegion("Searching directory…")
      : searchResult.status === "error"
        ? errorRegion(searchResult.error.message)
        : searchResult.status === "empty"
          ? statusRegion("No people found.")
          : createElement(
              "fieldset",
              {
                className: "handrail-chat__direct-creation-results",
                disabled: creationPending,
              },
              createElement("legend", null, "Select one person"),
              createElement(
                "ul",
                { className: "handrail-chat__direct-creation-list" },
                ...searchResult.data.users.map((user) => createElement(
                  "li",
                  {
                    className: "handrail-chat__direct-creation-item",
                    key: user.userId,
                  },
                  createElement(
                    "label",
                    { className: "handrail-chat__direct-creation-choice" },
                    createElement("input", {
                      checked: selectedUserId === user.userId,
                      name: "directParticipant",
                      onChange: () => {
                        setSelectedUserId(user.userId);
                        setCreationError(undefined);
                      },
                      type: "radio",
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
        ? "handrail-chat__direct-creation handrail-chat__direct-creation--modal"
        : "handrail-chat__direct-creation",
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
            className: "handrail-chat__direct-creation-trigger",
            onClick: () => {
              setDialogOpen(true);
              setCreationError(undefined);
            },
            ref: triggerRef,
            type: "button",
          },
          "Create direct conversation",
        ),
    !dialogOpen
      ? null
      : createElement(
          "div",
          {
            "aria-labelledby": dialogTitleId,
            "aria-modal": true,
            className: "handrail-chat__direct-creation-dialog",
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
              className: "handrail-chat__direct-creation-form",
              onSubmit: (event: FormEvent<HTMLFormElement>) => {
                void submit(event);
              },
            },
            createElement(
              "h3",
              {
                className: "handrail-chat__direct-creation-title",
                id: dialogTitleId,
              },
              "Create direct conversation",
            ),
            createElement(
              "label",
              {
                className: "handrail-chat__direct-creation-label",
                htmlFor: queryId,
              },
              "Find a person",
            ),
            createElement("input", {
              autoComplete: "off",
              autoFocus: true,
              className: "handrail-chat__direct-creation-input",
              disabled: creationPending,
              id: queryId,
              name: "directoryQuery",
              onInput: (event: FormEvent<HTMLInputElement>) => {
                setQuery(event.currentTarget.value);
                setSelectedUserId(undefined);
                setCreationError(undefined);
              },
              ref: queryInputRef,
              type: "search",
              value: query,
            }),
            searchContent,
            creationPending
              ? statusRegion("Creating direct conversation…")
              : null,
            creationError === undefined
              ? null
              : errorRegion(creationError),
            createElement(
              "div",
              { className: "handrail-chat__direct-creation-actions" },
              createElement(
                "button",
                {
                  className: "handrail-chat__direct-creation-cancel",
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
                  className: "handrail-chat__direct-creation-submit",
                  disabled: creationPending || selectedUserId === undefined,
                  type: "submit",
                },
                creationPending ? "Creating…" : "Create",
              ),
            ),
          ),
        ),
  );
}
