import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  CHAT_CLIENT_PACKAGE_VERSION,
  createNormalizedChatCache,
  type ChatClient,
} from "@handrail/chat/client";
import { ChatProvider } from "@handrail/chat/react";

import { HeadlessChatScreen, type HeadlessChatScreenProps } from "../src/HeadlessChatScreen";

type ConversationId = HeadlessChatScreenProps["conversationId"];
type Identity = NonNullable<Parameters<typeof createNormalizedChatCache>[0]>;

const conversationId = "channel-operations" as ConversationId;
const messageId = "message-101" as Parameters<ChatClient["openThread"]>[0];
const tenantId = "tenant-example" as Identity["tenantId"];
const userId = "user-current" as Identity["userId"];
const now = "2030-01-01T12:00:00.000Z";

function createFixture() {
  const cache = createNormalizedChatCache({
    tenantId,
    userId,
    sessionId: "session-example" as Identity["sessionId"],
  });
  const metadata = {
    packageVersion: CHAT_CLIENT_PACKAGE_VERSION,
    protocolVersion: 4,
    schemaVersion: 1,
    enabledFeatures: { huddles: true },
    supportedProtocolRange: { minimumVersion: 4, maximumVersion: 4 },
    feature: { name: "conversation_snapshots", version: 1 },
  } as const;
  cache.hydrateConversationDetail({
    kind: "conversation_detail",
    conversation: {
      id: conversationId,
      tenantId,
      type: "channel",
      name: "Operations",
      visibility: "public",
      createdAt: now,
      updatedAt: now,
      latestSequence: 101,
      activityAt: now,
      currentMember: {
        tenantId,
        conversationId,
        userId,
        role: "member",
        state: "active",
        joinedAt: now,
        updatedAt: now,
      },
      currentReadState: {
        conversationId,
        userId,
        lastReadSequence: 100,
        updatedAt: now,
      },
      memberUserIds: [userId],
      currentPreference: {
        conversationId,
        userId,
        notificationPreference: "all",
        mute: { muted: false },
        updatedAt: now,
      },
    },
    _meta: metadata,
  });
  cache.hydrateMessageTimeline({
    conversationId,
    messages: [{
      id: messageId,
      tenantId,
      conversationId,
      author: { type: "user", userId },
      sequence: 101,
      createdAt: now,
      updatedAt: now,
      revision: { revision: 1 },
      content: { format: "plain", text: "The custom timeline is ready." },
      isThreadRoot: false,
      reactions: [],
      attachmentMetadata: [],
    }],
    pagination: {
      older: { available: false },
      newer: { available: false },
    },
    replay: { resumeFrom: { eventId: "event-12" } },
  });

  const calls = {
    sendMessage: vi.fn(async () => ({ status: "success", value: {} })),
    setReaction: vi.fn(async () => ({ status: "success", value: {} })),
    markRead: vi.fn(async () => ({ status: "success", value: {} })),
    openThread: vi.fn(async () => ({ state: "loading", rootMessageId: messageId, parentConversationId: conversationId })),
  };
  const draftState = {
    conversationId,
    status: "ready",
    authoritativeRevision: 1,
    dirty: false,
    draft: {
      kind: "replaced",
      content: { format: "plain", text: "", attachments: [] },
    },
  } as const;
  const huddleState = {
    conversationId,
    hydrationStatus: "ready",
    media: { state: "idle" },
  } as const;
  const client = {
    endpoint: "/api/chat",
    state: {
      state: "ready",
      clientPackageVersion: CHAT_CLIENT_PACKAGE_VERSION,
      protocolVersion: 4,
      metadata,
      enabledFeatures: { huddles: true },
    },
    realtime: undefined,
    coordination: undefined,
    cache,
    subscribeLifecycle: () => () => undefined,
    ...calls,
    selectConversationDraft: () => draftState,
    subscribeConversationDraft: () => () => undefined,
    replaceConversationDraft: () => draftState,
    clearConversationDraft: () => draftState,
    getHuddleState: () => huddleState,
    subscribeHuddle: () => () => undefined,
  } as unknown as ChatClient<"huddles">;
  return { client, calls };
}

describe("fully headless custom screen", () => {
  it("routes send, reaction, mark-read, and thread actions through ChatProvider", async () => {
    const { client, calls } = createFixture();
    render(
      <ChatProvider client={client}>
        <HeadlessChatScreen conversationId={conversationId} />
      </ChatProvider>,
    );

    expect(screen.getByRole("heading", { name: "Operations" })).toBeTruthy();
    expect(screen.getByText("The custom timeline is ready.")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Message Operations"), {
      target: { value: "Ship the headless example" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.click(screen.getByRole("button", { name: `React to message ${messageId}` }));
    fireEvent.click(screen.getByRole("button", { name: "Mark read" }));
    fireEvent.click(screen.getByRole("button", { name: `Open thread for message ${messageId}` }));

    await waitFor(() => expect(calls.sendMessage).toHaveBeenCalledOnce());
    expect(calls.sendMessage).toHaveBeenCalledWith({
      conversationId,
      content: { format: "plain", text: "Ship the headless example" },
    });
    expect(calls.setReaction).toHaveBeenCalledWith({
      messageId,
      reactionKey: "👍",
      reacted: true,
    });
    expect(calls.markRead).toHaveBeenCalledWith({
      conversationId,
      throughSequence: 101,
    });
    expect(calls.openThread).toHaveBeenCalledWith(messageId);
  });
});
