import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@handrail/chat/ui/styles.css";

import { ChatLabRuntime } from "./ChatLabRuntime";
import { installChatLabHuddleFixture } from "./chat-lab-huddle-fixture";
import {
  createChatLabHuddleFixtureMediaAdapter,
  isChatLabHuddleFixtureEnabled,
} from "./chat-lab-media";
import "./chat-lab.css";
import { ChatLabWebRtcAdapter } from "./chat-lab-webrtc";
import { ChatLabMediaPanel } from "./ChatLabMediaPanel";
import { isChatLabActorId } from "./chat-lab-config";

const root = document.querySelector<HTMLDivElement>("#root");
if (root === null) throw new Error("The chat lab root is missing.");

const huddleFixtureEnabled = isChatLabHuddleFixtureEnabled(globalThis.location.href);
const directMessageVisualFixtureEnabled =
  new URL(globalThis.location.href).searchParams.get("chatLabDirectMessageVisual") ===
  "true";
const mediaAdapter = huddleFixtureEnabled
  ? createChatLabHuddleFixtureMediaAdapter()
  : undefined;
const realMediaAdapter = huddleFixtureEnabled ? undefined : new ChatLabWebRtcAdapter();
const requestedActor = new URL(globalThis.location.href).searchParams.get("actor");

if (mediaAdapter !== undefined) {
  installChatLabHuddleFixture({
    mediaAdapter,
    root,
  });
}

createRoot(root).render(
  <StrictMode>
    <ChatLabRuntime
      directMessageVisualFixture={directMessageVisualFixtureEnabled}
      {...(realMediaAdapter === undefined ? {} : {
        huddleMediaAdapter: realMediaAdapter,
        huddleMediaView: <ChatLabMediaPanel adapter={realMediaAdapter} />,
      })}
      {...(requestedActor !== null && isChatLabActorId(requestedActor) ? { initialActorId: requestedActor } : {})}
      {...(mediaAdapter === undefined ? {} : {
        huddleMediaAdapter: mediaAdapter,
        initialActorId: "ada",
      })}
    />
  </StrictMode>,
);
