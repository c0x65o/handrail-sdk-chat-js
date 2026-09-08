import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { ChatLabApp } from "../src/ChatLabApp";
// The executable Chat Lab harness intentionally remains plain Node ESM.
// @ts-expect-error No declaration file is emitted for this example-only script.
import { resolveChatLabActor, startChatLabBackend } from "../scripts/chat-lab-backend.mjs";
// @ts-expect-error No declaration file is emitted for this example-only script.
import { installChatLabBrowserSocket } from "../scripts/chat-lab-browser-socket-harness.mjs";

interface ConversationPreferenceDetail {
  readonly conversation: {
    readonly currentPreference: {
      readonly notificationPreference: "all" | "mentions" | "none";
      readonly mute:
        | { readonly muted: false }
        | { readonly muted: true; readonly mutedUntil?: string };
    };
  };
}

const nativeFetch = globalThis.fetch;
let lab: Awaited<ReturnType<typeof startChatLabBackend>>;
let restoreBrowserSocket: (() => void) | undefined;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const quoteIdentifier = (identifier: string) =>
  `"${identifier.replaceAll('"', '""')}"`;

const requireSuccess = <Value,>(
  operation: string,
  result: { readonly status: string; readonly value?: Value },
): Value => {
  expect(result.status, operation).toBe("success");
  expect(result.value, operation).toBeDefined();
  return result.value as Value;
};

const selectActor = async (name: RegExp) => {
  fireEvent.click(screen.getByRole("button", { name }));
  await screen.findByText("Managed realtime connected", {}, { timeout: 10_000 });
};

const selectGroupConversation = async () => {
  const navigation = await screen.findByRole("navigation", { name: "Conversations" });
  fireEvent.click(await within(navigation).findByRole(
    "button",
    { name: "Group conversation" },
    { timeout: 10_000 },
  ));
  const trigger = await screen.findByRole(
    "button",
    { name: /^Notification preferences:/u },
    { timeout: 10_000 },
  );
  expect(trigger.getAttribute("title")).toBe(trigger.getAttribute("aria-label"));
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
};

const expectGroupNavigationPreference = async (
  notificationPreference: "all" | "mentions" | "none",
  muteState: "unmuted" | "indefinite",
) => {
  const labels = {
    all: "All messages",
    mentions: "Mentions only",
    none: "No notifications",
  } as const;
  const muteLabel = muteState === "unmuted" ? "Unmuted" : "Muted indefinitely";
  const navigation = await screen.findByRole("navigation", { name: "Conversations" });
  await waitFor(() => {
    const row = navigation.querySelector(
      `[data-conversation-id="${lab.conversationIds.groupDirect}"]`,
    );
    expect(row).not.toBeNull();
    expect(row?.getAttribute("data-notification-level"))
      .toBe(notificationPreference);
    expect(row?.getAttribute("data-mute-state")).toBe(muteState);
    expect(row?.getAttribute("aria-label"))
      .toContain(`Notifications: ${labels[notificationPreference]}; ${muteLabel}`);
    const indicator = row?.querySelector(
      ".handrail-chat__conversation-notification-indicator",
    );
    expect(indicator?.getAttribute("aria-hidden")).toBe("true");
    expect(indicator?.getAttribute("title"))
      .toBe(`${labels[notificationPreference]}; ${muteLabel}`);
  }, { timeout: 10_000 });
};

const openPreferences = async () => {
  const trigger = screen.getByRole("button", { name: /^Notification preferences:/u });
  fireEvent.click(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  return screen.findByRole("dialog", { name: "Notification preferences" });
};

const savePreference = async (
  panel: HTMLElement,
  notificationPreference: "all" | "mentions" | "none",
  mute: "unmuted" | "indefinite",
) => {
  const labels = {
    all: "All messages",
    mentions: "Mentions only",
    none: "No notifications",
  } as const;
  const muteLabel = mute === "unmuted" ? "Unmuted" : "Muted indefinitely";
  const summary = `${labels[notificationPreference]}; ${muteLabel}`;
  const expected = `Notification preferences saved: ${summary}.`;
  const triggerName = `Notification preferences: ${summary}`;
  const authorAndSubmit = () => {
    fireEvent.change(within(panel).getByRole("combobox", { name: "Notify me about" }), {
      target: { value: notificationPreference },
    });
    fireEvent.click(within(panel).getByRole("radio", {
      name: mute === "unmuted" ? "Unmuted" : "Muted indefinitely",
    }));
    fireEvent.click(within(panel).getByRole("button", { name: "Save preferences" }));
  };

  authorAndSubmit();
  await waitFor(() => {
    expect(
      within(panel).queryByText(expected) ??
        within(panel).queryByText(/Preferences changed elsewhere/u),
    ).not.toBeNull();
  }, { timeout: 10_000 });
  if (within(panel).queryByText(/Preferences changed elsewhere/u) !== null) {
    authorAndSubmit();
  }
  await within(panel).findByText(expected, {}, { timeout: 10_000 });
  await waitFor(() => {
    const trigger = screen.getByRole("button", { name: triggerName });
    expect(trigger.getAttribute("title")).toBe(triggerName);
    expect(trigger.getAttribute("data-notification-level"))
      .toBe(notificationPreference);
    expect(trigger.getAttribute("data-mute-state")).toBe(mute);
  }, { timeout: 10_000 });
  await expectGroupNavigationPreference(notificationPreference, mute);
};

const readPreference = async (
  credential: string,
): Promise<ConversationPreferenceDetail["conversation"]["currentPreference"]> => {
  const verifier = lab.harness.createClient(credential);
  expect((await verifier.start()).state).toBe("ready");
  const detail = requireSuccess<ConversationPreferenceDetail>(
    `${credential} preference detail`,
    await verifier.getConversation({
      conversationId: lab.conversationIds.groupDirect,
    }),
  );
  verifier.close();
  return detail.conversation.currentPreference;
};

const flushThroughMessage = async (messageId: string) => {
  const dispatcher = lab.harness.runtime.notificationDispatcher;
  expect(dispatcher).toBeDefined();
  const schema = quoteIdentifier(lab.harness.schema);
  const event = await lab.harness.pool.query(
    `SELECT replay_position
     FROM ${schema}.chat_outbox_events
     WHERE payload #>> '{message,id}' = $1`,
    [messageId],
  );
  expect(event.rows).toHaveLength(1);
  const replayPosition = BigInt(event.rows[0].replay_position);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    await dispatcher!.runOnce();
    const offset = await lab.harness.pool.query(
      `SELECT last_replay_position
       FROM ${schema}.chat_notification_materializer_offsets
       WHERE materializer_name = 'message-created-notifications:v1'`,
    );
    if (
      offset.rows.length === 1 &&
      BigInt(offset.rows[0].last_replay_position) >= replayPosition
    ) return;
  }
  throw new Error(`Notification materialization did not reach message ${messageId}`);
};

const notificationRecipients = (messageId: string): string[] =>
  lab.harness.calls
    .all("notifications.send")
    .map(({ input }: { readonly input: unknown }) => input)
    .filter((input: unknown) => isRecord(input) && input["messageId"] === messageId)
    .map((input: unknown) => (input as Readonly<Record<string, unknown>>)["recipientUserId"])
    .filter((userId: unknown): userId is string => typeof userId === "string")
    .sort();

const sendControlledMessage = async (
  credential: string,
  operation: string,
  content: Readonly<Record<string, unknown>>,
): Promise<string> => {
  const sender = lab.harness.createClient(credential);
  try {
    expect((await sender.start()).state).toBe("ready");
    return requireSuccess<{ readonly message: { readonly id: string } }>(
      operation,
      await sender.sendMessage({
        conversationId: lab.conversationIds.groupDirect,
        content,
      }),
    ).message.id;
  } finally {
    sender.close();
  }
};

beforeAll(async () => {
  lab = await startChatLabBackend();
  globalThis.fetch = (input, init) => {
    if (typeof input !== "string" && !(input instanceof URL)) {
      return nativeFetch(input, init);
    }
    const requested = new URL(input, "http://chat-lab.test");
    if (requested.pathname === "/__chat-lab/session") {
      const actor = resolveChatLabActor(requested.searchParams.get("actor") ?? "");
      return Promise.resolve(new Response(actor?.credential ?? "Unknown chat lab actor", {
        status: actor === undefined ? 404 : 200,
      }));
    }
    return nativeFetch(
      new URL(
        `${requested.pathname.replace(/^\/api\/chat/u, "")}${requested.search}`,
        lab.harness.endpoint,
      ),
      init,
    );
  };
  restoreBrowserSocket = installChatLabBrowserSocket({
    endpoint: lab.harness.webSocketEndpoint,
  });
}, 120_000);

afterEach(() => {
  cleanup();
  localStorage.clear();
  lab.harness.calls.reset();
});

afterAll(async () => {
  globalThis.fetch = nativeFetch;
  restoreBrowserSocket?.();
  if (lab !== undefined) await lab.harness.teardown();
}, 120_000);

describe("ChatLabApp notification preferences", () => {
  it("persists actor-private levels and sends only eligible in-process notifications", async () => {
    const view = render(<ChatLabApp />);

    await screen.findByText("Managed realtime connected", {}, { timeout: 10_000 });
    await selectGroupConversation();
    let panel = await openPreferences();
    await savePreference(panel, "none", "unmuted");

    await selectActor(/Grace Hopper Engineering/u);
    await selectGroupConversation();
    await expectGroupNavigationPreference("all", "unmuted");
    panel = await openPreferences();
    await savePreference(panel, "mentions", "unmuted");
    await savePreference(panel, "all", "unmuted");

    await selectActor(/Margaret Hamilton Flight software/u);
    await selectGroupConversation();
    await expectGroupNavigationPreference("all", "unmuted");
    panel = await openPreferences();
    await savePreference(panel, "mentions", "unmuted");

    expect(await readPreference("chat-lab-ada")).toMatchObject({
      notificationPreference: "none",
      mute: { muted: false },
    });
    expect(await readPreference("chat-lab-grace")).toMatchObject({
      notificationPreference: "all",
      mute: { muted: false },
    });
    expect(await readPreference("chat-lab-margaret")).toMatchObject({
      notificationPreference: "mentions",
      mute: { muted: false },
    });

    await selectActor(/Ada Lovelace Product/u);
    await selectGroupConversation();
    await expectGroupNavigationPreference("none", "unmuted");
    panel = await openPreferences();
    expect(within(panel).getByText(/Current preference: No notifications; Unmuted/u))
      .toBeTruthy();
    fireEvent.click(within(panel).getByRole("button", { name: "Close" }));

    await selectActor(/Grace Hopper Engineering/u);
    await selectGroupConversation();
    await expectGroupNavigationPreference("all", "unmuted");
    panel = await openPreferences();
    expect(within(panel).getByText(/Current preference: All messages; Unmuted/u))
      .toBeTruthy();
    fireEvent.click(within(panel).getByRole("button", { name: "Close" }));

    await selectActor(/Margaret Hamilton Flight software/u);
    await selectGroupConversation();
    await expectGroupNavigationPreference("mentions", "unmuted");
    panel = await openPreferences();
    expect(within(panel).getByText(/Current preference: Mentions only; Unmuted/u))
      .toBeTruthy();

    view.unmount();
    localStorage.setItem("handrail-chat-lab:actor", "margaret");
    render(<ChatLabApp />);
    await screen.findByText("Managed realtime connected", {}, { timeout: 10_000 });
    await selectGroupConversation();
    await expectGroupNavigationPreference("mentions", "unmuted");
    panel = await openPreferences();
    expect(within(panel).getByText(/Current preference: Mentions only; Unmuted/u))
      .toBeTruthy();

    lab.harness.calls.reset();

    const plainFromAda = await sendControlledMessage(
      "chat-lab-ada",
      "plain Ada message",
      { format: "plain", text: "Notification all-level case." },
    );
    await flushThroughMessage(plainFromAda);
    expect(notificationRecipients(plainFromAda)).toEqual(["grace"]);

    const mentionFromAda = await sendControlledMessage(
      "chat-lab-ada",
      "mentioned Margaret message",
      {
        format: "plain",
        text: "Notification mention-level case.",
        mentions: [{ type: "user", userId: "margaret" }],
      },
    );
    await flushThroughMessage(mentionFromAda);
    expect(notificationRecipients(mentionFromAda)).toEqual([
      "grace",
      "margaret",
    ]);

    const suppressedByLevels = await sendControlledMessage(
      "chat-lab-grace",
      "level-suppressed Grace message",
      { format: "plain", text: "No eligible level recipients." },
    );
    await flushThroughMessage(suppressedByLevels);
    expect(notificationRecipients(suppressedByLevels)).toEqual([]);

    await selectActor(/Ada Lovelace Product/u);
    await selectGroupConversation();
    panel = await openPreferences();
    await savePreference(panel, "all", "indefinite");
    const suppressedByMute = await sendControlledMessage(
      "chat-lab-grace",
      "mute-suppressed Grace message",
      { format: "plain", text: "Muted recipients stay suppressed." },
    );
    await flushThroughMessage(suppressedByMute);
    expect(notificationRecipients(suppressedByMute)).toEqual([]);

    await savePreference(panel, "all", "unmuted");
    const deliveredAfterUnmute = await sendControlledMessage(
      "chat-lab-grace",
      "unmuted Grace message",
      { format: "plain", text: "Unmuted recipients receive delivery." },
    );
    await flushThroughMessage(deliveredAfterUnmute);
    expect(notificationRecipients(deliveredAfterUnmute)).toEqual(["ada"]);

    for (const call of lab.harness.calls.all("notifications.send")) {
      expect(JSON.stringify(call.input)).not.toMatch(
        /Notification all-level case|Notification mention-level case|Muted recipients|Unmuted recipients/u,
      );
    }
  }, 60_000);
});
