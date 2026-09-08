import { useMemo, useState, type ChangeEvent, type FormEvent } from "react";
import {
  useAttachmentUpload,
  useChat,
  useChatActions,
  useConversation,
  useDraft,
  useHuddle,
  useMessages,
  usePresence,
  useReadState,
} from "@handrail/chat/react";

// The goal's prose names are kept local while the example consumes the shipped API.
const useChannel = useConversation;
const useUnreadState = useReadState;

type ConversationId = Parameters<typeof useConversation>[0];

export interface HeadlessChatScreenProps {
  readonly conversationId: ConversationId;
}

const EMPTY_UPLOAD_ID = "no-active-upload";
const SUPPORTED_ATTACHMENT_CONTENT_TYPES = [
  "application/pdf",
  "audio/mpeg",
  "audio/ogg",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/plain",
  "video/mp4",
  "video/webm",
] as const;
type SupportedAttachmentContentType =
  (typeof SUPPORTED_ATTACHMENT_CONTENT_TYPES)[number];

const attachmentContentType = (value: string): SupportedAttachmentContentType =>
  SUPPORTED_ATTACHMENT_CONTENT_TYPES.includes(value as SupportedAttachmentContentType)
    ? value as SupportedAttachmentContentType
    : "text/plain";

export function HeadlessChatScreen({ conversationId }: HeadlessChatScreenProps) {
  const chat = useChat();
  const channel = useChannel(conversationId);
  const messages = useMessages(conversationId);
  const unread = useUnreadState(conversationId);
  const presence = usePresence();
  const draft = useDraft(conversationId);
  const actions = useChatActions(conversationId);
  const { setReaction: toggleReaction } = actions;

  const huddlesEnabled =
    chat?.state.state === "ready" &&
    chat.state.enabledFeatures.huddles === true;
  const huddle = useHuddle(conversationId, { enabled: huddlesEnabled });

  const [composerText, setComposerText] = useState("");
  const [activeUploadId, setActiveUploadId] = useState<string>();
  const [activity, setActivity] = useState("Ready");
  const attachment = useAttachmentUpload(activeUploadId ?? EMPTY_UPLOAD_ID);

  const timeline = messages.data?.messages ?? [];
  const latestSequence = useMemo(
    () => timeline.reduce((latest, message) => Math.max(latest, message.sequence), 0),
    [timeline],
  );
  const title = channel.data?.type === "channel"
    ? channel.data.name
    : channel.data === undefined
      ? "Loading conversation…"
      : "Private conversation";
  const onlineCount = presence.data?.filter((item) => item.state === "online").length ?? 0;
  const draftStatus = draft.data?.status ?? draft.status;
  const uploadStatus = attachment.data?.status ?? "not started";
  const huddleStatus = huddle.data?.canonicalState?.status ?? huddle.data?.hydrationStatus;

  const replaceDraft = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const text = event.currentTarget.value;
    setComposerText(text);
    actions.replaceConversationDraft({
      content: { format: "plain", text, attachments: [] },
    });
  };

  const send = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = composerText.trim();
    if (text.length === 0) return;
    setActivity("Sending…");
    const result = await actions.sendMessage({
      content: { format: "plain", text },
    });
    if (result.status === "success") {
      actions.clearConversationDraft();
      setComposerText("");
      setActivity("Message sent");
    } else {
      setActivity("Message needs attention");
    }
  };

  const upload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    if (file === undefined) return;
    const handle = actions.uploadAttachment({
      metadata: {
        fileName: file.name,
        contentType: attachmentContentType(file.type),
        sizeBytes: file.size,
      },
      source: file,
    });
    setActiveUploadId(handle.uploadId);
    setActivity(`Uploading ${file.name}`);
    void handle.completion.then((result) => setActivity(`Upload ${result.status}`));
  };

  return (
    <main className="chat-shell">
      <header className="company-header">
        <div>
          <span className="eyebrow">Northwind operations</span>
          <h1>{title}</h1>
          <p>{onlineCount} teammates online · {unread.data?.unreadCount ?? 0} unread</p>
        </div>
        <div className="header-actions">
          <button
            type="button"
            disabled={!huddlesEnabled}
            title={huddlesEnabled ? "Start a huddle" : "Huddles were not negotiated"}
            onClick={() => void actions.startHuddle()}
          >
            Start huddle
          </button>
          <button
            type="button"
            disabled={latestSequence === 0}
            onClick={() => void actions.markRead({ throughSequence: latestSequence })}
          >
            Mark read
          </button>
        </div>
      </header>

      <section className="status-strip" aria-label="Headless SDK state">
        <span>Draft: {draftStatus}</span>
        <span>Attachment: {uploadStatus}</span>
        <span>Huddle: {huddlesEnabled ? (huddleStatus ?? "loading") : "unavailable"}</span>
      </section>

      <section className="timeline" aria-label="Message timeline">
        {timeline.length === 0 ? <p className="empty-state">No messages yet.</p> : null}
        {timeline.map((message) => {
          const liked = message.reactions.some(
            (reaction) => reaction.reactionKey === "👍" && reaction.reactedByCurrentUser,
          );
          return (
            <article className="message" key={message.id}>
              <div className="avatar" aria-hidden="true">
                {message.author.userId.slice(0, 2).toUpperCase()}
              </div>
              <div className="message-body">
                <strong>{message.author.userId}</strong>
                <p>{message.content?.text ?? "Message deleted"}</p>
                <div className="message-actions">
                  <button
                    type="button"
                    aria-label={`React to message ${message.id}`}
                    onClick={() => void toggleReaction({
                      messageId: message.id,
                      reactionKey: "👍",
                      reacted: !liked,
                    })}
                  >
                    👍 {message.reactions.find((reaction) => reaction.reactionKey === "👍")?.count ?? 0}
                  </button>
                  <button
                    type="button"
                    aria-label={`Open thread for message ${message.id}`}
                    onClick={() => void actions.openThread(message.id)}
                  >
                    Open thread
                  </button>
                </div>
              </div>
            </article>
          );
        })}
      </section>

      <form className="composer" onSubmit={(event) => void send(event)}>
        <label htmlFor="message">Message {title}</label>
        <textarea
          id="message"
          value={composerText}
          placeholder="Write an update…"
          onChange={replaceDraft}
        />
        <div className="composer-actions">
          <label className="attachment-picker">
            Attach file
            <input type="file" onChange={upload} />
          </label>
          <span role="status">{activity}</span>
          <button type="submit" disabled={composerText.trim().length === 0}>Send</button>
        </div>
      </form>
    </main>
  );
}
