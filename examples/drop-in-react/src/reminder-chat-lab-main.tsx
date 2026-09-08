import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@handrail/chat/ui/styles.css";

import { ReminderChatLab } from "./ReminderChatLab";
import "./reminder-chat-lab.css";

const root = document.querySelector<HTMLDivElement>("#root");
if (root === null) throw new Error("The reminder chat lab root is missing.");

createRoot(root).render(
  <StrictMode>
    <ReminderChatLab />
  </StrictMode>,
);
