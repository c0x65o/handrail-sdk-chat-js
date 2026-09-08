import { expect, test as base } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";

const exampleRoot = fileURLToPath(new URL("..", import.meta.url));

export { expect };

export const startConversationStateChatLab = async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";
  let environmentRestored = false;
  const restoreEnvironment = () => {
    if (environmentRestored) return;
    environmentRestored = true;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  };
  let vite;
  try {
    vite = await createViteServer({
      appType: "spa",
      configFile: false,
      mode: "development",
      optimizeDeps: {
        noDiscovery: true,
        include: ["react", "react-dom/client", "react/jsx-dev-runtime", "react/jsx-runtime"],
      },
      resolve: {
        dedupe: ["react", "react-dom"],
      },
      root: exampleRoot,
      server: {
        host: "127.0.0.1",
        port: 0,
        strictPort: false,
      },
    });
    await vite.listen();
  } catch (error) {
    await vite?.close();
    restoreEnvironment();
    throw error;
  }

  const address = vite.httpServer?.address();
  if (address === null || address === undefined || typeof address === "string") {
    await vite.close();
    restoreEnvironment();
    throw new Error("The conversation-state Vite server did not expose a TCP address");
  }

  let closePromise;
  const origin = `http://127.0.0.1:${address.port}`;
  return Object.freeze({
    origin,
    close() {
      closePromise ??= vite.close().finally(restoreEnvironment);
      return closePromise;
    },
  });
};

export const test = base.extend({
  conversationStateOrigin: [
    async ({}, use) => {
      const lab = await startConversationStateChatLab();
      console.log(`Conversation state Chat Lab started: ${lab.origin}`);
      try {
        await use(lab.origin);
      } finally {
        await lab.close();
        console.log(`Conversation state Chat Lab stopped: ${lab.origin}`);
      }
    },
    { scope: "worker" },
  ],
});
