import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import {
  CHAT_CLIENT_PACKAGE_VERSION,
  createChatClient,
  createNormalizedChatCache,
  selectCurrentUserMessageReminders,
} from "@handrail/chat/client";
import {
  CHAT_PROTOCOL_VERSION,
  encodeMessageReminderSnapshotCursor,
  encodeSavedMessageSnapshotCursor,
  type MessageId,
  type ConversationId,
  type IsoTimestamp,
  type SessionId,
  type TenantId,
  type UserId,
} from "@handrail/chat";
import { ChatProvider } from "@handrail/chat/react";

import { ChatLabPrivateStateHydration } from "../src/ChatLabPrivateStateHydration";

const savedAt = "2026-09-05T12:00:00.000Z";
const dueAt = "2099-09-05T13:00:00.000Z";
const messageIds = ["message-one", "message-two"] as MessageId[];
const requests: Array<{ actor: string; path: string; method: string }> = [];
const clients: ReturnType<typeof createChatClient>[] = [];

function session(actor: string, delay?: Promise<void>, failSavedPage = false, cancelled = false) {
  const cache = createNormalizedChatCache({
    tenantId: "chat-lab" as TenantId,
    userId: actor as UserId,
    sessionId: `session-${actor}` as SessionId,
  });
  const client = createChatClient({
    endpoint: "/api/chat",
    cache,
    getAccessToken: () => actor,
    async fetch(url, init) {
      const requested = new URL(url, "https://chat-lab.test");
      const path = requested.pathname;
      requests.push({ actor, path, method: init?.method ?? "GET" });
      if (path.endsWith("/_meta")) {
        return new Response(JSON.stringify({
          packageVersion: CHAT_CLIENT_PACKAGE_VERSION,
          protocolVersion: CHAT_PROTOCOL_VERSION,
          schemaVersion: 1,
          enabledFeatures: {},
          supportedProtocolRange: {
            minimumVersion: CHAT_PROTOCOL_VERSION,
            maximumVersion: CHAT_PROTOCOL_VERSION,
          },
        }));
      }
      expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${actor}`);
      await delay;
      if (init?.method === "PUT") {
        const command = JSON.parse(String(init.body));
        expect(command.expectedReminderRevision).toBe(4);
        return new Response(JSON.stringify({
          ...command,
          dueAt: undefined,
          reconciliationStatus: "applied",
          reminderRevision: 5,
          reminder: { privacy: "affected_authenticated_actor", state: "scheduled", dueAt: command.dueAt },
        }));
      }
      const isSaved = path.endsWith("/saved-messages");
      if (!isSaved) expect(requested.searchParams.get("includeCancelled")).toBe("true");
      expect(isSaved || path.endsWith("/message-reminders")).toBe(true);
      const secondPage = requested.searchParams.has("cursor");
      if (failSavedPage && isSaved && secondPage) return new Response("{}", { status: 403 });
      const messageId = messageIds[secondPage ? 1 : 0] as MessageId;
      const items = actor === "ada" ? [isSaved ? {
        messageId,
        savedMessageRevision: 1,
        savedAt: secondPage ? "2026-09-05T11:00:00.000Z" : savedAt,
        updatedAt: savedAt,
        message: {
          availability: "available",
          current: {
            id: messageId,
            conversationId: "direct-conversation",
            author: { type: "user", userId: "grace" },
            sequence: secondPage ? 2 : 1,
            createdAt: savedAt,
            updatedAt: savedAt,
            revision: { revision: 1 },
            content: { format: "plain", text: messageId },
            attachmentMetadata: [],
          },
        },
      } : {
        conversationId: "direct-conversation",
        messageId,
        reminderRevision: cancelled && secondPage ? 4 : 1,
        ...(cancelled && secondPage ? {
          lastScheduledDueAt: dueAt,
          reminder: { privacy: "affected_authenticated_actor", state: "cancelled" },
        } : { reminder: { privacy: "affected_authenticated_actor", state: "scheduled", dueAt } }),
      }] : [];
      return new Response(JSON.stringify({
        kind: isSaved ? "saved_message_list" : "message_reminder_list",
        privacy: "actor_private",
        items,
        page: {
          nextCursor: actor !== "ada" || secondPage ? null : isSaved
            ? encodeSavedMessageSnapshotCursor({ savedAt, messageId })
            : encodeMessageReminderSnapshotCursor({ dueAt, messageId }),
        },
      }));
    },
  });
  clients.push(client);
  return client;
}

function mount(client: ReturnType<typeof createChatClient>) {
  void client.start();
  return render(<ChatProvider client={client}><ChatLabPrivateStateHydration /></ChatProvider>);
}

async function expectRestored(client: ReturnType<typeof createChatClient>) {
  await waitFor(() => {
    const state = client.cache.getState().currentUser;
    for (const messageId of messageIds) {
      expect(state.savedMessages[messageId]?.isSaved).toBe(true);
      expect(state.messageReminders[messageId]?.state).toBe("scheduled");
      expect(state.savedMessageRevisions[messageId]).toBe(1);
      expect(state.messageReminderRevisions[messageId]).toBe(1);
    }
  });
}

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.close();
  requests.length = 0;
});

it("restores both messages across fresh sessions using only paginated authenticated reads", async () => {
  for (let reload = 0; reload < 2; reload += 1) {
    const ada = session("ada");
    const view = mount(ada);
    await expectRestored(ada);
    expect(Object.keys(ada.cache.getState().currentUser.messageReminders)).toHaveLength(2);
    view.unmount();
    ada.close();
  }
  const grace = session("grace");
  mount(grace);
  await waitFor(() => expect(requests.filter(({ actor, path }) => actor === "grace" && !path.endsWith("/_meta"))).toHaveLength(2));
  expect(grace.cache.getState().currentUser.savedMessages).toEqual({});
  expect(grace.cache.getState().currentUser.messageReminders).toEqual({});
  expect(requests.every(({ method }) => method === "GET")).toBe(true);
  expect(requests.filter(({ actor, path }) => actor === "ada" && !path.endsWith("/_meta"))).toHaveLength(8);
});

it("cancels old actor reads when unmounted without hydrating either session", async () => {
  let release!: () => void;
  const delay = new Promise<void>((resolve) => { release = resolve; });
  const ada = session("ada", delay);
  const view = mount(ada);
  await waitFor(() => expect(requests.filter(({ actor, path }) => actor === "ada" && !path.endsWith("/_meta"))).toHaveLength(2));
  view.unmount();
  const grace = session("grace");
  mount(grace);
  release();
  await waitFor(() => expect(requests.filter(({ actor, path }) => actor === "grace" && !path.endsWith("/_meta"))).toHaveLength(2));
  for (const client of [ada, grace]) {
    expect(client.cache.getState().currentUser.savedMessages).toEqual({});
    expect(client.cache.getState().currentUser.messageReminders).toEqual({});
  }
});

it("stops a failed list without preventing the other list from restoring", async () => {
  const ada = session("ada", undefined, true);
  mount(ada);
  await waitFor(() => expect(Object.keys(ada.cache.getState().currentUser.messageReminders)).toHaveLength(2));
  expect(Object.keys(ada.cache.getState().currentUser.savedMessages)).toEqual(["message-one"]);
  expect(requests.filter(({ path }) => path.endsWith("/saved-messages"))).toHaveLength(2);
});

it("hydrates cancelled revisions on reload and schedules on the first command", async () => {
  const ada = session("ada", undefined, false, true);
  mount(ada);
  await waitFor(() => expect(ada.cache.getState().currentUser.messageReminderRevisions["message-two" as MessageId]).toBe(4));
  expect(selectCurrentUserMessageReminders(ada.cache.getState()).map(({ messageId }) => messageId)).toEqual(["message-one"]);
  expect(ada.cache.getState().currentUser.messageReminders["message-one" as MessageId]?.state).toBe("scheduled");
  expect(ada.cache.getState().currentUser.savedMessages["message-two" as MessageId]?.isSaved).toBe(true);
  expect(requests.every(({ method }) => method === "GET")).toBe(true);
  const result = await ada.setMessageReminder({
    conversationId: "direct-conversation" as ConversationId,
    messageId: "message-two" as MessageId,
    dueAt: dueAt as IsoTimestamp,
  });
  expect(result.status).toBe("success");
  expect(requests.filter(({ method }) => method === "PUT")).toHaveLength(1);
  expect(ada.cache.getState().currentUser.messageReminderRevisions["message-two" as MessageId]).toBe(5);
});
