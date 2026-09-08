import { useEffect, useState } from "react";

import { ChatLabApp, type ChatLabAppProps } from "./ChatLabApp";

const instanceEndpoint = "/__chat-lab/instance";
const instancePollIntervalMs = 1_000;

const readInstanceId = async (): Promise<{ instanceId: string; replyStylesScenario: boolean }> => {
  const response = await fetch(instanceEndpoint, {
    cache: "no-store",
    credentials: "same-origin",
  });
  if (!response.ok) throw new Error("The Chat Lab instance is unavailable.");
  const value = await response.json() as unknown;
  const instanceId = typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as { readonly instanceId?: unknown }).instanceId
    : undefined;
  if (typeof instanceId !== "string" || !/^[a-f0-9]{32}$/u.test(instanceId)) {
    throw new Error("The Chat Lab instance response is invalid.");
  }
  return { instanceId, replyStylesScenario: (value as { seedProfile?: string }).seedProfile === "reply-styles" };
};

/** Keeps a long-lived browser tab isolated from data seeded by older lab processes. */
export function ChatLabRuntime(props: ChatLabAppProps) {
  const [instance, setInstance] = useState<Awaited<ReturnType<typeof readInstanceId>>>();

  useEffect(() => {
    let active = true;
    let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;

    const poll = async () => {
      try {
        const nextInstanceId = await readInstanceId();
        if (active) {
          setInstance((current) =>
            current?.instanceId === nextInstanceId.instanceId ? current : nextInstanceId);
        }
      } catch {
        // Keep a connected instance mounted through brief restart/proxy gaps.
      } finally {
        if (active) timeout = globalThis.setTimeout(poll, instancePollIntervalMs);
      }
    };

    void poll();
    return () => {
      active = false;
      if (timeout !== undefined) globalThis.clearTimeout(timeout);
    };
  }, []);

  if (instance === undefined) {
    return <div role="status">Connecting to Chat Lab…</div>;
  }

  return <ChatLabApp {...props} {...instance} key={instance.instanceId} />;
}
