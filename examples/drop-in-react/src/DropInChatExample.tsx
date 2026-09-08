import type { CSSProperties } from "react";
import { ChatWorkspace } from "@handrail/chat/ui";

import { companyComponents } from "./company-slots";

const organizationScope = { type: "organization" } as const;
const salesOrderScope = {
  type: "entity",
  entity: { type: "sales-order", id: "SO-1042" },
} as const;

export function DropInChatExample() {
  return (
    <main className="drop-in-example">
      <section className="drop-in-example__full-screen" aria-labelledby="workspace-title">
        <div className="drop-in-example__heading">
          <p>Complete drop-in</p>
          <h1 id="workspace-title">Organization chat</h1>
        </div>
        <ChatWorkspace
          ariaLabel="Organization chat workspace"
          className="company-chat-theme"
          components={companyComponents}
          mode="full-screen"
          scope={organizationScope}
          style={{ "--hr-chat-color-accent": "#4f46e5" } as CSSProperties}
          theme="light"
        />
      </section>

      <section className="drop-in-example__record" aria-labelledby="record-title">
        <div className="drop-in-example__record-summary">
          <p>Sales order</p>
          <h2 id="record-title">SO-1042 · Northwind renewal</h2>
          <dl>
            <div><dt>Status</dt><dd>Awaiting approval</dd></div>
            <div><dt>Owner</dt><dd>Account operations</dd></div>
          </dl>
        </div>
        <aside className="drop-in-example__side-panel" aria-label="Sales order chat panel">
          <ChatWorkspace
            ariaLabel="Sales order SO-1042 chat"
            className="company-chat-theme company-chat-theme--record"
            components={companyComponents}
            mode="side-panel"
            scope={salesOrderScope}
            style={{ "--hr-chat-color-accent": "#a5b4fc" } as CSSProperties}
            theme="dark"
          />
        </aside>
      </section>
    </main>
  );
}
