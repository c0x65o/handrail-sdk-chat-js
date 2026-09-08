import type { CreateChatClientConfig } from "@handrail/chat/client";

export const chatConfig = {
  endpoint: "/api/chat",
  features: { huddles: true },
  async getAccessToken() {
    const response = await fetch("/api/chat/session", {
      credentials: "same-origin",
    });
    if (!response.ok) {
      throw new Error("The host application did not provide a chat session.");
    }
    return response.text();
  },
} satisfies CreateChatClientConfig<"huddles">;
