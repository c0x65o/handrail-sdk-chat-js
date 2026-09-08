import { createServer } from "node:net";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { buildFlutterChatLab } from "../scripts/build-flutter-chat-lab.mjs";

import { expect, test as base } from "@playwright/test";

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
    throw new Error("Could not allocate an isolated Chat Lab port");
  }
  return address.port;
};

export const test = base.extend({
  chatLabDiscoveryAcceptance: [false, { option: true, scope: "worker" }],
  chatLabFlutterAcceptance: [false, { option: true, scope: "worker" }],
  chatLabSeedProfile: [undefined, { option: true, scope: "worker" }],
  chatLab: [
    async ({ chatLabSeedProfile, chatLabFlutterAcceptance, chatLabDiscoveryAcceptance }, use) => {
      const isolatedAcceptance = chatLabFlutterAcceptance || chatLabDiscoveryAcceptance;
      let lab;
      let identity;
      let flutterWebRoot;
      let buildProvenance;
      const output = process.env.CHAT_LAB_RECOVERY_ACCEPTANCE_DIR;
      const record = () => writeFile(path.join(output, "fixture.json"), JSON.stringify(identity, null, 2));
      if (isolatedAcceptance) {
        if (!output || !process.env.CHAT_LAB_RECOVERY_DATABASE_URL ||
            process.env.FLUTTER_CHAT_LAB_ORIGIN || process.env.CHAT_LAB_DATABASE_URL ||
            process.env.TEST_DATABASE_URL || process.env.DATABASE_URL) {
          throw new Error("Incomplete acceptance: use the dedicated npm run accept entry point; shared runtime/database overrides are forbidden");
        }
        if (chatLabFlutterAcceptance) {
          flutterWebRoot = path.join(output, "flutter-web");
          buildProvenance = await buildFlutterChatLab({ outputDirectory: flutterWebRoot });
        }
      }
      try {
        lab = await startChatLab({
          port: await availableLoopbackPort(),
          seedProfile: chatLabSeedProfile,
          ...(isolatedAcceptance ? {
            host: "127.0.0.1",
            databaseUrl: process.env.CHAT_LAB_RECOVERY_DATABASE_URL,
            flutterWebRoot,
          } : {}),
          // Acceptance has awaited a real build above; React-only fixtures do not build Flutter.
          flutterReady: Promise.resolve(buildProvenance),
        });
        if (isolatedAcceptance) {
          identity = { instanceId: lab.instanceId, origin: lab.origin,
            schema: lab.harness.schema, seedProfile: chatLabSeedProfile,
            conversationId: lab.conversationId, buildProvenance, closed: false };
          await record();
        }
        console.log(`Chat Lab started: ${lab.origin}`);
        await use(lab);
      } finally {
        if (lab !== undefined) {
          await lab.close();
          if (identity) {
            identity.closed = true;
            await record();
          }
          console.log(`Chat Lab stopped: ${lab.origin}`);
        }
      }
    },
    { scope: "worker", timeout: 600_000 },
  ],
  chatLabOrigin: [
    async ({ chatLab }, use) => {
      await use(chatLab.origin);
    },
    { scope: "worker" },
  ],
});
