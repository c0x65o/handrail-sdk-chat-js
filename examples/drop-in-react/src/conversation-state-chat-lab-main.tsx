import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@handrail/chat/ui/styles.css";

import { ConversationStateChatLab } from "./ConversationStateChatLab";
import "./chat-lab.css";

const root = document.querySelector<HTMLDivElement>("#root");
if (root === null) throw new Error("The conversation state fixture root is missing.");

if (!import.meta.env.DEV) {
  throw new Error("The conversation state fixture is available only in development.");
}

createRoot(root).render(
  <StrictMode>
    <ConversationStateChatLab />
  </StrictMode>,
);
