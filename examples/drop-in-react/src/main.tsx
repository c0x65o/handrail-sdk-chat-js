import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ChatProvider } from "@handrail/chat/react";
import "@handrail/chat/ui/styles.css";

import { chatConfig } from "./chat-config";
import { DropInChatExample } from "./DropInChatExample";
import "./styles.css";

const root = document.querySelector<HTMLDivElement>("#root");
if (root === null) throw new Error("The drop-in chat root is missing.");

createRoot(root).render(
  <StrictMode>
    <ChatProvider config={chatConfig}>
      <DropInChatExample />
    </ChatProvider>
  </StrictMode>,
);
