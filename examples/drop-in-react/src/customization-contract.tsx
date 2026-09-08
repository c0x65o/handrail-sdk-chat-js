import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  ChatProvider,
  useChatActions,
  useConversation,
  useMessages,
  useReadState,
  useTyping,
} from "@handrail/chat/react";
import {
  ChatWorkspace,
  HuddleControls,
  MessageComposer,
  MessageTimeline,
  ThreadPanel,
  type ChatWorkspaceBodyProps,
  type ChatWorkspaceChannelCreationAvailability,
  type ChatWorkspaceProps,
  type HuddleControlsPermissions,
  type ThreadPanelProps,
} from "@handrail/chat/ui";

import { companyComponents } from "./company-slots";

type ConversationId = Parameters<typeof useConversation>[0];
type CurrentUserId = NonNullable<ChatWorkspaceProps["currentUserId"]>;

const organizationScope = { type: "organization" } as const;
const recordScope = {
  type: "entity",
  entity: { type: "sales-order", id: "SO-1042" },
} as const;

const huddlePermissions = Object.freeze({
  canStart: true,
  canJoin: true,
  canLeave: true,
  canControlMicrophone: true,
  canShareScreen: false,
  canSelectDevices: true,
  canRetry: true,
  canRejoin: true,
  canEnd: false,
}) satisfies HuddleControlsPermissions;

const channelCreationAvailability = Object.freeze({
  canCreate: true,
}) satisfies ChatWorkspaceChannelCreationAvailability;

/** Compile fixture for all four root-local layout modes and both scope kinds. */
export function WorkspaceLayoutContract() {
  const [conversationId, setConversationId] = useState<ConversationId | null>(null);
  const shared = {
    channelCreationAvailability,
    components: companyComponents,
    conversationId,
    onConversationChange: setConversationId,
  } satisfies Pick<
    ChatWorkspaceProps,
    | "channelCreationAvailability"
    | "components"
    | "conversationId"
    | "onConversationChange"
  >;

  return (
    <div className="workspace-layout-contract">
      <ChatWorkspace {...shared} mode="full-screen" scope={organizationScope} />
      <ChatWorkspace {...shared} mode="side-panel" scope={organizationScope} />
      <ChatWorkspace {...shared} mode="modal" scope={organizationScope} />
      <ChatWorkspace {...shared} mode="record" scope={recordScope} />
    </div>
  );
}

/** Body renderer examples use the same public components available outside the shell. */
export const renderCompanyTimeline = ({
  conversation,
  slots,
}: ChatWorkspaceBodyProps): ReactNode => (
  <MessageTimeline conversationId={conversation.id} slots={slots} />
);

export const renderCompanyComposer = ({
  conversation,
  slots,
}: ChatWorkspaceBodyProps): ReactNode => (
  <MessageComposer
    components={{ Composer: slots.Composer }}
    conversation={conversation}
    conversationId={conversation.id}
  />
);

export interface ThreadAndHuddleContractProps {
  readonly conversationId: ConversationId;
  readonly currentUserId: CurrentUserId;
  readonly rootMessageId: ThreadPanelProps["rootMessageId"];
}

export function ThreadAndHuddleContract({
  conversationId,
  currentUserId,
  rootMessageId,
}: ThreadAndHuddleContractProps) {
  return (
    <aside aria-label="Conversation collaboration panels">
      <ThreadPanel
        composerComponents={{ Composer: companyComponents.Composer }}
        rootMessageId={rootMessageId}
        timelineSlots={companyComponents}
      />
      <HuddleControls
        conversationId={conversationId}
        currentUserId={currentUserId}
        permissions={huddlePermissions}
      />
    </aside>
  );
}

export interface FullyHeadlessChatProps {
  readonly conversationId: ConversationId;
}

/**
 * A complete workspace replacement: public provider, queries, and actions only.
 * It has no dependency on ChatWorkspace, UI internals, transports, or sockets.
 */
export function FullyHeadlessChat({ conversationId }: FullyHeadlessChatProps) {
  const conversation = useConversation(conversationId);
  const messages = useMessages(conversationId);
  const unread = useReadState(conversationId);
  const typing = useTyping(conversationId);
  const actions = useChatActions(conversationId);
  const [text, setText] = useState("");
  const [announcement, setAnnouncement] = useState("Ready");
  const timeline = messages.data?.messages ?? [];
  const latestSequence = useMemo(
    () => timeline.reduce((latest, message) => Math.max(latest, message.sequence), 0),
    [timeline],
  );

  const send = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const content = text.trim();
    if (content.length === 0) return;
    setAnnouncement("Sending message");
    const result = await actions.sendMessage({
      content: { format: "plain", text: content },
    });
    if (result.status === "success") {
      setText("");
      setAnnouncement("Message sent");
    } else {
      setAnnouncement("Message could not be sent");
    }
  };

  const title = conversation.data?.type === "channel"
    ? conversation.data.name
    : "Conversation";

  return (
    <section aria-labelledby="headless-chat-title" className="company-headless-chat">
      <header>
        <h1 id="headless-chat-title">{title}</h1>
        <p>{unread.data?.unreadCount ?? 0} unread</p>
        <button
          disabled={latestSequence === 0}
          onClick={() => void actions.markRead({ throughSequence: latestSequence })}
          type="button"
        >
          Mark read
        </button>
      </header>

      {conversation.status === "error"
        ? <p role="alert">{conversation.error.message}</p>
        : null}
      {messages.status === "error" ? <p role="alert">{messages.error.message}</p> : null}

      <ol aria-label="Messages">
        {timeline.map((message) => (
          <li key={message.id}>
            <article aria-label={`Message ${message.sequence}`}>
              <p>{message.content?.text ?? "Message deleted"}</p>
              <button onClick={() => void actions.openThread(message.id)} type="button">
                Open thread
              </button>
            </article>
          </li>
        ))}
      </ol>

      <p aria-live="polite">
        {typing.data?.length === 0 ? "No one is typing" : "Someone is typing"}
      </p>
      <form onSubmit={(event) => void send(event)}>
        <label htmlFor="headless-message">Message {title}</label>
        <textarea
          id="headless-message"
          onChange={(event) => setText(event.currentTarget.value)}
          value={text}
        />
        <button disabled={text.trim().length === 0} type="submit">Send</button>
        <span aria-live="polite" role="status">{announcement}</span>
      </form>
    </section>
  );
}

export function FullyHeadlessProviderExample(props: FullyHeadlessChatProps) {
  return (
    <ChatProvider
      config={{
        endpoint: "/api/chat",
        async getAccessToken() {
          const response = await fetch("/api/chat/session", {
            credentials: "same-origin",
          });
          if (!response.ok) throw new Error("Chat session unavailable");
          return response.text();
        },
      }}
    >
      <FullyHeadlessChat {...props} />
    </ChatProvider>
  );
}
