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
import { createChatLabHuddleFixtureMediaAdapter } from "../src/chat-lab-media";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { compileFunction, constants } from "node:vm";

// Run executable Node ESM natively. Vitest's automatic .mjs inlining rewrites
// filesystem import.meta.url into a browser URL in this jsdom suite.
const importNative = compileFunction("return import(specifier)", ["specifier"], {
  importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
}) as (specifier: string) => Promise<any>;
const { CHAT_LAB_ACTORS, resolveChatLabActor, startChatLabBackend } =
  await importNative(pathToFileURL(resolve("scripts/chat-lab-backend.mjs")).href);
// This helper intentionally installs into the jsdom test global, not Node's.
// @ts-expect-error No declaration file is emitted for this example-only script.
import { installChatLabBrowserSocket } from "../scripts/chat-lab-browser-socket-harness.mjs";

const nativeFetch = globalThis.fetch;
let lab: Awaited<ReturnType<typeof startChatLabBackend>>;
let restoreBrowserSocket: (() => void) | undefined;

const openDirectConversation = async (active = false): Promise<HTMLElement> => {
  const navigation = await screen.findByRole("navigation", { name: "Conversations" });
  // The actor's navigation shell renders before its canonical list hydrates.
  const direct = await waitFor(() => {
    const button = within(navigation).getAllByRole("button").find(candidate =>
      candidate.getAttribute("data-conversation-id") === lab.conversationIds.direct);
    if (!button) throw new Error("Seeded direct conversation is missing");
    return button;
  }, { timeout: 10_000 });
  fireEvent.click(direct);
  if (active) {
    return screen.findByRole("region", { name: "Huddle controls" }, { timeout: 10_000 });
  }
  const start = await screen.findByRole<HTMLButtonElement>(
    "button",
    { name: "Start huddle" },
    { timeout: 10_000 },
  );
  const main = start.closest<HTMLElement>("main");
  if (main === null) throw new Error("The header huddle action must belong to the conversation.");
  return main;
};

const selectActor = async (name: RegExp) => {
  fireEvent.click(screen.getByRole("button", { name: /^Development fixture identity:/u }));
  fireEvent.click(screen.getByRole("option", { name }));
  const displayName = name.source.includes("Grace") ? "Grace Hopper" : "Ada Lovelace";
  await screen.findByRole("button", {
    name: `Development fixture identity: ${displayName}`,
  }, { timeout: 10_000 });
  await screen.findByText("Managed realtime connected", {}, { timeout: 10_000 });
  return openDirectConversation(true);
};

const ensureConnected = async (huddle: HTMLElement) => {
  if (within(huddle).queryByText("Media connection: Connected.") !== null) return;
  const rejoin = await within(huddle).findByRole(
    "button",
    { name: /^(?:Rejoin|Join) huddle$/u },
    { timeout: 10_000 },
  );
  fireEvent.click(rejoin);
  await within(huddle).findByText(
    "Media connection: Connected.",
    {},
    { timeout: 10_000 },
  );
};

const openHuddleDetails = async (huddle: HTMLElement) => {
  const trigger = within(huddle).getByRole("button", { name: "Open huddle details" });
  if (trigger.getAttribute("aria-expanded") !== "true") fireEvent.click(trigger);
  return within(huddle).findByRole("dialog", { name: "Huddle details" });
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
    // Every SDK request is routed into the in-process real-stack harness. Any
    // attempted provider/network URL fails the test instead of escaping.
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
  await lab?.harness.teardown();
}, 120_000);

describe("ChatLabApp huddles", () => {
  it("fails closed without a host-provided huddle media adapter", async () => {
    render(<ChatLabApp initialActorId="ada" />);

    expect(await screen.findByText(
      "Huddle media not configured. Start and Join actions are unavailable.",
    )).not.toBeNull();
    expect(screen.queryByText(/Huddle media is configured for this Chat Lab session/u))
      .toBeNull();
    await screen.findByText("Managed realtime connected", {}, { timeout: 10_000 });
    const navigation = await screen.findByRole("navigation", { name: "Conversations" });
    const direct = within(navigation).getAllByRole("button").find(button =>
      button.getAttribute("data-conversation-id") === lab.conversationIds.direct);
    if (!direct) throw new Error("Seeded direct conversation is missing");
    fireEvent.click(direct);
    await waitFor(() => {
      expect(document.querySelector(`.handrail-chat__conversation[data-conversation-id="${lab.conversationIds.direct}"]`))
        .not.toBeNull();
    });

    expect(screen.queryByRole("button", { name: "Start huddle" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Join huddle" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Huddle controls" })).toBeNull();

    fireEvent.click(screen.getByRole("button", {
      name: "Development fixture identity: Ada Lovelace",
    }));
    fireEvent.click(screen.getByRole("option", { name: "Grace Hopper Engineering" }));
    await screen.findByRole("button", {
      name: "Development fixture identity: Grace Hopper",
    }, { timeout: 10_000 });
    expect(screen.getByText(
      "Huddle media not configured. Start and Join actions are unavailable.",
    )).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Start huddle" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Join huddle" })).toBeNull();
  }, 120_000);

  it("runs two actors through one local huddle and cleans media on every identity boundary", async () => {
    const mediaAdapter = createChatLabHuddleFixtureMediaAdapter();
    render(<ChatLabApp huddleMediaAdapter={mediaAdapter} />);

    expect(await screen.findByText(/Huddle media is configured for this Chat Lab session/u))
      .not.toBeNull();
    await screen.findByText("Managed realtime connected", {}, { timeout: 10_000 });
    let huddle = await openDirectConversation();
    const start = within(huddle).getByRole<HTMLButtonElement>(
      "button",
      { name: "Start huddle" },
    );
    expect(start.title).toBe("Start huddle");
    expect(within(huddle).queryByText(/Media connection:/u)).toBeNull();
    expect(screen.queryByRole("region", { name: "Huddle controls" })).toBeNull();

    fireEvent.click(start);
    fireEvent.click(await within(huddle).findByRole(
      "button",
      { name: "Join huddle" },
      { timeout: 10_000 },
    ));
    await within(huddle).findByText("Huddle is active.", {}, { timeout: 10_000 });
    await within(huddle).findByText(
      "Media connection: Connected.",
      {},
      { timeout: 10_000 },
    );
    const admittedConnectionCount = mediaAdapter.snapshot().connectionCount;
    const activeConnection = mediaAdapter.snapshot().connections.at(-1);
    expect(activeConnection).toMatchObject({
      connectionStatus: "connected",
      disconnectCount: 0,
      tracks: [{ kind: "microphone", stopped: false }],
    });
    expect(mediaAdapter.setCurrentConnectionStatus("reconnecting")).toBe(true);
    await within(huddle).findByText(
      "Media connection: Reconnecting.",
      {},
      { timeout: 10_000 },
    );
    expect(within(huddle).getByText("Huddle is active.")).not.toBeNull();
    expect(within(huddle).getByRole<HTMLButtonElement>("button", {
      name: "Leave huddle",
    }).disabled).toBe(false);
    expect(within(huddle).getByRole<HTMLButtonElement>("button", {
      name: "Unmute microphone",
    }).disabled).toBe(true);
    let details = await openHuddleDetails(huddle);
    expect(within(details).getByRole("list", { name: "Huddle participants" }))
      .not.toBeNull();
    expect(within(details).getByText("ada")).not.toBeNull();
    expect(within(details).getByRole<HTMLButtonElement>("button", {
      name: "End huddle",
    }).disabled).toBe(false);
    expect(mediaAdapter.snapshot().connectionCount).toBe(admittedConnectionCount);
    // Superseded admission attempts may have been cleaned during recovery;
    // exactly one live provider and complete prior cleanup are the invariant.
    expect(mediaAdapter.snapshot().connections.filter(connection =>
      connection.connectionStatus !== "disconnected")).toMatchObject([{
        id: activeConnection?.id,
        connectionStatus: "reconnecting",
        disconnectCount: 0,
        tracks: [{ kind: "microphone", stopped: false }],
      }]);
    expect(mediaAdapter.snapshot().connections.filter(connection =>
      connection.id !== activeConnection?.id).every(connection =>
        connection.disconnectCount === 1 && connection.tracks.every(track => track.stopped)))
      .toBe(true);

    expect(mediaAdapter.setCurrentConnectionStatus("connected")).toBe(true);
    await within(huddle).findByText(
      "Media connection: Connected.",
      {},
      { timeout: 10_000 },
    );
    expect(mediaAdapter.snapshot().connectionCount).toBe(admittedConnectionCount);
    // Superseded admission attempts may have been cleaned during recovery;
    // exactly one live provider and complete prior cleanup are the invariant.
    expect(mediaAdapter.snapshot().connections.filter(connection =>
      connection.connectionStatus !== "disconnected")).toMatchObject([{
        id: activeConnection?.id,
        connectionStatus: "connected",
        disconnectCount: 0,
        tracks: [{ kind: "microphone", stopped: false }],
      }]);
    expect(mediaAdapter.snapshot().connections.filter(connection =>
      connection.id !== activeConnection?.id).every(connection =>
        connection.disconnectCount === 1 && connection.tracks.every(track => track.stopped)))
      .toBe(true);
    expect(within(huddle).getByRole<HTMLButtonElement>("button", {
      name: "Unmute microphone",
    }).disabled).toBe(false);
    expect(within(details).getByText("ada")).not.toBeNull();
    fireEvent.click(within(details).getByRole("button", {
      name: "Close huddle details",
    }));

    const detailsTrigger = within(huddle).getByRole<HTMLButtonElement>(
      "button",
      { name: "Open huddle details" },
    );
    const hiddenDetails = huddle.querySelector<HTMLElement>(
      ".handrail-chat__huddle-details",
    );
    expect(hiddenDetails).not.toBeNull();
    expect(hiddenDetails?.hidden).toBe(true);
    expect(detailsTrigger.getAttribute("aria-expanded")).toBe("false");

    detailsTrigger.focus();
    details = await openHuddleDetails(huddle);
    expect(details.hidden).toBe(false);
    expect(detailsTrigger.getAttribute("aria-expanded")).toBe("true");
    const explicitClose = within(details).getByRole<HTMLButtonElement>(
      "button",
      { name: "Close huddle details" },
    );
    explicitClose.focus();
    fireEvent.click(explicitClose);
    expect(hiddenDetails?.hidden).toBe(true);
    expect(detailsTrigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(detailsTrigger);

    details = await openHuddleDetails(huddle);
    const escapeClose = within(details).getByRole<HTMLButtonElement>(
      "button",
      { name: "Close huddle details" },
    );
    escapeClose.focus();
    fireEvent.keyDown(details, { key: "Escape" });
    expect(hiddenDetails?.hidden).toBe(true);
    expect(detailsTrigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(detailsTrigger);

    details = await openHuddleDetails(huddle);
    fireEvent.click(within(details).getByRole("button", {
      name: "Start screen sharing",
    }));
    await within(details).findByText(
      "ada is sharing their screen.",
      {},
      { timeout: 10_000 },
    );

    const adaConnection = mediaAdapter.snapshot().connections.at(-1);
    expect(adaConnection?.connectionStatus).toBe("connected");
    expect(adaConnection?.tracks.map(({ kind }) => kind)).toContain("screen_share");

    huddle = await selectActor(/Grace Hopper Engineering/u);
    await waitFor(() => {
      const cleaned = mediaAdapter.snapshot().connections.find(
        ({ id }) => id === adaConnection?.id,
      );
      expect(cleaned?.connectionStatus).toBe("disconnected");
      expect(cleaned?.disconnectCount).toBe(1);
      expect(cleaned?.tracks.every(({ stopped }) => stopped)).toBe(true);
    });
    fireEvent.click(await within(huddle).findByRole(
      "button",
      { name: "Join huddle" },
      { timeout: 10_000 },
    ));
    await within(huddle).findByText(
      "Media connection: Connected.",
      {},
      { timeout: 10_000 },
    );
    details = await openHuddleDetails(huddle);
    // This fixture uses the legacy chat-socket-owned policy: switching its
    // only Ada client leaves Ada and releases canonical share ownership.
    await within(details).findByText("No one is sharing their screen.", {}, { timeout: 10_000 });
    await waitFor(async () => {
      const canonical = await lab.harness.pool.query(
        `SELECT participant.left_at, session.active_screen_share_owner_user_id
           FROM "${lab.harness.schema}".chat_huddle_sessions AS session
           JOIN "${lab.harness.schema}".chat_huddle_participants AS participant
             ON participant.tenant_id = session.tenant_id
            AND participant.huddle_session_id = session.id
          WHERE session.tenant_id = 'chat-lab' AND session.conversation_id = $1
            AND session.status = 'active' AND participant.user_id = 'ada'`,
        [lab.conversationIds.direct],
      );
      expect(canonical.rows).toHaveLength(1);
      expect(canonical.rows[0].left_at).not.toBeNull();
      expect(canonical.rows[0].active_screen_share_owner_user_id).toBeNull();
    });
    expect(within(details).getByRole<HTMLButtonElement>("button", {
      name: "Start screen sharing",
    }).disabled).toBe(false);

    huddle = await selectActor(/Ada Lovelace Product/u);
    await ensureConnected(huddle);
    details = await openHuddleDetails(huddle);
    fireEvent.click(within(details).getByRole("button", { name: "Start screen sharing" }));
    await within(details).findByText("ada is sharing their screen.", {}, { timeout: 10_000 });
    fireEvent.click(within(details).getByRole("button", {
      name: "Stop screen sharing",
    }));
    await within(details).findByText(
      "No one is sharing their screen.",
      {},
      { timeout: 10_000 },
    );

    huddle = await selectActor(/Grace Hopper Engineering/u);
    await ensureConnected(huddle);
    details = await openHuddleDetails(huddle);
    fireEvent.click(within(details).getByRole("button", {
      name: "Start screen sharing",
    }));
    await within(details).findByText(
      "grace is sharing their screen.",
      {},
      { timeout: 10_000 },
    );

    huddle = await selectActor(/Ada Lovelace Product/u);
    details = await openHuddleDetails(huddle);
    await within(details).findByText(
      "No one is sharing their screen.",
      {},
      { timeout: 10_000 },
    );
    // Left participants have no capture controls until they join again.
    expect(within(details).queryByRole("button", {
      name: "Start screen sharing",
    })).toBeNull();

    huddle = await selectActor(/Grace Hopper Engineering/u);
    await ensureConnected(huddle);
    fireEvent.click(within(huddle).getByRole("button", { name: "Leave huddle" }));
    await within(huddle).findByText(/grace \(left\)/u, {}, { timeout: 10_000 });

    huddle = await selectActor(/Ada Lovelace Product/u);
    details = await openHuddleDetails(huddle);
    fireEvent.click(within(details).getByRole("button", { name: "End huddle" }));
    await within(huddle).findByText("Huddle ended.", {}, { timeout: 10_000 });

    await waitFor(() => {
      expect(mediaAdapter.snapshot().connections.every((connection) =>
        connection.disconnectCount === 1 &&
        connection.tracks.every(({ stopped }) => stopped)
      )).toBe(true);
    });
    expect(JSON.stringify(mediaAdapter)).toBe("{}");
    expect(lab.harness.calls.count("media.createRoom")).toBe(1);
    expect(lab.harness.calls.count("media.createParticipantToken")).toBeGreaterThanOrEqual(3);
    expect(lab.harness.calls.count("media.terminateRoom")).toBe(1);
    expect(JSON.stringify(lab.harness.calls.all("media.createParticipantToken")))
      .not.toContain("test-media-token-");

    const huddleCapabilities = (actorId: string) => CHAT_LAB_ACTORS
      .find(({ id }: { readonly id: string }) => id === actorId)
      ?.capabilities.filter((capability: string) => capability.startsWith("huddle."));
    expect(huddleCapabilities("ada")).toEqual([
      "huddle.start",
      "huddle.join",
      "huddle.leave",
      "huddle.screen_share",
      "huddle.end",
    ]);
    expect(huddleCapabilities("grace")).toEqual([
      "huddle.join",
      "huddle.leave",
      "huddle.screen_share",
    ]);
    expect(huddleCapabilities("margaret")).toEqual([
      "huddle.join",
      "huddle.leave",
    ]);
  }, 120_000);
});
