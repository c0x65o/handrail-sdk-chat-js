import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { ChatLabApp } from "../src/ChatLabApp";
// The executable Chat Lab harness intentionally remains plain Node ESM.
// @ts-expect-error No declaration file is emitted for this example-only script.
import { resolveChatLabActor, startChatLabBackend } from "../scripts/chat-lab-backend.mjs";
// @ts-expect-error No declaration file is emitted for this example-only script.
import { installChatLabBrowserSocket } from "../scripts/chat-lab-browser-socket-harness.mjs";

interface CapturedCreationResult {
  readonly type: "channel" | "direct" | "group_direct";
  readonly reconciliationStatus: "created" | "existing_equivalent" | "replayed";
  readonly conversation: {
    readonly conversation: { readonly id: string };
  };
}

interface RetrievedConversationDetail {
  readonly conversation: {
    readonly id: string;
    readonly type: "channel" | "direct" | "group_direct" | "thread";
    readonly visibility: "public" | "private";
    readonly name?: string;
    readonly memberUserIds: readonly string[];
  };
}

const nativeFetch = globalThis.fetch;
let lab: Awaited<ReturnType<typeof startChatLabBackend>>;
let restoreBrowserSocket: (() => void) | undefined;
const creationResults: CapturedCreationResult[] = [];

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isCapturedCreationResult = (value: unknown): value is CapturedCreationResult =>
  isRecord(value) &&
  (value["type"] === "channel" ||
    value["type"] === "direct" ||
    value["type"] === "group_direct") &&
  (value["reconciliationStatus"] === "created" ||
    value["reconciliationStatus"] === "existing_equivalent" ||
    value["reconciliationStatus"] === "replayed") &&
  isRecord(value["conversation"]) &&
  isRecord(value["conversation"]["conversation"]) &&
  typeof value["conversation"]["conversation"]["id"] === "string";

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

const selectedConversationId = () =>
  document.querySelector<HTMLElement>(
    ".handrail-chat__conversation[data-conversation-id]",
  )?.dataset["conversationId"];

const activeConversationRows = () =>
  document.querySelectorAll(
    '.handrail-chat__conversation-button[aria-current="page"]',
  );

beforeAll(async () => {
  lab = await startChatLabBackend();

  // The seed intentionally includes the canonical three-person group. Archive
  // it inside this isolated test schema so the UI flow proves a newly created
  // group while preserving the shared fixture for every other Chat Lab run.
  const fixtureActor = lab.harness.createClient("chat-lab-ada");
  expect((await fixtureActor.start()).state).toBe("ready");
  requireSuccess(
    "archive the seeded group direct",
    await fixtureActor.archiveConversation({
      conversationId: lab.conversationIds.groupDirect,
      expectedLifecycleRevision: 1,
    }),
  );
  fixtureActor.close();

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
    if (
      requested.pathname === "/api/chat/conversations" &&
      init?.method === "POST" &&
      response.ok
    ) {
      const body: unknown = await response.clone().json();
      if (isCapturedCreationResult(body)) creationResults.push(body);
    }
    return response;
  };
  restoreBrowserSocket = installChatLabBrowserSocket({
    endpoint: lab.harness.webSocketEndpoint,
  });
}, 120_000);

afterEach(() => {
  cleanup();
  localStorage.clear();
  creationResults.length = 0;
});

afterAll(async () => {
  globalThis.fetch = nativeFetch;
  restoreBrowserSocket?.();
  await lab.harness.teardown();
}, 120_000);

describe("ChatLabApp conversation creation", () => {
  it("creates and selects persisted public, private, direct, and three-person conversations", async () => {
    render(<ChatLabApp />);

    await screen.findByText("Managed realtime connected", {}, { timeout: 10_000 });
    const navigation = await screen.findByRole("navigation", { name: "Conversations" });
    expect(within(navigation).getByRole("heading", {
      level: 2,
      name: "Development workspace",
    })).toBeTruthy();
    expect(within(navigation).queryByRole("heading", {
      level: 2,
      name: "Conversations",
    })).toBeNull();
    const addConversation = within(navigation).getByRole("button", {
      name: "Add conversation",
    });
    const openCreationDialog = (label: string) => {
      fireEvent.click(addConversation);
      fireEvent.click(within(navigation).getByRole("menuitem", { name: label }));
    };

    fireEvent.click(addConversation);
    expect(within(navigation).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "Create channel",
      "Create direct conversation",
      "Create group conversation",
    ]);
    fireEvent.keyDown(within(navigation).getByRole("menu"), { key: "Escape" });

    const verifier = lab.harness.createClient("chat-lab-ada");
    expect((await verifier.start()).state).toBe("ready");
    const seededIds = new Set(Object.values(lab.conversationIds));

    const createChannel = async (name: string, visibility: "public" | "private") => {
      const previousId = selectedConversationId();
      openCreationDialog("Create channel");
      const dialog = await screen.findByRole("dialog", { name: "Create channel" });
      enterText(within(dialog).getByRole("textbox", { name: "Channel name" }), name);
      fireEvent.click(within(dialog).getByRole("radio", {
        name: visibility === "public" ? "Public" : "Private",
      }));
      fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));

      await waitFor(() => {
        expect(screen.queryByRole("dialog", { name: "Create channel" })).toBeNull();
        expect(selectedConversationId()).toBeTruthy();
        expect(selectedConversationId()).not.toBe(previousId);
        expect(activeConversationRows()).toHaveLength(1);
      }, { timeout: 10_000 });
      const captured = creationResults.at(-1);
      expect(captured?.type).toBe("channel");
      expect(captured?.reconciliationStatus).toBe("created");
      expect(selectedConversationId()).toBe(captured?.conversation.conversation.id);
      const detail = requireSuccess<RetrievedConversationDetail>(
        `${visibility} channel detail`,
        await verifier.getConversation({ conversationId: captured!.conversation.conversation.id }),
      );
      expect(detail.conversation).toMatchObject({
        id: captured!.conversation.conversation.id,
        type: "channel",
        visibility,
        name,
        memberUserIds: ["ada"],
      });
      expect(seededIds.has(captured!.conversation.conversation.id)).toBe(false);
    };

    await createChannel("Chat Lab Created Public", "public");
    await createChannel("Chat Lab Created Private", "private");

    openCreationDialog("Create direct conversation");
    let dialog = await screen.findByRole("dialog", { name: "Create direct conversation" });
    enterText(within(dialog).getByRole("searchbox", { name: "Find a person" }), "Margaret");
    const margaret = await within(dialog).findByRole(
      "radio",
      { name: "Margaret Hamilton" },
      { timeout: 10_000 },
    );
    fireEvent.click(margaret);
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Create direct conversation" })).toBeNull();
      expect(selectedConversationId()).toBe(creationResults.at(-1)?.conversation.conversation.id);
      expect(activeConversationRows()).toHaveLength(1);
    }, { timeout: 10_000 });
    const directResult = creationResults.at(-1)!;
    expect(directResult.type).toBe("direct");
    expect(directResult.reconciliationStatus).toBe("created");
    const directDetail = requireSuccess<RetrievedConversationDetail>(
      "direct detail",
      await verifier.getConversation({
        conversationId: directResult.conversation.conversation.id,
      }),
    );
    expect(directDetail.conversation).toMatchObject({
      id: directResult.conversation.conversation.id,
      type: "direct",
      visibility: "private",
      memberUserIds: ["ada", "margaret"],
    });
    expect(seededIds.has(directResult.conversation.conversation.id)).toBe(false);

    openCreationDialog("Create group conversation");
    dialog = await screen.findByRole("dialog", { name: "Create group conversation" });
    const groupSearch = within(dialog).getByRole<HTMLInputElement>("searchbox", {
      name: "Find people",
    });
    enterText(groupSearch, "Ada");
    await within(dialog).findByText("No eligible people found.", {}, { timeout: 10_000 });
    expect(within(dialog).queryByRole("checkbox", { name: "Ada Lovelace" })).toBeNull();

    enterText(groupSearch, "Margaret");
    const groupMargaret = await within(dialog).findByRole(
      "checkbox",
      { name: "Margaret Hamilton" },
      { timeout: 10_000 },
    );
    fireEvent.click(groupMargaret);
    enterText(groupSearch, "Grace");
    const grace = await within(dialog).findByRole(
      "checkbox",
      { name: "Grace Hopper" },
      { timeout: 10_000 },
    );
    fireEvent.click(grace);
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Create group conversation" })).toBeNull();
      expect(selectedConversationId()).toBe(creationResults.at(-1)?.conversation.conversation.id);
      expect(activeConversationRows()).toHaveLength(1);
    }, { timeout: 10_000 });
    const groupResult = creationResults.at(-1)!;
    expect(groupResult.type).toBe("group_direct");
    expect(groupResult.reconciliationStatus).toBe("created");
    const groupDetail = requireSuccess<RetrievedConversationDetail>(
      "group direct detail",
      await verifier.getConversation({
        conversationId: groupResult.conversation.conversation.id,
      }),
    );
    expect(groupDetail.conversation).toMatchObject({
      id: groupResult.conversation.conversation.id,
      type: "group_direct",
      visibility: "private",
      memberUserIds: ["ada", "grace", "margaret"],
    });
    expect(new Set(groupDetail.conversation.memberUserIds).size).toBe(3);
    expect(seededIds.has(groupResult.conversation.conversation.id)).toBe(false);
    expect(creationResults.map(({ type }) => type)).toEqual([
      "channel",
      "channel",
      "direct",
      "group_direct",
    ]);
    verifier.close();
  }, 45_000);
});
