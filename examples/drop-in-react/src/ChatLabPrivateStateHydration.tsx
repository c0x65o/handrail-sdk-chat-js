import { useEffect } from "react";
import { useChat } from "@handrail/chat/react";

/** Restore canonical actor-private indicators that realtime does not replay on startup. */
export function ChatLabPrivateStateHydration() {
  const chat = useChat();
  const client = chat?.client;
  const isReady = chat?.isReady;

  useEffect(() => {
    if (client === undefined || !isReady) return;
    const controller = new AbortController();
    const options = { signal: controller.signal };

    const hydrateSavedMessages = async () => {
      let cursor: Parameters<typeof client.listSavedMessages>[0]["cursor"];
      do {
        const result = await client.listSavedMessages({
          limit: 100,
          ...(cursor === undefined ? {} : { cursor }),
        }, options);
        if (result.status !== "success" || controller.signal.aborted) return;
        cursor = result.value.page.nextCursor ?? undefined;
      } while (cursor !== undefined);
    };
    const hydrateReminders = async () => {
      let cursor: Parameters<typeof client.listMessageReminders>[0]["cursor"];
      do {
        const result = await client.listMessageReminders({
          limit: 100,
          includeCancelled: true,
          ...(cursor === undefined ? {} : { cursor }),
        }, options);
        if (result.status !== "success" || controller.signal.aborted) return;
        cursor = result.value.page.nextCursor ?? undefined;
      } while (cursor !== undefined);
    };

    void hydrateSavedMessages();
    void hydrateReminders();
    return () => controller.abort();
  }, [client, isReady]);

  return null;
}
