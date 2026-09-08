import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ChatProvider } from "@handrail/chat/react";

import { chatConfig } from "./chat-config";
import { HeadlessChatScreen, type HeadlessChatScreenProps } from "./HeadlessChatScreen";
import "./styles.css";

const root = document.querySelector<HTMLDivElement>("#root");
if (root === null) throw new Error("The headless chat root is missing.");

const conversationId = (
  import.meta.env.VITE_CHAT_CONVERSATION_ID ?? "example-channel"
) as HeadlessChatScreenProps["conversationId"];

createRoot(root).render(
  <StrictMode>
    <ChatProvider config={chatConfig}>
      <HeadlessChatScreen conversationId={conversationId} />
    </ChatProvider>
  </StrictMode>,
);
