import { useCallback, useMemo, useRef, useState } from "react";
import {
  DefaultMessageRenderer,
  type ChatMessageActions,
  type ChatMessageReminderActionOutcome,
  type ChatMessageReminderViewModel,
  type ChatMessageSavedViewModel,
  type ChatMessageViewModel,
} from "@handrail/chat/ui";

type ConversationId = ChatMessageViewModel["conversationId"];
type MessageId = ChatMessageViewModel["id"];
type IsoTimestamp = ChatMessageViewModel["createdAt"];
type ActiveAuthor = Extract<
  NonNullable<ChatMessageViewModel["author"]>,
  { readonly kind: "active" }
>;
type UserId = ActiveAuthor["userId"];

type MutationMode = "success" | "pending" | "error" | "conflict";
type PendingMutation = Readonly<{
  next: ChatMessageReminderViewModel;
  resolve: (outcome: ChatMessageReminderActionOutcome) => void;
}>;

const conversationId = "react-reminder-fixture" as ConversationId;
const fixtureUserId = "react-reminder-author" as UserId;
const initialDueAt = "2038-05-07T10:30:00.000Z" as IsoTimestamp;
const conflictDueAt = "2038-05-09T16:00:00.000Z" as IsoTimestamp;
const successfulOutcome = Object.freeze({ status: "success", conflict: false } as const);
const failedOutcome = Object.freeze({ status: "failed", conflict: false } as const);
const conflictOutcome = Object.freeze({ status: "success", conflict: true } as const);

const idleSaved = Object.freeze({
  available: false,
  isSaved: false,
  authoritativeRevision: 0,
  mutationState: "idle",
  retryable: false,
  conflict: false,
}) satisfies ChatMessageSavedViewModel;

const idleReminder = (
  overrides: Partial<ChatMessageReminderViewModel> = {},
): ChatMessageReminderViewModel => Object.freeze({
  state: "none",
  authoritativeRevision: 0,
  mutationState: "idle",
  retryable: false,
  conflict: false,
  ...overrides,
});

const message = (
  id: string,
  sequence: number,
  text: string,
  overrides: Partial<ChatMessageViewModel> = {},
): ChatMessageViewModel => Object.freeze({
  id: id as MessageId,
  conversationId,
  sequence,
  createdAt: "2038-05-06T07:08:09.000Z",
  updatedAt: "2038-05-06T07:08:09.000Z",
  revision: Object.freeze({ revision: 1 }),
  content: Object.freeze({ format: "plain", text }),
  reactions: Object.freeze([]),
  attachmentMetadata: Object.freeze([]),
  isThreadRoot: false,
  author: Object.freeze({
    kind: "active",
    userId: fixtureUserId,
    displayName: "React Fixture",
    avatar: Object.freeze({ kind: "initials", initials: "RF" }),
  }),
  delivery: Object.freeze({ state: "sent" }),
  editState: "idle",
  deleteState: "idle",
  saved: idleSaved,
  reminder: idleReminder(),
  canEdit: false,
  canDelete: false,
  ...overrides,
});

const ineligibleFixtures = Object.freeze([
  Object.freeze({
    state: "deleted",
    label: "Deleted canonical message",
    message: message("react-message-deleted", 2, "Deleted canonical message", {
      content: null,
      deletedAt: "2038-05-06T07:10:00.000Z",
      deletedByUserId: fixtureUserId,
    }),
  }),
  Object.freeze({
    state: "unsent",
    label: "Unsent optimistic message",
    message: message("react-message-unsent", 0, "Unsent optimistic message", {
      delivery: Object.freeze({
        state: "sending",
        clientMessageId: "react-client-unsent",
      }),
    }),
  }),
  Object.freeze({
    state: "sending",
    label: "Sending optimistic message",
    message: message("react-message-sending", 3, "Sending optimistic message", {
      delivery: Object.freeze({
        state: "sending",
        clientMessageId: "react-client-sending",
      }),
    }),
  }),
  Object.freeze({
    state: "failed",
    label: "Failed optimistic message",
    message: message("react-message-failed", 4, "Failed optimistic message", {
      delivery: Object.freeze({
        state: "failed",
        clientMessageId: "react-client-failed",
        retryable: true,
      }),
    }),
  }),
]);

const ignoredAction = async (): Promise<never> => Promise.resolve(undefined as never);

export function ReminderChatLab() {
  const [mutationMode, setMutationMode] = useState<MutationMode>("success");
  const [fixtureVersion, setFixtureVersion] = useState(0);
  const [reminder, setReminder] = useState<ChatMessageReminderViewModel>(() =>
    idleReminder({
      state: "scheduled",
      dueAt: initialDueAt,
      authoritativeRevision: 3,
    }));
  const pendingMutation = useRef<PendingMutation | undefined>(undefined);
  const lastMutation = useRef<ChatMessageReminderViewModel | undefined>(undefined);

  const applyMutation = useCallback((next: ChatMessageReminderViewModel) => {
    lastMutation.current = next;
    setReminder((current) => ({
      ...next,
      authoritativeRevision: current.authoritativeRevision + 1,
      mutationState: "idle",
      retryable: false,
      conflict: false,
    }));
  }, []);

  const runMutation = useCallback((next: ChatMessageReminderViewModel) => {
    lastMutation.current = next;
    setReminder((current) => ({
      ...current,
      mutationState: "pending",
      retryable: false,
      conflict: false,
    }));
    if (mutationMode === "pending") {
      return new Promise<ChatMessageReminderActionOutcome>((resolve) => {
        pendingMutation.current = Object.freeze({ next, resolve });
      });
    }
    if (mutationMode === "error") {
      setReminder((current) => ({
        ...current,
        mutationState: "failed",
        retryable: true,
        conflict: false,
      }));
      return Promise.resolve(failedOutcome);
    }
    if (mutationMode === "conflict") {
      setReminder((current) => ({
        state: "scheduled",
        dueAt: conflictDueAt,
        authoritativeRevision: current.authoritativeRevision + 1,
        mutationState: "idle",
        retryable: false,
        conflict: true,
      }));
      return Promise.resolve(conflictOutcome);
    }
    applyMutation(next);
    return Promise.resolve(successfulOutcome);
  }, [applyMutation, mutationMode]);

  const resolvePending = () => {
    const pending = pendingMutation.current;
    if (pending === undefined) return;
    pendingMutation.current = undefined;
    applyMutation(pending.next);
    pending.resolve(successfulOutcome);
  };

  const injectConflict = () => {
    const pending = pendingMutation.current;
    pendingMutation.current = undefined;
    setReminder((current) => ({
      state: "scheduled",
      dueAt: conflictDueAt,
      authoritativeRevision: current.authoritativeRevision + 1,
      mutationState: "idle",
      retryable: false,
      conflict: true,
    }));
    pending?.resolve(conflictOutcome);
  };

  const resetFixture = () => {
    const pending = pendingMutation.current;
    pendingMutation.current = undefined;
    pending?.resolve(failedOutcome);
    lastMutation.current = undefined;
    setMutationMode("success");
    setReminder(idleReminder({
      state: "scheduled",
      dueAt: initialDueAt,
      authoritativeRevision: 3,
    }));
    setFixtureVersion((current) => current + 1);
  };

  const actions = useMemo(() => ({
    retryMessage: ignoredAction,
    editMessage: ignoredAction,
    deleteMessage: ignoredAction,
    setReaction: ignoredAction,
    markUnread: ignoredAction,
    openThread: ignoredAction,
    saveMessage: ignoredAction,
    unsaveMessage: ignoredAction,
    setMessageReminder: ({ dueAt }: Readonly<{ dueAt: IsoTimestamp }>) =>
      runMutation(idleReminder({
        state: "scheduled",
        dueAt,
        authoritativeRevision: reminder.authoritativeRevision,
      })),
    cancelMessageReminder: () => runMutation(idleReminder({
      state: "cancelled",
      authoritativeRevision: reminder.authoritativeRevision,
    })),
    retryMessageReminder: () => {
      const retry = lastMutation.current;
      if (retry === undefined) return Promise.resolve(failedOutcome);
      applyMutation(retry);
      return Promise.resolve(successfulOutcome);
    },
  }) as unknown as ChatMessageActions, [applyMutation, reminder.authoritativeRevision, runMutation]);

  const sentMessage = useMemo(() => message(
    "react-message-sent",
    1,
    "Sent canonical message — exercise Remind me on this default React renderer.",
    { reminder },
  ), [reminder]);

  return (
    <main className="react-reminder-lab">
      <header className="react-reminder-lab__header">
        <p className="react-reminder-lab__eyebrow">Deterministic acceptance fixture</p>
        <h1>Default React message renderer</h1>
        <p>
          React DOM controls exercise reminder scheduling and reconciliation. The
          Flutter renderer is not mounted on this route.
        </p>
      </header>

      <section className="react-reminder-lab__controls" aria-label="Reminder mutation feedback controls">
        <fieldset>
          <legend>Next reminder mutation</legend>
          {(["success", "pending", "error", "conflict"] as const).map((mode) => (
            <button
              aria-pressed={mutationMode === mode}
              key={mode}
              onClick={() => setMutationMode(mode)}
              type="button"
            >
              {mode === "conflict" ? "Canonical conflict" : mode[0]?.toUpperCase() + mode.slice(1)}
            </button>
          ))}
        </fieldset>
        <div className="react-reminder-lab__fixture-actions">
          <button
            disabled={reminder.mutationState !== "pending"}
            onClick={resolvePending}
            type="button"
          >
            Resolve pending as success
          </button>
          <button onClick={injectConflict} type="button">Inject canonical conflict</button>
          <button onClick={resetFixture} type="button">Reset fixture</button>
        </div>
        <p className="react-reminder-lab__instructions">
          Open <strong>Remind me</strong> below. Presets and custom input schedule
          or reschedule; the existing reminder can be cancelled. Select a next
          mutation mode to expose pending, retryable error, or conflict feedback.
        </p>
      </section>

      <section className="handrail-chat react-reminder-lab__messages" aria-label="Default React renderer message states">
        <article className="react-reminder-lab__message" data-fixture-state="sent">
          <h2>Sent</h2>
          <DefaultMessageRenderer
            actions={actions}
            hostProps={{ "data-message-id": sentMessage.id }}
            key={fixtureVersion}
            message={sentMessage}
          />
        </article>
        {ineligibleFixtures.map((fixture) => (
          <article
            className="react-reminder-lab__message"
            data-fixture-state={fixture.state}
            key={fixture.state}
          >
            <h2>{fixture.label}</h2>
            <DefaultMessageRenderer
              actions={actions}
              hostProps={{ "data-message-id": fixture.message.id }}
              message={fixture.message}
            />
          </article>
        ))}
      </section>
    </main>
  );
}
