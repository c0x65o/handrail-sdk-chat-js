import { createElement, useCallback, useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactElement } from "react";
import type { ConversationId, MessageId } from "../contracts/index.js";
import { validateThreadConversationName } from "../contracts/conversation.js";
import { useChat, useChatActions, useChatSelector } from "../react/index.js";
import type { MessageComposerAvailability } from "./message-composer.js";

/** Presentation restrictions only; the create command rechecks server authority. */
export function useThreadCreationRestriction(
  conversationId: ConversationId | undefined,
  readOnly?: boolean,
  availability?: MessageComposerAvailability,
): string | undefined {
  const chat = useChat();
  const restriction = useChatSelector(useCallback(state => {
    const conversation = conversationId === undefined ? undefined : state.entities.conversations[conversationId];
    const membership = conversationId === undefined ? undefined : state.currentUser.memberships[conversationId];
    if (state.identity === null || conversation === undefined) return "This conversation is unavailable.";
    if (conversation.type === "thread") return "Nested threads are not supported.";
    if (conversation.archivedAt !== undefined) return "This conversation is archived.";
    if ((membership !== undefined && membership.state !== "active") ||
      (conversation.visibility !== "public" && membership?.state !== "active")) return "You must be an active member to create a thread.";
    return undefined;
  }, [conversationId]));
  return !chat?.isReady ? "Chat is not ready to create threads." :
    chat.state.state !== "ready" || chat.state.enabledFeatures?.namedThreads !== true
      ? "Named threads are not supported by this server." :
    readOnly === true ? "This conversation is read-only." :
    availability?.canSend === false ? "Thread creation is unavailable in this conversation." :
    availability?.membershipState !== undefined && availability.membershipState !== "active"
      ? "You must be an active member to create a thread." : restriction;
}

/** Workspace-owned, separate from the message composer and its persisted draft. */
export interface ThreadCreationDraft {
  name: string;
  submittedName?: string;
}

export interface ThreadCreationRequest {
  readonly conversationId: ConversationId;
  readonly rootMessageId: MessageId;
  readonly returnFocusTarget: HTMLElement | null;
  readonly draft: ThreadCreationDraft;
}

export function ThreadCreationDialog({ request, disabledReason, onCancel, onCreated }: {
  readonly request: ThreadCreationRequest;
  readonly disabledReason: string | undefined;
  readonly onCancel: () => void;
  readonly onCreated: () => void;
}): ReactElement {
  const actions = useChatActions();
  const id = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const active = useRef(false);
  const pendingRef = useRef(false);
  const [name, setName] = useState(request.draft.name);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [invalid, setInvalid] = useState(false);
  const restrictionRef = useRef(disabledReason);
  restrictionRef.current = disabledReason;
  const rootAvailable = useChatSelector(useCallback(state => {
    const root = state.entities.messages[request.rootMessageId];
    return root !== undefined && root.conversationId === request.conversationId &&
      root.content !== null && root.deletedAt === undefined && root.sequence > 0;
  }, [request]));
  const rootAvailableRef = useRef(rootAvailable);
  rootAvailableRef.current = rootAvailable;
  useLayoutEffect(() => {
    active.current = true;
    input.current?.focus();
    return () => { active.current = false; };
  }, []);
  const cancel = () => {
    active.current = false;
    onCancel();
    queueMicrotask(() => {
      if (request.returnFocusTarget?.isConnected) request.returnFocusTarget.focus();
    });
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!active.current || pendingRef.current || restrictionRef.current !== undefined || !rootAvailableRef.current) return;
    let validated: string;
    try {
      validated = validateThreadConversationName(request.draft.submittedName ?? name);
    } catch {
      setInvalid(true);
      setError("Enter a name of 1–100 characters, without leading or trailing whitespace.");
      input.current?.focus();
      return;
    }
    // The client retains its original name and idempotency key after failure.
    // Keep this identity even when the dialog is dismissed and opened again.
    request.draft.submittedName = validated;
    pendingRef.current = true;
    setPending(true);
    setInvalid(false);
    setError(undefined);
    try {
      const result = await actions.createThread({ rootMessageId: request.rootMessageId, name: validated });
      if (!active.current) return;
      if (result.state === "ready" && result.rootMessageId === request.rootMessageId &&
        result.parentConversationId === request.conversationId && restrictionRef.current === undefined && rootAvailableRef.current) {
        active.current = false;
        onCreated();
      } else {
        setError(result.state === "error" ? result.message : "The thread could not be opened. Try again.");
      }
    } catch {
      if (active.current) setError("The chat service could not be reached. Check your connection and try again.");
    } finally {
      pendingRef.current = false;
      if (active.current) setPending(false);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancel(); }
    if (event.key !== "Tab") return;
    event.stopPropagation();
    const controls = [...(dialog.current?.querySelectorAll<HTMLElement>("input:not(:disabled), button:not(:disabled)") ?? [])];
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) {
      event.preventDefault(); last?.focus();
    } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) {
      event.preventDefault(); first?.focus();
    }
  };
  return createElement("div", { className: "handrail-chat__channel-creation" },
    createElement("div", { role: "dialog", "aria-modal": true, "aria-labelledby": `${id}-title`,
      className: "handrail-chat__channel-creation-dialog", ref: dialog, tabIndex: -1, onKeyDown },
    createElement("h3", { id: `${id}-title` }, "Create Thread"),
    createElement("form", { className: "handrail-chat__channel-creation-form", onSubmit: event => void submit(event), "aria-busy": pending },
      createElement("label", { htmlFor: id }, "Thread name"),
      createElement("input", { id, ref: input, value: name, type: "text", className: "handrail-chat__channel-creation-input",
        readOnly: request.draft.submittedName !== undefined, "aria-invalid": invalid,
        "aria-describedby": `${id}-help ${id}-status${error === undefined ? "" : ` ${id}-error`}`,
        onChange: event => { if (request.draft.submittedName !== undefined) return; request.draft.name = event.currentTarget.value; setName(event.currentTarget.value); setInvalid(false); setError(undefined); } }),
      createElement("p", { id: `${id}-help` }, "Start a separate discussion from this message. If one already exists, its original name is kept."),
      createElement("div", { id: `${id}-status`, role: "status", "aria-live": "polite" },
        disabledReason ?? (!rootAvailable ? "The source message is unavailable." : pending ? "Creating thread…" :
          request.draft.submittedName !== undefined ? "Retries keep the originally submitted name." : "Use 1–100 characters without leading or trailing whitespace.")),
      error === undefined ? null : createElement("p", { id: `${id}-error`, role: "alert" }, error),
      createElement("button", { type: "submit", className: "handrail-chat__channel-creation-submit",
        disabled: pending || disabledReason !== undefined || !rootAvailable }, pending ? "Creating…" : request.draft.submittedName === undefined ? "Create Thread" : "Retry"),
      createElement("button", { type: "button", className: "handrail-chat__button", onClick: cancel }, "Cancel"))));
}
