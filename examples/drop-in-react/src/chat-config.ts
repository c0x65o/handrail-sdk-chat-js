import type { CreateChatClientConfig } from "@handrail/chat/client";

/**
 * These host-owned values are the only connection configuration the drop-in
 * UI needs. The host remains responsible for its endpoint and session route.
 */
export const chatConfig = {
  endpoint: "/api/chat",
  async getAccessToken() {
    const response = await fetch("/api/chat/session", {
      credentials: "same-origin",
    });
    if (!response.ok) {
      throw new Error("The host application did not provide a chat session.");
    }
    return response.text();
  },
} satisfies CreateChatClientConfig;
