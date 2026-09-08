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

const nativeFetch = globalThis.fetch;
let lab: Awaited<ReturnType<typeof startChatLabBackend>>;
let restoreBrowserSocket: (() => void) | undefined;

const selectActor = async (displayName: string, optionName: string) => {
  fireEvent.click(screen.getByRole("button", {
    name: /Development fixture identity:/u,
  }));
  fireEvent.click(within(screen.getByRole("listbox", {
    name: "Development fixture identities",
  })).getByRole("option", { name: optionName }));
  await screen.findByText(`Current actor: ${displayName}`, {}, { timeout: 10_000 });
  await screen.findByText("Managed realtime connected", {}, { timeout: 10_000 });
};

const openDirectConversation = async (): Promise<HTMLTextAreaElement> => {
  const navigation = await screen.findByRole("navigation", { name: "Conversations" });
  fireEvent.click(within(navigation).getByRole("button", {
    name: /^Direct conversation(?:, \d+ unread messages?)?$/u,
  }));
  await screen.findByRole("heading", { name: "Direct conversation" }, { timeout: 10_000 });
  const composer = await screen.findByRole<HTMLTextAreaElement>("textbox", {
    name: "Message",
  });
  await waitFor(() => {
    expect(composer.disabled).toBe(false);
    expect(composer.placeholder).not.toBe("Loading draft");
  }, { timeout: 10_000 });
  return composer;
};

const restoredDirectComposer = async (): Promise<HTMLTextAreaElement> => {
  await screen.findByRole("heading", { name: "Direct conversation" }, { timeout: 10_000 });
  const composer = await screen.findByRole<HTMLTextAreaElement>("textbox", {
    name: "Message",
  });
  await waitFor(() => {
    expect(composer.disabled).toBe(false);
    expect(composer.placeholder).not.toBe("Loading draft");
  }, { timeout: 10_000 });
  return composer;
};

const composerStatus = (composer: HTMLTextAreaElement): HTMLElement => {
  const form = composer.closest("form");
  if (form === null) throw new Error("The conversation composer form is unavailable.");
  return within(form).getByRole("status");
};

const typeAndSynchronizeDraft = async (
  composer: HTMLTextAreaElement,
  text: string,
): Promise<void> => {
  const status = composerStatus(composer);
  fireEvent.change(composer, { target: { value: text } });
  expect(composer.value).toBe(text);
  await waitFor(() => {
    expect(status.textContent).toBe("Saving draft…");
  });
  await waitFor(() => {
    expect(status.textContent).toBe("");
    expect(composer.closest("form")?.querySelector('[role="alert"]')).toBeNull();
  }, { timeout: 10_000 });
};

const expectTextAbsentFromRenderedActor = (text: string): void => {
  for (const textbox of screen.queryAllByRole<HTMLInputElement | HTMLTextAreaElement>(
    "textbox",
  )) {
    expect(textbox.value).not.toContain(text);
  }
  expect(document.body.textContent).not.toContain(text);
  for (const liveRegion of document.querySelectorAll<HTMLElement>(
    '[aria-live], [role="status"], [role="alert"]',
  )) {
    expect(liveRegion.textContent).not.toContain(text);
  }
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
    if (!requested.pathname.startsWith("/api/chat")) {
      throw new Error(`Unexpected external Chat Lab request: ${requested.origin}`);
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

afterEach(async () => {
  cleanup();
  localStorage.clear();
  await Promise.resolve();
});

afterAll(async () => {
  globalThis.fetch = nativeFetch;
  restoreBrowserSocket?.();
  if (lab !== undefined) await lab.harness.teardown();
}, 120_000);

describe("ChatLabApp draft isolation", () => {
  it("restores only the active actor's synchronized draft across identity round trips", async () => {
    const runId = Date.now().toString(36);
    const adaDraft = `Ada private unsent draft ${runId}`;
    const graceDraft = `Grace private unsent draft ${runId}`;

    render(<ChatLabApp />);

    await screen.findByText("Managed realtime connected", {}, { timeout: 10_000 });
    let composer = await openDirectConversation();
    await typeAndSynchronizeDraft(composer, adaDraft);

    await selectActor("Grace Hopper", "Grace Hopper Engineering");
    composer = await openDirectConversation();
    expect(composer.value).toBe("");
    expectTextAbsentFromRenderedActor(adaDraft);
    await typeAndSynchronizeDraft(composer, graceDraft);

    await selectActor("Ada Lovelace", "Ada Lovelace Product");
    composer = await restoredDirectComposer();
    await waitFor(() => {
      expect(composer.value).toBe(adaDraft);
    }, { timeout: 10_000 });
    expectTextAbsentFromRenderedActor(graceDraft);

    await selectActor("Grace Hopper", "Grace Hopper Engineering");
    composer = await restoredDirectComposer();
    await waitFor(() => {
      expect(composer.value).toBe(graceDraft);
    }, { timeout: 10_000 });
    expectTextAbsentFromRenderedActor(adaDraft);
  }, 30_000);
});
