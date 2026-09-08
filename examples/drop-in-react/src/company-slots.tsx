import type {
  ChatAttachmentSlotProps,
  ChatAvatarSlotProps,
  ChatChannelHeaderSlotProps,
  ChatComposerSlotProps,
  ChatEmptyStateSlotProps,
  ChatEntityReferenceSlotProps,
  ChatMessageSlotProps,
  ChatSystemEventSlotProps,
  ChatUserSlotProps,
  ChatWorkspaceHeaderSlotProps,
  ChatWorkspaceSlotOverrides,
} from "@handrail/chat/ui";

const userLabel = (user: ChatAvatarSlotProps["user"]): string =>
  user.kind === "active" ? user.displayName : "Chat user";

export function CompanyWorkspaceHeader({
  identity,
  controls,
  hostProps,
}: ChatWorkspaceHeaderSlotProps) {
  return (
    <div
      {...hostProps}
      className={["company-workspace-header", hostProps.className].filter(Boolean).join(" ")}
      data-example-slot="WorkspaceHeader"
    >
      <h2>{identity?.name ?? "Conversations"}</h2>
      {identity?.description === undefined ? null : <span>{identity.description}</span>}
      <div>
        {controls.menu}
        {controls.settings}
        {controls.messageSearch}
        {controls.createConversation}
      </div>
    </div>
  );
}

export function CompanyAvatar({ user, size, hostProps }: ChatAvatarSlotProps) {
  const label = userLabel(user);
  const initials = user.kind === "active" && user.avatar.kind === "initials"
    ? user.avatar.initials
    : label.slice(0, 2).toLocaleUpperCase();
  return (
    <span
      {...hostProps}
      className={["company-avatar", hostProps.className].filter(Boolean).join(" ")}
      data-example-slot="Avatar"
      data-size={size}
      title={label}
    >
      {initials}
    </span>
  );
}

export function CompanyMessage({ message, hostProps }: ChatMessageSlotProps) {
  return (
    <article
      {...hostProps}
      className={["company-message", hostProps.className].filter(Boolean).join(" ")}
      data-example-slot="Message"
    >
      <p>{message.content?.text ?? "This message was removed."}</p>
      <small>Message #{message.sequence}</small>
    </article>
  );
}

export function CompanyChannelHeader({
  conversation,
  hostProps,
}: ChatChannelHeaderSlotProps) {
  const title = conversation.type === "channel"
    ? conversation.name
    : conversation.type === "thread"
      ? "Thread"
      : "Private conversation";
  return (
    <section
      {...hostProps}
      className={["company-channel-header", hostProps.className].filter(Boolean).join(" ")}
      data-example-slot="ChannelHeader"
    >
      <h2>{title}</h2>
    </section>
  );
}

export function CompanyComposer({ state, controls, hostProps }: ChatComposerSlotProps) {
  return (
    <form
      {...hostProps}
      className={["company-composer", hostProps.className].filter(Boolean).join(" ")}
      data-example-slot="Composer"
      onSubmit={(event) => {
        event.preventDefault();
        if (state.canSubmit) void controls.send();
      }}
    >
      <label>
        <span>{state.inputLabel}</span>
        <textarea
          aria-label={state.inputLabel}
          disabled={state.disabled}
          onBlur={controls.blur}
          onChange={(event) => controls.setText(event.currentTarget.value)}
          placeholder={state.placeholder}
          readOnly={state.readOnly}
          value={state.text}
        />
      </label>
      <button disabled={!state.canSubmit} type="submit">Send</button>
      <span aria-live="polite" role="status">{state.status.message}</span>
    </form>
  );
}

export function CompanyEmptyState({
  title,
  description,
  hostProps,
}: ChatEmptyStateSlotProps) {
  return (
    <section
      {...hostProps}
      className={["company-empty-state", hostProps.className].filter(Boolean).join(" ")}
      data-example-slot="EmptyState"
    >
      <h2>{title}</h2>
      {description === undefined ? null : <p>{description}</p>}
    </section>
  );
}

export function CompanyAttachment({ attachment, hostProps }: ChatAttachmentSlotProps) {
  const { downloadUrl, fileName } = attachment.attachment;
  return (
    <article
      {...hostProps}
      className={["company-attachment", hostProps.className].filter(Boolean).join(" ")}
      data-example-slot="Attachment"
    >
      <strong>File</strong>
      {downloadUrl === undefined
        ? <span>{fileName}</span>
        : <a href={downloadUrl}>{fileName}</a>}
    </article>
  );
}

export function CompanySystemEvent({ event, hostProps }: ChatSystemEventSlotProps) {
  return (
    <span
      {...hostProps}
      className={["company-system-event", hostProps.className].filter(Boolean).join(" ")}
      data-example-slot="SystemEvent"
    >
      <time dateTime={event.occurredAt}>{event.summary}</time>
    </span>
  );
}

export function CompanyUser({ user, hostProps }: ChatUserSlotProps) {
  return (
    <span
      {...hostProps}
      className={["company-user", hostProps.className].filter(Boolean).join(" ")}
      data-example-slot="User"
    >
      {userLabel(user)}
    </span>
  );
}

export function CompanyEntityReference({
  entityReference,
  hostProps,
}: ChatEntityReferenceSlotProps) {
  return (
    <aside
      {...hostProps}
      className={["company-entity", hostProps.className].filter(Boolean).join(" ")}
      data-example-slot="EntityReference"
    >
      <strong>{entityReference.label}</strong>
      <span>{entityReference.description ?? entityReference.entity.id}</span>
    </aside>
  );
}

export const companyComponents = Object.freeze({
  WorkspaceHeader: CompanyWorkspaceHeader,
  Avatar: CompanyAvatar,
  Message: CompanyMessage,
  ChannelHeader: CompanyChannelHeader,
  Composer: CompanyComposer,
  EmptyState: CompanyEmptyState,
  Attachment: CompanyAttachment,
  SystemEvent: CompanySystemEvent,
  User: CompanyUser,
  EntityReference: CompanyEntityReference,
}) satisfies ChatWorkspaceSlotOverrides;
