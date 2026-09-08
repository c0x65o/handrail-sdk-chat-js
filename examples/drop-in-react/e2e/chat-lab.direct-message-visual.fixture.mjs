import { createServer } from "node:net";

import { expect, test as base } from "@playwright/test";

import {
  CHAT_LAB_DIRECT_MESSAGE_VISUAL_PROFILE,
} from "../scripts/chat-lab-backend.mjs";
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
    throw new Error("Could not allocate an isolated direct-message visual port");
  }
  return address.port;
};

export const test = base.extend({
  chatLabOrigin: [
    async ({}, use) => {
      let lab;
      try {
        lab = await startChatLab({
          port: await availableLoopbackPort(),
          flutterReady: Promise.resolve(),
          seedProfile: CHAT_LAB_DIRECT_MESSAGE_VISUAL_PROFILE,
        });
        console.log(`Direct-message visual Chat Lab started: ${lab.origin}`);
        await use(lab.origin);
      } finally {
        if (lab !== undefined) {
          await lab.close();
          console.log(`Direct-message visual Chat Lab stopped: ${lab.origin}`);
        }
      }
    },
    { scope: "worker" },
  ],
});
