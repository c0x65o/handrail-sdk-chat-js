import { createServer } from "node:net";

import { expect, test as base } from "@playwright/test";

import { CHAT_LAB_DENSE_SIDEBAR_PROFILE } from "../scripts/chat-lab-backend.mjs";
import { startChatLab } from "../scripts/chat-lab.mjs";

export { expect };

const availableLoopbackPort = async () => {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
  if (address === null || typeof address === "string") {
    throw new Error("Could not allocate an isolated dense Chat Lab port");
  }
  return address.port;
};

export const test = base.extend({
  denseChatLab: [
    async ({}, use) => {
      let lab;
      try {
        lab = await startChatLab({
          port: await availableLoopbackPort(),
          flutterReady: Promise.resolve(),
          seedProfile: CHAT_LAB_DENSE_SIDEBAR_PROFILE,
        });
        await use(lab);
      } finally {
        await lab?.close();
      }
    },
    { scope: "worker" },
  ],
});
