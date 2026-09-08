import { ChatHuddleMediaSession } from "@handrail/chat/client";
import { describe, expect, it } from "vitest";

import {
  installChatLabHuddleFixture,
  type ChatLabHuddleFixtureBridge,
} from "../src/chat-lab-huddle-fixture";
import {
  createChatLabHuddleFixtureMediaAdapter,
  isChatLabHuddleFixtureEnabled,
} from "../src/chat-lab-media";

describe("fixture-only deterministic Chat Lab media adapter", () => {
  it("requires the explicit enabled query value", () => {
    expect(isChatLabHuddleFixtureEnabled("https://chat.test/chat-lab.html"))
      .toBe(false);
    expect(isChatLabHuddleFixtureEnabled(
      "https://chat.test/chat-lab.html?chatLabHuddleFixture=reconnecting",
    )).toBe(false);
    expect(isChatLabHuddleFixtureEnabled(
      "https://chat.test/chat-lab.html?chatLabHuddleFixture=enabled",
    )).toBe(true);
  });

  it("keeps opaque material outside diagnostics and stops every local track", async () => {
    const secret = "OPAQUE_CHAT_LAB_JOIN_SENTINEL";
    const descriptor = {
      kind: "opaque_media_join" as const,
      descriptor: secret,
      expiresAt: "2030-01-01T00:05:00.000Z" as const,
      toJSON() {
        throw new Error("The adapter must not serialize join material");
      },
    };
    const adapter = createChatLabHuddleFixtureMediaAdapter();
    const session = new ChatHuddleMediaSession(adapter);

    await session.connect(descriptor);
    await session.unmuteMicrophone();
    await session.startScreenShare();
    expect(session.getState()).toMatchObject({
      connectionStatus: "connected",
      microphoneMuted: false,
      screenShareActive: true,
    });
    expect(adapter.snapshot()).toMatchObject({
      connectionCount: 1,
      connections: [{
        connectionStatus: "connected",
        disconnectCount: 0,
        tracks: [
          { kind: "microphone", stopped: false },
          { kind: "screen_share", stopped: false },
        ],
      }],
    });

    await session.handleIdentityChange();
    expect(adapter.snapshot()).toMatchObject({
      connections: [{
        connectionStatus: "disconnected",
        disconnectCount: 1,
        tracks: [
          { kind: "microphone", stopped: true },
          { kind: "screen_share", stopped: true },
        ],
      }],
    });
    expect(JSON.stringify({ adapter, diagnostics: adapter.snapshot() }))
      .not.toContain(secret);

    await session.close();
    expect(session.getState().connectionStatus).toBe("closed");
  });

  it("bridges the live adapter while preserving the header-to-call-bar transition", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    const headerGroup = document.createElement("div");
    headerGroup.className = "handrail-chat__header-actions";
    headerGroup.setAttribute("aria-label", "Conversation actions");
    headerGroup.setAttribute("role", "group");
    const start = document.createElement("button");
    start.setAttribute("aria-label", "Start huddle");
    start.setAttribute("data-handrail-huddle-header-control", "");
    headerGroup.append(start);
    root.append(headerGroup);

    const adapter = createChatLabHuddleFixtureMediaAdapter();
    const session = new ChatHuddleMediaSession(adapter);
    const dispose = installChatLabHuddleFixture({ mediaAdapter: adapter, root });
    const fixture = (
      globalThis as typeof globalThis & {
        readonly __handrailChatLabHuddleFixture?: ChatLabHuddleFixtureBridge;
      }
    ).__handrailChatLabHuddleFixture;

    expect(headerGroup.getAttribute("role")).toBe("region");
    expect(headerGroup.getAttribute("aria-label")).toBe("Huddle controls");
    expect(fixture).toBeDefined();
    expect(fixture?.setConnectionStatus("reconnecting")).toBe(false);

    await session.connect(Object.freeze({
      kind: "opaque_media_join" as const,
      descriptor: "fixture-bridge-descriptor",
      expiresAt: "2030-01-01T00:05:00.000Z" as const,
    }));
    expect(fixture?.setConnectionStatus("reconnecting")).toBe(true);
    expect(session.getState().connectionStatus).toBe("reconnecting");
    expect(fixture?.setConnectionStatus("connected")).toBe(true);
    expect(session.getState().connectionStatus).toBe("connected");

    const activeControls = document.createElement("section");
    activeControls.setAttribute("aria-label", "Huddle controls");
    activeControls.setAttribute("data-handrail-huddle-controls", "");
    const primaryActions = document.createElement("div");
    primaryActions.className = "handrail-chat__huddle-actions--primary";
    const microphone = document.createElement("button");
    microphone.className = "handrail-chat__huddle-button";
    primaryActions.append(microphone);
    const detailsTrigger = document.createElement("button");
    detailsTrigger.className = "handrail-chat__huddle-details-trigger";
    detailsTrigger.setAttribute("aria-expanded", "true");
    const details = document.createElement("div");
    details.className = "handrail-chat__huddle-details";
    detailsTrigger.addEventListener("click", () => {
      details.hidden = false;
      detailsTrigger.setAttribute("aria-expanded", "true");
    });
    activeControls.append(primaryActions, detailsTrigger, details);
    root.replaceChildren(activeControls);
    await Promise.resolve();

    expect(headerGroup.getAttribute("role")).toBe("group");
    expect(headerGroup.getAttribute("aria-label")).toBe("Conversation actions");
    expect(activeControls.getAttribute("aria-label")).toBe("Huddle controls");

    microphone.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    details.hidden = true;
    detailsTrigger.setAttribute("aria-expanded", "false");
    await Promise.resolve();
    expect(details.hidden).toBe(false);
    expect(detailsTrigger.getAttribute("aria-expanded")).toBe("true");

    dispose();
    expect("__handrailChatLabHuddleFixture" in globalThis).toBe(false);
    await session.close();
    root.remove();
  });
});
