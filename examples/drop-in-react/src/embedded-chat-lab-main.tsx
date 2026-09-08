import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@handrail/chat/ui/styles.css";

import { ChatLabApp } from "./ChatLabApp";
import "./chat-lab.css";

const root = document.querySelector<HTMLDivElement>("#root");
if (root === null) throw new Error("The embedded chat lab root is missing.");

createRoot(root).render(
  <StrictMode>
    <ChatLabApp embeddedWorkspaceFixture />
  </StrictMode>,
);
