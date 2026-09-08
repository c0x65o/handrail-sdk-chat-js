import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { ChatLabApp } from "../src/ChatLabApp";
// The executable Chat Lab harness intentionally remains plain Node ESM.
// @ts-expect-error No declaration file is emitted for this example-only script.
import { resolveChatLabActor, startChatLabBackend } from "../scripts/chat-lab-backend.mjs";
// @ts-expect-error No declaration file is emitted for this example-only script.
import { installChatLabBrowserSocket } from "../scripts/chat-lab-browser-socket-harness.mjs";

interface MembershipExchange {
  readonly request: Readonly<Record<string, unknown>>;
  readonly response: Readonly<Record<string, unknown>>;
}

interface RetrievedConversationDetail {
  readonly conversation: {
    readonly id: string;
    readonly memberUserIds: readonly string[];
    readonly currentMember: {
      readonly role: "owner" | "moderator" | "member";
      readonly state: "active" | "left" | "removed";
    };
  };
}

const nativeFetch = globalThis.fetch;
let lab: Awaited<ReturnType<typeof startChatLabBackend>>;
let restoreBrowserSocket: (() => void) | undefined;
const membershipExchanges: MembershipExchange[] = [];
const incomingFrames: unknown[] = [];

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireSuccess = <Value,>(
  operation: string,
  result: { readonly status: string; readonly value?: Value },
): Value => {
  expect(result.status, operation).toBe("success");
  expect(result.value, operation).toBeDefined();
  return result.value as Value;
};

const enterText = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
    input,
    value,
  );
  input.dispatchEvent(new InputEvent("input", { bubbles: true }));
};

beforeAll(async () => {
  lab = await startChatLabBackend();
  globalThis.fetch = async (input, init) => {
    if (typeof input !== "string" && !(input instanceof URL)) {
      return nativeFetch(input, init);
    }
    const requested = new URL(input, "http://chat-lab.test");
    if (requested.pathname === "/__chat-lab/session") {
      const actor = resolveChatLabActor(requested.searchParams.get("actor") ?? "");
      return new Response(actor?.credential ?? "Unknown chat lab actor", {
        status: actor === undefined ? 404 : 200,
      });
    }
    const response = await nativeFetch(
      new URL(
        `${requested.pathname.replace(/^\/api\/chat/u, "")}${requested.search}`,
        lab.harness.endpoint,
      ),
      init,
    );
    if (requested.pathname.endsWith("/membership") && init?.method === "PATCH") {
      const request: unknown = typeof init.body === "string"
        ? JSON.parse(init.body) as unknown
        : undefined;
      const responseBody: unknown = await response.clone().json();
      if (isRecord(request) && isRecord(responseBody)) {
        membershipExchanges.push({ request, response: responseBody });
      }
    }
    return response;
  };
  restoreBrowserSocket = installChatLabBrowserSocket({
    endpoint: lab.harness.webSocketEndpoint,
    onIncomingFrame: (frame: unknown) => incomingFrames.push(frame),
  });
}, 120_000);

afterEach(() => {
  cleanup();
  localStorage.clear();
  membershipExchanges.length = 0;
  incomingFrames.length = 0;
});

afterAll(async () => {
  globalThis.fetch = nativeFetch;
  restoreBrowserSocket?.();
  await lab.harness.teardown();
}, 120_000);

describe("ChatLabApp member management", () => {
  it("adds and promotes Margaret with canonical revisions, then exposes the persisted channel only without controls", async () => {
    render(<ChatLabApp />);

    await screen.findByText("Managed realtime connected", {}, { timeout: 10_000 });
    expect(incomingFrames.some((frame) =>
      isRecord(frame) && frame["type"] === "chat.session.accepted"
    )).toBe(true);
    let navigation = await screen.findByRole("navigation", { name: "Conversations" });
    fireEvent.click(within(navigation).getByRole("button", { name: "Chat Lab Private" }));

    const membersTrigger = await screen.findByRole(
      "button",
      { name: /Open conversation members \(2 members\)/u },
      { timeout: 10_000 },
    );
    expect(membersTrigger.getAttribute("title")).toBe(
      "Open conversation members (2 members)",
    );
    expect(membersTrigger.textContent).toBe("2");
    expect(membersTrigger.querySelector(
      "svg.handrail-chat__member-management-icon",
    )).not.toBeNull();
    fireEvent.click(membersTrigger);
    expect(membersTrigger.getAttribute("aria-expanded")).toBe("true");
    const panel = await screen.findByRole(
      "dialog",
      { name: "Conversation members" },
      { timeout: 10_000 },
    );
    await within(panel).findByText("Ada Lovelace", {}, { timeout: 10_000 });
    await within(panel).findByText("Grace Hopper", {}, { timeout: 10_000 });

    const search = within(panel).getByRole<HTMLInputElement>("searchbox", {
      name: "Add a member",
    });
    enterText(search, "Margaret");
    const margaret = await within(panel).findByRole(
      "radio",
      { name: "Margaret Hamilton" },
      { timeout: 10_000 },
    );
    fireEvent.click(margaret);
    fireEvent.click(within(panel).getByRole("button", { name: "Add member" }));

    await within(panel).findByText(
      "Margaret Hamilton was added to the conversation.",
      {},
      { timeout: 10_000 },
    );
    expect(membersTrigger.getAttribute("aria-label")).toBe(
      "Open conversation members (3 members)",
    );
    expect(membersTrigger.getAttribute("title")).toBe(
      "Open conversation members (3 members)",
    );
    expect(membersTrigger.textContent).toBe("3");
    expect(membershipExchanges[0]?.request).toMatchObject({
      operation: "mutate_conversation_membership",
      intent: "add_member",
      conversationId: lab.conversationIds.privateChannel,
      expectedMemberListRevision: 2,
      targetUserId: "margaret",
      requestedRole: "member",
    });
    expect(membershipExchanges[0]?.response).toMatchObject({
      reconciliationStatus: "applied",
      memberListRevision: 3,
    });
    const role = await within(panel).findByRole<HTMLSelectElement>(
      "combobox",
      { name: "Role for Margaret Hamilton" },
      { timeout: 10_000 },
    );
    expect(within(role).getByRole<HTMLOptionElement>("option", {
      name: "Moderator",
    }).disabled).toBe(false);
    fireEvent.change(role, { target: { value: "moderator" } });
    await within(panel).findByText(
      "Margaret Hamilton is now a Moderator.",
      {},
      { timeout: 10_000 },
    );
    expect(membershipExchanges[1]?.request).toMatchObject({
      operation: "mutate_conversation_membership",
      intent: "change_member_role",
      conversationId: lab.conversationIds.privateChannel,
      expectedMemberListRevision: 3,
      targetUserId: "margaret",
      requestedRole: "moderator",
    });
    expect(membershipExchanges[1]?.response).toMatchObject({
      reconciliationStatus: "applied",
      memberListRevision: 4,
    });
    fireEvent.click(screen.getByRole("button", { name: /Grace Hopper Engineering/u }));
    await screen.findByText(
      "Viewing the real persisted conversation as Grace Hopper",
      {},
      { timeout: 10_000 },
    );
    await screen.findByText("Managed realtime connected", {}, { timeout: 10_000 });
    expect(screen.queryByRole("button", { name: /Open conversation members/u })).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Conversation members" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add member" })).toBeNull();

    fireEvent.click(screen.getByRole("button", {
      name: /Margaret Hamilton Flight software/u,
    }));
    await screen.findByText(
      "Viewing the real persisted conversation as Margaret Hamilton",
      {},
      { timeout: 10_000 },
    );
    await screen.findByText("Managed realtime connected", {}, { timeout: 10_000 });
    navigation = await screen.findByRole("navigation", { name: "Conversations" });
    fireEvent.click(await within(navigation).findByRole(
      "button",
      { name: "Chat Lab Private" },
      { timeout: 10_000 },
    ));
    await screen.findByText(lab.privateSearchText, {}, { timeout: 10_000 });
    expect(screen.queryByRole("button", { name: /Open conversation members/u })).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Conversation members" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add member" })).toBeNull();
    expect(membershipExchanges).toHaveLength(2);

    const verifier = lab.harness.createClient("chat-lab-margaret");
    expect((await verifier.start()).state).toBe("ready");
    const persisted = requireSuccess<RetrievedConversationDetail>(
      "Margaret persisted private-channel detail",
      await verifier.getConversation({
        conversationId: lab.conversationIds.privateChannel,
      }),
    );
    expect(persisted.conversation.memberUserIds).toEqual(["ada", "grace", "margaret"]);
    expect(persisted.conversation.currentMember).toMatchObject({
      role: "moderator",
      state: "active",
    });
    verifier.close();
  }, 45_000);
});
